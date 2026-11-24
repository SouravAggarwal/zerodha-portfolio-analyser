// Portfolio page: sidebar list, one stock at a time with price chart + orders table, and Sync.
const $ = (id) => document.getElementById(id);
const inr = (n, d = 2) => {
  if (n == null || !isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  return (n < 0 && s.replace(/[0.,]/g, '') ? '−₹' : '₹') + s;
};
const pct = (n) => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const sign = (n) => (n >= 0 ? 'up' : 'down');
const qtyFmt = (q) => Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const niceDate = (iso) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let DATA = null;
const OVERVIEW = '__overview';
let current = OVERVIEW; // key (ISIN) of the open stock, or the overview page
let chart = null;
let selected = null; // id of the highlighted order
const byKey = (k) => DATA.holdings.find((h) => h.key === k);

// ---------- theme ----------
function paintThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme').textContent = dark ? '☀' : '☾';
  $('theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  paintThemeButton();
  if (DATA) {
    const keep = selected;
    show(current); // redraw the charts in the new colours
    if (keep && byKey(current)) pick(keep, false);
  }
};
paintThemeButton();

// ---------- load ----------
async function load() {
  $('loading').hidden = false;
  try {
    const r = await fetch('/api/portfolio');
    DATA = await r.json();
    if (!r.ok) throw new Error(DATA.error || 'Failed to load');
  } catch (e) {
    $('loading').hidden = true;
    $('main').innerHTML = `<div class="empty"><div><h2>Could not load</h2>${esc(e.message)}<br/>
      <button class="btn" onclick="load()">Try again</button></div></div>`;
    return;
  }
  $('loading').hidden = true;
  $('synced').innerHTML = (DATA.lastSynced ? 'Last synced: ' + niceDate(DATA.lastSynced) : 'Not synced yet') +
    (DATA.holdingsDate ? `<br/>Kite holdings file: ${niceDate(DATA.holdingsDate)}` : '');
  renderTotals();
  if (!DATA.holdings.length) return renderEmpty();
  let want = ''; // a link like #INFY opens that stock
  try { want = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* a broken link: open the overview */ }
  const linked = want && DATA.holdings.find((h) => h.symbol === want || h.key === want);
  if (linked) current = linked.key;
  if (want.startsWith('cat=')) current = 'cat:' + want.slice(4);
  if (current !== OVERVIEW && !byKey(current) && !(isCat(current) && catList().includes(current.slice(4)))) current = OVERVIEW;
  renderList();
  show(current);
}

const isCat = (key) => key.startsWith('cat:');
function show(key) {
  const hash = key === OVERVIEW ? '' : isCat(key) ? '#cat=' + encodeURIComponent(key.slice(4)) : '#' + encodeURIComponent(byKey(key).symbol);
  history.replaceState(null, '', location.pathname + location.search + hash);
  if (key === OVERVIEW) showOverview();
  else if (isCat(key)) showCategory(key.slice(4));
  else showStock(key);
}
function go(key) {
  current = key;
  renderList();
  show(key);
  $('main').scrollTop = 0;
}
window.load = load;

function renderEmpty() {
  $('list').innerHTML = '';
  $('main').innerHTML = `<div class="empty"><div>
    <h2>No trades yet</h2>
    Download your tradebook from Kite Console and add it here.<br/>
    <button class="btn primary" onclick="openSync()">Add my first tradebook</button>
  </div></div>`;
}

function renderTotals() {
  const H = DATA.holdings.filter((h) => h.qty > 0);
  const inv = H.reduce((a, h) => a + h.invested, 0);
  const cur = H.reduce((a, h) => a + h.current, 0);
  const realised = DATA.holdings.reduce((a, h) => a + h.realised, 0);
  $('totals').innerHTML = `
    <div>Invested<b>${inr(inv, 0)}</b></div>
    <div>Current<b>${inr(cur, 0)}</b></div>
    <div>P&amp;L (holding)<b class="${sign(cur - inv)}">${inr(cur - inv, 0)}${inv ? ` <small>${pct((cur - inv) / inv)}</small>` : ''}</b></div>
    <div>P&amp;L (sold)<b class="${sign(realised)}">${inr(realised, 0)}</b></div>`;
}

// ---------- sidebar ----------
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const match = (h) => !q || [h.symbol, h.name, ...h.symbols].join(' ').toLowerCase().includes(q);
  const holding = DATA.holdings.filter((h) => h.qty > 0 && match(h));
  const lastOrder = (h) => (h.orders.length ? h.orders[h.orders.length - 1].date : '');
  const sold = DATA.holdings.filter((h) => h.qty <= 0 && match(h)).sort((a, b) => lastOrder(b).localeCompare(lastOrder(a)));
  const item = (h) => `<div class="item ${h.key === current ? 'on' : ''}" data-k="${esc(h.key)}">
      <div><span class="sym">${esc(h.symbol)}</span><span class="tag">${esc(h.kind)}</span></div>
      <div class="num">${inr(h.last)}</div>
      ${h.qty > 0
        ? `<small>${qtyFmt(h.qty)} qty · avg ${inr(h.avg)}</small>` +
          (h.last != null ? `<small class="num ${sign(h.pnl)}">${pct(h.pnlPct)}</small>` : '<small class="num" title="No price">—</small>')
        : `<small>Sold · ${h.orders.length} orders</small><small class="num ${sign(h.realised)}">${inr(h.realised, 0)}</small>`}
    </div>`;
  $('list').innerHTML =
    `<div class="item ov ${current === OVERVIEW ? 'on' : ''}" data-k="${OVERVIEW}"><span class="sym">Overview</span><small class="num">returns, sectors</small></div>` +
    (q ? '' : `<div class="group">Categories <button class="link" data-edit-cats>Edit</button></div>` + catList().map((n) => {
      const c = catSummary(n);
      return `<div class="item ${current === 'cat:' + n ? 'on' : ''}" data-k="cat:${esc(n)}">
        <div><span class="sym">${esc(n)}</span></div><div class="num">${inr(c.cur, 0)}</div>
        <small>${c.held.length} holding${c.held.length === 1 ? '' : 's'}</small>
        <small class="num ${sign(c.pnl)}">${c.inv ? pct(c.pnlPct) : ''}</small></div>`;
    }).join('')) +
    (holding.length ? `<div class="group">Holding (${holding.length})</div>` + holding.map(item).join('') : '') +
    (sold.length ? `<div class="group">Sold (${sold.length})</div>` + sold.map(item).join('') : '') +
    (!holding.length && !sold.length ? '<div class="group">No match</div>' : '');
}
$('list').onclick = (e) => {
  if (e.target.closest('[data-edit-cats]')) return openCats();
  const it = e.target.closest('[data-k]');
  if (it) go(it.dataset.k);
};
$('search').oninput = renderList;

