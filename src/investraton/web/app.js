// INVESTigator — local app frontend (vanilla JS, no build step)
const $ = (s, r = document) => r.querySelector(s);
// Backend seam. Two hosts, one UI:
//   - Tauri desktop/Android: window.__invest(method, path, body) runs the bundled
//     TypeScript engine in-process (no server).
//   - Python dev server: plain fetch to the FastAPI app.
// The bridge is set synchronously before this script runs, so detect it once.
const BRIDGE = typeof window !== 'undefined' ? window.__invest : null;
const api = {
  async get(p) { if (BRIDGE) return BRIDGE('GET', p); const r = await fetch(p); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); },
  async send(p, m, b) { if (BRIDGE) return BRIDGE(m, p, b); const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b == null ? null : JSON.stringify(b) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); },
  put(p, b) { return api.send(p, 'PUT', b); }, post(p, b) { return api.send(p, 'POST', b); }, del(p) { return api.send(p, 'DELETE'); },
};
const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 1 : 2) + '%';
const esc = (s) => (s ?? '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tip = (t) => `<span class="tip" data-tip="${esc(t)}">i</span>`;

// External links can't open with target=_blank inside the webview; route them
// through the local server so they open in the user's default browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="http"]');
  if (a) { e.preventDefault(); const p = '/api/open?url=' + encodeURIComponent(a.href); if (BRIDGE) BRIDGE('GET', p); else fetch(p); }
}, true);

// Click-to-show tooltip popover (native title doesn't work well in a webview).
document.addEventListener('click', (e) => {
  const pop = $('#poptip');
  if (e.target.classList && e.target.classList.contains('tip')) {
    const r = e.target.getBoundingClientRect();
    pop.textContent = e.target.dataset.tip;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 296)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.className = 'poptip show';
    e.stopPropagation();
  } else if (!e.target.closest || !e.target.closest('.poptip')) {
    pop.className = 'poptip';
  }
});

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => t.className = 'toast', 2800);
}

function debounce(fn, ms = 700) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const savedTag = '<span class="muted small" id="savestate">Changes save automatically ✓</span>';
function setSaved(txt = 'Saved ✓') { const el = $('#savestate'); if (el) el.textContent = txt; }

function md(src) {
  const lines = (src || '').split('\n'); let html = '', inList = false;
  const inline = (t) => esc(t)
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">link ↗</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^### /.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h3>${inline(l.slice(4))}</h3>`; }
    else if (/^## /.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${inline(l.slice(3))}</h2>`; }
    else if (/^# /.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h1>${inline(l.slice(2))}</h1>`; }
    else if (/^[-*] /.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(l.slice(2))}</li>`; }
    else if (!l) { if (inList) { html += '</ul>'; inList = false; } }
    else { if (inList) { html += '</ul>'; inList = false; } html += `<p>${inline(l)}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}

const OPAQUE = (lbl) => /unmapped|opaque|unknown/i.test(lbl);
function bars(items, max) {
  const top = Math.max(0.0001, ...items.map(i => i.weight));
  return items.slice(0, max).map(i => {
    const o = OPAQUE(i.label) ? ' opaque' : '';
    return `<div class="bar-row"><div class="bar-label${o}">${esc(i.label)}</div>
      <div class="bar-track"><div class="bar-fill${o}" style="width:${(i.weight / top * 100).toFixed(1)}%"></div></div>
      <div class="bar-val${o}">${pct(i.weight)}</div></div>`;
  }).join('');
}

function eventCard(e, radar = false) {
  const sevClass = radar ? 'radar' : e.severity;
  const badge = `<span class="badge ${sevClass}">${radar ? 'radar' : e.severity}</span>`;
  const src = e.url ? `<span class="evt-src">open ↗</span>` : '';
  const inner = `<div class="evt-top">${badge}<span class="evt-tkr">${esc(e.ticker)}</span>
      <span class="muted small">urgency ${e.urgency}</span>${src}</div>
    <div class="evt-head">${esc(e.headline)}</div>
    <div class="evt-why">${esc(e.explanation)}</div>`;
  return e.url
    ? `<a class="evt" href="${esc(e.url)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="evt">${inner}</div>`;
}

// Shared digest rendering (used by Dashboard run + History detail).
function eventsBlock(d) {
  const evs = d.events.length ? d.events.map(e => eventCard(e)).join('')
    : '<div class="muted">Nothing cleared your threshold — quiet is good. ✅</div>';
  const radar = d.watchlist.length
    ? `<h2 style="margin-top:18px">On your radar ${tip('News about things you are tracking but do NOT own yet — discovery, not advice.')}</h2>
       <div class="sub">Watchlist / discovery</div>${d.watchlist.map(e => eventCard(e, true)).join('')}` : '';
  return `<details style="margin:10px 0"><summary class="muted small" style="cursor:pointer">AI summary</summary>
      <div class="md">${md(d.narrative)}</div></details>
    <h2 style="margin-top:8px">What's moving</h2>
    <div class="sub">Your positions · click a card to open the source ↗</div>${evs}${radar}`;
}
function findingsBlock(structure) {
  if (!structure || !structure.length) return '';
  return `<h2 style="margin-top:18px">Your structure</h2>` + structure.map(f =>
    `<div class="finding"><div class="dot ${f.severity}"></div>
      <div><div class="ttl">${esc(f.title)}</div><div class="det">${esc(f.detail)}</div></div></div>`).join('');
}

// ---------- Router ----------
const VIEWS = { dashboard: renderDashboard, holdings: renderHoldings, plan: renderPlan, schedules: renderSchedules, history: renderHistory, settings: renderSettings, guide: renderGuide };
const TITLES = { dashboard: 'Dashboard', holdings: 'Holdings', plan: 'Plan', schedules: 'Schedules', history: 'History', settings: 'Settings', guide: 'Guide & help' };

// render() does the work; go() only changes the hash. Keeping these separate means
// a navigation triggers exactly ONE render (hashchange), never a double.
function render(view) {
  if (!VIEWS[view]) view = 'dashboard';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  $('#view-title').textContent = TITLES[view];
  $('#topbar-actions').innerHTML = '';
  $('#view').innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  VIEWS[view]().catch(e => { $('#view').innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; });
}
function go(view) {
  if (!VIEWS[view]) view = 'dashboard';
  if ((location.hash.slice(1) || 'dashboard') === view) render(view);
  else location.hash = view;
}
document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => go(n.dataset.view)));

