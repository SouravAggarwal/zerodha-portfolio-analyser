#!/usr/bin/env python3
"""
zerodha-portfolio-analyser: a small local app for your Zerodha Kite portfolio.

Run:  python3 app.py        (opens http://localhost:8000)

- Trades come from Kite Console tradebook CSV files you add with "Sync".
  They are saved in data/trades.csv. Only new trades are added (matched by trade ID).
- The Kite holdings file (optional) tells the app about shares that never were trades
  (IPO, bonus, demerger, transfers, gold bonds) and is saved in data/holdings.json.
- Daily prices come from Yahoo Finance (free) and are cached in data/prices/ once a day.
No packages to install: only the Python standard library is used.
"""
import base64
import csv
import io
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
PRICES = DATA / "prices"
TRADES = DATA / "trades.csv"
HOLDINGS = DATA / "holdings.json"
META = DATA / "meta.json"
TICKERS = DATA / "tickers.json"  # optional: {"KITE_SYMBOL or ISIN": "YAHOO.TICKER"}
PORT = int(os.environ.get("PORT", "8000"))
EPS = 1e-6

FIELDS = ["symbol", "isin", "trade_date", "exchange", "segment", "series", "trade_type",
          "quantity", "price", "trade_id", "order_id", "order_execution_time"]
REQUIRED = ["symbol", "trade_date", "trade_type", "quantity", "price", "trade_id"]
ALIASES = {
    "trade_time": "order_execution_time", "execution_time": "order_execution_time",
    "type": "trade_type", "qty": "quantity", "qty.": "quantity", "date": "trade_date",
    "tradingsymbol": "symbol",
}
# Kite adds a series code to some symbols in the holdings file, e.g. GOLDBEES-E, SGBJUN28-GB
SERIES_SUFFIX = re.compile(r"-(E|F|GB|BE|BZ|SM|ST|GS|TB|N\d|X\d)$")
lock = threading.Lock()


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".%d.tmp" % threading.get_ident())
    tmp.write_text(text)
    tmp.replace(path)


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def utc_day(ts, offset):
    return datetime.fromtimestamp(ts + offset, tz=timezone.utc).date().isoformat()


# ---------- reading files ----------

def norm_header(h):
    h = str(h or "").strip().lower().replace(" ", "_")
    return ALIASES.get(h, h)


def parse_date(s):
    s = str(s or "").strip()
    if re.fullmatch(r"\d{5}(\.\d+)?", s):  # a date cell from an .xlsx file (days since 1899-12-30)
        return (date(1899, 12, 30) + timedelta(days=int(float(s)))).isoformat()
    s = s[:10]
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("unknown date: " + s)


def num(s):
    s = str(s if s is not None else "").replace(",", "").strip()
    return float(s) if s else 0.0


def read_xlsx(data):
    """Read every sheet of an .xlsx file into lists of rows, with the standard library only."""
    m = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    r_id = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(m + "si"):
            shared.append("".join(t.text or "" for t in si.iter(m + "t")))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for sh in ET.fromstring(z.read("xl/workbook.xml")).iter(m + "sheet"):
        target = rels.get(sh.get(r_id), "").lstrip("/")
        path = target if target.startswith("xl/") else "xl/" + target
        if path not in names:
            continue
        rows = []
        for row in ET.fromstring(z.read(path)).iter(m + "row"):
            cells = {}
            for c in row.iter(m + "c"):
                col = 0
                for ch in re.match(r"[A-Z]+", c.get("r", "A")).group(0):
                    col = col * 26 + ord(ch) - 64
                t, v = c.get("t"), c.find(m + "v")
                if t == "s" and v is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(m + "t"))
                else:
                    val = v.text if v is not None else ""
                cells[col - 1] = val
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
        sheets[sh.get("name")] = rows
    return sheets