// ---------- notes that explain where numbers come from ----------
function notesFor(h) {
  const n = [];
  const warn = (t) => n.push(`<div class="note">${t}</div>`);
  const info = (t) => n.push(`<div class="note info">${t}</div>`);
  const r = h.recon;
  if (r) {
    const diff = r.kiteQty - r.tradeQty;
    const on = niceDate(r.date);
    if (diff > 0 && !h.orders.length)
      info(`There are no trades for this in your tradebook. Kite's holdings file (${on}) shows ${qtyFmt(r.kiteQty)} shares. They came from outside trading, for example an IPO, a demerger, a gold bond bought from RBI, or shares moved in. Numbers below use Kite's figures.`);
    else if (diff > 0)
      info(`Kite shows ${qtyFmt(r.kiteQty)} shares on ${on}, but your trades add up to ${qtyFmt(r.tradeQty)}. The other ${qtyFmt(diff)} came from outside trading, for example an IPO, a bonus, a demerger, or shares moved in. Numbers below use Kite's figures.`);
    else if (diff < 0 && -diff < 1)
      info(`A split or bonus left ${qtyFmt(-diff)} of a share. Kite paid that part to you in cash.`);
    else if (diff < 0)
      info(`Your trades add up to ${qtyFmt(r.tradeQty)} shares on ${on}, but Kite shows ${qtyFmt(r.kiteQty)}. ${qtyFmt(-diff)} shares left without a sell, for example in a demerger, a buyback or a move to another account.`);
    if (r.costChanged)
      info(`Kite's average buy price (${inr(r.kiteAvg)}) is different from your trades (${inr(r.tradeAvg)}). This usually happens after a demerger, when Kite splits your cost between the two companies. Numbers below use Kite's.`);
  }
  if (h.missingBuys)
    warn(`You sold more shares than your tradebook shows you bought. Some shares came from outside trading (IPO, bonus, demerger, moved in). Add your Kite holdings file in Sync to fix the numbers.`);
  if (h.priceFrom === 'kite')
    info(`Yahoo Finance has no daily prices for this one, so there is no price line. The price shown is the last closing price from your Kite holdings file of ${niceDate(h.lastDate)}.`);
  else if (h.last == null)
    warn(`No daily prices found for this one. If it was renamed, add its new Yahoo name to <code>data/tickers.json</code>, for example <code>{"${esc(h.symbol)}": "NEWNAME.NS"}</code>.`);
  else if (h.priceError && h.priceError !== 'no prices') warn(esc(h.priceError));
  const others = h.symbols.filter((s) => s !== h.symbol);
  if (others.length) info(`Also traded under the old name ${others.map(esc).join(', ')}.`);
  h.splits.forEach((s) =>
    info(`Split or bonus on ${niceDate(s.date)} (${s.num} for ${s.den}). Older orders are shown in today's share count, marked "adj."`));
  return n.join('');
}

// ---------- categories (your own groups, like Gold or Stocks) ----------
const NONE = 'No category';
const AUTO_ORDER = ['Stocks', 'Gold', 'Silver', 'Liquid', 'Other ETFs'];
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const total = (list, k) => list.reduce((a, h) => a + h[k], 0);

// Until you save your own, categories are made from what each holding is (stock, gold, silver…)
function catNames() {
  if (DATA.categories) return DATA.categories.names;
  const used = new Set(DATA.holdings.map((h) => h.autoCategory));
  return AUTO_ORDER.filter((n) => used.has(n)).concat([...used].filter((n) => !AUTO_ORDER.includes(n)));
}
function catOf(h) {
  const names = catNames();
  const a = DATA.categories && DATA.categories.assign[h.key];
  if (a && names.includes(a)) return a;
  return names.includes(h.autoCategory) ? h.autoCategory : NONE;
}
function catList() {
  const names = catNames().slice();
  if (DATA.holdings.some((h) => catOf(h) === NONE)) names.push(NONE);
  return names;
}

