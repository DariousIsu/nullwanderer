/* Legislation surface — operator data browser. Calls window.sq.leg.* over IPC (main maps engine
   payloads to view shapes via studio/leg_view.js). Toolbar facets + FTS search drive a bill list
   (offset-paginated); selecting a bill loads summary + sponsors + votes + related. Read-only. */
'use strict';
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), detailEl = $('detail'), headEl = $('listhead'), chipsEl = $('chips'), qEl = $('q');
const selators = { state: $('f-state'), session: $('f-session'), bill_type: $('f-bill_type'), chamber_origin: $('f-chamber_origin'), year: $('f-year') };
let filters = {};
let offset = 0, total = 0, hasMore = false;
let activeId = null, mode = 'browse';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderChips() {
  chipsEl.innerHTML = Object.keys(filters).filter(k => filters[k]).map(k =>
    `<span class="fchip" data-k="${k}">${esc(k.replace('_origin', '').replace('bill_', ''))}: ${esc(filters[k])} <span class="x">×</span></span>`).join('');
  chipsEl.querySelectorAll('.fchip').forEach(el => el.addEventListener('click', () => setFilter(el.dataset.k, '')));
}

function rowHtml(b) {
  const mt = [b.typeLabel, b.state, b.session, b.sponsors ? `${b.sponsors} sp` : '', (b.yea || b.nay) ? `${b.yea}-${b.nay}` : '', b.related ? `${b.related} rel` : '']
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="bitem${b.id === activeId ? ' active' : ''}" data-id="${esc(b.id)}">
    <div class="nm">${esc(b.name)}</div>${b.summary ? `<div class="sm">${esc(b.summary)}</div>` : ''}<div class="mt">${mt}</div></div>`;
}
function bindRows() { rowsEl.querySelectorAll('.bitem').forEach(el => el.addEventListener('click', () => openBill(el.dataset.id))); }

function renderList(items, { append = false } = {}) {
  const html = items.map(rowHtml).join('') || (append ? '' : '<div class="status">No matching bills.</div>');
  const moreBtn = (mode === 'browse' && hasMore) ? `<div class="more"><button id="moreBtn">Load more</button></div>` : '';
  if (append) { const old = $('moreBtn'); if (old) old.parentElement.remove(); rowsEl.insertAdjacentHTML('beforeend', html + moreBtn); }
  else rowsEl.innerHTML = html + moreBtn;
  const mb = $('moreBtn'); if (mb) mb.addEventListener('click', loadMore);
  bindRows();
}

async function refresh() {
  const term = qEl.value.trim();
  mode = term ? 'search' : 'browse';
  offset = 0;
  if (mode === 'browse' && !Object.keys(filters).some(k => filters[k])) {
    headEl.textContent = 'Filter or search to begin…';
    rowsEl.innerHTML = '<div class="status">Pick a state / session / type, or search bill text.</div>';
    return;
  }
  headEl.textContent = 'Loading…';
  try {
    let res;
    if (mode === 'search') res = await window.sq.leg.search(term, filters);
    else res = await window.sq.leg.browse(filters, 0);
    if (!res || !res.ok) { rowsEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed')}</div>`; headEl.textContent = ''; return; }
    const list = res.list;
    total = list.total || list.items.length; hasMore = !!list.hasMore; offset = list.offset || list.items.length;
    headEl.textContent = mode === 'search'
      ? `${list.items.length} result${list.items.length === 1 ? '' : 's'}`
      : `${total.toLocaleString()} bills${list.items.length < total ? ` · showing ${list.items.length}` : ''}`;
    renderList(list.items);
  } catch (e) { rowsEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; headEl.textContent = ''; }
}

async function loadMore() {
  if (!hasMore) return;
  const btn = $('moreBtn'); if (btn) btn.textContent = 'Loading…';
  try {
    const res = await window.sq.leg.browse(filters, offset);
    if (res && res.ok) { hasMore = !!res.list.hasMore; offset = res.list.offset || offset; renderList(res.list.items, { append: true }); }
  } catch (e) { /* leave as-is */ }
}

function sponsorHtml(s) {
  const meta = [s.party, s.chamber, s.state].filter(Boolean).map(esc).join(' · ');
  return `<div class="sp"><span class="nm">${esc(s.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}${s.linked ? '<span class="lk">CRM</span>' : ''}</div>`;
}

function renderCard(c) {
  if (!c) { detailEl.innerHTML = `<div class="err">⚠ bill not found</div>`; return; }
  const meta = [
    c.typeLabel && `<b>${esc(c.typeLabel)}</b>`,
    c.state && `<span>${esc(c.state)}</span>`,
    c.session && `<span>${esc(c.session)}</span>`,
    c.year && `<span>${esc(c.year)}</span>`,
    c.chamberLabel && `<span>${esc(c.chamberLabel)}</span>`,
  ].filter(Boolean).join('');
  const sponsorSec = c.sponsors.length
    ? `<div class="sec"><div class="h"><span>Sponsors</span><span>${c.counts.sponsors}</span></div>${c.sponsors.map(sponsorHtml).join('')}</div>` : '';
  const voteSec = (c.counts.yea || c.counts.nay || c.votesYea.length || c.votesNay.length)
    ? `<div class="sec"><div class="h">Votes</div><div class="votes"><span class="y">▲ ${c.counts.yea} yea</span><span class="n">▼ ${c.counts.nay} nay</span></div>${c.votesYea.length ? `<div class="status">Yea: ${c.votesYea.slice(0, 12).map(esc).join(', ')}</div>` : ''}${c.votesNay.length ? `<div class="status">Nay: ${c.votesNay.slice(0, 12).map(esc).join(', ')}</div>` : ''}</div>` : '';
  const relSec = c.related.length
    ? `<div class="sec"><div class="h"><span>Related bills</span><span>${c.related.length}</span></div>${c.related.map(r => `<div class="sp"><span class="nm">${esc(r.name || r.id)}</span>${r.relation ? `<span class="meta">${esc(r.relation)}</span>` : ''}</div>`).join('')}</div>` : '';
  detailEl.innerHTML = `
    <div class="b-name">${esc(c.name)}</div>
    <div class="b-meta">${meta}</div>
    ${c.summary ? `<div class="b-summary">${esc(c.summary)}</div>` : ''}
    ${sponsorSec}${voteSec}${relSec}`;
}

async function openBill(id) {
  activeId = id;
  rowsEl.querySelectorAll('.bitem').forEach(el => el.classList.toggle('active', el.dataset.id == id));
  detailEl.innerHTML = `<div class="status">Loading bill…</div>`;
  try {
    const res = await window.sq.leg.get(id);
    if (!res || !res.ok) { detailEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load bill')}</div>`; return; }
    renderCard(res.card);
  } catch (e) { detailEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

function setFilter(key, value) {
  if (value) filters[key] = value; else delete filters[key];
  if (selators[key]) selators[key].value = value || '';
  renderChips(); refresh();
}

async function loadFacets() {
  try {
    const res = await window.sq.leg.facets(filters);
    if (!res || !res.ok) return;
    for (const g of res.groups) {
      const sel = selators[g.key]; if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = `<option value="">${esc(g.label)}</option>` + g.options.map(o => `<option value="${esc(o.value)}">${esc(o.label)} (${o.count.toLocaleString()})</option>`).join('');
      sel.value = cur;
    }
  } catch (e) { /* leave empty */ }
}

Object.keys(selators).forEach(k => selators[k].addEventListener('change', () => setFilter(k, selators[k].value)));
let t; qEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 350); });
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); refresh(); } });

(async () => { await loadFacets(); })();
