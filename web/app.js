// The page: Home, Holdings, Categories and Sync, each at its own link:
// #/ (home), #/holdings, #/holdings/SYMBOL, #/categories, #/categories/NAME, #/sync
// Part 1 (P): data, numbers, charts, categories and sync. Part 2: how each page is laid out.
(function () {
  const P = (window.P = {});
  const $ = (P.$ = (s, r = document) => r.querySelector(s));

  // ---------- formatting ----------
  P.inr = (n, d = 2) => {
    if (n == null || !isFinite(n)) return '—';
    const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (n < 0 && s.replace(/[0.,]/g, '') ? '−₹' : '₹') + s;
  };
  P.pct = (n) => (n == null || !isFinite(n) ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%');
  P.sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  P.qty = (q) => Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  P.date = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  P.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  P.css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  P.compact = (v) => (Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + ' L' : Math.round(v).toLocaleString('en-IN'));
  P.plural = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
  const esc = P.esc, inr = P.inr, pct = P.pct, sign = P.sign;
  const total = (list, k) => list.reduce((a, h) => a + h[k], 0);
  P.todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

  // ---------- data ----------
  P.DATA = null;
  P.load = async () => {
    const r = await fetch('/api/portfolio');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not load');
    P.DATA = d;
    return d;
  };
  P.held = () => P.DATA.holdings.filter((h) => h.qty > 0);
  P.sold = () => P.DATA.holdings.filter((h) => h.qty <= 0);
  P.find = (s) => P.DATA.holdings.find((h) => h.symbol === s || h.key === s);
  P.totals = () => {
    const H = P.held(), inv = total(H, 'invested'), cur = total(H, 'current');
    return { inv, cur, pnl: cur - inv, pnlPct: inv ? (cur - inv) / inv : 0, booked: P.DATA.insights.booked, count: H.length };
  };

  // ---------- yearly return ----------
  P.xirr = (flows) => {
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
  };
  P.xirrHtml = (o) => (o.xirr == null
    ? `— <small class="muted">${o.xirrDays < 90 ? 'needs 3 months' : 'can’t work out'}</small>`
    : `<span class="${sign(o.xirr)}">${pct(o.xirr)}</span>`);

  // ---------- categories ----------
  const NONE = (P.NONE = 'No category');
  const AUTO = ['Stocks', 'Gold', 'Silver', 'Liquid', 'Other ETFs'];
  P.catNames = () => {
    if (P.DATA.categories) return P.DATA.categories.names;
    const used = new Set(P.DATA.holdings.map((h) => h.autoCategory));
    return AUTO.filter((n) => used.has(n)).concat([...used].filter((n) => !AUTO.includes(n)));
  };
  P.catOf = (h) => {
    const names = P.catNames(), a = P.DATA.categories && P.DATA.categories.assign[h.key];
    if (a && names.includes(a)) return a;
    return names.includes(h.autoCategory) ? h.autoCategory : NONE;
  };
  P.catList = () => {
    const names = P.catNames().slice();
    if (P.DATA.holdings.some((h) => P.catOf(h) === NONE)) names.push(NONE);
    return names;
  };
  P.cat = (name) => {
    const all = P.DATA.holdings.filter((h) => P.catOf(h) === name);
    const held = all.filter((h) => h.qty > 0);
    const inv = total(held, 'invested'), cur = total(held, 'current');
    const flows = all.flatMap((h) => h.flows).concat(held.length ? [[P.todayIso(), cur]] : []);
    const ds = flows.filter(([, a]) => Math.abs(a) > 0.005).map(([d]) => Date.parse(d));
    const days = ds.length ? Math.round((Math.max(...ds) - Math.min(...ds)) / 864e5) : 0;
    const all$ = total(P.held(), 'current');
    return { name, all, held, inv, cur, pnl: cur - inv, pnlPct: inv ? (cur - inv) / inv : 0, share: all$ ? cur / all$ : 0,
      booked: total(all, 'realised'), xirr: days >= 90 ? P.xirr(flows) : null, xirrDays: days };
  };
  P.cats = () => P.catList().map(P.cat);
  P.catDraft = () => {
    const assign = {};
    P.DATA.holdings.forEach((h) => { const c = P.catOf(h); if (c !== NONE) assign[h.key] = c; });
    return { names: P.catNames().slice(), assign };
  };
  P.saveCats = async (d) => {
    const r = await P.post('/api/categories', d);
    if (r.error) throw new Error(r.error);
    P.DATA.categories = r;
  };

  // Day by day: money in these holdings, and what they were worth
  P.series = (hs) => {
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
        val += k.p >= 0 ? q * h.prices[k.p][1] : c;
      });
      out.push([d, inv, val]);
    }
    const H = hs.filter((h) => h.qty > 0);
    const now = [P.todayIso(), total(H, 'invested'), total(H, 'current')];
    if (out.length && out[out.length - 1][0] >= now[0]) out[out.length - 1] = now;
    else if (H.length) out.push(now);
    return out;
  };

  // ---------- notes that explain where numbers come from ----------
  P.notes = (h) => {
    const n = [];
    const r = h.recon;
    if (r) {
      const diff = r.kiteQty - r.tradeQty, on = P.date(r.date);
      if (diff > 0 && !h.orders.length) n.push(['info', `No trades for this in your tradebook. Kite's holdings file (${on}) shows ${P.qty(r.kiteQty)} shares, from outside trading (IPO, demerger, gold bond from RBI, shares moved in). Numbers use Kite's figures.`]);
      else if (diff > 0) n.push(['info', `Kite shows ${P.qty(r.kiteQty)} shares on ${on}; your trades add up to ${P.qty(r.tradeQty)}. The other ${P.qty(diff)} came from outside trading. Numbers use Kite's figures.`]);
      else if (diff < 0 && -diff < 1) n.push(['info', `A split or bonus left ${P.qty(-diff)} of a share. Kite paid that part in cash.`]);
      else if (diff < 0) n.push(['info', `${P.qty(-diff)} shares left without a sell (demerger, buyback or moved out).`]);
      if (r.costChanged) n.push(['info', `Kite's average price (${inr(r.kiteAvg)}) differs from your trades (${inr(r.tradeAvg)}), usually after a demerger. Numbers use Kite's.`]);
    }
    if (h.missingBuys) n.push(['warn', 'You sold more shares than your tradebook shows you bought. Add your Kite holdings file in Sync to fix this.']);
    if (h.priceFrom === 'kite') n.push(['info', `No daily prices on Yahoo Finance for this one. The price is from your Kite holdings file of ${P.date(h.lastDate)}.`]);
    else if (h.last == null) n.push(['warn', `No daily prices found. If it was renamed, add its new name to <code>data/tickers.json</code>.`]);
    const others = h.symbols.filter((s) => s !== h.symbol);
    if (others.length) n.push(['info', `Also traded under the old name ${others.map(esc).join(', ')}.`]);
    h.splits.forEach((s) => n.push(['info', `Split or bonus on ${P.date(s.date)} (${s.num} for ${s.den}). Older orders are shown in today's share count, marked "adj."`]));
    return n.map(([k, t]) => `<div class="note ${k}">${t}</div>`).join('');
  };

  // ---------- pieces of pages (each design styles them) ----------
  const link = (href) => `data-href="${esc(href)}"`;
  P.href = { holding: (h) => '#/holdings/' + encodeURIComponent(h.symbol), cat: (n) => '#/categories/' + encodeURIComponent(n) };
  P.ui = {
    kpis: (list) => `<div class="kpis">${list.map(([k, v, sub]) => `<div class="kpi"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`).join('')}</div>`,
    homeKpis() {
      const t = P.totals(), I = P.DATA.insights, N = I.nifty;
      return P.ui.kpis([
        ['Invested', inr(t.inv, 0), P.plural(t.count, 'holding')],
        ['Current value', inr(t.cur, 0), ''],
        ['P&amp;L on holdings', `<span class="${sign(t.pnl)}">${inr(t.pnl, 0)}</span>`, `<span class="${sign(t.pnl)}">${pct(t.pnlPct)}</span>`],
        ['P&amp;L booked', `<span class="${sign(t.booked)}">${inr(t.booked, 0)}</span>`, 'on shares you sold'],
        ['Yearly return (XIRR)', P.xirrHtml(I), `over ${Math.round(I.xirrDays / 30.4)} months`],
        ['Same money in Nifty 50', N.xirr == null ? '—' : `<span class="${sign(N.xirr)}">${pct(N.xirr)}</span>`, N.value == null ? 'no Nifty prices' : 'worth ' + inr(N.value, 0)],
      ]);
    },
    catKpis(c) {
      return P.ui.kpis([
        ['Invested', inr(c.inv, 0), P.plural(c.held.length, 'holding')],
        ['Current value', inr(c.cur, 0), (c.share * 100).toFixed(1) + '% of portfolio'],
        ['P&amp;L on holdings', `<span class="${sign(c.pnl)}">${inr(c.pnl, 0)}</span>`, `<span class="${sign(c.pnl)}">${pct(c.pnlPct)}</span>`],
        ['P&amp;L booked', `<span class="${sign(c.booked)}">${inr(c.booked, 0)}</span>`, 'on shares you sold'],
        ['Yearly return (XIRR)', P.xirrHtml(c), ''],
      ]);
    },
    holdingKpis(h) {
      return P.ui.kpis(h.qty > 0
        ? [['Quantity', P.qty(h.qty), 'avg ' + inr(h.avg)], ['Invested', inr(h.invested, 0), ''], ['Current value', h.last == null ? '—' : inr(h.current, 0), ''],
           ['P&amp;L', `<span class="${sign(h.pnl)}">${inr(h.pnl, 0)}</span>`, `<span class="${sign(h.pnl)}">${pct(h.pnlPct)}</span>`],
           ['P&amp;L booked', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`, ''], ['Yearly return (XIRR)', P.xirrHtml(h), '']]
        : [['Quantity', '0', 'all sold'], ['P&amp;L booked', `<span class="${sign(h.realised)}">${inr(h.realised, 0)}</span>`, ''],
           ['Yearly return (XIRR)', P.xirrHtml(h), ''], ['Orders', h.orders.length, '']]);
    },
    catTable: (rows) => `<table class="tbl"><thead><tr><th>Category</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">Share</th><th class="num">Yearly return</th></tr></thead>
      <tbody>${rows.map((c) => `<tr ${link(P.href.cat(c.name))}><td><b>${esc(c.name)}</b> <small class="muted">${c.held.length}</small></td>
        <td class="num">${inr(c.inv, 0)}</td><td class="num">${inr(c.cur, 0)}</td>
        <td class="num ${sign(c.pnl)}">${inr(c.pnl, 0)} <small>${c.inv ? pct(c.pnlPct) : ''}</small></td>
        <td class="num">${(c.share * 100).toFixed(1)}%</td><td class="num">${P.xirrHtml(c)}</td></tr>`).join('')}</tbody></table>`,
    holdingsTable: (hs, opts = {}) => `<table class="tbl"><thead><tr><th>Name</th>${opts.cat === false ? '' : '<th>Category</th>'}<th class="num">Qty</th><th class="num">Avg</th><th class="num">Last price</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">Yearly return</th></tr></thead>
      <tbody>${hs.map((h) => `<tr ${link(P.href.holding(h))}><td><b>${esc(h.symbol)}</b> <small class="muted">${esc(h.kind)}</small></td>
        ${opts.cat === false ? '' : `<td><span class="tag">${esc(P.catOf(h))}</span></td>`}
        <td class="num">${h.qty > 0 ? P.qty(h.qty) : 'sold'}</td><td class="num">${h.qty > 0 ? inr(h.avg) : '—'}</td><td class="num">${inr(h.last)}</td>
        <td class="num">${h.qty > 0 ? inr(h.invested, 0) : '—'}</td><td class="num">${h.qty > 0 ? inr(h.current, 0) : '—'}</td>
        <td class="num ${sign(h.qty > 0 ? h.pnl : h.realised)}">${h.qty > 0 ? `${inr(h.pnl, 0)} <small>${pct(h.pnlPct)}</small>` : `${inr(h.realised, 0)} <small>booked</small>`}</td>
        <td class="num">${P.xirrHtml(h)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Nothing here.</td></tr>'}</tbody>${opts.total ? P.ui.totalRow(hs, opts.cat !== false) : ''}</table>`,
    totalRow(hs, withCat) {
      const H = hs.filter((h) => h.qty > 0), inv = total(H, 'invested'), cur = total(H, 'current');
      return `<tfoot><tr><td>Total</td>${withCat ? '<td></td>' : ''}<td></td><td></td><td></td><td class="num">${inr(inv, 0)}</td><td class="num">${inr(cur, 0)}</td>
        <td class="num ${sign(cur - inv)}">${inr(cur - inv, 0)} <small>${inv ? pct((cur - inv) / inv) : ''}</small></td><td></td></tr></tfoot>`;
    },
    orders: (h) => `<table class="tbl orders"><thead><tr><th>Date</th><th>Type</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
      <tbody>${h.orders.slice().reverse().map((o) => `<tr data-id="${esc(o.id)}" title="Order ${esc(o.orderId)} · ${esc(o.exchange)}${o.time ? ' · ' + esc(o.time) : ''}">
        <td>${P.date(o.date)}${o.fills > 1 ? ` <small class="muted">${o.fills} parts</small>` : ''}${o.symbol !== h.symbol ? ` <small class="muted">as ${esc(o.symbol)}</small>` : ''}</td>
        <td><span class="pill ${o.type.toLowerCase()}">${o.type}</span></td>
        <td class="num">${P.qty(o.qty)}${o.adjusted ? ' <small class="muted">adj.</small>' : ''}</td><td class="num">${inr(o.price)}</td><td class="num">${inr(o.qty * o.price, 0)}</td></tr>`).join('') ||
        '<tr><td colspan="5" class="muted">No trades for this in your tradebook.</td></tr>'}</tbody></table>`,
    bars: (rows, href) => rows.map((r) => `<div class="bar" ${href ? link(href(r.name)) : ''} title="${esc(r.name)}: ${inr(r.value, 0)}">
        <span class="bar-name">${esc(r.name)}</span><span class="bar-track"><i style="width:${Math.max(r.share * 100, 0.6).toFixed(2)}%"></i></span>
        <span class="num">${(r.share * 100).toFixed(1)}%</span><span class="num muted">${inr(r.value, 0)}</span></div>`).join('') || '<div class="muted">Nothing to show.</div>',
    movers(best) {
      const priced = P.held().filter((h) => h.last != null && h.invested > 0).sort((a, b) => b.pnlPct - a.pnlPct);
      const list = best ? priced.filter((h) => h.pnl > 0).slice(0, 5) : priced.filter((h) => h.pnl < 0).reverse().slice(0, 5);
      return list.map((h) => `<a class="row" href="${P.href.holding(h)}"><b>${esc(h.symbol)}</b><span class="num ${sign(h.pnl)}">${pct(h.pnlPct)}</span><span class="num muted">${inr(h.pnl, 0)}</span></a>`).join('') ||
        `<div class="muted">None ${best ? 'in profit' : 'in loss'}.</div>`;
    },
    booked: () => P.DATA.insights.bookedByYear.map((y) => `<div class="row"><span>FY ${esc(y.year)}</span><span class="num ${sign(y.value)}">${inr(y.value, 0)}</span></div>`).join('') ||
      '<div class="muted">You have not sold anything yet.</div>',
    sectors: () => P.ui.bars(P.DATA.insights.sectors),
    catPicker: (h) => `<label class="cat-pick">Category <select data-cat-of="${esc(h.key)}">${P.catNames().map((n) => `<option ${P.catOf(h) === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}${P.catOf(h) === NONE ? `<option selected disabled>${NONE}</option>` : ''}</select></label>`,
    xirrNote: () => `Yearly return (XIRR) is your profit or loss as a yearly rate. It counts when each rupee went in or came out, with today's value as if you sold everything today. Nifty 50 shows what the same money, put in and taken out on the same days, would give in the Nifty 50 index.`,
  };

  // ---------- charts ----------
  P.charts = [];
  const ro = new ResizeObserver((es) => es.forEach((e) => { const c = echarts.getInstanceByDom(e.target); if (c) c.resize(); }));
  P.dropCharts = () => { P.charts.forEach((c) => { ro.unobserve(c.getDom()); c.dispose(); }); P.charts = []; };
  P.newChart = (el) => {
    if (!el) return null;
    if (!window.echarts) { el.innerHTML = '<div class="empty">The chart library could not load.</div>'; return null; }
    const c = echarts.init(el);
    P.charts.push(c);
    ro.observe(el);
    return c;
  };
  const tip = () => ({ backgroundColor: P.css('--card'), borderColor: P.css('--line'), textStyle: { color: P.css('--text'), fontSize: 12 } });
  const axes = (time) => ({
    xAxis: time ? { type: 'time', axisLine: { lineStyle: { color: P.css('--line') } }, axisLabel: { color: P.css('--muted') }, splitLine: { show: false } } : undefined,
    yAxis: { type: 'value', scale: !!time, axisLabel: { color: P.css('--muted'), formatter: (v) => '₹' + P.compact(v) }, splitLine: { lineStyle: { color: P.css('--line') } } },
  });
  const zoom = () => [
    { type: 'inside', filterMode: 'none' },
    { type: 'slider', filterMode: 'none', height: 20, bottom: 10, borderColor: P.css('--line'), textStyle: { color: P.css('--muted') },
      fillerColor: 'rgba(100,130,250,.12)', dataBackground: { lineStyle: { color: P.css('--muted') }, areaStyle: { color: P.css('--line') } } },
  ];
  const fade = (c) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: c + '30' }, { offset: 1, color: c + '00' }]);

  // Invested and current value for each category, side by side (both ₹, one axis)
  P.catBars = (el, rows) => {
    rows = rows.filter((c) => c.held.length);
    if (!rows.length) { el.innerHTML = '<div class="empty">Nothing held right now.</div>'; return; }
    const c = P.newChart(el);
    if (!c) return;
    c.setOption({
      animation: false, grid: { left: 70, right: 12, top: 34, bottom: 46 },
      legend: { top: 4, right: 6, textStyle: { color: P.css('--muted') }, itemWidth: 12, itemHeight: 10 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tip(), formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return `<b>${esc(r.name)}</b><br/>Invested: ${inr(r.inv, 0)}<br/>Current value: ${inr(r.cur, 0)}<br/>P&amp;L: <span style="color:${P.css(r.pnl >= 0 ? '--up' : '--down')}">${inr(r.pnl, 0)} (${pct(r.pnlPct)})</span>`;
      } },
      xAxis: { type: 'category', data: rows.map((r) => r.name), axisLine: { lineStyle: { color: P.css('--line') } }, axisTick: { show: false },
        axisLabel: { interval: 0, formatter: (v, i) => `{n|${v}}\n{${rows[i].pnl >= 0 ? 'u' : 'd'}|${pct(rows[i].pnlPct)}}`,
          rich: { n: { color: P.css('--text'), fontSize: 12, lineHeight: 18 }, u: { color: P.css('--up'), fontSize: 11 }, d: { color: P.css('--down'), fontSize: 11 } } } },
      yAxis: axes(false).yAxis,
      series: [
        { name: 'Invested', type: 'bar', data: rows.map((r) => r.inv), itemStyle: { color: P.css('--bar-2'), borderRadius: [4, 4, 0, 0] }, barGap: '8%', barMaxWidth: 44 },
        { name: 'Current value', type: 'bar', data: rows.map((r) => r.cur), itemStyle: { color: P.css('--accent'), borderRadius: [4, 4, 0, 0] }, barMaxWidth: 44 },
      ],
    });
    c.on('click', (p) => (location.hash = P.href.cat(rows[p.dataIndex].name)));
  };

  // Value and money put in, day by day
  P.valueChart = (el, series) => {
    if (!series.length) { el.innerHTML = '<div class="empty">No history to draw yet.</div>'; return; }
    const c = P.newChart(el);
    if (!c) return;
    const line = P.css('--accent'), inv = P.css('--bar-2');
    c.setOption({
      animation: false, grid: { left: 70, right: 14, top: 14, bottom: 56 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: P.css('--muted'), type: 'dashed' } }, ...tip(), formatter: (ps) => {
        const [d, i, v] = series[ps[0].dataIndex];
        return `<b>${P.date(d)}</b><br/>Value: ${inr(v, 0)}<br/>Invested: ${inr(i, 0)}<br/>P&amp;L: <span style="color:${P.css(v - i >= 0 ? '--up' : '--down')}">${inr(v - i, 0)}${i ? ` (${pct((v - i) / i)})` : ''}</span>`;
      } },
      ...axes(true), dataZoom: zoom(),
      series: [
        { name: 'Invested', type: 'line', step: 'end', showSymbol: false, data: series.map((r) => [r[0], r[1]]), lineStyle: { width: 2, color: inv, type: 'dashed' }, itemStyle: { color: inv } },
        { name: 'Value', type: 'line', showSymbol: false, data: series.map((r) => [r[0], r[2]]), lineStyle: { width: 2, color: line }, itemStyle: { color: line }, areaStyle: { color: fade(line) } },
      ],
    });
  };

  // Daily price with buy/sell dots; clicking a dot or a row highlights both
  P.priceChart = (el, table, h) => {
    let selected = null;
    const c = (h.prices.length || h.orders.length) ? P.newChart(el) : null;
    if (!c && el && !el.innerHTML) el.innerHTML = '<div class="empty">No price history or trades to draw.</div>';
    const maxQty = Math.max(1, ...h.orders.map((o) => o.qty));
    const series = () => {
      const dots = (type) => h.orders.filter((o) => o.type === type).map((o) => ({
        value: [o.date, o.price], id: o.id, symbolSize: (9 + 26 * Math.sqrt(o.qty / maxQty)) * (o.id === selected ? 1.25 : 1),
        itemStyle: o.id === selected ? { borderColor: P.css('--text'), borderWidth: 3, opacity: 1 } : undefined, z: o.id === selected ? 10 : 2 }));
      const line = P.css('--accent'), card = P.css('--card');
      return [
        { name: 'Price', type: 'line', showSymbol: false, data: h.prices, z: 1, lineStyle: { width: 1.6, color: line }, itemStyle: { color: line }, areaStyle: { color: fade(line) } },
        { name: 'Buy', type: 'scatter', data: dots('BUY'), cursor: 'pointer', itemStyle: { color: P.css('--up'), opacity: 0.82, borderColor: card, borderWidth: 1.5 } },
        { name: 'Sell', type: 'scatter', data: dots('SELL'), cursor: 'pointer', itemStyle: { color: P.css('--down'), opacity: 0.82, borderColor: card, borderWidth: 1.5 } },
      ];
    };
    const pick = (id, fromChart) => {
      selected = id;
      if (c) c.setOption({ series: series() });
      table.querySelectorAll('tr[data-id]').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
      const row = table.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
      const box = row && row.closest('.scroll');
      if (!box) return;
      const headH = table.querySelector('thead').offsetHeight;
      if (row.offsetTop - headH < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
        box.scrollTo({ top: row.offsetTop - box.clientHeight / 3, behavior: 'smooth' });
      if (fromChart) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    };
    table.onclick = (e) => { const r = e.target.closest('tr[data-id]'); if (r) pick(r.dataset.id, false); };
    if (!c) return;
    const DAY = 864e5;
    c.setOption({
      animation: false, grid: { left: 66, right: 14, top: 14, bottom: 56 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: P.css('--muted'), type: 'dashed' } }, ...tip(), formatter: (ps) => {
        const d = ps[0].value[0], price = ps.find((p) => p.seriesName === 'Price');
        let s = `<b>${P.date(d)}</b>` + (price ? `<br/>Close: ${inr(price.value[1])}` : '');
        h.orders.filter((o) => Math.abs(Date.parse(o.date) - Date.parse(d)) <= 2 * DAY).forEach((o) => {
          s += `<br/><span style="color:${P.css(o.type === 'BUY' ? '--up' : '--down')}">●</span> ${o.type} ${P.qty(o.qty)} @ ${inr(o.price)}`;
        });
        return s;
      } },
      ...axes(true), dataZoom: zoom(), series: series(),
    });
    c.on('click', (p) => { if (p.seriesName === 'Buy' || p.seriesName === 'Sell') pick(p.data.id, true); });
  };

  // ---------- sync ----------
  P.syncSteps = () => `<ol class="steps">
      <li>Open <a href="https://console.zerodha.com/reports/tradebook" target="_blank" rel="noopener">Kite Console → Reports → Tradebook</a>.</li>
      <li>Segment <b>Equity</b>. ${P.DATA.lastTradeDate ? `Your saved trades go up to <b>${P.date(P.DATA.lastTradeDate)}</b>: pick dates from that day to today.` : 'First time: download one file per financial year.'}</li>
      <li>Click <b>View</b>, then <b>Download: CSV</b> (or XLSX).</li>
      <li>Also download your holdings from <a href="https://console.zerodha.com/portfolio/holdings" target="_blank" rel="noopener">Console → Portfolio → Holdings</a>.</li>
      <li>Drop all the files below. Overlapping dates, the same file twice, or CSV and XLSX together are fine: each trade is saved once.</li></ol>`;
  P.syncDrop = () => `<label class="drop" id="drop"><input type="file" id="file" accept=".csv,.xlsx" multiple hidden />
      <span><b>Drop tradebook and holdings files here</b><br/>or click to pick them</span></label><div class="result" id="result" hidden></div>`;
  P.syncStatus = () => P.ui.kpis([
    ['Trades saved', P.DATA.tradeCount.toLocaleString('en-IN'), ''],
    ['Last trade', P.date(P.DATA.lastTradeDate), ''],
    ['Last synced', P.date(P.DATA.lastSynced), ''],
    ['Kite holdings file', P.date(P.DATA.holdingsDate), P.DATA.holdingsDate ? '' : 'not added yet'],
  ]);
  P.bindSync = (onDone) => {
    const drop = $('#drop'), res = $('#result');
    let pending = null;
    const show = (html) => { res.innerHTML = html; res.hidden = false; };
    const b64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
    const read = async (list) => {
      const files = await Promise.all([...list].map(async (f) => (/\.xlsx$/i.test(f.name) ? { name: f.name, b64: b64(await f.arrayBuffer()) } : { name: f.name, text: await f.text() })));
      if (!files.length) return;
      pending = files;
      show('<div class="muted">Checking…</div>');
      const r = await P.post('/api/sync/preview', { files });
      if (r.error) return show(`<div class="err">${esc(r.error)}</div>`);
      const lines = r.files.map((f) => (f.error ? `<div class="err">${esc(f.name)}: ${esc(f.error)}</div>`
        : f.kind === 'holdings' ? `<div><b>${esc(f.name)}</b> · holdings file from ${P.date(f.date)} · ${f.rows} holdings</div>` : `<div><b>${esc(f.name)}</b> · ${f.rows} equity trades</div>`)).join('');
      const saveHold = r.holdings && !r.holdings.older;
      const label = r.new ? `Add ${r.new} trades${saveHold ? ' and save holdings' : ''}` : saveHold ? 'Save holdings' : '';
      show(`${lines}<div class="chips"><span class="chip new">${r.new} new</span><span class="chip">${r.already} already saved</span>${r.repeated ? `<span class="chip">${r.repeated} in more than one file, added once</span>` : ''}${r.skipped ? `<span class="chip">${r.skipped} not equity</span>` : ''}</div>
        ${r.new ? `<div class="muted">New trades from ${P.date(r.from)} to ${P.date(r.to)}</div>` : ''}
        ${r.holdings && r.holdings.older ? '<div class="muted">This holdings file is older than the saved one, so it is not used.</div>' : ''}
        ${label ? `<button class="btn primary" id="commit">${label}</button>` : '<div class="muted">Nothing new to add.</div>'}`);
      if (label) $('#commit').onclick = async () => {
        $('#commit').disabled = true;
        const c = await P.post('/api/sync/commit', { files: pending });
        if (c.error) return show(`<div class="err">${esc(c.error)}</div>`);
        await P.load();
        onDone(c);
      };
    };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); read(e.dataTransfer.files); };
    $('#file').onchange = (e) => read(e.target.files);
  };

  // ---------- edit categories ----------
  let draft = null;
  P.catEditor = () => {
    draft = P.catDraft();
    return `<div class="cat-editor" id="cat-editor"></div>`;
  };
  const paintEditor = () => {
    const box = $('#cat-editor');
    if (!box) return;
    const opt = (h) => draft.names.map((n) => `<option ${draft.assign[h.key] === n ? 'selected' : ''}>${esc(n)}</option>`).join('') + (!draft.names.includes(draft.assign[h.key]) ? `<option selected value="">${NONE}</option>` : '');
    const row = (h) => `<div class="ce-row"><span><b>${esc(h.symbol)}</b> <small class="muted">${h.qty > 0 ? inr(h.current, 0) : 'sold'}</small></span><select data-h="${esc(h.key)}">${opt(h)}</select></div>`;
    box.innerHTML = `<div class="ce-cols"><div><h4>Your categories</h4>${draft.names.map((n, i) => `<div class="ce-name"><input value="${esc(n)}" data-i="${i}" /><span class="muted" title="holdings you hold now in this category">${P.held().filter((h) => draft.assign[h.key] === n).length} held</span><button class="link danger" data-del="${i}">Delete</button></div>`).join('')}
        <div class="ce-add"><input id="ce-new" placeholder="New category name" maxlength="40" /><button class="btn" id="ce-add">Add</button></div></div>
      <div><h4>Which holding goes where</h4><div class="ce-list">${P.held().map(row).join('')}${P.sold().length ? '<h4>Sold</h4>' + P.sold().map(row).join('') : ''}</div></div></div>
      <div class="ce-foot"><button class="btn" data-ce-cancel>Cancel</button><button class="btn primary" data-ce-save>Save</button></div>`;
  };
  P.bindCatEditor = (onDone) => {
    paintEditor();
    const box = $('#cat-editor');
    box.onclick = async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const name = draft.names.splice(+del.dataset.del, 1)[0];
        Object.keys(draft.assign).forEach((k) => { if (draft.assign[k] === name) delete draft.assign[k]; });
        paintEditor();
      } else if (e.target.id === 'ce-add') {
        const n = $('#ce-new').value.trim();
        if (n && !draft.names.includes(n)) draft.names.push(n);
        paintEditor();
        $('#ce-new').focus();
      } else if (e.target.closest('[data-ce-save]')) {
        try { await P.saveCats(draft); } catch (err) { return P.saveError(err); }
        onDone();
      } else if (e.target.closest('[data-ce-cancel]')) onDone();
    };
    box.onkeydown = (e) => { if (e.key === 'Enter' && e.target.id === 'ce-new') $('#ce-add').click(); };
    box.onchange = (e) => {
      const t = e.target;
      if (t.dataset.h) { if (t.value) draft.assign[t.dataset.h] = t.value; else delete draft.assign[t.dataset.h]; paintEditor(); }
      else if (t.dataset.i != null) {
        const old = draft.names[+t.dataset.i], n = t.value.trim();
        if (!n || draft.names.includes(n)) { t.value = old; return; }
        draft.names[+t.dataset.i] = n;
        Object.keys(draft.assign).forEach((k) => { if (draft.assign[k] === old) draft.assign[k] = n; });
        paintEditor();
      }
    };
  };

  // Shown at the top of the page when categories could not be saved
  P.saveError = (err) => {
    const page = $('#page');
    if (page) page.insertAdjacentHTML('afterbegin', `<div class="note err">Could not save your categories: ${esc(err.message)}</div>`);
  };

  // ---------- page links, theme, start ----------
  P.post = async (url, body) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  };
  P.route = () => {
    const [page = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
    let a = arg;
    try { a = arg && decodeURIComponent(arg); } catch (e) { a = null; }
    return { page: page || 'home', arg: a };
  };
  P.toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    P.render();
  };
  P.start = async (render) => {
    P.render = () => { P.dropCharts(); render(P.route()); };
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-href]');
      if (a && !e.target.closest('a[href], select, input, button')) location.hash = a.dataset.href;
      if (e.target.closest('[data-theme-toggle]')) P.toggleTheme();
    });
    document.addEventListener('change', async (e) => {
      const s = e.target.closest('select[data-cat-of]');
      if (!s) return;
      const d = P.catDraft();
      d.assign[s.dataset.catOf] = s.value;
      try { await P.saveCats(d); } catch (err) { P.render(); return P.saveError(err); }
      P.render();
    });
    window.addEventListener('hashchange', () => { P.render(); window.scrollTo(0, 0); });
    try {
      await P.load();
    } catch (e) {
      $('#body').innerHTML = `<div class="empty"><div><h2>Could not load your portfolio</h2>${esc(e.message)}<br/><button class="btn" onclick="location.reload()">Try again</button></div></div>`;
      return;
    }
    P.render();
  };
})();