// Yearly return of dated money flows (money in is minus), the same as the server's
function xirr(flows) {
  const f = flows.filter(([, a]) => Math.abs(a) > 0.005).map(([d, a]) => [Date.parse(d + 'T00:00:00Z'), a]);
  if (!f.some((x) => x[1] > 0) || !f.some((x) => x[1] < 0)) return null;
  const t0 = Math.min(...f.map((x) => x[0]));
  const ts = f.map(([t, a]) => [(t - t0) / 864e5 / 365, a]);
  const npv = (r) => ts.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
  let lo = -0.9999, hi = 1, fLo = npv(lo);
  while (npv(hi) > 0 && hi < 1e6) hi *= 4;
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-7; i++) {
    const m = (lo + hi) / 2, fm = npv(m);
    if ((fm > 0) === (fLo > 0)) { lo = m; fLo = fm; } else hi = m;
  }
  return (lo + hi) / 2;
}

function catSummary(name) {
  const all = DATA.holdings.filter((h) => catOf(h) === name);
  const held = all.filter((h) => h.qty > 0);
  const inv = total(held, 'invested'), cur = total(held, 'current');
  const flows = all.flatMap((h) => h.flows).concat(held.length ? [[todayIso(), cur]] : []);
  const ds = flows.filter(([, a]) => Math.abs(a) > 0.005).map(([d]) => Date.parse(d));
  const days = ds.length ? Math.round((Math.max(...ds) - Math.min(...ds)) / 864e5) : 0;
  return { name, all, held, inv, cur, pnl: cur - inv, pnlPct: inv ? (cur - inv) / inv : 0,
    booked: total(all, 'realised'), xirr: days >= 90 ? xirr(flows) : null, xirrDays: days };
}

const catTable = (rows) => `<div class="table-wrap"><table class="trades">
  <thead><tr><th>Category</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">P&amp;L booked</th><th class="num">Yearly return</th></tr></thead>
  <tbody>${rows.map((c) => `<tr data-k="cat:${esc(c.name)}">
    <td><b>${esc(c.name)}</b><small>${c.held.length} holding${c.held.length === 1 ? '' : 's'}</small></td>
    <td class="num">${inr(c.inv, 0)}</td><td class="num">${inr(c.cur, 0)}</td>
    <td class="num ${sign(c.pnl)}">${inr(c.pnl, 0)}${c.inv ? `<small>${pct(c.pnlPct)}</small>` : ''}</td>
    <td class="num ${sign(c.booked)}">${inr(c.booked, 0)}</td>
    <td class="num">${xirrText(c)}</td></tr>`).join('')}</tbody></table></div>`;

// Invested and current value side by side for each category (both in ₹, one axis)
function drawCatBars(rows) {
  rows = rows.filter((c) => c.held.length);
  const el = $('chart');
  if (!rows.length) { el.innerHTML = '<div class="empty">Nothing held right now.</div>'; return; }
  const c = newChart(el);
  if (!c) return;
  const muted = css('--muted'), grid = css('--line');
  c.setOption({
    animation: false,
    grid: { left: 80, right: 18, top: 36, bottom: 30 },
    legend: { top: 6, right: 10, textStyle: { color: muted }, itemWidth: 12, itemHeight: 10 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(),
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return `<b>${esc(r.name)}</b><br/>Invested: ${inr(r.inv, 0)}<br/>Current value: ${inr(r.cur, 0)}<br/>` +
          `P&amp;L: <span style="color:${css(r.pnl >= 0 ? '--up' : '--down')}">${inr(r.pnl, 0)} (${pct(r.pnlPct)})</span>`;
      } },
    xAxis: { type: 'category', data: rows.map((r) => r.name), axisLine: { lineStyle: { color: grid } }, axisLabel: { color: css('--text') }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: muted, formatter: (v) => '₹' + compact(v) }, splitLine: { lineStyle: { color: grid } } },
    series: [
      { name: 'Invested', type: 'bar', data: rows.map((r) => r.inv), itemStyle: { color: css('--bar-2'), borderRadius: [4, 4, 0, 0] }, barGap: '8%', barMaxWidth: 46 },
      { name: 'Current value', type: 'bar', data: rows.map((r) => r.cur), itemStyle: { color: css('--accent'), borderRadius: [4, 4, 0, 0] }, barMaxWidth: 46,
        label: { show: true, position: 'top', color: muted, fontSize: 11, formatter: (p) => (rows[p.dataIndex].inv ? pct(rows[p.dataIndex].pnlPct) : '') } },
    ],
  });
  c.on('click', (p) => go('cat:' + rows[p.dataIndex].name));
}
const compact = (v) => (Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(1) + ' Cr' : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + ' L' : v.toLocaleString('en-IN'));

