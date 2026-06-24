/* Editor Studio renderer — LIVE (slice 1).
 * View A (index) + New-document import read/write the real registry over window.sq.editor.*;
 * View B renders the real imported working copy (read-only). Findings / Run checks / drawer
 * are the next slice — the rail shows a placeholder and the action buttons are disabled. */
'use strict';
const E = (window.sq && window.sq.editor) || null;
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

const STATUS_PILL = { 'in-process':'info', 'certified':'warn', 'published':'ok' };
let DOCS = [];
let sortKey = 'accessed', sortDir = 'desc';
let currentDoc = null;     // { id, current_version, ... } of the open doc in View B
let FINDINGS = [];         // mapped findings for the open doc (from Run checks)

function relTime(ms){
  if(!ms) return '—';
  const d = Date.now() - ms;
  if(d < 60000) return 'just now';
  if(d < 3600000) return Math.floor(d/60000) + 'm ago';
  if(d < 86400000) return Math.floor(d/3600000) + 'h ago';
  if(d < 172800000) return 'yesterday';
  if(d < 604800000) return Math.floor(d/86400000) + 'd ago';
  const dt = new Date(ms); return (dt.getMonth()+1) + '/' + dt.getDate();
}

function mapDoc(d){
  return {
    id: d.id,
    title: d.title || '(untitled)',
    author: d.author || '—',
    cert: d.cert_number || '—',
    ver: 'v' + d.current_version,
    last: relTime(d.last_accessed_at),
    status: d.status,
    version: d.current_version,
    summary: d.project ? `Project: ${esc(d.project)}` : 'No summary yet.',
    topics: Array.isArray(d.topics) ? d.topics : [],
    history: `v1 … v${d.current_version}`,
    checks: '— not yet run',
    src: d.doc_type ? `imported from .${d.doc_type}` : 'native',
    published: d.status === 'published',
    publicCopy: d.public_copy_ref || null,
    open: false,
  };
}

/* ---------- View A ---------- */
function rowHTML(d){
  const pill = STATUS_PILL[d.status] || 'mute';
  const certCls = d.cert === '—' ? 'mono dim' : 'mono';
  return `<tr class="row ${d.open?'open':''}" data-id="${d.id}">
    <td><span class="twirl">&#9656;</span>${esc(d.title)}</td>
    <td class="dim">${esc(d.author)}</td>
    <td class="${certCls}">${esc(d.cert)}</td>
    <td>${esc(d.ver)}</td>
    <td class="dim">${esc(d.last)}</td>
    <td><span class="pill ${pill}">${esc(d.status)}</span></td></tr>`;
}
function detailHTML(d){
  const chips = d.topics.length ? d.topics.map(t=>`<span class="chip">${esc(t)}</span>`).join(' ') : '<span class="chip" style="opacity:.5">no topics</span>';
  const pub = d.published
    ? (d.publicCopy ? `<a class="detail-link" href="#">&#8599; public copy</a>` : `<span class="detail-link" style="opacity:.5">published</span>`)
    : `<button class="btn sm" disabled title="close-out wires next slice">Close out</button>`;
  return `<tr class="detail" data-detail="${d.id}"><td colspan="6"><div class="detail-grid">
    <div class="detail-col wide"><div class="detail-summary">${d.summary}</div><div class="detail-chips">${chips}</div></div>
    <div class="detail-col detail-meta">
      <div><span class="ic">&#8634;</span>${esc(d.history)}</div>
      <div><span class="ic">&#10003;</span>${esc(d.checks)}</div>
      <div><span class="ic">&#9776;</span>${esc(d.src)}</div></div>
    <div class="detail-actions"><button class="btn accent sm" data-open="${d.id}">&#8599; Open document</button>${pub}</div>
  </div></td></tr>`;
}
function renderIndex(){
  const rows = document.getElementById('rows');
  rows.innerHTML = DOCS.map(d => rowHTML(d) + (d.open ? detailHTML(d) : '')).join('');
  document.getElementById('empty').hidden = DOCS.length > 0;
  document.getElementById('release-count').textContent = DOCS.length + (DOCS.length === 1 ? ' release' : ' releases');
  document.querySelectorAll('.stbl thead th.sortable').forEach(th => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle('active', active);
    const caret = th.querySelector('.caret');
    if (caret) caret.innerHTML = active ? (sortDir === 'desc' ? '&#9660;' : '&#9650;') : '&#8645;';
  });
}
async function loadIndex(){
  if(!E){ document.getElementById('release-count').textContent = 'bridge offline'; return; }
  const r = await E.listDocuments({ sort: sortKey, dir: sortDir, limit: 500 });
  DOCS = (r && r.documents ? r.documents : []).map(mapDoc);
  renderIndex();
}

/* ---------- View B (read-only this slice) ---------- */
function renderDocBody(wc){
  const el = document.getElementById('doc-body');
  if(!wc || !Array.isArray(wc.blocks) || !wc.blocks.length){ el.innerHTML = '<p class="muted">No working copy stored for this document.</p>'; return; }
  el.innerHTML = wc.blocks.map(b => {
    if(b.type === 'heading') return (b.level <= 1 ? `<div class="doc-h1">${esc(b.text)}</div>` : `<div class="doc-h2">${esc(b.text)}</div>`);
    if(b.type === 'list_item') return `<li>${esc(b.text)}</li>`;
    if(b.type === 'table' || b.type === 'code') return `<pre>${esc(b.text)}</pre>`;
    return `<p>${esc(b.text)}</p>`;
  }).join('');
}
async function openDoc(id){
  if(!E) return;
  const dR = await E.getDocument(id);
  const doc = dR && dR.document;
  if(!doc){ return; }
  currentDoc = doc;
  FINDINGS = [];
  const wcR = await E.getWorkingCopy(id, doc.current_version);
  document.getElementById('doc-title').textContent = doc.title || '(untitled)';
  document.getElementById('doc-sub').textContent = (doc.author || '—') + ' · v' + doc.current_version;
  const pill = document.getElementById('doc-status');
  pill.className = 'pill ' + (STATUS_PILL[doc.status] || 'mute');
  pill.textContent = doc.status;
  renderDocBody(wcR && wcR.workingCopy);
  resetFindings();
  document.getElementById('view-index').hidden = true;
  document.getElementById('view-doc').hidden = false;
}
function showIndex(){ document.getElementById('view-doc').hidden = true; document.getElementById('view-index').hidden = false; }

