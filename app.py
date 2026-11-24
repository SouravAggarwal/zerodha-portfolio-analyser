#!/usr/bin/env python3
"""
Portfolio viewer for a Zerodha Kite account.

Run:  python3 app.py        (opens http://localhost:8000)

- Trades come from Kite Console tradebook CSV files you upload with "Sync trades".
  They are saved in data/trades.csv. Only new trades are added (matched by trade ID).
- Daily prices come from Yahoo Finance (free) and are cached in data/prices/ once a day.
No packages to install: only the Python standard library is used.
"""
import csv
import io
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
PRICES = DATA / "prices"
TRADES = DATA / "trades.csv"
META = DATA / "meta.json"
TICKERS = DATA / "tickers.json"  # optional: {"KITE_SYMBOL": "YAHOO.TICKER"} for renamed stocks
PORT = int(os.environ.get("PORT", "8000"))

FIELDS = ["symbol", "isin", "trade_date", "exchange", "segment", "series", "trade_type",
          "quantity", "price", "trade_id", "order_id", "order_execution_time"]
REQUIRED = ["symbol", "trade_date", "trade_type", "quantity", "price", "trade_id"]
ALIASES = {
    "trade_time": "order_execution_time", "execution_time": "order_execution_time",
    "type": "trade_type", "qty": "quantity", "qty.": "quantity", "date": "trade_date",
    "tradingsymbol": "symbol", "trade_id.": "trade_id",
}
lock = threading.Lock()


# ---------- trades file ----------

def norm_header(h):
    h = (h or "").strip().lower().replace(" ", "_")
    return ALIASES.get(h, h)