// Day by day: money in the holdings of this category, and what they were worth
function catSeries(hs) {
  const dates = new Set();
  hs.forEach((h) => { h.prices.forEach((p) => dates.add(p[0])); h.steps.forEach((s) => dates.add(s[0])); });
  const starts = hs.filter((h) => h.steps.length).map((h) => h.steps[0][0]).sort();
  const D = [...dates].filter((d) => starts.length && d >= starts[0]).sort();
  const at = hs.map(() => ({ s: -1, p: -1 }));
  const out = [];
  for (const d of D) {
    let inv = 0, val = 0;
    hs.forEach((h, i) => {
      const k = at[i];
      while (k.s + 1 < h.steps.length && h.steps[k.s + 1][0] <= d) k.s++;
      while (k.p + 1 < h.prices.length && h.prices[k.p + 1][0] <= d) k.p++;
      if (k.s < 0) return;
      const [, q, c] = h.steps[k.s];
      inv += c;
      val += k.p >= 0 ? q * h.prices[k.p][1] : c; // no price yet: count it at cost
    });
    out.push([d, inv, val]);
  }
  // End on today's numbers, so the chart matches the tiles above it
  const now = [todayIso(), total(hs.filter((h) => h.qty > 0), 'invested'), total(hs.filter((h) => h.qty > 0), 'current')];
  if (out.length && out[out.length - 1][0] >= now[0]) out[out.length - 1] = now;
  else if (hs.some((h) => h.qty > 0)) out.push(now);
  return out;
}