def file_rows(f):
    """Returns a list of (sheet name, rows) for an uploaded file (CSV or XLSX)."""
    if f.get("b64"):
        raw = base64.b64decode(f["b64"])
        if raw[:2] == b"PK":
            return list(read_xlsx(raw).items())
        text = raw.decode("utf-8-sig", errors="replace")
    else:
        text = f.get("text", "")
    return [("csv", list(csv.reader(io.StringIO(text.lstrip("﻿")))))]


def find_header(rows, must):
    for i, r in enumerate(rows):
        if must <= {norm_header(c) for c in r}:
            return i
    return None


def parse_tradebook(rows):
    """Rows of one Kite tradebook. Returns (equity_trades, skipped_other_segment)."""
    head_i = find_header(rows, {"symbol", "trade_id"})
    header = [norm_header(c) for c in rows[head_i]]
    missing = [c for c in REQUIRED if c not in header]
    if missing:
        raise ValueError("Missing columns: " + ", ".join(missing))
    trades, skipped = [], 0
    for r in rows[head_i + 1:]:
        if not any(str(c).strip() for c in r):
            continue
        d = {header[i]: (str(r[i]).strip() if i < len(r) else "") for i in range(len(header))}
        seg = d.get("segment", "EQ").upper()
        typ = d.get("trade_type", "").lower()
        if (seg and seg not in ("EQ", "EQUITY")) or typ not in ("buy", "sell"):
            skipped += 1
            continue
        t = {f: d.get(f, "") for f in FIELDS}
        t.update(
            symbol=t["symbol"].upper(), isin=t["isin"].upper(), exchange=t["exchange"].upper(),
            trade_date=parse_date(t["trade_date"]), trade_type=typ,
            quantity="%g" % num(t["quantity"]), price="%g" % num(t["price"]),
        )
        t["order_id"] = t["order_id"] or t["trade_id"]
        trades.append(t)
    return trades, skipped


def parse_holdings(rows):
    """Rows of the Equity sheet of a Kite Console holdings file."""
    head_i = find_header(rows, {"symbol", "quantity_available"})
    header = [norm_header(c) for c in rows[head_i]]
    as_on = None
    for r in rows[:head_i]:
        m = re.search(r"as on (\d{4}-\d{2}-\d{2})", " ".join(str(c) for c in r))
        if m:
            as_on = m.group(1)
    items = {}
    for r in rows[head_i + 1:]:
        d = {header[i]: r[i] for i in range(min(len(header), len(r)))}
        sym = str(d.get("symbol") or "").strip().upper()
        if not sym:
            continue
        qty = sum(num(d.get(k)) for k in ("quantity_available", "quantity_discrepant",
                                           "quantity_pledged_(margin)", "quantity_pledged_(loan)"))
        isin = str(d.get("isin") or "").strip().upper()
        items[isin or sym] = {
            "symbol": SERIES_SUFFIX.sub("", sym), "isin": isin, "qty": qty,
            "avg": num(d.get("average_price")), "prevClose": num(d.get("previous_closing_price")),
            "sector": str(d.get("sector") or "").strip(),
        }
    return {"date": as_on or date.today().isoformat(), "items": items}


def classify(f):
    """Read one uploaded file. Returns ('trades', trades, skipped) or ('holdings', snapshot)."""
    sheets = file_rows(f)
    # A holdings .xlsx has Equity, Mutual Funds and Combined sheets: only Equity is used
    sheets = [s for s in sheets if s[0] in ("csv", "Equity")] or sheets
    for name, rows in sheets:
        if find_header(rows, {"symbol", "quantity_available"}) is not None:
            return ("holdings", parse_holdings(rows))
        if find_header(rows, {"symbol", "trade_id"}) is not None:
            trades, skipped = parse_tradebook(rows)
            return ("trades", trades, skipped)
    raise ValueError("Not a Kite tradebook or holdings file. Use the CSV from Console → Reports → "
                     "Tradebook, or the file from Console → Portfolio → Holdings.")


# ---------- saved data ----------