def parse_date(s):
    s = (s or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("unknown date: " + s)


def num(s):
    return float(str(s).replace(",", "").strip() or 0)


def trade_key(t):
    return (t["symbol"], t["exchange"], t["trade_id"], t["order_id"])


def parse_tradebook(text):
    """Read one Kite tradebook CSV. Returns (equity_trades, skipped_other_segment)."""
    text = text.lstrip("﻿")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    # Find the header row (some exports have a few lines on top)
    head_i = next((i for i, r in enumerate(rows)
                   if {"symbol", "trade_id"} <= {norm_header(c) for c in r}), None)
    if head_i is None:
        raise ValueError("This does not look like a Kite tradebook CSV (no 'symbol' and 'trade_id' columns).")
    header = [norm_header(c) for c in rows[head_i]]
    missing = [c for c in REQUIRED if c not in header]
    if missing:
        raise ValueError("Missing columns: " + ", ".join(missing))
    trades, skipped = [], 0
    for r in rows[head_i + 1:]:
        if not any(c.strip() for c in r):
            continue
        d = {header[i]: (r[i].strip() if i < len(r) else "") for i in range(len(header))}
        seg = d.get("segment", "EQ").upper()
        if seg and seg not in ("EQ", "EQUITY"):
            skipped += 1
            continue
        t = {f: d.get(f, "") for f in FIELDS}
        t["symbol"] = t["symbol"].upper()
        t["trade_date"] = parse_date(t["trade_date"])
        t["trade_type"] = t["trade_type"].lower()
        t["quantity"] = str(num(t["quantity"])).rstrip("0").rstrip(".")
        t["price"] = str(num(t["price"]))
        t["exchange"] = t["exchange"].upper()
        if not t["order_id"]:
            t["order_id"] = t["trade_id"]
        if t["trade_type"] not in ("buy", "sell"):
            skipped += 1
            continue
        trades.append(t)
    return trades, skipped


def load_trades():
    if not TRADES.exists():
        return []
    with TRADES.open(newline="") as f:
        return list(csv.DictReader(f))


def save_trades(trades):
    DATA.mkdir(exist_ok=True)
    trades.sort(key=lambda t: (t["trade_date"], t["order_execution_time"], t["symbol"]))
    tmp = TRADES.with_suffix(".tmp")
    with tmp.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(trades)
    tmp.replace(TRADES)


def load_meta():
    return json.loads(META.read_text()) if META.exists() else {}


def sync(files, commit):
    saved = load_trades()
    keys = {trade_key(t) for t in saved}
    report = {"files": [], "new": 0, "already": 0, "skipped": 0, "symbols": [], "from": None, "to": None}
    new = []
    for f in files:
        try:
            trades, skipped = parse_tradebook(f.get("text", ""))
        except Exception as e:  # noqa: BLE001 - shown to the user
            report["files"].append({"name": f.get("name"), "error": str(e)})
            continue
        report["files"].append({"name": f.get("name"), "rows": len(trades)})
        report["skipped"] += skipped
        for t in trades:
            k = trade_key(t)
            if k in keys:
                report["already"] += 1
                continue
            keys.add(k)
            new.append(t)
            d = t["trade_date"]
            report["from"] = min(report["from"] or d, d)
            report["to"] = max(report["to"] or d, d)
    report["new"] = len(new)
    report["symbols"] = sorted({t["symbol"] for t in new})
    if commit and new:
        with lock:
            save_trades(saved + new)
            meta = load_meta()
            meta["lastSynced"] = date.today().isoformat()
            META.write_text(json.dumps(meta, indent=2))
    return report


# ---------- prices (Yahoo Finance, cached once a day) ----------

def fetch_yahoo(ticker, start):
    p1 = int(datetime.combine(start, datetime.min.time()).timestamp())
    p2 = int(datetime.now().timestamp()) + 86400
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(ticker)
           + "?period1=%d&period2=%d&interval=1d&events=split" % (p1, p2))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.load(r)["chart"]["result"][0]
    meta = res.get("meta", {})
    off = meta.get("gmtoffset", 19800)
    closes = (res.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    prices = {}
    for ts, c in zip(res.get("timestamp") or [], closes):
        if c is not None:
            prices[datetime.utcfromtimestamp(ts + off).date().isoformat()] = round(c, 2)
    splits = [
        {"date": datetime.utcfromtimestamp(s["date"] + off).date().isoformat(),
         "num": s["numerator"], "den": s["denominator"]}
        for s in (res.get("events", {}).get("splits") or {}).values()
    ]
    if not prices:
        raise ValueError("no prices")
    return {
        "ticker": ticker,
        "name": meta.get("longName") or meta.get("shortName") or "",
        "type": meta.get("instrumentType", ""),
        "prices": sorted(prices.items()),
        "splits": sorted(splits, key=lambda s: s["date"]),
    }


def get_prices(symbol, first_date):
    PRICES.mkdir(parents=True, exist_ok=True)
    path = PRICES / (symbol.replace("/", "_") + ".json")
    today = date.today().isoformat()
    cached = json.loads(path.read_text()) if path.exists() else None
    start = date.fromisoformat(first_date) - timedelta(days=30)
    if cached and cached.get("fetched") == today and cached.get("start", "9") <= start.isoformat():
        return cached
    overrides = json.loads(TICKERS.read_text()) if TICKERS.exists() else {}
    tickers = [overrides[symbol]] if symbol in overrides else [symbol + ".NS", symbol + ".BO"]
    err = None
    for tk in tickers:
        try:
            data = fetch_yahoo(tk, start)
            data.update(fetched=today, start=start.isoformat())
            path.write_text(json.dumps(data))
            return data
        except Exception as e:  # noqa: BLE001
            err = e
    if cached:  # keep yesterday's prices if today's fetch failed
        cached["error"] = "Could not refresh prices today"
        return cached
    return {"error": ("No daily prices found for %s. If the stock was renamed, add its new Yahoo "
                      "name to data/tickers.json, for example {\"%s\": \"NEWNAME.NS\"}." % (symbol, symbol)),
            "prices": [], "splits": [], "name": ""}


# ---------- portfolio ----------

def build_holding(symbol, trades, px):
    # Splits and bonus issues are not in the tradebook. Yahoo lists them as splits:
    # older trades are scaled so quantities and prices match today's share count.
    for t in trades:
        q, p, f = float(t["quantity"]), float(t["price"]), 1.0
        for s in px.get("splits", []):
            if t["trade_date"] < s["date"] and s["den"]:
                f *= s["num"] / s["den"]
        t["_q"], t["_p"], t["_adj"] = q * f, p / f, f != 1.0

    orders = {}
    for t in trades:
        o = orders.setdefault(t["order_id"] + t["trade_type"], {
            "id": "%s-%s" % (symbol, t["order_id"]), "orderId": t["order_id"],
            "date": t["trade_date"], "time": t["order_execution_time"][11:19],
            "type": t["trade_type"].upper(), "exchange": t["exchange"],
            "qty": 0.0, "value": 0.0, "fills": 0, "adjusted": t["_adj"]})
        o["qty"] += t["_q"]
        o["value"] += t["_q"] * t["_p"]
        o["fills"] += 1
    orders = sorted(orders.values(), key=lambda o: (o["date"], o["time"]))

    qty = cost = realised = 0.0
    missing = False
    for o in orders:
        o["price"] = o["value"] / o["qty"] if o["qty"] else 0
        o["qty"] = round(o["qty"], 4)
        if o["type"] == "BUY":
            qty += o["qty"]
            cost += o["value"]
        else:
            sell = o["qty"]
            if sell > qty + 1e-6:  # sold more than bought: some buys are not in the tradebook
                missing = True
                sell = qty
            avg = cost / qty if qty else 0
            realised += (o["price"] - avg) * sell
            cost -= avg * sell
            qty -= sell
        del o["value"]
    if qty < 1e-6:
        qty = cost = 0.0

    prices = px.get("prices", [])
    last = prices[-1][1] if prices else (orders[-1]["price"] if orders else 0)
    prev = prices[-2][1] if len(prices) > 1 else last
    name = px.get("name") or symbol
    is_etf = px.get("type") == "ETF" or "ETF" in name.upper() or "BEES" in symbol or symbol.endswith("ETF")
    current = qty * last
    return {
        "symbol": symbol, "name": name, "kind": "ETF" if is_etf else "Stock",
        "qty": round(qty, 4), "avg": cost / qty if qty else 0, "invested": cost,
        "current": current, "pnl": current - cost, "pnlPct": (current - cost) / cost if cost else 0,
        "realised": realised, "last": last, "lastDate": prices[-1][0] if prices else None,
        "dayChange": (last - prev) / prev if prev else 0,
        "missingBuys": missing, "priceError": px.get("error"), "splits": px.get("splits", []),
        "orders": orders, "prices": prices,
    }


def portfolio():
    trades = load_trades()
    by_sym = {}
    for t in trades:
        by_sym.setdefault(t["symbol"], []).append(t)
    firsts = {s: min(t["trade_date"] for t in ts) for s, ts in by_sym.items()}
    with ThreadPoolExecutor(max_workers=8) as ex:
        pxs = dict(zip(firsts, ex.map(lambda s: get_prices(s, firsts[s]), firsts)))
    holdings = [build_holding(s, ts, pxs[s]) for s, ts in by_sym.items()]
    holdings.sort(key=lambda h: -h["current"])
    meta = load_meta()
    return {
        "holdings": holdings,
        "tradeCount": len(trades),
        "lastSynced": meta.get("lastSynced"),
        "lastTradeDate": max((t["trade_date"] for t in trades), default=None),
    }


# ---------- web server ----------

TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
         ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}


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
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/portfolio":
            try:
                return self.send(200, portfolio())
            except Exception as e:  # noqa: BLE001
                return self.send(500, {"error": str(e)})
        file = (WEB / (path.lstrip("/") or "index.html")).resolve()
        if WEB not in file.parents or not file.is_file():
            return self.send(404, b"Not found", "text/plain")
        self.send(200, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/api/sync/preview", "/api/sync/commit"):
            return self.send(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length", 0))
        if size > 50 * 1024 * 1024:
            return self.send(413, {"error": "File too big"})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
            return self.send(200, sync(body.get("files", []), commit=path.endswith("commit")))
        except Exception as e:  # noqa: BLE001
            return self.send(400, {"error": str(e)})


def main():
    DATA.mkdir(exist_ok=True)
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