function showCategory(name) {
  selected = null;
  dropChart();
  const c = catSummary(name);
  const all = DATA.holdings.filter((h) => h.qty > 0).reduce((a, h) => a + h.current, 0);
  const stats = [
    ['Invested now', inr(c.inv, 0)],
    ['Current value', inr(c.cur, 0)],
    ['P&amp;L on what you hold', `<span class="${sign(c.pnl)}">${inr(c.pnl, 0)}${c.inv ? ` (${pct(c.pnlPct)})` : ''}</span>`],
    ['P&amp;L booked on sales', `<span class="${sign(c.booked)}">${inr(c.booked, 0)}</span>`],
    ['Yearly return (XIRR)', xirrText(c)],
    ['Share of your portfolio', all ? (c.cur / all * 100).toFixed(1) + '%' : '—'],
  ];
  const rows = c.held.slice().sort((a, b) => b.current - a.current).concat(c.all.filter((h) => h.qty <= 0));
  $('main').innerHTML = `
    <div class="head"><div><h1>${esc(name)}</h1><div class="sub">Category · ${c.held.length} holding${c.held.length === 1 ? '' : 's'}${c.all.length > c.held.length ? ` · ${c.all.length - c.held.length} sold` : ''} · <button class="link" data-edit-cats>Edit categories</button></div></div></div>
    <div class="stats">${stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    ${c.all.some((h) => Math.abs(h.outsideCost) > 0.005) ? `<div class="notes"><div class="note info">Some shares here were not trades (IPO, gold bond from RBI, demerger, moved in). They join the chart below on the holdings file date, ${niceDate(DATA.holdingsDate)}.</div></div>` : ''}
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><b>Value over time</b><div class="legend"><span><i style="background:var(--accent)"></i>Current value</span><span><i style="background:var(--bar-2)"></i>Invested</span></div></div>
      <div id="chart"></div>
    </div>
    <div class="card"><div class="card-head"><b>Holdings in ${esc(name)}</b><span class="muted">click one to open it</span></div>
      <div class="table-wrap"><table class="trades">
        <thead><tr><th>Name</th><th class="num">Qty</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">P&amp;L booked</th></tr></thead>
        <tbody>${rows.map((h) => `<tr data-k="${esc(h.key)}">
          <td><b>${esc(h.symbol)}</b><small>${esc(h.kind)}</small></td>
          <td class="num">${h.qty > 0 ? qtyFmt(h.qty) : 'sold'}</td>
          <td class="num">${h.qty > 0 ? inr(h.invested, 0) : '—'}</td>
          <td class="num">${h.qty > 0 ? inr(h.current, 0) : '—'}</td>
          <td class="num ${sign(h.pnl)}">${h.qty > 0 ? `${inr(h.pnl, 0)}<small>${pct(h.pnlPct)}</small>` : '—'}</td>
          <td class="num ${sign(h.realised)}">${inr(h.realised, 0)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing in this category yet. Open a holding and pick this category at the top.</td></tr>'}</tbody>
      </table></div></div>`;
  wireMain();
  const series = catSeries(c.all);
  const el = $('chart');
  if (!series.length) { el.innerHTML = '<div class="empty">No history to draw yet.</div>'; return; }
  const ch = newChart(el);
  if (!ch) return;
  const muted = css('--muted'), grid = css('--line'), line = css('--accent'), inv = css('--bar-2');
  ch.setOption({
    animation: false,
    grid: { left: 80, right: 18, top: 16, bottom: 62 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } }, ...tipStyle(),
      formatter: (ps) => {
        const [d, i, v] = series[ps[0].dataIndex];
        return `<b>${niceDate(d)}</b><br/>Current value: ${inr(v, 0)}<br/>Invested: ${inr(i, 0)}<br/>` +
          `P&amp;L: <span style="color:${css(v - i >= 0 ? '--up' : '--down')}">${inr(v - i, 0)}${i ? ` (${pct((v - i) / i)})` : ''}</span>`;
      } },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: muted, formatter: (v) => '₹' + compact(v) }, splitLine: { lineStyle: { color: grid } } },
    dataZoom: [
      { type: 'inside', filterMode: 'none' },
      { type: 'slider', filterMode: 'none', height: 22, bottom: 14, borderColor: grid, textStyle: { color: muted },
        fillerColor: 'rgba(59,130,246,.12)', dataBackground: { lineStyle: { color: muted }, areaStyle: { color: grid } } },
    ],
    series: [
      { name: 'Invested', type: 'line', step: 'end', showSymbol: false, data: series.map((r) => [r[0], r[1]]), lineStyle: { width: 2, color: inv, type: 'dashed' }, itemStyle: { color: inv } },
      { name: 'Current value', type: 'line', showSymbol: false, data: series.map((r) => [r[0], r[2]]), lineStyle: { width: 2, color: line }, itemStyle: { color: line },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: line + '30' }, { offset: 1, color: line + '00' }]) } },
    ],
  });
}

// ---------- edit categories ----------
// A full copy of today's categories, with every holding's category written out
function catDraft() {
  const assign = {};
  DATA.holdings.forEach((h) => { const c = catOf(h); if (c !== NONE) assign[h.key] = c; });
  return { names: catNames().slice(), assign };
}
async function saveCats(d) {
  const r = await postJson('/api/categories', d);
  if (r.error) return alertNote(r.error);
  DATA.categories = r;
  if (isCat(current) && !catList().includes(current.slice(4))) current = OVERVIEW; // renamed or deleted
  renderList();
  show(current);
}
const alertNote = (msg) => { const n = document.createElement('div'); n.className = 'note'; n.textContent = msg; $('main').prepend(n); };

let draft = null;
function openCats(focusKey) {
  draft = catDraft();
  $('cats').hidden = false;
  renderCats(focusKey);
  const row = document.querySelector('.cat-row.focus');
  if (row) row.scrollIntoView({ block: 'center' });
  setTimeout(() => $('cat-new').focus(), 0);
}
function renderCats(focusKey) {
  const held = DATA.holdings.filter((h) => h.qty > 0);
  const sold = DATA.holdings.filter((h) => h.qty <= 0);
  const opts = (h) => draft.names.map((n) => `<option ${draft.assign[h.key] === n ? 'selected' : ''}>${esc(n)}</option>`).join('') +
    (!draft.names.includes(draft.assign[h.key]) ? `<option selected value="">${NONE}</option>` : '');
  const row = (h) => `<div class="cat-row ${h.key === focusKey ? 'focus' : ''}"><span><b>${esc(h.symbol)}</b> <small class="muted">${h.qty > 0 ? inr(h.current, 0) : 'sold'}</small></span>
    <select data-h="${esc(h.key)}">${opts(h)}</select></div>`;
  $('cat-names').innerHTML = draft.names.map((n, i) => `<div class="cat-name">
      <input value="${esc(n)}" data-i="${i}" aria-label="Category name" />
      <span class="muted">${Object.values(draft.assign).filter((v) => v === n).length}</span>
      <button class="link danger" data-del="${i}" title="Delete this category. Its holdings go back to no category.">Delete</button></div>`).join('') ||
    '<div class="muted">No categories yet. Add one below.</div>';
  $('cat-holdings').innerHTML = held.map(row).join('') + (sold.length ? `<div class="group">Sold</div>` + sold.map(row).join('') : '');
}
$('cats').addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) return ($('cats').hidden = true);
  const del = e.target.closest('[data-del]');
  if (del) {
    const name = draft.names[+del.dataset.del];
    draft.names.splice(+del.dataset.del, 1);
    Object.keys(draft.assign).forEach((k) => { if (draft.assign[k] === name) delete draft.assign[k]; });
    renderCats();
  }
});
$('cats').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.h) {
    if (t.value) draft.assign[t.dataset.h] = t.value; else delete draft.assign[t.dataset.h];
    renderCats();
  } else if (t.dataset.i != null) { // rename: the holdings move with it
    const old = draft.names[+t.dataset.i], name = t.value.trim();
    if (!name || draft.names.includes(name)) { t.value = old; return; }
    draft.names[+t.dataset.i] = name;
    Object.keys(draft.assign).forEach((k) => { if (draft.assign[k] === old) draft.assign[k] = name; });
    renderCats();
  }
});
function addCat() {
  const name = $('cat-new').value.trim();
  if (name && !draft.names.includes(name)) draft.names.push(name);
  $('cat-new').value = '';
  renderCats();
  $('cat-new').focus();
}
$('cat-add').onclick = addCat;
$('cat-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCat(); });
$('cat-save').onclick = async () => {
  $('cats').hidden = true;
  await saveCats(draft);
};
$('cat-reset').onclick = async () => {
  $('cats').hidden = true;
  const used = new Set(DATA.holdings.map((h) => h.autoCategory));
  await saveCats({ names: AUTO_ORDER.filter((n) => used.has(n)).concat([...used].filter((n) => !AUTO_ORDER.includes(n))), assign: {} });
};

// ---------- overview ----------
const xirrText = (o) => o.xirr == null
  ? `— <small class="muted">${o.xirrDays < 90 ? 'needs 3 months' : 'can’t work out'}</small>`
  : `<span class="${sign(o.xirr)}">${pct(o.xirr)}</span>`;

// A labelled horizontal bar per group: one colour, the size of the bar is the share
const bars = (rows) => rows.length
  ? rows.map((r) => `<div class="bar" title="${esc(r.name)}: ${inr(r.value, 0)} (${(r.share * 100).toFixed(1)}%)">
      <span class="bar-name">${esc(r.name)}</span>
      <span class="bar-track"><i style="width:${Math.max(r.share * 100, 0.6).toFixed(2)}%"></i></span>
      <span class="num">${(r.share * 100).toFixed(1)}%</span>
      <span class="num muted">${inr(r.value, 0)}</span></div>`).join('')
  : '<div class="muted">Nothing to show yet.</div>';

function showOverview() {
  selected = null;
  dropChart();
  const I = DATA.insights;
  const H = DATA.holdings.filter((h) => h.qty > 0);
  const inv = H.reduce((a, h) => a + h.invested, 0);
  const cur = H.reduce((a, h) => a + h.current, 0);
  const months = Math.round(I.xirrDays / 30.4);
  const N = I.nifty;
  const stats = [
    ['Invested now', inr(inv, 0)],
    ['Current value', inr(cur, 0)],
    ['P&amp;L on what you hold', `<span class="${sign(cur - inv)}">${inr(cur - inv, 0)}${inv ? ` (${pct((cur - inv) / inv)})` : ''}</span>`],
    ['P&amp;L booked on sales', `<span class="${sign(I.booked)}">${inr(I.booked, 0)}</span>`],
    ['Your yearly return (XIRR)', xirrText(I)],
    ['Same money in Nifty 50', N.xirr == null ? (N.error ? '— <small class="muted">no Nifty prices</small>' : '—')
      : `<span class="${sign(N.xirr)}">${pct(N.xirr)}</span> <small class="muted">${inr(N.value, 0)}</small>`],
  ];
  const notes = [];
  notes.push(`<div class="note info"><b>Yearly return (XIRR)</b> is your profit or loss as a yearly rate. It counts when each rupee went in or came out, over ${months} months of trades, with today's value as if you sold everything today. <b>Nifty 50</b> shows what the same money, put in and taken out on the same days, would give in the Nifty 50 index.</div>`);
  if (I.outside)
    notes.push(`<div class="note info">${I.outside} of your holdings have shares that were not trades (IPO, gold bond from RBI, demerger, shares moved in). For the yearly return they count as bought on the holdings file date (${niceDate(DATA.holdingsDate)}) at Kite's average price.</div>`);
  if (!DATA.holdingsDate)
    notes.push(`<div class="note">Sectors come from your Kite holdings file. Add it in Sync to see them.</div>`);

  const priced = H.filter((h) => h.last != null && h.invested > 0).sort((a, b) => b.pnlPct - a.pnlPct);
  const best = priced.filter((h) => h.pnl > 0).slice(0, 5);
  const worst = priced.filter((h) => h.pnl < 0).reverse().slice(0, 5);
  const mover = (h) => `<div class="mover" data-k="${esc(h.key)}"><span class="sym">${esc(h.symbol)}</span>
      <span class="num ${sign(h.pnl)}">${pct(h.pnlPct)}</span><span class="num muted">${inr(h.pnl, 0)}</span></div>`;
  const years = I.bookedByYear.length
    ? I.bookedByYear.map((y) => `<div class="mover"><span>FY ${esc(y.year)}</span><span class="num ${sign(y.value)}">${inr(y.value, 0)}</span><span></span></div>`).join('')
    : '<div class="muted">You have not sold anything yet.</div>';

  $('main').innerHTML = `
    <div class="head"><div><h1>Overview</h1><div class="sub">${H.length} holdings · ${DATA.tradeCount} trades saved</div></div></div>
    <div class="stats">${stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <div class="notes">${notes.join('')}</div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><b>By category</b><span><span class="muted">your own groups · </span><button class="link" data-edit-cats>Edit categories</button></span></div>
      <div id="chart" class="chart-sm"></div>
      ${catTable(catList().map(catSummary))}
    </div>
    <div class="grid2">
      <div class="card"><div class="card-head"><b>Stocks by sector</b><span class="muted">only stocks, not ETFs</span></div><div class="pad">${bars(I.sectors)}</div></div>
      <div class="card"><div class="card-head"><b>Doing best</b><span class="muted">P&amp;L on what you hold</span></div><div class="pad movers">${best.map(mover).join('') || '<div class="muted">None in profit.</div>'}</div></div>
      <div class="card"><div class="card-head"><b>Doing worst</b><span class="muted">P&amp;L on what you hold</span></div><div class="pad movers">${worst.map(mover).join('') || '<div class="muted">None in loss.</div>'}</div></div>
      <div class="card"><div class="card-head"><b>P&amp;L booked by year</b><span class="muted">financial year, April to March</span></div><div class="pad movers">${years}</div></div>
    </div>`;
  wireMain();
  drawCatBars(catList().map(catSummary));
}

// Clicks inside the page: open a stock or category, or edit categories
function wireMain() {
  $('main').onclick = (e) => {
    if (e.target.closest('[data-edit-cats]')) return openCats();
    const el = e.target.closest('.mover[data-k], tr[data-k]');
    if (el) go(el.dataset.k);
  };
}

// ---------- one stock ----------
function showStock(key) {
  const h = byKey(key);
  selected = null;
  const main = $('main');
  main.innerHTML = '';
  main.appendChild($('stock-view').content.cloneNode(true));
  const f = (k) => main.querySelector(`[data-f="${k}"]`);
  f('symbol').textContent = h.symbol;
  f('name').textContent = [h.name !== h.symbol ? h.name : '', h.kind, h.sector && h.sector !== h.kind.toUpperCase() ? h.sector : '']
    .filter(Boolean).join(' · ');
  const pickCat = f('cat');
  pickCat.innerHTML = catNames().map((n) => `<option ${catOf(h) === n ? 'selected' : ''}>${esc(n)}</option>`).join('') +
    (catOf(h) === NONE ? `<option selected disabled>${NONE}</option>` : '') + '<option value="__new">+ New category…</option>';
  pickCat.onchange = () => {
    if (pickCat.value === '__new') {
      pickCat.value = catOf(h) === NONE ? NONE : catOf(h);
      return openCats(h.key);
    }
    const d = catDraft();
    d.assign[h.key] = pickCat.value;
    saveCats(d);
  };
  f('last').textContent = inr(h.last);
  f('chg').innerHTML = h.last == null ? '<small>No price</small>'
    : h.priceFrom === 'yahoo'
      ? `<span class="${sign(h.dayChange)}">${pct(h.dayChange)}</span> <small>on ${niceDate(h.lastDate)}</small>`
      : `<small>from Kite holdings file, ${niceDate(h.lastDate)}</small>`;

  const stats = h.qty > 0
    ? [
        ['Quantity', qtyFmt(h.qty)],
        ['Avg. buy price', inr(h.avg)],
        ['Invested', inr(h.invested, 0)],
        ['Current value', h.last == null ? '—' : inr(h.current, 0)],
        ['P&amp;L', h.last == null ? '—' : `<span class="${sign(h.pnl)}">${inr(h.pnl, 0)} (${pct(h.pnlPct)})</span>`],
        ['P&amp;L on sold shares', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`],
        ['Yearly return (XIRR)', xirrText(h)],
      ]
    : [
        ['Quantity', '0 (all sold)'],
        ['P&amp;L on sold shares', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`],
        ['Yearly return (XIRR)', xirrText(h)],
        ['Orders', h.orders.length],
      ];
  f('stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');
  f('notes').innerHTML = notesFor(h);
  f('count').textContent = h.orders.length + (h.orders.length === 1 ? ' order' : ' orders');

  $('table').querySelector('tbody').innerHTML = h.orders.length
    ? h.orders.slice().reverse().map((o) => `
      <tr data-id="${esc(o.id)}" title="Order ${esc(o.orderId)} · ${esc(o.exchange)}${o.time ? ' · ' + esc(o.time) : ''}">
        <td>${niceDate(o.date)}${o.fills > 1 ? `<small>${o.fills} parts</small>` : ''}${o.symbol !== h.symbol ? `<small>as ${esc(o.symbol)}</small>` : ''}</td>
        <td><span class="pill ${o.type.toLowerCase()}">${o.type}</span></td>
        <td class="num">${qtyFmt(o.qty)}${o.adjusted ? '<small>adj.</small>' : ''}</td>
        <td class="num">${inr(o.price)}</td>
        <td class="num">${inr(o.qty * o.price, 0)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No trades for this in your tradebook.</td></tr>';
  $('table').onclick = (e) => {
    const row = e.target.closest('[data-id]');
    if (row) pick(row.dataset.id, false);
  };
  drawChart(h);
}

// Highlight one order in both the chart and the table
function pick(id, fromChart) {
  selected = id;
  if (chart) chart.setOption({ series: chartSeries(byKey(current)) });
  const box = document.querySelector('.table-wrap');
  document.querySelectorAll('#table tr[data-id]').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
  const row = document.querySelector(`#table tr[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const headH = box.querySelector('thead').offsetHeight;
  if (row.offsetTop - headH < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 3, behavior: 'smooth' });
  if (fromChart) {
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }
}

// ---------- chart ----------
function chartSeries(h) {
  const maxQty = Math.max(1, ...h.orders.map((o) => o.qty));
  const size = (q) => 9 + 26 * Math.sqrt(q / maxQty);
  const ring = css('--text');
  const dots = (type) => h.orders.filter((o) => o.type === type).map((o) => ({
    value: [o.date, o.price],
    id: o.id,
    symbolSize: size(o.qty) * (o.id === selected ? 1.25 : 1),
    itemStyle: o.id === selected ? { borderColor: ring, borderWidth: 3, opacity: 1 } : undefined,
    z: o.id === selected ? 10 : 2,
  }));
  const line = css('--accent');
  const card = css('--card');
  return [
    {
      name: 'Price', type: 'line', showSymbol: false, data: h.prices, z: 1,
      lineStyle: { width: 1.6, color: line }, itemStyle: { color: line },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: line + '30' }, { offset: 1, color: line + '00' }]) },
    },
    { name: 'Buy', type: 'scatter', data: dots('BUY'), cursor: 'pointer', itemStyle: { color: css('--up'), opacity: 0.82, borderColor: card, borderWidth: 1.5 } },
    { name: 'Sell', type: 'scatter', data: dots('SELL'), cursor: 'pointer', itemStyle: { color: css('--down'), opacity: 0.82, borderColor: card, borderWidth: 1.5 } },
  ];
}