async function loadStatus() {
  try {
    const s = await api.get('/api/status');
    window._status = s;
    $('#status-foot').innerHTML = `
      <div class="small"><span class="muted">AI brain</span> · ${esc(s.llm_provider)}</div>
      <div class="small"><span class="muted">Holdings</span> · ${s.holdings_count}</div>
      <div class="small"><span class="muted">Delivery</span> · ${esc(s.delivery.join(', '))}</div>
      <div class="small muted">v${esc(s.version)}</div>`;
  } catch { $('#status-foot').innerHTML = '<div class="small muted">status unavailable</div>'; }
}

// ---------- Dashboard ----------
async function renderDashboard() {
  const st = window._status || await api.get('/api/status');
  if (!st.holdings_count) { renderOnboarding(); return; }
  $('#topbar-actions').innerHTML = `
    <div class="seg"><select id="focus" title="Which products to include">
      <option value="all">All</option><option value="invested">Invested only</option>
      <option value="watchlist">Watchlist only</option></select></div>
    <div class="seg"><select id="cx" title="How much filtering">
      <option value="simple">Simple</option><option value="standard" selected>Standard</option>
      <option value="complex">Complex</option><option value="urgent">Urgent only</option>
      <option value="none">No filtering</option></select></div>
    <button class="btn primary" id="run">Run digest</button>`;
  $('#view').innerHTML = `
    <div id="digest-card" class="card">
      <h2>Digest ${tip('A noise-filtered briefing of what moved and why it matters to YOU. Never buy/sell advice.')}</h2>
      <div class="sub">Pick a focus + complexity above, then Run. Fetches latest news — a few seconds.</div>
      <div class="muted">No digest generated yet.</div>
    </div>
    <div class="grid">
      <div class="card"><h2>Effective exposure ${tip('Your true company-level exposure after decomposing ETFs into their underlying holdings.')}</h2><div class="sub">After ETF look-through</div><div id="exp-name"></div></div>
      <div class="card"><h2>By region ${tip('Continent / market bloc. A regional event (e.g. across Europe) hits every country in it, so this is your real geographic concentration.')}</h2><div class="sub">Share of decoded holdings (=100%)</div><div id="exp-geo"></div></div>
      <div class="card"><h2>By country</h2><div class="sub">Share of decoded holdings (=100%)</div><div id="exp-cty"></div></div>
      <div class="card"><h2>By sector</h2><div class="sub">Share of decoded holdings (=100%)</div><div id="exp-sec"></div></div>
    </div>
    <div class="card"><h2>Structure findings ${tip('Hidden concentration, ETF overlap, geographic/sector tilt, and drift from your plan.')}</h2><div class="sub" id="cov"></div><div id="findings"></div></div>`;
  $('#run').addEventListener('click', runDigest);
  try {
    const s = await api.get('/api/structure');
    $('#exp-name').innerHTML = bars(s.by_name, 8);
    $('#exp-geo').innerHTML = bars(s.by_region, 7);
    $('#exp-cty').innerHTML = bars(s.by_country, 8);
    $('#exp-sec').innerHTML = bars(s.by_sector, 6);
    const opaque = s.opaque.map(o => `${esc(o.label)} ${pct(o.weight)}`).join(', ');
    $('#cov').innerHTML = `Look-through covers <strong>${pct(s.coverage)}</strong> of your portfolio` + (opaque ? ` · opaque: ${opaque}` : '');
    $('#findings').innerHTML = s.findings.map(f => `<div class="finding"><div class="dot ${f.severity}"></div>
      <div><div class="ttl">${esc(f.title)}</div><div class="det">${esc(f.detail)}</div></div></div>`).join('') || '<div class="muted">No findings.</div>';
  } catch (e) { $('#cov').innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
}

function renderOnboarding() {
  $('#view').innerHTML = `
    <div class="card onboard">
      <h2>👋 Welcome to INVESTigator</h2>
      <p class="muted">A context amplifier for your investing — what moved, why it matters to <em>you</em>, no buy/sell advice.</p>
      <ol class="steps">
        <li><strong>Add your holdings</strong> — go to <a href="#" data-nav="holdings">Holdings</a> and list what you own.</li>
        <li><strong>Set your plan</strong> — targets + a watchlist in <a href="#" data-nav="plan">Plan</a>.</li>
        <li><strong>Run a digest</strong> — come back here and click Run.</li>
        <li><em>Optional:</em> set up <a href="#" data-nav="schedules">automatic digests</a> and pick an <a href="#" data-nav="settings">AI brain</a>.</li>
      </ol>
      <div><a class="btn primary" href="#" data-nav="holdings">Add your first holding →</a></div>
      <p class="muted small" style="margin-top:18px">New here? The <a href="#" data-nav="guide">Guide</a> explains everything.</p>
    </div>`;
  $('#view').querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.nav); }));
}