def trade_key(t):
    # ISIN, not the name: a renamed stock keeps its ISIN, so a re-downloaded file can't add it twice
    return (t.get("isin") or t["symbol"], t["exchange"], t["trade_id"], t["order_id"])


def load_trades():
    if not TRADES.exists():
        return []
    with TRADES.open(newline="") as f:
        return list(csv.DictReader(f))


def save_trades(trades):
    trades.sort(key=lambda t: (t["trade_date"], t["order_execution_time"], t["symbol"]))
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=FIELDS, lineterminator="\n")
    w.writeheader()
    w.writerows({k: t.get(k, "") for k in FIELDS} for t in trades)
    write_atomic(TRADES, out.getvalue())


def sync(files, commit):
    if not commit:
        return _sync(files, False)
    with lock:  # one commit at a time, from reading saved trades to writing them
        return _sync(files, True)


def _sync(files, commit):
    saved = load_trades()
    keys = {trade_key(t) for t in saved}
    report = {"files": [], "new": 0, "already": 0, "skipped": 0, "symbols": [],
              "from": None, "to": None, "holdings": None}
    new, snapshot = [], None
    for f in files:
        try:
            got = classify(f)
        except Exception as e:  # noqa: BLE001 - shown to the user
            report["files"].append({"name": f.get("name"), "error": str(e)})
            continue
        if got[0] == "holdings":
            snap = got[1]
            if snapshot is None or snap["date"] >= snapshot["date"]:
                snapshot = snap
            report["files"].append({"name": f.get("name"), "kind": "holdings",
                                    "rows": len(snap["items"]), "date": snap["date"]})
            continue
        trades, skipped = got[1], got[2]
        report["files"].append({"name": f.get("name"), "kind": "trades", "rows": len(trades)})
        report["skipped"] += skipped
        for t in trades:
            k = trade_key(t)
            if k in keys:
                report["already"] += 1
                continue
            keys.add(k)
            new.append(t)
            report["from"] = min(report["from"] or t["trade_date"], t["trade_date"])
            report["to"] = max(report["to"] or t["trade_date"], t["trade_date"])
    report["new"] = len(new)
    report["symbols"] = sorted({t["symbol"] for t in new})
    if snapshot:
        old = read_json(HOLDINGS, {})
        report["holdings"] = {"date": snapshot["date"], "count": len(snapshot["items"]),
                              "older": bool(old.get("date") and old["date"] > snapshot["date"])}
    if commit and (new or snapshot):
        if new:
            save_trades(saved + new)
        if snapshot and not report["holdings"]["older"]:
            write_atomic(HOLDINGS, json.dumps(snapshot, indent=1))
        meta = read_json(META, {})
        meta["lastSynced"] = date.today().isoformat()
        write_atomic(META, json.dumps(meta, indent=2))
    return report


# ---------- prices (Yahoo Finance, cached once a day) ----------