function dropChart() {
  if (chart) chart.dispose();
  chart = null;
  resizer.disconnect();
}
function newChart(el) {
  dropChart();
  if (!window.echarts) {
    el.innerHTML = '<div class="empty">The chart library could not load. Check your internet connection.</div>';
    return null;
  }
  chart = echarts.init(el);
  resizer.observe(el);
  return chart;
}
const tipStyle = () => ({ backgroundColor: css('--card'), borderColor: css('--line'), textStyle: { color: css('--text'), fontSize: 12 } });

function drawChart(h) {
  dropChart();
  const el = $('chart');
  if (!window.echarts) {
    el.innerHTML = '<div class="empty">The chart library could not load. Check your internet connection.</div>';
    return;
  }
  if (!h.prices.length && !h.orders.length) {
    el.innerHTML = '<div class="empty">No price history or trades to draw for this one.</div>';
    return;
  }
  chart = echarts.init(el);
  const muted = css('--muted');
  const grid = css('--line');
  const DAY = 864e5;
  chart.setOption({
    animation: false,
    grid: { left: 70, right: 18, top: 16, bottom: 62 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
      backgroundColor: css('--card'), borderColor: grid, textStyle: { color: css('--text'), fontSize: 12 },
      formatter: (ps) => {
        const d = ps[0].value[0];
        const price = ps.find((p) => p.seriesName === 'Price');
        let html = `<b>${niceDate(d)}</b>` + (price ? `<br/>Close: ${inr(price.value[1])}` : '');
        const ms = new Date(d).getTime();
        h.orders.filter((o) => Math.abs(new Date(o.date).getTime() - ms) <= 2 * DAY).forEach((o) => {
          const c = o.type === 'BUY' ? css('--up') : css('--down');
          html += `<br/><span style="color:${c}">●</span> ${o.type} ${qtyFmt(o.qty)} @ ${inr(o.price)}${o.date !== d ? ` <span style="opacity:.6">(${niceDate(o.date)})</span>` : ''}`;
        });
        return html;
      },
    },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: muted, formatter: (v) => '₹' + v.toLocaleString('en-IN') }, splitLine: { lineStyle: { color: grid } } },
    dataZoom: [
      { type: 'inside', filterMode: 'none' },
      { type: 'slider', filterMode: 'none', height: 22, bottom: 14, borderColor: grid, textStyle: { color: muted },
        fillerColor: 'rgba(59,130,246,.12)', dataBackground: { lineStyle: { color: muted }, areaStyle: { color: grid } } },
    ],
    series: chartSeries(h),
  });
  chart.on('click', (p) => {
    if (p.seriesName === 'Buy' || p.seriesName === 'Sell') pick(p.data.id, true);
  });
  resizer.disconnect(); // only ever watch the chart on screen
  resizer.observe(el);
}
const resizer = new ResizeObserver(() => chart && !chart.isDisposed() && chart.resize());