async function runDigest() {
  const btn = $('#run'); const focus = $('#focus').value, cx = $('#cx').value;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
  try {
    const d = await api.get(`/api/digest?deliver=false&focus=${focus}&complexity=${cx}`);
    const value = d.amounts_provided ? `≈ €${Math.round(d.portfolio_total_eur).toLocaleString()}` : 'amounts not set';
    $('#digest-card').innerHTML = `
      <h2>Digest <span class="pill">${value}</span></h2>
      <div class="sub">${esc(d.data_freshness)}</div>${eventsBlock(d)}`;
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Run digest'; }
}

// ---------- Holdings ----------
const TYPES = ['etf', 'growth_stock', 'experimental', 'equity'];
let holdingRows = [];
function valCell(h) {
  const cv = h.current_value, amt = parseFloat(h.amount_invested_eur) || 0;
  if (!cv) return '<span class="muted">—</span>';
  const cls = cv >= amt ? 'gain' : 'loss', d = amt ? (cv - amt) / amt * 100 : 0;
  return `<span class="${cls}">€${Math.round(cv).toLocaleString()}</span> <span class="muted" style="font-size:11px">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span>`;
}
async function renderHoldings() {
  $('#topbar-actions').innerHTML = '<button class="btn" id="add">+ Add position</button><button class="btn primary" id="save">Save</button>';
  holdingRows = (await api.get('/api/holdings')).holdings.map(h => ({ ...h }));
  drawHoldings();
  $('#add').addEventListener('click', () => { holdingRows.push({ ticker: '', name: '', type: 'equity', amount_invested_eur: '', avg_cost: '', strategy_tag: '' }); drawHoldings(); });
  $('#save').addEventListener('click', saveHoldings);
}
function drawHoldings() {
  const opt = (t, sel) => `<option ${t === sel ? 'selected' : ''}>${t}</option>`;
  $('#view').innerHTML = `<div class="card">
    <h2>Your positions</h2>
    <div class="sub">Only <strong>ticker</strong> is required ${tip('Use Yahoo Finance tickers: EU listings need a suffix (IWDA.AS, CSPX.L); US ones do not (AAPL).')}. Leave amount blank to equal-weight. Type ${tip('etf = a fund (gets look-through). growth_stock / experimental / equity bucket you for plan comparison.')} and tag ${tip('A free label like core / growth / speculative. Used for the “group” focus in schedules.')} are optional.</div>
    <table><thead><tr><th>Ticker</th><th>Name</th><th>Type</th><th class="num">Amount €</th><th class="num">Value now ${tip('Estimated current value = your entered amount adjusted by how the price moved since you set it (updates when a digest fetches prices). It’s an estimate — re-enter the amount any time to reset it.')}</th><th class="num">Avg cost</th><th>Tag</th><th></th></tr></thead>
    <tbody>${holdingRows.map((h, i) => `<tr>
      <td><input data-i="${i}" data-k="ticker" value="${esc(h.ticker)}" placeholder="AAPL"></td>
      <td><input data-i="${i}" data-k="name" value="${esc(h.name)}" placeholder="Apple Inc"></td>
      <td><select data-i="${i}" data-k="type">${TYPES.map(t => opt(t, h.type)).join('')}</select></td>
      <td><input class="num" data-i="${i}" data-k="amount_invested_eur" value="${esc(h.amount_invested_eur ?? '')}" placeholder="—"></td>
      <td class="num">${valCell(h)}</td>
      <td><input class="num" data-i="${i}" data-k="avg_cost" value="${esc(h.avg_cost ?? '')}" placeholder="—"></td>
      <td><input data-i="${i}" data-k="strategy_tag" value="${esc(h.strategy_tag)}" placeholder="core"></td>
      <td><button class="btn ghost" data-del="${i}">✕</button></td></tr>`).join('')}</tbody></table>
    ${holdingRows.length ? '' : '<div class="empty">No positions yet — click “Add position”.</div>'}</div>`;
  $('#view').querySelectorAll('input,select').forEach(el => el.addEventListener('input', () => { holdingRows[el.dataset.i][el.dataset.k] = el.value; }));
  $('#view').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { holdingRows.splice(+b.dataset.del, 1); drawHoldings(); }));
}
async function saveHoldings() {
  const clean = holdingRows.filter(h => h.ticker && h.ticker.trim()).map(h => ({
    ticker: h.ticker.trim(), name: h.name || '', type: h.type || 'equity',
    amount_invested_eur: h.amount_invested_eur === '' ? null : h.amount_invested_eur,
    avg_cost: h.avg_cost === '' ? null : h.avg_cost, strategy_tag: h.strategy_tag || '',
  }));
  try { await api.put('/api/holdings', clean); toast(`Saved ${clean.length} position(s)`); loadStatus(); } catch (e) { toast(e.message, true); }
}

