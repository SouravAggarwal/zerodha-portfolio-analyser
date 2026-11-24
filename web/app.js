// Portfolio page: sidebar list, one stock at a time with price chart + orders table, and Sync.
const $ = (id) => document.getElementById(id);
const inr = (n, d = 2) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n) => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const sign = (n) => (n >= 0 ? 'up' : 'down');
const qtyFmt = (q) => Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const niceDate = (iso) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let DATA = null;
let current = null;
let chart = null;
let selected = null;

// ---------- theme ----------
function paintThemeButton() {
  $('theme').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
}
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  paintThemeButton();
  if (current) showStock(current); // redraw chart in the new colours
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
    $('main').innerHTML = `<div class="empty"><div><h2>Could not load</h2>${esc(e.message)}</div></div>`;
    $('loading').hidden = true;
    return;
  }
  $('loading').hidden = true;
  $('synced').textContent = DATA.lastSynced ? 'Last synced: ' + niceDate(DATA.lastSynced) : 'Not synced yet';
  renderTotals();
  if (!DATA.holdings.length) return renderEmpty();
  if (!current || !DATA.holdings.find((h) => h.symbol === current)) current = DATA.holdings[0].symbol;
  renderList();
  showStock(current);
}

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
  const match = (h) => !q || (h.symbol + ' ' + h.name).toLowerCase().includes(q);
  const holding = DATA.holdings.filter((h) => h.qty > 0 && match(h));
  const sold = DATA.holdings.filter((h) => h.qty <= 0 && match(h));
  const item = (h) => `<div class="item ${h.symbol === current ? 'on' : ''}" data-s="${esc(h.symbol)}">
      <div><span class="sym">${esc(h.symbol)}</span><span class="tag">${h.kind}</span></div>
      <div class="num">${inr(h.last)}</div>
      ${h.qty > 0
        ? `<small>${qtyFmt(h.qty)} qty · avg ${inr(h.avg)}</small>` +
          (h.prices.length ? `<small class="num ${sign(h.pnl)}">${pct(h.pnlPct)}</small>` : '<small class="num" title="No price data">—</small>')
        : `<small>Sold · ${h.orders.length} orders</small><small class="num ${sign(h.realised)}">${inr(h.realised, 0)}</small>`}
    </div>`;
  $('list').innerHTML =
    (holding.length ? `<div class="group">Holding (${holding.length})</div>` + holding.map(item).join('') : '') +
    (sold.length ? `<div class="group">Sold (${sold.length})</div>` + sold.map(item).join('') : '') +
    (!holding.length && !sold.length ? '<div class="group">No match</div>' : '');
}
$('list').onclick = (e) => {
  const it = e.target.closest('[data-s]');
  if (!it) return;
  current = it.dataset.s;
  renderList();
  showStock(current);
};
$('search').oninput = renderList;

// ---------- one stock ----------
function showStock(symbol) {
  const h = DATA.holdings.find((x) => x.symbol === symbol);
  selected = null;
  const main = $('main');
  main.innerHTML = '';
  main.appendChild($('stock-view').content.cloneNode(true));
  const f = (k) => main.querySelector(`[data-f="${k}"]`);
  f('symbol').textContent = h.symbol;
  f('name').textContent = h.name + ' · ' + h.kind;
  f('last').textContent = inr(h.last);
  f('chg').innerHTML = `<span class="${sign(h.dayChange)}">${pct(h.dayChange)}</span> <small>on ${niceDate(h.lastDate)}</small>`;

  const stats = h.qty > 0
    ? [
        ['Quantity', qtyFmt(h.qty)],
        ['Avg. buy price', inr(h.avg)],
        ['Invested', inr(h.invested, 0)],
        ['Current value', inr(h.current, 0)],
        ['P&amp;L', `<span class="${sign(h.pnl)}">${inr(h.pnl, 0)} (${pct(h.pnlPct)})</span>`],
        ['P&amp;L on sold shares', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`],
      ]
    : [
        ['Quantity', '0 (all sold)'],
        ['P&amp;L on sold shares', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`],
        ['Orders', h.orders.length],
      ];
  f('stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');

  const notes = [];
  if (h.missingBuys)
    notes.push(`<div class="note">You sold more shares than the tradebook shows you bought. Some buys are missing (for example IPO shares, gifts, or shares moved from another broker), so the numbers here may be off.</div>`);
  if (h.priceError) notes.push(`<div class="note">${esc(h.priceError)}</div>`);
  h.splits.forEach((s) =>
    notes.push(`<div class="note info">Split or bonus on ${niceDate(s.date)} (${s.num} for ${s.den}). Older orders are shown in today's share count.</div>`));
  f('notes').innerHTML = notes.join('');
  f('count').textContent = h.orders.length + ' orders';

  $('table').querySelector('tbody').innerHTML = h.orders.slice().reverse().map((o) => `
    <tr data-id="${esc(o.id)}" title="Order ${esc(o.orderId)} · ${esc(o.exchange)}${o.time ? ' · ' + o.time : ''}">
      <td>${niceDate(o.date)}${o.fills > 1 ? `<small>${o.fills} parts</small>` : ''}</td>
      <td><span class="pill ${o.type.toLowerCase()}">${o.type}</span></td>
      <td class="num">${qtyFmt(o.qty)}${o.adjusted ? '<small>adj.</small>' : ''}</td>
      <td class="num">${inr(o.price)}</td>
      <td class="num">${inr(o.qty * o.price, 0)}</td>
    </tr>`).join('');
  $('table').onclick = (e) => {
    const row = e.target.closest('[data-id]');
    if (row) pick(row.dataset.id, false);
  };
  drawChart(h);
}