def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def fetch_yahoo(ticker, start):
    p1 = int(datetime.combine(start, datetime.min.time()).timestamp())
    p2 = int(datetime.now().timestamp()) + 86400
    res = http_json("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(ticker)
                    + "?period1=%d&period2=%d&interval=1d&events=split" % (p1, p2))["chart"]["result"][0]
    meta = res.get("meta", {})
    off = meta.get("gmtoffset", 19800)
    quote = (res.get("indicators", {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    volumes = quote.get("volume") or [None] * len(closes)
    prices, prev = {}, None
    for ts, c, v in zip(res.get("timestamp") or [], closes, volumes):
        if c is None:
            continue
        if v == 0 and prev is not None and round(c, 2) == prev:
            continue  # on market holidays Yahoo repeats the last close with no trading: skip it
        prices[utc_day(ts, off)] = prev = round(c, 2)
    if not prices:
        raise ValueError("no prices")
    splits = [{"date": utc_day(s["date"], off), "num": s["numerator"], "den": s["denominator"]}
              for s in (res.get("events", {}).get("splits") or {}).values()
              if s.get("numerator") and s.get("denominator")]
    return {
        "ticker": ticker,
        "name": meta.get("longName") or meta.get("shortName") or "",
        "type": meta.get("instrumentType", ""),
        "prices": sorted(prices.items()),
        "splits": sorted(splits, key=lambda s: s["date"]),
    }


def search_by_isin(isin):
    """Find the current Yahoo ticker of a share by its ISIN (works after a rename)."""
    quotes = http_json("https://query1.finance.yahoo.com/v1/finance/search?quotesCount=5&newsCount=0&q="
                       + urllib.parse.quote(isin)).get("quotes", [])
    found = [q["symbol"] for q in quotes if q.get("symbol", "").endswith((".NS", ".BO"))]
    found.sort(key=lambda s: not s.endswith(".NS"))
    out = []
    for s in found:  # a BSE hit may also trade on NSE under the same name
        out += [s.rsplit(".", 1)[0] + ".NS", s] if s.endswith(".BO") else [s]
    return out


def get_prices(symbol, isin, first_date):
    path = PRICES / (re.sub(r"[^A-Za-z0-9_.&-]", "_", symbol) + ".json")
    today = date.today().isoformat()
    start = (date.fromisoformat(first_date) - timedelta(days=30)).isoformat()
    cached = read_json(path, None)
    if cached and cached.get("fetched") == today and cached.get("start", "9") <= start:
        return cached
    overrides = read_json(TICKERS, {})
    forced = overrides.get(symbol) or overrides.get(isin)
    offline = False  # True when Yahoo could not be reached at all (no internet, timeout)

    def attempt(tickers, tried):
        nonlocal offline
        for tk in tickers:
            if tk in tried:
                continue
            tried.add(tk)
            try:
                data = fetch_yahoo(tk, date.fromisoformat(start))
                data.update(fetched=today, start=start)
                write_atomic(path, json.dumps(data))
                return data
            except urllib.error.HTTPError:
                pass  # Yahoo answered: it doesn't know this name
            except (urllib.error.URLError, OSError):
                offline = True
            except (ValueError, KeyError, IndexError, TypeError):
                pass  # Yahoo answered with no usable prices
        return None

    tried = set()
    data = attempt([forced] if forced else [symbol + ".NS"], tried)
    if data is None and not forced and not offline:
        more = []
        if isin:
            try:
                more = search_by_isin(isin)  # finds the new name of a renamed stock
            except (urllib.error.URLError, OSError):
                offline = True
            except (ValueError, KeyError, TypeError):
                pass
        data = attempt(more + [symbol + ".BO"], tried)
    if data is not None:
        return data
    if cached and cached.get("prices"):  # keep the older prices if today's fetch failed
        cached["error"] = "Could not refresh prices today; showing prices up to %s." % cached["prices"][-1][0]
        return cached
    if offline:  # don't remember this: try again on the next page load
        return {"error": "Could not reach Yahoo Finance for prices. Check your internet connection.",
                "prices": [], "splits": [], "name": ""}
    data = {"error": "no prices", "prices": [], "splits": [], "name": "", "fetched": today, "start": start}
    write_atomic(path, json.dumps(data))  # Yahoo doesn't have it: don't ask again until tomorrow
    return data


# ---------- portfolio ----------

def split_factor(splits, day):
    """How many of today's shares one share bought on `day` became."""
    f = 1.0
    for s in splits:
        if day < s["date"]:
            f *= s["num"] / s["den"]
    return f


def build_holding(key, isin, symbol, trades, px, snap_item, snap_date):
    splits = px.get("splits", [])
    if trades:
        first = min(t["trade_date"] for t in trades)
        splits = [s for s in splits if s["date"] > first]  # older splits don't matter

    # One dot per order: an order filled in parts has several trades with the same order ID
    orders = {}
    for t in sorted(trades, key=lambda t: (t["trade_date"], t["order_execution_time"])):
        f = split_factor(splits, t["trade_date"])
        q, p = float(t["quantity"]) * f, float(t["price"]) / f
        o = orders.setdefault((t["order_id"], t["trade_type"]), {
            "id": "%s-%s" % (t["order_id"], t["trade_type"]), "orderId": t["order_id"],
            "symbol": t["symbol"], "date": t["trade_date"], "time": t["order_execution_time"][11:19],
            "type": t["trade_type"].upper(), "exchange": t["exchange"],
            "qty": 0.0, "value": 0.0, "fills": 0, "adjusted": f != 1.0})
        o["qty"] += q
        o["value"] += q * p
        o["fills"] += 1
    orders = sorted(orders.values(), key=lambda o: (o["date"], o["time"]))
    for o in orders:
        o["price"] = o["value"] / o["qty"] if o["qty"] else 0.0

    # First in, first out (the same method Kite uses for the average price)
    lots, realised, missing = [], 0.0, False

    def run(o):
        nonlocal realised, missing
        if o["type"] == "BUY":
            lots.append([o["qty"], o["price"]])
            return
        left = o["qty"]
        while left > EPS and lots:
            take = min(left, lots[0][0])
            realised += (o["price"] - lots[0][1]) * take
            lots[0][0] -= take
            left -= take
            if lots[0][0] <= EPS:
                lots.pop(0)
        if left > EPS:
            missing = True  # sold more than the trades show was bought

    def held():
        return sum(q for q, _ in lots)

    def cost():
        return sum(q * p for q, p in lots)

    recon = None
    if snap_date is not None:
        for o in orders:
            if o["date"] < snap_date:  # the holdings file doesn't include that day's trades yet
                run(o)
        trade_qty, trade_avg = held(), (cost() / held() if held() > EPS else 0.0)
        f = split_factor(splits, snap_date)  # a split after the holdings file date
        k_qty = snap_item["qty"] * f if snap_item else 0.0
        k_avg = snap_item["avg"] / f if snap_item else 0.0
        diff = k_qty - trade_qty
        if diff > EPS:
            lots.append([diff, k_avg])
        elif diff < -EPS:
            drop = -diff
            while drop > EPS and lots:  # shares that left without a sell (demerger, transfer out…)
                take = min(drop, lots[0][0])
                lots[0][0] -= take
                drop -= take
                if lots[0][0] <= EPS:
                    lots.pop(0)
        cost_changed = False
        if k_qty > EPS and cost() > EPS and k_avg > 0:
            scale = k_qty * k_avg / cost()
            cost_changed = abs(scale - 1) > 0.002 and abs(diff) <= EPS
            for lot in lots:
                lot[1] *= scale
        if abs(diff) > EPS or cost_changed:
            recon = {"date": snap_date, "kiteQty": k_qty, "tradeQty": trade_qty,
                     "kiteAvg": k_avg, "tradeAvg": trade_avg, "costChanged": cost_changed}
        missing = False  # the holdings file settles the count
        for o in orders:
            if o["date"] >= snap_date:
                run(o)
    else:
        for o in orders:
            run(o)
        # A split or bonus can leave part of a share; Kite pays that part in cash
        frac = held() - int(held() + EPS)
        if splits and frac > EPS and lots:
            lots[-1][0] -= frac
            if lots[-1][0] <= EPS:
                lots.pop()

    qty = held() if held() > EPS else 0.0
    invested = cost() if qty else 0.0
    prices = px.get("prices", [])
    last_date, price_from = None, None
    if prices:
        last, prev, last_date, price_from = prices[-1][1], (prices[-2][1] if len(prices) > 1 else prices[-1][1]), prices[-1][0], "yahoo"
    elif snap_item and snap_item.get("prevClose"):
        last = prev = snap_item["prevClose"]
        last_date, price_from = snap_date, "kite"
    else:
        last = prev = None
    current = qty * last if last is not None else invested
    name = px.get("name") or symbol
    sector = (snap_item or {}).get("sector", "")
    is_etf = (px.get("type") == "ETF" or sector == "ETF" or "ETF" in name.upper()
              or "BEES" in symbol or symbol.endswith("ETF") or isin.startswith("INF"))
    kind = "Gold bond" if symbol.startswith("SGB") else ("ETF" if is_etf else "Stock")
    for o in orders:
        o["qty"] = round(o["qty"], 4)
        del o["value"]
    return {
        "key": key, "symbol": symbol, "isin": isin, "name": name, "kind": kind,
        "sector": sector, "qty": round(qty, 4), "avg": invested / qty if qty else 0.0,
        "invested": invested, "current": current, "pnl": current - invested,
        "pnlPct": (current - invested) / invested if invested else 0.0, "realised": realised,
        "last": last, "lastDate": last_date, "priceFrom": price_from,
        "dayChange": (last - prev) / prev if last is not None and prev else 0.0,
        "missingBuys": missing, "recon": recon, "priceError": px.get("error"), "splits": splits,
        "symbols": sorted({o["symbol"] for o in orders}),
        "orders": orders, "prices": prices,
    }


def portfolio():
    trades = load_trades()
    snap = read_json(HOLDINGS, None)
    snap_items = snap["items"] if snap else {}
    groups = {}
    for t in trades:
        groups.setdefault(t.get("isin") or t["symbol"], []).append(t)
    keys = set(groups) | set(snap_items)

    def symbol_of(k):  # the newest name: from the holdings file, else the latest trade
        if k in snap_items:
            return snap_items[k]["symbol"]
        return max(groups[k], key=lambda t: (t["trade_date"], t["order_execution_time"]))["symbol"]

    def isin_of(k):
        if k in groups and groups[k][0].get("isin"):
            return groups[k][0]["isin"]
        return snap_items.get(k, {}).get("isin", "")

    def first_date(k):
        if k in groups:
            return min(t["trade_date"] for t in groups[k])
        return (date.fromisoformat(snap["date"]) - timedelta(days=365)).isoformat()

    PRICES.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as ex:
        pxs = dict(zip(keys, ex.map(lambda k: get_prices(symbol_of(k), isin_of(k), first_date(k)), keys)))
    holdings = [build_holding(k, isin_of(k), symbol_of(k), groups.get(k, []), pxs[k], snap_items.get(k),
                              snap["date"] if snap else None) for k in keys]
    holdings.sort(key=lambda h: (-h["current"], h["symbol"]))
    meta = read_json(META, {})
    return {
        "holdings": holdings,
        "tradeCount": len(trades),
        "lastSynced": meta.get("lastSynced"),
        "lastTradeDate": max((t["trade_date"] for t in trades), default=None),
        "holdingsDate": snap["date"] if snap else None,
    }


# ---------- web server ----------

TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
         ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}
ALLOWED_HOSTS = ("localhost", "127.0.0.1", "[::1]")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        # Only answer pages opened as localhost, so other websites can't read or change your data
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ALLOWED_HOSTS

    def do_GET(self):
        if not self.host_ok():
            return self.send(403, b"Forbidden", "text/plain")
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/portfolio":
            try:
                return self.send(200, portfolio())
            except Exception as e:  # noqa: BLE001
                return self.send(500, {"error": str(e)})
        file = (WEB / (urllib.parse.unquote(path).lstrip("/") or "index.html")).resolve()
        if WEB not in file.parents or not file.is_file():
            return self.send(404, b"Not found", "text/plain")
        self.send(200, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self.host_ok() or not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send(403, {"error": "Forbidden"})
        if path not in ("/api/sync/preview", "/api/sync/commit"):
            return self.send(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            if size > 50 * 1024 * 1024:
                return self.send(413, {"error": "Files too big (over 50 MB)"})
            body = json.loads(self.rfile.read(size) or b"{}")
            return self.send(200, sync(body.get("files", []), commit=path.endswith("commit")))
        except Exception as e:  # noqa: BLE001
            return self.send(400, {"error": str(e)})


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = "http://localhost:%d" % PORT
    print("Portfolio running at " + url + "   (Ctrl+C to stop)")
    if "--no-open" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