// ---------- Plan ----------
let plan;
const debouncedSavePlan = debounce(savePlan);
async function renderPlan() {
  $('#topbar-actions').innerHTML = savedTag;
  plan = await api.get('/api/plan'); drawPlan();
}
function drawPlan() {
  const th = plan.thresholds || {}, pr = plan.profile || {};
  $('#view').innerHTML = `<div class="grid">
    <div class="card"><h2>Contributions & profile</h2>
      <div class="field"><label>Monthly contribution (€)</label><input id="mc" value="${esc(plan.monthly_contribution_eur)}"></div>
      <div class="field"><label>Country</label><input id="country" value="${esc(pr.country || '')}"></div>
      <div class="field"><label>Currency</label><input id="currency" value="${esc(pr.currency || 'EUR')}"></div></div>
    <div class="card"><h2>Allocation targets ${tip('Fractions that sum to ~1.0. Compared with your real allocation to flag drift.')}</h2>
      <div id="targets"></div>
      <div class="row"><input id="nt-key" placeholder="bucket (etf)" style="max-width:150px"><input id="nt-val" placeholder="0.80" style="max-width:90px"><button class="btn" id="nt-add">Add</button></div></div>
    <div class="card"><h2>Watchlist ${tip('Tickers (NVDA) or themes (clean energy) you are considering. They get their own “On your radar” section.')}</h2>
      <div id="wl">${(plan.watchlist || []).map((w, i) => `<span class="chip">${esc(w)}<button data-wl="${i}">✕</button></span>`).join('')}</div>
      <div class="row" style="margin-top:8px"><input id="wl-new" placeholder="NVDA or clean energy" style="max-width:200px"><button class="btn" id="wl-add">Add</button></div></div>
    <div class="card"><h2>Thresholds ${tip('How aggressively to filter. Higher = quieter digests. Investments and watchlist are tuned separately.')}</h2>
      <div class="sub">Your investments</div>
      <div class="field"><label>Min daily price move to flag (%)</label><input id="pm" value="${esc(th.price_move_pct ?? 3)}"></div>
      <div class="field"><label>Min urgency to report (0–10)</label><input id="mu" value="${esc(th.min_urgency_to_report ?? 2)}"></div>
      <div class="field"><label>News lookback (days)</label><input id="nl" value="${esc(th.news_lookback_days ?? 7)}"></div>
      <div class="sub" style="margin-top:6px">Watchlist ${tip('Names you are tracking but do not own. Keep these permissive to see (almost) every news item about them.')}</div>
      <div class="field"><label>Watchlist min urgency (0 = show everything)</label><input id="wmu" value="${esc(th.watchlist_min_urgency ?? 0)}"></div>
      <div class="field"><label>Max news per watched name</label><input id="wmax" value="${esc(th.watchlist_max_per_item ?? 8)}"></div></div></div>`;
  drawTargets();
  const mutate = () => { drawPlan(); savePlan(); };
  $('#nt-add').addEventListener('click', () => { const k = $('#nt-key').value.trim(), v = parseFloat($('#nt-val').value); if (k && !isNaN(v)) { plan.allocation_targets[k] = v; mutate(); } });
  $('#wl-add').addEventListener('click', () => { const w = $('#wl-new').value.trim(); if (w) { plan.watchlist = plan.watchlist || []; plan.watchlist.push(w); mutate(); } });
  $('#view').querySelectorAll('[data-wl]').forEach(b => b.addEventListener('click', () => { plan.watchlist.splice(+b.dataset.wl, 1); mutate(); }));
  // Auto-save text fields (debounced).
  ['mc', 'country', 'currency', 'pm', 'mu', 'nl', 'wmu', 'wmax'].forEach(id => {
    const el = $('#' + id); if (el) el.addEventListener('input', () => { setSaved('Saving…'); debouncedSavePlan(); });
  });
}
function drawTargets() {
  const at = plan.allocation_targets || {};
  $('#targets').innerHTML = Object.entries(at).map(([k, v]) => `<div class="bar-row" style="grid-template-columns:120px 1fr 70px 28px">
    <div class="bar-label">${esc(k)}</div><div class="bar-track"><div class="bar-fill" style="width:${(v * 100).toFixed(0)}%"></div></div>
    <div class="bar-val">${(v * 100).toFixed(0)}%</div><button class="btn ghost" data-tk="${esc(k)}">✕</button></div>`).join('');
  $('#targets').querySelectorAll('[data-tk]').forEach(b => b.addEventListener('click', () => { delete plan.allocation_targets[b.dataset.tk]; drawPlan(); savePlan(); }));
}
async function savePlan() {
  const body = {
    profile: { ...(plan.profile || {}), country: $('#country').value, currency: $('#currency').value },
    monthly_contribution_eur: parseFloat($('#mc').value) || 0, allocation_targets: plan.allocation_targets || {},
    watchlist: plan.watchlist || [], thresholds: {
      price_move_pct: parseFloat($('#pm').value) || 3, min_urgency_to_report: parseFloat($('#mu').value) || 2,
      news_lookback_days: parseInt($('#nl').value) || 7,
      watchlist_min_urgency: parseFloat($('#wmu').value) || 0, watchlist_max_per_item: parseInt($('#wmax').value) || 8,
    },
  };
  try { await api.put('/api/plan', body); setSaved('Saved ✓'); } catch (e) { setSaved('Save failed'); toast(e.message, true); }
}