/* ---------- findings (Run checks) ---------- */
function resetFindings(){
  document.getElementById('findings').innerHTML = '<div class="rail-empty">No checks run yet. Press <b>Run checks</b> to verify this document.</div>';
  document.getElementById('rail-count').textContent = '0';
  updateProgress();
}
function findingCardHTML(f){
  const done = f.resolved || f.auto;
  const resolve = f.auto
    ? `<span class="fcard-resolve done">&#9745; cite-ready</span>`
    : `<span class="fcard-resolve ${f.resolved?'done':''}" data-resolve="${f.id}">${f.resolved?'&#9745; resolved':'&#9744; resolve'}</span>`;
  return `<div class="fcard ${f.verdict} ${done?'done':''}" data-fcard="${f.id}">
    <div class="fcard-top"><span class="fcard-lbl">${esc(f.label)}</span><span class="pill ${f.verdict}">${esc(f.vlabel)}</span></div>
    <div class="fcard-ev">${esc(f.ev)}</div>
    <div class="fcard-actions"><span></span>${resolve}</div></div>`;
}
function renderFindings(){
  const el = document.getElementById('findings');
  if(!FINDINGS.length){ resetFindings(); return; }
  el.innerHTML = FINDINGS.map(findingCardHTML).join('');
  document.getElementById('rail-count').textContent = FINDINGS.length;
  updateProgress();
}
function updateProgress(){
  const total = FINDINGS.length;
  const done = FINDINGS.filter(f => f.resolved || f.auto).length;
  document.getElementById('prog-text').textContent = `${done} of ${total} resolved`;
  document.getElementById('prog-bar').style.width = total ? `${Math.round(done/total*100)}%` : '0%';
}
// findings rail: manual resolve toggle (delegated)
document.getElementById('findings').addEventListener('click', e => {
  const r = e.target.closest('[data-resolve]'); if(!r) return;
  const f = FINDINGS.find(x => x.id === r.dataset.resolve);
  if(f){ f.resolved = !f.resolved; renderFindings(); }
});

document.getElementById('run-checks-btn').addEventListener('click', async () => {
  if(!E || !currentDoc) return;
  const btn = document.getElementById('run-checks-btn');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="ic">&#8635;</span>Running…';
  document.getElementById('findings').innerHTML = '<div class="rail-empty">Verifying… the Rainey citation-verifier + fact-checker are reading the document and tracing sources. This runs on cloud and can take a few minutes.</div>';
  try {
    const res = await E.runChecks(currentDoc.id);
    if (res && res.ok) {
      FINDINGS = (res.mapped && res.mapped.findings) || [];
      renderFindings();
      if(!FINDINGS.length) document.getElementById('findings').innerHTML = '<div class="rail-empty">Checks ran but returned no findings (the agents attached nothing — likely the document had no traceable citations, or the run timed out).</div>';
    } else {
      document.getElementById('findings').innerHTML = `<div class="rail-empty">Run checks failed: ${esc(res && res.error || 'unknown error')}</div>`;
    }
  } catch (err) {
    document.getElementById('findings').innerHTML = `<div class="rail-empty">Run checks errored: ${esc(err.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = orig; }
});

/* ---------- wiring ---------- */
document.getElementById('new-doc-btn').addEventListener('click', async () => {
  if(!E) return;
  const btn = document.getElementById('new-doc-btn');
  btn.disabled = true;
  try {
    const r = await E.importDocument();
    if (r && r.ok) await loadIndex();
    else if (r && r.error) console.error('[editor] import:', r.error);
  } finally { btn.disabled = false; }
});

document.getElementById('back-btn').addEventListener('click', showIndex);
document.getElementById('rail-toggle').addEventListener('click', () => document.getElementById('rail').classList.toggle('collapsed'));
document.getElementById('rail-collapse').addEventListener('click', () => document.getElementById('rail').classList.toggle('collapsed'));

document.querySelectorAll('.stbl thead th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = (sortDir === 'desc' ? 'asc' : 'desc');
    else { sortKey = k; sortDir = (k === 'accessed' ? 'desc' : 'asc'); }
    loadIndex();
  });
});

let clickTimer = null;
const rows = document.getElementById('rows');
rows.addEventListener('click', e => {
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) { openDoc(+openBtn.dataset.open); return; }
  const tr = e.target.closest('tr.row'); if(!tr) return;
  if (clickTimer) return;
  clickTimer = setTimeout(() => { clickTimer = null; const d = DOCS.find(x => x.id == +tr.dataset.id); if(d){ d.open = !d.open; renderIndex(); } }, 200);
});
rows.addEventListener('dblclick', e => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  const tr = e.target.closest('tr.row'); if(tr) openDoc(+tr.dataset.id);
});

loadIndex();