// Highlight one order in both the chart and the table
function pick(id, fromChart) {
  selected = id;
  chart.setOption({ series: chartSeries(DATA.holdings.find((x) => x.symbol === current)) });
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

function drawChart(h) {
  if (chart) chart.dispose();
  const el = $('chart');
  chart = echarts.init(el);
  const muted = css('--muted');
  const grid = css('--line');
  chart.setOption({
    animation: false,
    grid: { left: 64, right: 18, top: 16, bottom: 62 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
      backgroundColor: css('--card'), borderColor: grid, textStyle: { color: css('--text'), fontSize: 12 },
      formatter: (ps) => {
        const d = ps[0].value[0];
        const price = ps.find((p) => p.seriesName === 'Price');
        let html = `<b>${niceDate(d)}</b><br/>Close: ${price ? inr(price.value[1]) : '-'}`;
        const ms = new Date(d).getTime();
        h.orders.filter((o) => Math.abs(new Date(o.date).getTime() - ms) <= 2 * 864e5).forEach((o) => {
          const c = o.type === 'BUY' ? css('--up') : css('--down');
          html += `<br/><span style="color:${c}">●</span> ${o.type} ${qtyFmt(o.qty)} @ ${inr(o.price)}${o.date !== d ? ` <span style="opacity:.6">(${niceDate(o.date)})</span>` : ''}`;
        });
        return html;
      },
    },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: muted, formatter: (v) => '₹' + v.toLocaleString('en-IN') }, splitLine: { lineStyle: { color: grid } } },
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', height: 22, bottom: 14, borderColor: grid, textStyle: { color: muted },
        fillerColor: 'rgba(59,130,246,.12)', dataBackground: { lineStyle: { color: muted }, areaStyle: { color: grid } } },
    ],
    series: chartSeries(h),
  });
  chart.on('click', (p) => {
    if (p.seriesName === 'Buy' || p.seriesName === 'Sell') pick(p.data.id, true);
  });
  new ResizeObserver(() => !chart.isDisposed() && chart.resize()).observe(el);
}

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('sync').hidden = true; });

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles(e.dataTransfer.files); });
$('file').onchange = (e) => readFiles(e.target.files);

async function readFiles(list) {
  const files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
  if (!files.length) return;
  pending = files;
  showResult('Checking…');
  const r = await post('/api/sync/preview', files);
  if (r.error) return showResult(`<div class="err">${esc(r.error)}</div>`);
  const lines = r.files.map((f) => f.error
    ? `<div class="file err">${esc(f.name)}: ${esc(f.error)}</div>`
    : `<div class="file"><b>${esc(f.name)}</b> · ${f.rows} equity trades</div>`).join('');
  const range = r.new ? `<div class="muted">New trades from ${niceDate(r.from)} to ${niceDate(r.to)} · ${r.symbols.length} stocks/ETFs</div>` : '';
  showResult(`${lines}
    <div class="chips"><span class="chip new">${r.new} new</span><span class="chip">${r.already} already saved</span>${r.skipped ? `<span class="chip">${r.skipped} not equity, skipped</span>` : ''}</div>
    ${range}
    ${r.new ? `<button class="btn primary" id="commit" style="justify-self:start">Add ${r.new} trades</button>` : '<div class="muted">Nothing new to add.</div>'}`);
  if (r.new) $('commit').onclick = commit;
}

async function commit() {
  $('commit').disabled = true;
  $('commit').textContent = 'Adding…';
  const r = await post('/api/sync/commit', pending);
  if (r.error) return showResult(`<div class="err">${esc(r.error)}</div>`);
  $('sync').hidden = true;
  await load();
}

function showResult(html) {
  $('result').innerHTML = html;
  $('result').hidden = false;
}

async function post(url, files) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

load();