// ---------- sync ----------
let pending = null;
function openSync() {
  pending = null;
  $('result').hidden = true;
  $('file').value = '';
  $('sync-range').innerHTML = DATA && DATA.lastTradeDate
    ? `Your saved trades go up to <b>${niceDate(DATA.lastTradeDate)}</b>. Pick dates from that day to today.`
    : `First time: pick <b>prev. FY</b>, then <b>current FY</b>, and older years too. Download one file each.`;
  $('sync').hidden = false;
}
window.openSync = openSync;
$('sync-btn').onclick = openSync;
$('sync').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) $('sync').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('sync').hidden = $('cats').hidden = true; });

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles(e.dataTransfer.files); });
$('file').onchange = (e) => readFiles(e.target.files);

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readFiles(list) {
  const files = await Promise.all([...list].map(async (f) =>
    /\.xlsx$/i.test(f.name) ? { name: f.name, b64: toBase64(await f.arrayBuffer()) } : { name: f.name, text: await f.text() }));
  if (!files.length) return;
  pending = files;
  showResult('<div class="muted">Checking…</div>');
  const r = await post('/api/sync/preview', files);
  if (r.error) return showResult(`<div class="err">${esc(r.error)}</div>`);
  const lines = r.files.map((f) => f.error
    ? `<div class="file err">${esc(f.name)}: ${esc(f.error)}</div>`
    : f.kind === 'holdings'
      ? `<div class="file"><b>${esc(f.name)}</b> · holdings file from ${niceDate(f.date)} · ${f.rows} holdings</div>`
      : `<div class="file"><b>${esc(f.name)}</b> · ${f.rows} equity trades</div>`).join('');
  const range = r.new ? `<div class="muted">New trades from ${niceDate(r.from)} to ${niceDate(r.to)} · ${r.symbols.length} stocks/ETFs</div>` : '';
  const hold = r.holdings
    ? (r.holdings.older
      ? `<div class="muted">This holdings file is older than the one already saved, so it will not replace it.</div>`
      : `<div class="muted">The holdings file will be saved. It fills in shares that never were trades.</div>`)
    : '';
  const saveHold = r.holdings && !r.holdings.older;
  const label = r.new ? `Add ${r.new} trades${saveHold ? ' and save holdings' : ''}` : saveHold ? 'Save holdings' : '';
  showResult(`${lines}
    <div class="chips"><span class="chip new">${r.new} new trades</span><span class="chip">${r.already} already saved</span>${r.repeated ? `<span class="chip">${r.repeated} in more than one file, added once</span>` : ''}${r.skipped ? `<span class="chip">${r.skipped} not equity, skipped</span>` : ''}</div>
    ${range}${hold}
    ${label ? `<button class="btn primary" id="commit" style="justify-self:start">${label}</button>` : '<div class="muted">Nothing new to add.</div>'}`);
  if (label) $('commit').onclick = commit;
}

async function commit() {
  $('commit').disabled = true;
  $('commit').textContent = 'Saving…';
  const r = await post('/api/sync/commit', pending);
  if (r.error) return showResult(`<div class="err">${esc(r.error)}</div>`);
  $('sync').hidden = true;
  await load();
}

function showResult(html) {
  $('result').innerHTML = html;
  $('result').hidden = false;
}

const post = (url, files) => postJson(url, { files });
async function postJson(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

load();