// ---------- Part 2: the pages ----------
(function () {
  const { $, esc, inr, pct, sign } = P;
  const ic = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    holdings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>',
    categories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  const ALL = 'all'; // #/holdings/all and #/categories/all: the summary at the top of each list
  let query = '', editing = false, flash = '';
  window.addEventListener('hashchange', () => { editing = false; }); // leaving the page closes the editor
  document.addEventListener('click', (e) => { // clicking the page you are on (in the list) also closes the editor
    const a = e.target.closest('#list a.li');
    if (a && editing && a.getAttribute('href') === location.hash) { editing = false; P.render(); }
  });

  const title = (t) => { document.title = t + ' · Portfolio'; };
  const lastOrder = (h) => (h.orders.length ? h.orders[h.orders.length - 1].date : '');
  const priceLine = (h) => (h.priceFrom === 'yahoo'
    ? `<span class="${sign(h.dayChange)}">${pct(h.dayChange)}</span> <small class="muted">${P.date(h.lastDate)}</small>`
    : h.priceFrom === 'kite' ? '<small class="muted">from Kite holdings file</small>' : '<small class="muted">no price</small>');
  const valueLegend = () => `<div class="legend"><span><i style="background:var(--accent)"></i>Value</span><span><i style="background:var(--bar-2)"></i>Invested</span></div>`;
  const outsideNote = (hs) => (hs.some((h) => Math.abs(h.outsideCost) > 0.005)
    ? `<div class="pad" style="padding-top:0"><small class="muted">Shares that were not trades (IPO, gold bond from RBI, demerger, moved in) join this chart on the holdings file date, ${P.date(P.DATA.holdingsDate)}.</small></div>` : '');

  function rail(r) {
    $('#rail').innerHTML = `<a class="mark" href="#/" title="Home">₹</a>` +
      [['home', '#/', 'Home'], ['holdings', '#/holdings', 'Holdings'], ['categories', '#/categories', 'Categories'], ['sync', '#/sync', 'Sync']]
        .map(([k, h, l]) => `<a href="${h}" class="${r.page === k ? 'on' : ''}" ${r.page === k ? 'aria-current="page"' : ''}>${ic[k]}${l}</a>`).join('') +
      `<div class="spacer"></div><button data-theme-toggle title="Switch light / dark">${ic.theme}${document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark'}</button>`;
  }

  // Draws the list (if any) and an empty page. The list keeps its scroll place when the page redraws.
  function layout(list, detail) {
    const old = $('#list');
    const keep = old && list && old.dataset.page === list.page ? old.scrollTop : null;
    $('#body').className = 'body' + (list ? ' split' : '') + (detail ? ' detail' : '');
    $('#body').innerHTML = (list ? `<div class="list" id="list" data-page="${list.page}">${list.html}</div>` : '') + '<div class="page" id="page"></div>';
    if (keep != null) $('#list').scrollTop = keep;
    const on = $('#list .li.on');
    if (on) on.scrollIntoView({ block: 'nearest' }); // only moves when the picked item is out of view
  }

  // ---------- home ----------
  function home() {
    title('Home');
    layout(null);
    const t = P.totals(), I = P.DATA.insights, N = I.nifty, cats = P.cats();
    const msg = flash;
    flash = '';
    $('#page').innerHTML = `${msg ? `<div class="note ok">${msg}</div>` : ''}
      <div class="hero"><div><small>Your portfolio today</small><div class="big">${inr(t.cur, 0)}</div>
          <div><span class="${sign(t.pnl)}"><b>${inr(t.pnl, 0)}</b> (${pct(t.pnlPct)})</span> <span class="muted">on ${inr(t.inv, 0)} invested · ${P.plural(t.count, 'holding')}</span></div>
          <div class="muted" style="margin-top:4px">Booked on sales: <span class="${sign(t.booked)}">${inr(t.booked, 0)}</span></div></div>
        <div class="vs"><div><small class="muted">Your yearly return</small><b>${P.xirrHtml(I)}</b><small class="muted">over ${Math.round(I.xirrDays / 30.4)} months</small></div>
          <div><small class="muted">Same money in Nifty 50</small><b>${N.xirr == null ? '—' : `<span class="${sign(N.xirr)}">${pct(N.xirr)}</span>`}</b><small class="muted">${N.value == null ? 'no Nifty prices' : 'worth ' + inr(N.value, 0)}</small></div></div></div>
      <div class="card"><div class="card-head"><b>Portfolio value over time</b>${valueLegend()}</div><div class="chart" id="c1"></div>${outsideNote(P.DATA.holdings)}</div>
      <div class="head"><h2>Categories</h2><a href="#/categories/all">All categories →</a></div>
      <div class="catcards">${cats.filter((c) => c.held.length).map((c) => `<a class="catcard" href="${P.href.cat(c.name)}">
          <div class="t"><b>${esc(c.name)}</b><span class="muted">${(c.share * 100).toFixed(1)}%</span></div><div class="v">${inr(c.cur, 0)}</div>
          <div class="meter"><i style="width:${(c.share * 100).toFixed(1)}%"></i></div>
          <div class="t"><span class="${sign(c.pnl)}">${inr(c.pnl, 0)} (${pct(c.pnlPct)})</span><span class="muted">XIRR ${c.xirr == null ? '—' : pct(c.xirr)}</span></div></a>`).join('')}</div>
      <div class="cols">
        <div class="card"><div class="card-head"><b>Doing best</b><span class="muted">on what you hold</span></div><div class="pad">${P.ui.movers(true)}</div></div>
        <div class="card"><div class="card-head"><b>Doing worst</b><span class="muted">on what you hold</span></div><div class="pad">${P.ui.movers(false)}</div></div>
        <div class="card"><div class="card-head"><b>Stocks by sector</b><span class="muted">stocks only</span></div><div class="pad">${P.ui.sectors()}</div></div>
        <div class="card"><div class="card-head"><b>P&amp;L booked by year</b><span class="muted">April to March</span></div><div class="pad">${P.ui.booked()}</div></div>
      </div>
      <div class="note info">${P.ui.xirrNote()}</div>`;
    P.valueChart($('#c1'), P.series(P.DATA.holdings));
  }

  // ---------- holdings: list grouped by category, the chosen one on the right ----------
  function holdingsList(sel, all) {
    const t = P.totals();
    const item = (x) => `<a class="li ${x === sel ? 'on' : ''}" href="${P.href.holding(x)}" data-s="${esc((x.symbol + ' ' + x.name + ' ' + x.symbols.join(' ')).toLowerCase())}">
        <b>${esc(x.symbol)}</b><span class="num">${x.qty > 0 ? inr(x.current, 0) : ''}</span>
        <small>${x.qty > 0 ? P.qty(x.qty) + ' shares' : 'sold'}</small>
        <small class="num ${sign(x.qty > 0 ? x.pnl : x.realised)}">${x.qty > 0 ? (x.last == null ? 'no price' : pct(x.pnlPct)) : inr(x.realised, 0) + ' booked'}</small></a>`;
    const groups = P.catList().map((c) => {
      const list = P.held().filter((x) => P.catOf(x) === c).sort((a, b) => b.current - a.current);
      return list.length ? `<div class="grp"><span>${esc(c)}</span><span>${inr(list.reduce((a, x) => a + x.current, 0), 0)}</span></div>` + list.map(item).join('') : '';
    }).join('');
    const sold = P.sold().sort((a, b) => lastOrder(b).localeCompare(lastOrder(a)));
    return { page: 'holdings', html: `<div class="list-head"><h2>Holdings <small>${P.held().length}</small></h2><input class="search" id="q" type="search" placeholder="Search holdings" value="${esc(query)}" aria-label="Search holdings" /></div>
      <a class="li all ${all ? 'on' : ''}" href="#/holdings/${ALL}"><b>All holdings</b><span class="num">${inr(t.cur, 0)}</span>
        <small>${P.plural(t.count, 'holding')} · ${sold.length} sold</small><small class="num ${sign(t.pnl)}">${pct(t.pnlPct)}</small></a>
      ${groups}${sold.length ? `<div class="grp"><span>Sold</span><span>${sold.length}</span></div>` + sold.map(item).join('') : ''}
      <div class="no-match" id="nomatch" hidden>No holding matches.</div>` };
  }

  // Search only hides list rows; the page on the right stays as it is
  function bindSearch() {
    const q = $('#q');
    const apply = () => {
      query = q.value;
      const v = query.trim().toLowerCase();
      let any = false;
      document.querySelectorAll('#list .li[data-s]').forEach((li) => { li.hidden = !!v && !li.dataset.s.includes(v); any = any || !li.hidden; });
      document.querySelectorAll('#list .grp').forEach((g) => {
        let n = g.nextElementSibling, shown = false;
        while (n && n.classList.contains('li')) { shown = shown || !n.hidden; n = n.nextElementSibling; }
        g.hidden = !shown;
      });
      $('#nomatch').hidden = any;
    };
    q.oninput = apply;
    apply();
  }

  function holdings(r) {
    const all = !r.arg || r.arg === ALL;
    const h = all ? null : P.find(r.arg);
    if (!all && !h) return (location.hash = '#/holdings');
    layout(holdingsList(h, all), !!r.arg);
    bindSearch();
    if (all) return allHoldings();
    title(h.symbol);
    $('#page').innerHTML = `<a class="back" href="#/holdings">← Holdings</a>
      <div class="head"><div><h1>${esc(h.symbol)}</h1><div class="sub">${esc(h.name !== h.symbol ? h.name + ' · ' : '')}${esc(h.kind)}${h.sector && h.sector !== 'ETF' ? ' · ' + esc(h.sector) : ''}</div>${P.ui.catPicker(h)}</div>
        <div class="price"><b>${inr(h.last)}</b><div>${priceLine(h)}</div></div></div>
      ${P.ui.holdingKpis(h)}<div class="notes">${P.notes(h)}</div>
      <div class="card"><div class="card-head"><b>Daily price and your trades</b><div class="legend"><span><i style="background:var(--up)"></i>Buy</span><span><i style="background:var(--down)"></i>Sell</span><span>bigger dot = more shares</span></div></div><div class="chart tall" id="c1"></div></div>
      <div class="card"><div class="card-head"><b>Buy / sell orders</b><span class="muted">${P.plural(h.orders.length, 'order')} · click one to find it on the chart</span></div><div class="scroll" id="ord">${P.ui.orders(h)}</div></div>`;
    P.priceChart($('#c1'), $('#ord'), h);
  }

  function allHoldings() {
    title('Holdings');
    const t = P.totals();
    const held = P.held().sort((a, b) => b.current - a.current);
    const sold = P.sold().sort((a, b) => lastOrder(b).localeCompare(lastOrder(a)));
    $('#page').innerHTML = `<a class="back" href="#/holdings">← Holdings</a>
      <div class="head"><div><h1>All holdings</h1><div class="sub">${P.plural(t.count, 'holding')} now · ${sold.length} sold</div></div>
        <div class="price"><b>${inr(t.cur, 0)}</b><div class="${sign(t.pnl)}">${inr(t.pnl, 0)} (${pct(t.pnlPct)})</div></div></div>
      ${P.ui.homeKpis()}
      <div class="card"><div class="card-head"><b>What you hold</b><span class="muted">click a row to open it</span></div>${P.ui.holdingsTable(held, { total: true })}</div>
      ${sold.length ? `<div class="card"><div class="card-head"><b>Sold</b><span class="muted">profit or loss you booked</span></div>${P.ui.holdingsTable(sold)}</div>` : ''}`;
  }

  // ---------- categories ----------
  function catsList(sel, all) {
    const cats = P.cats(), t = P.totals();
    return { page: 'categories', html: `<div class="list-head"><h2>Categories <small>${cats.length}</small><button class="btn small" id="edit">${editing ? 'Close' : 'Edit'}</button></h2></div>
      <a class="li all ${all && !editing ? 'on' : ''}" href="#/categories/${ALL}"><b>All categories</b><span class="num">${inr(t.cur, 0)}</span>
        <small>${P.plural(cats.length, 'category', 'categories')} · chart and table</small><small class="num ${sign(t.pnl)}">${pct(t.pnlPct)}</small></a>
      ${cats.map((c) => `<a class="li ${!editing && c.name === sel ? 'on' : ''}" href="${P.href.cat(c.name)}"><b>${esc(c.name)}</b><span class="num">${inr(c.cur, 0)}</span>
        <small>${P.plural(c.held.length, 'holding')} · ${(c.share * 100).toFixed(1)}%</small><small class="num ${sign(c.pnl)}">${c.inv ? pct(c.pnlPct) : ''}</small></a>`).join('')}` };
  }

  function categories(r) {
    const name = r.arg && r.arg !== ALL ? r.arg : null;
    if (name && !P.catList().includes(name)) return (location.hash = '#/categories');
    layout(catsList(name, !name), !!r.arg || editing);
    $('#edit').onclick = () => { editing = !editing; P.render(); };
    if (editing) {
      title('Edit categories');
      $('#page').innerHTML = `<a class="back" href="#/categories">← Categories</a>
        <div class="head"><div><h1>Edit categories</h1><div class="sub">Add, rename or delete categories, and choose where each holding goes.</div></div></div>
        <div class="card">${P.catEditor()}</div>`;
      return P.bindCatEditor(() => { editing = false; P.render(); });
    }
    if (!name) return allCategories();
    const c = P.cat(name);
    title(c.name);
    const rows = c.held.slice().sort((a, b) => b.current - a.current).concat(c.all.filter((h) => h.qty <= 0));
    $('#page').innerHTML = `<a class="back" href="#/categories">← Categories</a>
      <div class="head"><div><h1>${esc(c.name)}</h1><div class="sub">Category · ${P.plural(c.held.length, 'holding')}${c.all.length > c.held.length ? ` · ${c.all.length - c.held.length} sold` : ''}</div></div>
        <div class="price"><b>${inr(c.cur, 0)}</b><div class="${sign(c.pnl)}">${inr(c.pnl, 0)} (${pct(c.pnlPct)})</div></div></div>
      ${P.ui.catKpis(c)}
      <div class="card"><div class="card-head"><b>Value over time</b>${valueLegend()}</div><div class="chart tall" id="c1"></div>${outsideNote(c.all)}</div>
      <div class="card"><div class="card-head"><b>Holdings in ${esc(c.name)}</b><span class="muted">change one's category on its own page</span></div>
        ${rows.length ? P.ui.holdingsTable(rows, { cat: false, total: c.held.length > 1 }) : '<div class="pad muted">Nothing in this category yet. Use Edit to put holdings in it.</div>'}</div>`;
    P.valueChart($('#c1'), P.series(c.all));
  }

  function allCategories() {
    title('Categories');
    const cats = P.cats(), t = P.totals();
    $('#page').innerHTML = `<a class="back" href="#/categories">← Categories</a>
      <div class="head"><div><h1>All categories</h1><div class="sub">Your own groups. Each holding is in one.</div></div>
        <div class="price"><b>${inr(t.cur, 0)}</b><div class="${sign(t.pnl)}">${inr(t.pnl, 0)} (${pct(t.pnlPct)})</div></div></div>
      <div class="card"><div class="card-head"><b>Invested vs current value</b><span class="muted">click a bar to open that category</span></div><div class="chart" id="c1"></div></div>
      <div class="card">${P.ui.catTable(cats)}</div>
      <div class="note info">To change which holding is in which category, click <b>Edit</b> at the top of the list, or use the Category box on a holding's page.</div>`;
    P.catBars($('#c1'), cats);
  }

  // ---------- sync ----------
  function sync() {
    title('Sync trades');
    layout(null);
    $('#page').innerHTML = `<div class="sync"><div class="head"><div><h1>Sync trades</h1><div class="sub">Bring in new trades and your latest holdings from Kite.</div></div></div>
      ${P.syncStatus()}${P.syncDrop()}<div class="card"><div class="card-head"><b>Which files to download</b></div><div class="pad">${P.syncSteps()}</div></div></div>`;
    P.bindSync((c) => {
      flash = [c.new ? `Added ${P.plural(c.new, 'new trade')}.` : '', c.holdings && !c.holdings.older ? 'Saved your holdings file.' : ''].filter(Boolean).join(' ') || 'Nothing new to add.';
      location.hash = '#/';
    });
  }

  function empty() {
    title('Portfolio');
    layout(null);
    $('#page').innerHTML = `<div class="empty" style="min-height:60vh"><div><h2>No trades yet</h2>Download your tradebook from Kite Console and add it on the Sync page.<br/>
      <a class="btn primary" href="#/sync">Go to Sync</a></div></div>`;
  }

  P.start((r) => {
    rail(r);
    if (!P.DATA.holdings.length && r.page !== 'sync') return empty();
    ({ home, holdings, categories, sync }[r.page] || home)(r);
  });
})();
