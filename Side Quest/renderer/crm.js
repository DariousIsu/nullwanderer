/* CRM (Rolodex) surface — operator data browser. Calls window.sq.crm.* over IPC (main maps engine
   payloads to view shapes via studio/crm_view.js). Toolbar facets + search drive a contact list;
   selecting a contact loads the full record + related-list counts. Read-only, no model. */
'use strict';
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), detailEl = $('detail'), headEl = $('listhead'), chipsEl = $('chips'), qEl = $('q');
const selators = { party: $('f-party'), chamber: $('f-chamber'), state: $('f-state'), tier: $('f-tier') };
const FACET_KEY = { party: 'party', chamber: 'chamber', state: 'state', tier: 'tier' };
let filters = {};         // { party, chamber, state, tier }
let cursor = null;        // browse pagination
let activeId = null;
let mode = 'browse';      // 'browse' | 'search'

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderChips() {
  chipsEl.innerHTML = Object.keys(filters).filter(k => filters[k]).map(k =>
    `<span class="fchip" data-k="${k}">${esc(k)}: ${esc(filters[k])} <span class="x">×</span></span>`).join('');
  chipsEl.querySelectorAll('.fchip').forEach(el => el.addEventListener('click', () => { setFilter(el.dataset.k, ''); }));
}

function rowHtml(c) {
  const sub = [c.partyLabel, c.chamberLabel, c.state, c.district].filter(Boolean).map(esc).join(' · ');
  return `<div class="citem${c.id === activeId ? ' active' : ''}" data-id="${esc(c.id)}">
    <div class="nm">${esc(c.name)}</div>
    <div class="sub"><span class="pdot ${esc(c.party)}"></span>${sub}</div></div>`;
}

function bindRows() { rowsEl.querySelectorAll('.citem').forEach(el => el.addEventListener('click', () => openContact(el.dataset.id))); }

function renderList(res, { append = false } = {}) {
  const items = res.items || [];
  const html = items.map(rowHtml).join('') || '<div class="status">No matching contacts.</div>';
  const moreBtn = (mode === 'browse' && cursor) ? `<div class="more"><button id="moreBtn">Load more</button></div>` : '';
  if (append) rowsEl.insertAdjacentHTML('beforeend', html);
  else rowsEl.innerHTML = html + moreBtn;
  if (!append && moreBtn) $('moreBtn') && $('moreBtn').addEventListener('click', loadMore);
  // re-attach moreBtn after append
  if (append && cursor) {
    const old = $('moreBtn'); if (old) old.parentElement.remove();
    rowsEl.insertAdjacentHTML('beforeend', `<div class="more"><button id="moreBtn">Load more</button></div>`);
    $('moreBtn').addEventListener('click', loadMore);
  }
  bindRows();
}