// ---------- Schedules ----------
let scheds = [], schedMeta = {};
const debouncedSyncSched = debounce(syncSchedules, 1500);
const debouncedSaveSched = debounce(async (i) => {
  try { await persistSchedule(i); setSaved('Saved ✓'); debouncedSyncSched(); }
  catch (e) { setSaved('Save failed'); toast(e.message, true); }
}, 700);
async function renderSchedules() {
  $('#topbar-actions').innerHTML = savedTag + '<button class="btn" id="add">+ New schedule</button><button class="btn primary" id="sync">Sync to Windows now</button>';
  const data = await api.get('/api/schedules');
  scheds = data.schedules; schedMeta = data;
  drawSchedules();
  $('#add').addEventListener('click', addSchedule);
  $('#sync').addEventListener('click', syncSchedules);
}
async function addSchedule() {
  try {
    const created = await api.put('/api/schedules', { name: 'New digest', frequency: 'weekly', time: '08:00', complexity: 'standard', focus: 'all', delivery: [], enabled: true });
    scheds.push(created.schedule); drawSchedules(); setSaved('Saved ✓'); debouncedSyncSched();
  } catch (e) { toast(e.message, true); }
}
function drawSchedules() {
  const fr = schedMeta.frequencies || ['daily', 'weekly'], cx = schedMeta.complexities || ['standard'];
  const opt = (arr, sel) => arr.map(o => `<option ${o === sel ? 'selected' : ''}>${o}</option>`).join('');
  $('#view').innerHTML = `
    <div class="card"><div class="sub">Automatic digests run by Windows Task Scheduler ${tip('Each schedule becomes a Windows task so digests fire even when the app is closed. Click “Sync to Windows” after editing.')}. Add as many as you like — e.g. a daily “urgent” watchlist alert plus a weekly full review.</div></div>
    ${scheds.map((s, i) => `<div class="card">
      <div class="row" style="align-items:center;justify-content:space-between">
        <input data-i="${i}" data-k="name" value="${esc(s.name)}" style="max-width:240px;font-weight:600">
        <div class="row" style="align-items:center">
          <label class="switch"><input type="checkbox" data-i="${i}" data-k="enabled" ${s.enabled ? 'checked' : ''}><span class="slider"></span></label>
          <button class="btn" data-run="${i}">Run now</button>
          <button class="btn ghost" data-del="${i}">✕</button></div></div>
      <div class="row" style="margin-top:12px">
        <div class="field" style="margin:0"><label>Frequency</label><select data-i="${i}" data-k="frequency">${opt(fr, s.frequency)}</select></div>
        <div class="field" style="margin:0"><label>Time</label><input data-i="${i}" data-k="time" value="${esc(s.time)}" style="max-width:90px"></div>
        <div class="field" style="margin:0"><label>Complexity ${tip('simple = only clearly relevant. standard = balanced. complex = more + full structure. urgent = high-urgency alerts only. none = everything.')}</label><select data-i="${i}" data-k="complexity">${opt(cx, s.complexity)}</select></div>
        <div class="field" style="margin:0"><label>Focus ${tip('all = holdings + watchlist. invested = holdings only. watchlist = discovery only. group:&lt;tag&gt; = only positions with that tag/type.')}</label><input data-i="${i}" data-k="focus" value="${esc(s.focus)}" placeholder="all / invested / watchlist / group:growth_stock" style="max-width:240px"></div>
      </div>
      <label style="margin:12px 0 0;display:flex;align-items:center;gap:8px;cursor:pointer;width:fit-content">
        <input type="checkbox" data-i="${i}" data-k="skip_if_empty" ${s.skip_if_empty ? 'checked' : ''} style="width:16px;height:16px;margin:0;flex:none">
        <span>Only send if something was found ${tip('If on, a run with no events/watchlist items is NOT delivered (no empty “quiet is good” email) — it is still saved to History.')}</span></label>
      <div class="muted small" style="margin-top:8px">${s.id ? 'id ' + s.id : 'unsaved — Sync to register'}</div>
    </div>`).join('')}
    ${scheds.length ? '' : '<div class="empty">No schedules yet — click “New schedule”.</div>'}`;
  $('#view').querySelectorAll('input,select').forEach(el => {
    const k = el.dataset.k; if (!k) return;
    const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, () => {
      scheds[el.dataset.i][k] = el.type === 'checkbox' ? el.checked : el.value;
      setSaved('Saving…'); debouncedSaveSched(+el.dataset.i);
    });
  });
  $('#view').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const s = scheds[+b.dataset.del]; if (s.id) { try { await api.del('/api/schedules/' + s.id); } catch (e) { toast(e.message, true); } }
    scheds.splice(+b.dataset.del, 1); drawSchedules(); setSaved('Saved ✓'); debouncedSyncSched();
  }));
  $('#view').querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runScheduleNow(+b.dataset.run, b)));
}
async function persistSchedule(i) {
  const saved = await api.put('/api/schedules', scheds[i]); scheds[i] = saved.schedule; return scheds[i];
}
async function runScheduleNow(i, btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const s = await persistSchedule(i);
    const d = await api.post(`/api/schedules/${s.id}/run`);
    const rep = d.delivery_report || [];
    const sent = rep.map(r => r.ok ? `✓ ${r.channel}` : `✗ ${r.channel}: ${r.error}`).join('\n');
    const anyFail = rep.some(r => !r.ok);
    toast(`“${s.name}” ran — ${d.events.length} events, ${d.watchlist.length} on radar.\nDelivery:\n${sent || '(no channels)'}`, anyFail);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; drawSchedules(); }
}
async function syncSchedules() {
  const btn = $('#sync'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Syncing…';
  try {
    for (let i = 0; i < scheds.length; i++) await persistSchedule(i);
    const res = await api.post('/api/schedules/sync');
    drawSchedules();
    if (res.error) toast(res.error, true);
    else toast(res.ok ? 'Synced to Windows Task Scheduler ✓' : 'Synced with some issues — see Guide', !res.ok);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = 'Sync to Windows'; }
}

// ---------- History ----------
async function renderHistory() {
  const data = await api.get('/api/history');
  const list = data.history || [];
  $('#view').innerHTML = `
    <div class="card"><h2>Previous digests ${tip('Every digest you generate, and every one a schedule delivers, is saved here (last 200). Click one to reopen it.')}</h2>
      <div class="sub">A timeline of what INVESTigator has surfaced for you.</div>
      <div id="hist-list">${list.length ? list.map(histRow).join('') : '<div class="empty">No digests yet — run one from the Dashboard.</div>'}</div></div>
    <div id="hist-detail"></div>`;
  $('#view').querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => openHistory(+b.dataset.h)));
}
function histRow(h) {
  const dt = new Date(h.created_at).toLocaleString();
  return `<div class="evt" data-h="${h.id}" style="cursor:pointer">
    <div class="evt-top"><span class="badge low">${esc(h.complexity || '')}</span>
      <span class="evt-tkr">${esc(dt)}</span><span class="muted small">focus: ${esc(h.focus || 'all')}</span>
      <span class="evt-src">${h.events_count} events · ${h.watch_count} radar</span></div></div>`;
}
async function openHistory(id) {
  const d = await api.get('/api/history/' + id);
  const value = d.amounts_provided ? `≈ €${Math.round(d.portfolio_total_eur).toLocaleString()}` : 'amounts not set';
  $('#hist-detail').innerHTML = `<div class="card"><h2>Digest <span class="pill">${value}</span></h2>
    <div class="sub">${esc(d.data_freshness)}</div>${eventsBlock(d)}${findingsBlock(d.structure)}</div>`;
  $('#hist-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Settings (incl. Sources) ----------
let settings, sources = [];
const debouncedSaveSettings = debounce(saveSettings);
async function renderSettings() {
  $('#topbar-actions').innerHTML = savedTag;
  settings = await api.get('/api/settings');
  sources = (await api.get('/api/sources')).sources || [];
  drawSettings();
}
function drawSettings() {
  const s = settings, dv = s.delivery || [];
  const sel = (p) => s.llm_provider === p ? 'selected' : '', chk = (c) => dv.includes(c) ? 'checked' : '';
  $('#view').innerHTML = `<div class="grid">
    <div class="card"><h2>AI narrative brain ${tip('Optional. The app works fully without AI. Ollama is local + free; Claude needs an API key. See the Guide to set up Ollama.')}</h2>
      <div class="sub">Turns the computed numbers into prose. Numbers are always computed in code — the AI never changes them.</div>
      <div class="field"><label>Provider</label><select id="llm">
        <option value="template" ${sel('template')}>Template — no AI, always works</option>
        <option value="ollama" ${sel('ollama')}>Ollama — local, free, private</option>
        <option value="claude" ${sel('claude')}>Claude — best quality, needs key</option></select></div>
      <div id="ollama-fields" style="display:none">
        <div class="field"><label>Ollama host</label><input id="ohost" value="${esc(s.ollama_host)}"></div>
        <div class="field"><label>Ollama model</label><input id="omodel" value="${esc(s.ollama_model)}"></div></div>
      <div id="claude-fields" style="display:none">
        <div class="field"><label>Anthropic API key</label><input id="akey" type="password" value="${s.anthropic_api_key === '********' ? '' : esc(s.anthropic_api_key)}" placeholder="${s.anthropic_api_key === '********' ? 'saved — leave blank to keep' : 'sk-ant-…'}"></div>
        <div class="field"><label>Claude model</label><input id="amodel" value="${esc(s.anthropic_model)}"></div></div></div>
    <div class="card"><h2>Delivery</h2><div class="sub">Where digests go when run.</div>
      <div class="field"><label><input type="checkbox" id="d-console" ${chk('console')}> Console</label></div>
      <div class="field"><label><input type="checkbox" id="d-discord" ${chk('discord')}> Discord webhook</label>
        <input id="discord" value="${esc(s.discord_webhook_url)}" placeholder="https://discord.com/api/webhooks/…"></div>
      <div class="field"><label><input type="checkbox" id="d-email" ${chk('email')}> Email (SMTP)</label></div>
      <div id="smtp-fields" style="display:none">
        <div class="field"><label>SMTP host ${tip('Your mail provider’s outgoing server. Gmail = smtp.gmail.com, Outlook = smtp.office365.com.')}</label><input id="smtp-host" value="${esc(s.smtp?.host || '')}" placeholder="smtp.gmail.com"></div>
        <div class="field"><label>Your email — login &amp; sender ${tip('The account that sends the digest. This is also the “From” address.')}</label><input id="smtp-user" value="${esc(s.smtp?.user || '')}" placeholder="you@gmail.com"></div>
        <div class="field"><label>Email password ${tip('For Gmail this MUST be an App Password (Google account → Security → 2-Step Verification → App passwords), not your normal password. Spaces are fine — they’re stripped automatically.')}</label><input id="smtp-pass" type="password" value="${s.smtp?.password === '********' ? '' : esc(s.smtp?.password || '')}" placeholder="${s.smtp?.password === '********' ? 'saved — leave blank to keep' : 'app password (e.g. abcd efgh ijkl mnop)'}"></div>
        <div class="field"><label>Send digests to ${tip('Where the digest is delivered. To email yourself, put your OWN address here (same as above).')}</label><input id="smtp-to" value="${esc(s.smtp?.to || '')}" placeholder="you@gmail.com (yourself)"></div>
        <div class="field"><button class="btn" id="smtp-test">Send test email</button> <span class="muted small">Saves, then sends a test so you can confirm it works.</span></div>
      </div></div>
    <div class="card"><h2>Extra news sources ${tip('Add sites/feeds so the app also searches there. domain = e.g. ft.com (we query that site for your names). rss = a full feed URL we scan and match to your holdings.')}</h2>
      <div class="sub">Expands where INVESTigator looks beyond the default Google News + Yahoo.</div>
      <div id="sources"></div>
      <div class="row" style="margin-top:8px">
        <select id="src-type" style="max-width:110px"><option value="domain">domain</option><option value="rss">rss feed</option></select>
        <input id="src-val" placeholder="ft.com  or  https://site.com/rss" style="max-width:280px"><button class="btn" id="src-add">Add</button></div></div>
  </div>`;
  drawSources();
  const toggle = () => {
    $('#ollama-fields').style.display = $('#llm').value === 'ollama' ? '' : 'none';
    $('#claude-fields').style.display = $('#llm').value === 'claude' ? '' : 'none';
    $('#smtp-fields').style.display = $('#d-email').checked ? '' : 'none';
  };
  // Auto-save: selects/checkboxes immediately, text fields debounced.
  $('#llm').addEventListener('change', () => { toggle(); saveSettings(); });
  ['d-console', 'd-discord', 'd-email'].forEach(id => $('#' + id).addEventListener('change', () => { toggle(); saveSettings(); }));
  ['ohost', 'omodel', 'akey', 'amodel', 'discord', 'smtp-host', 'smtp-user', 'smtp-pass', 'smtp-to'].forEach(id => {
    const el = $('#' + id); if (el) el.addEventListener('input', () => { setSaved('Saving…'); debouncedSaveSettings(); });
  });
  toggle();
  $('#smtp-test')?.addEventListener('click', async () => {
    const btn = $('#smtp-test'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await saveSettings();  // persist the latest host/email/password first
      const r = await api.post('/api/test-email');
      if (r.ok) toast('Test email sent ✓ — check your inbox (and spam)');
      else toast('Email failed: ' + r.error, true);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Send test email'; }
  });
  $('#src-add').addEventListener('click', () => {
    const v = $('#src-val').value.trim(); if (!v) return;
    sources.push({ type: $('#src-type').value, value: v, name: v }); drawSources(); $('#src-val').value = ''; saveSettings();
  });
}
function drawSources() {
  $('#sources').innerHTML = sources.map((s, i) => `<span class="chip">${esc(s.type)}: ${esc(s.value)}<button data-src="${i}">✕</button></span>`).join('') || '<span class="muted small">Using defaults only (Google News + Yahoo).</span>';
  $('#sources').querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => { sources.splice(+b.dataset.src, 1); drawSources(); saveSettings(); }));
}
async function saveSettings() {
  const delivery = ['console', 'discord', 'email'].filter(c => $('#d-' + c).checked);
  const body = { llm_provider: $('#llm').value, delivery, ollama_host: $('#ohost')?.value, ollama_model: $('#omodel')?.value, anthropic_model: $('#amodel')?.value, discord_webhook_url: $('#discord').value };
  const akey = $('#akey')?.value; if (akey && akey !== '********') body.anthropic_api_key = akey;
  const sm = { host: $('#smtp-host')?.value || '', user: $('#smtp-user')?.value || '', to: $('#smtp-to')?.value || '' };
  sm.from = sm.user;  // sender = your email account
  const pw = $('#smtp-pass')?.value; if (pw && pw !== '********') sm.password = pw;
  body.smtp = sm;
  try { await api.put('/api/settings', body); await api.put('/api/sources', sources); setSaved('Saved ✓'); loadStatus(); }
  catch (e) { setSaved('Save failed'); toast(e.message, true); }
}

// ---------- Guide ----------
async function renderGuide() {
  $('#view').innerHTML = `<div class="guide">
    <div class="card"><h2>How INVESTigator works</h2>
      <p class="muted">It pulls your holdings + free public data (prices, news, ETF holdings), computes what matters to <em>you</em> in code, and writes a calm briefing. It never tells you to buy or sell — it amplifies your own thinking.</p></div>
    <details open><summary>What the holding fields & tags mean</summary>
      <p><strong>Ticker</strong> — the Yahoo Finance symbol. EU listings need an exchange suffix (<code>IWDA.AS</code>, <code>CSPX.L</code>, <code>VWCE.DE</code>); US tickers don't (<code>AAPL</code>).</p>
      <p><strong>Type</strong> — <code>etf</code> gets ETF look-through (decomposed into underlying stocks); <code>growth_stock</code>, <code>experimental</code>, <code>equity</code> are buckets compared against your plan's allocation targets.</p>
      <p><strong>Amount €</strong> — optional. With it, exposure/urgency is weighted by position size; without, everything is equal-weighted.</p>
      <p><strong>Tag</strong> — a free label (e.g. <code>core</code>, <code>growth</code>, <code>speculative</code>). Used by the <code>group:&lt;tag&gt;</code> schedule focus.</p></details>
    <details><summary>Complexity & focus (used in digests + schedules)</summary>
      <table><tr><td><strong>simple</strong></td><td>Only clearly-relevant items, no structure section.</td></tr>
      <tr><td><strong>standard</strong></td><td>The balanced default — events + full structure.</td></tr>
      <tr><td><strong>complex</strong></td><td>More items + full structure analysis.</td></tr>
      <tr><td><strong>urgent</strong></td><td>Only high-urgency alerts. Great for a daily heads-up.</td></tr>
      <tr><td><strong>none</strong></td><td>No filtering — show almost everything.</td></tr></table>
      <p style="margin-top:10px"><strong>Focus:</strong> <code>all</code> (holdings + watchlist), <code>invested</code> (holdings only), <code>watchlist</code> (discovery only), or <code>group:growth_stock</code> / <code>group:core</code> (only positions with that type or tag).</p></details>
    <details><summary>Setting up Ollama (free local AI)</summary>
      <p>The app works without AI, but Ollama gives nicer summaries, fully offline & private.</p>
      <p>1. Install from <code>ollama.com</code>. &nbsp; 2. In a terminal: <code>ollama pull llama3.1</code>. &nbsp; 3. It serves at <code>http://localhost:11434</code> automatically.</p>
      <p>4. In <strong>Settings → AI brain</strong>, pick <kbd>Ollama</kbd>, set the model to <code>llama3.1</code> (or any model you pulled), Save. Done.</p></details>
    <details><summary>Adding extra news sources</summary>
      <p><strong>domain</strong> — enter a site like <code>reuters.com</code> or <code>ft.com</code>. The app runs targeted queries for your holdings restricted to that site, so its coverage is pulled in.</p>
      <p><strong>rss feed</strong> — paste a full RSS/Atom URL. The app scans the feed and matches articles that mention your holdings or watchlist names.</p>
      <p>Manage these in <strong>Settings → Extra news sources</strong>.</p></details>
    <details><summary>Setting up email delivery (SMTP / Gmail) — emailing yourself</summary>
      <p>Go to <strong>Settings → Delivery</strong>, tick <kbd>Email (SMTP)</kbd>. Four fields:</p>
      <ul>
        <li><strong>SMTP host</strong> — your provider's server. Gmail = <code>smtp.gmail.com</code>, Outlook = <code>smtp.office365.com</code>.</li>
        <li><strong>Your email (login &amp; sender)</strong> — the account that sends the digest, e.g. <code>you@gmail.com</code>. This is also the "From".</li>
        <li><strong>Email password</strong> — for Gmail this must be an <em>App Password</em>, not your normal password: Google account → Security → 2-Step Verification → App passwords. Outlook/others may also need an app password.</li>
        <li><strong>Send digests to</strong> — the recipient. <strong>To email yourself, put your own address here</strong> (the same as above).</li>
      </ul>
      <p>So mailing yourself = the "sender" and "send to" fields are the same address. Settings save automatically. Then click <strong>Send test email</strong> to confirm it works (it reports the exact error if something's wrong — usually a wrong app password).</p>
      <p class="small">Notes: the Gmail app password is shown as four groups like <code>abcd efgh ijkl mnop</code> — paste it as-is, the spaces are stripped automatically. The saved password shows blank with "leave blank to keep" — that's normal, it's hidden for security. The dashboard "Run digest" is a <em>preview</em> and does not send; emails go out from <strong>schedules</strong> (or the test button).</p></details>
    <details><summary>Setting up Discord delivery (webhook)</summary>
      <p>A webhook posts digests straight into a Discord channel. You need a server you can manage (create a free personal one in 10 seconds with the <kbd>+</kbd> on Discord's left bar if you don't have one).</p>
      <ol>
        <li>In Discord, open the target channel and click the ⚙️ <strong>Edit Channel</strong> (or <strong>Server Settings → Integrations</strong>).</li>
        <li>Go to <strong>Integrations → Webhooks → New Webhook</strong>.</li>
        <li>Give it a name (e.g. "INVESTigator") and pick the channel it should post to.</li>
        <li>Click <strong>Copy Webhook URL</strong> — it looks like <code>https://discord.com/api/webhooks/123…/abc…</code>.</li>
        <li>Paste it into <strong>Settings → Delivery → Discord webhook</strong> and tick <kbd>Discord webhook</kbd>. It saves automatically.</li>
      </ol>
      <p class="small">Treat the webhook URL like a password — anyone with it can post to that channel. Long digests are split into multiple messages automatically. As with email, digests post from <strong>schedules</strong> (or a schedule's "Run now"), not the dashboard preview.</p></details>
    <details><summary>Automatic digests (schedules)</summary>
      <p>Create one or more schedules in the <strong>Schedules</strong> tab — each with its own frequency, time, complexity and focus. Click <strong>Sync to Windows</strong> to register them with Windows Task Scheduler so they run even when the app is closed.</p>
      <p>Example combo: a <em>daily · urgent · watchlist</em> alert + a <em>weekly · complex · all</em> full review. Use <strong>Run now</strong> to preview any schedule immediately.</p>
      <p class="small">If sync reports issues, it's usually a permissions prompt — re-run, or create the task manually from the command shown in the console.</p></details>
    <details><summary>Look-through, coverage & “opaque”</summary>
      <p><strong>Look-through</strong> decomposes your ETFs into their real holdings, so you see your <em>true</em> exposure (e.g. Apple held directly + inside a World ETF). <strong>Coverage</strong> is the % of your portfolio we could decompose. <strong>Opaque</strong> (striped bars) = ETFs with no free holdings feed (e.g. Vanguard) — shown honestly rather than ignored.</p></details>
    <details><summary>The guardrails</summary>
      <p>No buy/sell/hold advice, ever. Numbers are computed deterministically — the AI only narrates. Every item explains <em>why it matters to you</em>. Small moves and generic chatter are filtered out.</p></details>
  </div>`;
}

// ---------- boot ----------
window.addEventListener('hashchange', () => render(location.hash.slice(1) || 'dashboard'));
loadStatus();
render(location.hash.slice(1) || 'dashboard');