async function refresh() {
  const term = qEl.value.trim();
  mode = term ? 'search' : 'browse';
  cursor = null;
  headEl.textContent = 'Loading…';
  try {
    let res;
    if (mode === 'search') { res = await window.sq.crm.search(term, filters); }
    else { res = await window.sq.crm.browse(filters); }
    if (!res || !res.ok) { rowsEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed')}</div>`; headEl.textContent = ''; return; }
    const list = res.list || res;
    cursor = list.cursor || null;
    headEl.textContent = mode === 'search'
      ? `${list.items.length} result${list.items.length === 1 ? '' : 's'}`
      : `${list.total != null ? list.total.toLocaleString() : list.items.length} contacts${list.items.length < (list.total || 0) ? ` · showing ${list.items.length}` : ''}`;
    renderList(list);
  } catch (e) { rowsEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; headEl.textContent = ''; }
}

async function loadMore() {
  if (!cursor) return;
  const btn = $('moreBtn'); if (btn) btn.textContent = 'Loading…';
  try {
    const res = await window.sq.crm.page(cursor);
    if (res && res.ok) { cursor = res.page.cursor || null; renderList(res.page, { append: true }); }
  } catch (e) { /* leave list as-is */ }
}

function relSec(card) {
  if (!card.related.length) return '';
  return `<div class="sec"><div class="h">Related</div><div class="rel">${card.related.map(r => `<span class="relchip"><b>${r.count}</b> ${esc(r.label)}</span>`).join('')}</div></div>`;
}

function renderCard(card) {
  if (!card) { detailEl.innerHTML = `<div class="err">⚠ contact not found</div>`; return; }
  const meta = [
    card.partyLabel && `<span class="pdot ${esc(card.party)}"></span><b>${esc(card.partyLabel)}</b>`,
    card.chamberLabel && `<span>${esc(card.chamberLabel)}</span>`,
    card.state && `<span>${esc(card.state)}${card.district && card.district !== card.state ? ' · ' + esc(card.district) : ''}</span>`,
    card.activeElected && `<span style="color:var(--ok-fg)">active</span>`,
    card.tier && `<span>${esc(card.tier)}</span>`,
  ].filter(Boolean).join('');
  const rows = [
    card.email && `<div class="c-row"><span class="k">Email</span><span class="v"><a href="mailto:${esc(card.email)}">${esc(card.email)}</a></span></div>`,
    card.phone && `<div class="c-row"><span class="k">Phone</span><span class="v">${esc(card.phone)}</span></div>`,
    card.account && `<div class="c-row"><span class="k">Account</span><span class="v">${esc(card.account)}</span></div>`,
    card.jurisdiction && `<div class="c-row"><span class="k">Jurisdiction</span><span class="v">${esc(card.jurisdiction)}</span></div>`,
    card.engagement && `<div class="c-row"><span class="k">Engagement</span><span class="v">${esc(card.engagement)}</span></div>`,
    card.ids.length && `<div class="c-row"><span class="k">IDs</span><span class="v">${card.ids.map(esc).join(' · ')}</span></div>`,
  ].filter(Boolean).join('');
  detailEl.innerHTML = `
    <div class="c-name">${esc(card.name)}</div>
    ${card.title ? `<div class="c-title">${esc(card.title)}</div>` : ''}
    <div class="c-meta">${meta}</div>
    ${rows}
    ${card.notesPublic ? `<div class="sec"><div class="h">Notes</div><div style="font-size:12.5px;color:var(--tx-soft)">${esc(card.notesPublic)}</div></div>` : ''}
    ${relSec(card)}`;
}

async function openContact(id) {
  activeId = id;
  rowsEl.querySelectorAll('.citem').forEach(el => el.classList.toggle('active', el.dataset.id == id));
  detailEl.innerHTML = `<div class="status">Loading contact…</div>`;
  try {
    const res = await window.sq.crm.get(id);
    if (!res || !res.ok) { detailEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load contact')}</div>`; return; }
    renderCard(res.card);
  } catch (e) { detailEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

function setFilter(key, value) {
  if (value) filters[key] = value; else delete filters[key];
  if (selators[key]) selators[key].value = value || '';
  renderChips();
  refresh();
}

// populate facet dropdowns
async function loadFacets() {
  try {
    const res = await window.sq.crm.facets(filters);
    if (!res || !res.ok) return;
    for (const g of res.groups) {
      const sel = selators[g.key]; if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = `<option value="">${esc(g.label)}</option>` + g.options.map(o => `<option value="${esc(o.value)}">${esc(o.label)} (${o.count.toLocaleString()})</option>`).join('');
      sel.value = cur;
    }
  } catch (e) { /* leave selects empty */ }
}

Object.keys(selators).forEach(k => selators[k].addEventListener('change', () => setFilter(k, selators[k].value)));
let t; qEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 300); });
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); refresh(); } });

// DEEP-LINK: "Open in CRM →" from the canvas People rail loads this surface with #target=<contactId> —
// open that contact's complete entry straight away (the browse list still loads behind it).
function deepLinkId() { const m = /(?:^|[#&])target=(\d+)/.exec(location.hash || ''); return m ? m[1] : null; }
window.addEventListener('hashchange', () => { const id = deepLinkId(); if (id) openContact(id); });

(async () => { await loadFacets(); await refresh(); const id = deepLinkId(); if (id) openContact(id); })();
