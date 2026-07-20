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
let LAST_MAPPED = null;    // full {findings, suggestions, summary} from the last run → fed to Certify
let CITATIONS = [];        // citations found in the open doc (pre-run) — declared here so openDoc/notice can reset it

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
  // action-button states from lifecycle: Certify needs a fresh run (disabled on open);
  // Publish is available once certified; a published doc locks both.
  LAST_MAPPED = null;
  const certBtn = document.getElementById('certify-btn');
  const pubBtn = document.getElementById('publish-btn');
  certBtn.disabled = true;
  certBtn.innerHTML = (doc.cert_number && doc.status !== 'in-process') ? esc(doc.cert_number) : 'Certify';
  const reportBtn0 = document.getElementById('report-btn'); if(reportBtn0) reportBtn0.disabled = true;   // needs a run first
  pubBtn.disabled = (doc.status !== 'certified');
  pubBtn.innerHTML = (doc.status === 'published') ? 'Published' : 'Publish';
  renderDocBody(wcR && wcR.workingCopy);
  renderDocNotice(wcR && wcR.workingCopy);
  CITATIONS = [];
  loadCitations(id);                 // list the doc's citations in the rail (pre-run) so sources can be attached
  document.getElementById('view-index').hidden = true;
  document.getElementById('view-doc').hidden = false;
}
function showIndex(){ document.getElementById('view-doc').hidden = true; document.getElementById('view-index').hidden = false; }

/* ---------- import notices ----------
   A PDF can carry a good text layer and STILL hide pages (a designed document mixes typeset pages
   with image-only spreads). Those pages read as empty and were previously dropped in silence, so the
   operator would review — and certify — a document quietly missing content. Surface it, and offer to
   read them with vision. Not automatic: each page is a model call, and it is the operator's call. */
function renderDocNotice(wc){
  const box = document.getElementById('doc-notice');
  if(!box) return;
  const n = ((wc && wc.notices) || []).find(x => x && x.type === 'image-only-pages');
  if(!n || !(n.pages || []).length){ box.hidden = true; box.innerHTML = ''; return; }
  const many = n.pages.length > 1;
  box.className = 'doc-notice';
  box.innerHTML = `<span class="nx"><b>${n.pages.length} page${many?'s':''} could not be read as text</b>
      <span class="sub">Page${many?'s':''} ${n.pages.map(esc).join(', ')}${n.totalPages?` of ${esc(n.totalPages)}`:''} have no text layer — they are images.
      Their content is <b>not</b> in this document and will not be checked.</span></span>
    <button class="btn sm" id="ocr-btn">Read ${many?'them':'it'}</button>`;
  box.hidden = false;
  const btn = document.getElementById('ocr-btn');
  btn.addEventListener('click', async () => {
    if(!E || !currentDoc) return;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = 'Reading…';
    try {
      const r = await E.ocrPages(currentDoc.id, n.pages);
      if(r && r.ok){
        const wcR = await E.getWorkingCopy(currentDoc.id, currentDoc.current_version);
        const nwc = wcR && wcR.workingCopy;
        renderDocBody(nwc);
        renderDocNotice(nwc);                       // clears itself, or re-renders what still failed
        CITATIONS = []; loadCitations(currentDoc.id);
        // A checked-and-genuinely-blank page is a RESULT, not a failure — say so, or the operator is
        // left wondering whether the read silently did nothing.
        if(!(r.read || []).length && (r.blank || []).length && box.hidden){
          box.className = 'doc-notice';
          box.innerHTML = `<span class="nx"><b>Nothing to read on ${(r.blank.length>1?'those pages':'that page')}</b>
            <span class="sub">Page${r.blank.length>1?'s':''} ${r.blank.join(', ')} checked — decorative or blank, no text to add.</span></span>`;
          box.hidden = false;
        }
      } else {
        btn.disabled = false; btn.innerHTML = orig;
        alert('Could not read those pages: ' + (r && r.error || 'unknown error'));
      }
    } catch (err) { btn.disabled = false; btn.innerHTML = orig; alert('OCR errored: ' + err.message); }
  });
}

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
/* Fact check — the SECOND lane, rendered after the citation findings and visibly apart from them.
   Citation findings are defects to resolve and they drive the ruling; these are independent sources
   offered for the author to weigh. Deliberately NOT resolve-able cards and NOT counted in the rail
   total or the progress bar — a countering source is not a task, and treating it like one is exactly
   the conflation that failed an author for pages the verifier itself went and found. */
const FC_PILL = { corroborated:'ok', contested:'warn', mixed:'warn', 'no-independent-source':'mute' };
const FC_LABEL = { corroborated:'Corroborated', contested:'Countered', mixed:'Mixed record', 'no-independent-source':'No independent source' };
function factCheckHTML(fc){
  if(!fc || !fc.summary || !fc.summary.ran) return '';
  const items = (fc.items || []).filter(f => (f.countering||[]).length || (f.supporting||[]).length);
  const s = fc.summary;
  const head = `<div class="fc-head"><b>Fact check</b> <span class="fc-sub">independent sources · advisory, not part of the ruling</span>
    <div class="fc-sub">${s.checked} checked · ${s.corroborated} corroborated · ${s.contested} countered · ${s.mixed} mixed · ${s.none} none found</div></div>`;
  if(!items.length) return `${head}<div class="rail-empty">No independent sources were found for these claims.</div>`;
  const order = { contested:0, mixed:1, corroborated:2, 'no-independent-source':3 };
  const rows = items.slice().sort((a,b)=>(order[a.stance]??9)-(order[b.stance]??9)).map(f => {
    const src = (list, kind) => (list||[]).map(x =>
      `<li><span class="pill ${kind==='counters'?'warn':'ok'} xs">${kind==='counters'?'counters':'supports'}</span>
        <a href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.title || x.url)}</a>${x.quote?` <em>${esc(x.quote)}</em>`:''}</li>`).join('');
    return `<div class="fc-card">
      <div class="fc-claim">${esc(f.claim)}</div>
      <div class="fc-meta"><span class="pill ${FC_PILL[f.stance]||'mute'}">${esc(FC_LABEL[f.stance]||f.stance)}</span>
        <span class="src">${esc(f.uid||'')}</span></div>
      <ul class="fc-srcs">${src(f.countering,'counters')}${src(f.supporting,'supports')}</ul>
    </div>`;
  }).join('');
  return `${head}${rows}`;
}

function renderFindings(){
  const el = document.getElementById('findings');
  const fcHTML = factCheckHTML(LAST_MAPPED && LAST_MAPPED.factcheck);
  if(!FINDINGS.length && !fcHTML){ resetFindings(); return; }
  el.innerHTML = FINDINGS.map(findingCardHTML).join('') + (fcHTML ? `<div class="fc-block">${fcHTML}</div>` : '');
  document.getElementById('rail-count').textContent = FINDINGS.length;   // citation findings only
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

/* ---------- citations (pre-run list + attach an in-hand source to a citation) ---------- */
let attachPendingUid = null;

async function loadCitations(docId){
  if(!E || !E.listCitations) return;
  try {
    const r = await E.listCitations(docId);
    CITATIONS = (r && r.ok && r.citations) ? r.citations : [];
    renderCitations();
  } catch(err){ console.error('[editor] list-citations', err); }
}
function citationCardHTML(c){
  const foot = c.attached
    ? `<span class="attached-src" title="${esc(c.attached.title||'')}">&#9745; <span class="tt">${esc(c.attached.title||'source')}</span> <span class="detach-x" data-detach="${esc(c.uid)}" title="remove attached source">&#10005;</span></span>`
    : `<button class="attach-btn" data-attach="${esc(c.uid)}">&#128206; Attach source</button>`;
  return `<div class="ccard ${c.attached?'has-src':''}" data-ccard="${esc(c.uid)}">
    <div class="ccard-top"><span class="ckind">${esc(c.kind||'claim')}</span></div>
    <div class="ctext">${esc((c.text||'').slice(0,240))}</div>
    <div class="fcard-actions"><span></span>${foot}</div></div>`;
}
function renderCitations(){
  const el = document.getElementById('findings');
  if(!CITATIONS.length){
    el.innerHTML = '<div class="rail-empty">No citations found to verify in this document.</div>';
    document.getElementById('rail-count').textContent = '0';
    return;
  }
  const withSrc = CITATIONS.filter(c => c.attached).length;
  el.innerHTML = `<div class="rail-empty" style="padding-bottom:6px">${CITATIONS.length} citation${CITATIONS.length===1?'':'s'} found${withSrc?` &middot; ${withSrc} with attached source`:''}. Attach an in-hand source to any, then <b>Run checks</b> &mdash; attached citations verify against your document instead of the web.</div>`
    + CITATIONS.map(citationCardHTML).join('');
  document.getElementById('rail-count').textContent = CITATIONS.length;
}

// attach / detach (delegated; separate from the resolve toggle above)
document.getElementById('findings').addEventListener('click', e => {
  const a = e.target.closest('[data-attach]');
  if(a){ attachPendingUid = a.dataset.attach; document.getElementById('attach-file-input').click(); return; }
  const d = e.target.closest('[data-detach]');
  if(d){ detachSource(d.dataset.detach); return; }
});

document.getElementById('attach-file-input').addEventListener('change', async (ev) => {
  const input = ev.target;
  const file = input.files && input.files[0];
  const uid = attachPendingUid;
  input.value = '';                    // reset so the same file can be re-picked later
  attachPendingUid = null;
  if(!file || !uid || !currentDoc || !E || !E.attachSource || !E.pathForFile) return;
  const p = E.pathForFile(file);
  if(!p){ alert('Could not resolve the file path.'); return; }
  const btn = document.querySelector(`[data-ccard="${CSS.escape(uid)}"] .attach-btn`);
  if(btn){ btn.disabled = true; btn.textContent = 'Attaching…'; }
  try {
    const r = await E.attachSource(currentDoc.id, uid, p);
    if(r && r.ok){
      const c = CITATIONS.find(x => x.uid === uid);
      if(c) c.attached = { title: r.attachment.title, ref: r.attachment.ref };
    } else {
      alert('Attach failed: ' + (r && r.error || 'unknown error'));
    }
  } catch(err){ alert('Attach errored: ' + err.message); }
  renderCitations();
});

async function detachSource(uid){
  if(!currentDoc || !E || !E.detachSource) return;
  try {
    const r = await E.detachSource(currentDoc.id, uid);
    if(r && r.ok){ const c = CITATIONS.find(x => x.uid === uid); if(c) c.attached = null; renderCitations(); }
  } catch(err){ console.error('[editor] detach', err); }
}

document.getElementById('run-checks-btn').addEventListener('click', async () => {
  if(!E || !currentDoc) return;
  const btn = document.getElementById('run-checks-btn');
  const certBtn = document.getElementById('certify-btn');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="ic">&#8635;</span>Running…';
  if(certBtn) certBtn.disabled = true;
  document.getElementById('findings').innerHTML = '<div class="rail-empty">Verifying… extracting claims, resolving sources, matching (lexical + local embeddings), and classifying the residue. Runs on local models — usually under a minute.</div>';
  try {
    const res = await E.runChecks(currentDoc.id);
    if (res && res.ok) {
      LAST_MAPPED = res.mapped || null;
      FINDINGS = (res.mapped && res.mapped.findings) || [];
      renderFindings();
      if(!FINDINGS.length) document.getElementById('findings').innerHTML = '<div class="rail-empty">No verification units were extracted from this document (nothing with a quote, source reference, or statistic to check).</div>';
      // Certify + Report become available once a run has produced findings.
      if(certBtn) certBtn.disabled = !FINDINGS.length;
      const reportBtn = document.getElementById('report-btn'); if(reportBtn) reportBtn.disabled = !FINDINGS.length;
    } else {
      document.getElementById('findings').innerHTML = `<div class="rail-empty">Run checks failed: ${esc(res && res.error || 'unknown error')}</div>`;
    }
  } catch (err) {
    document.getElementById('findings').innerHTML = `<div class="rail-empty">Run checks errored: ${esc(err.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = orig; }
});

document.getElementById('report-btn').addEventListener('click', async () => {
  if(!E || !currentDoc || !LAST_MAPPED){ return; }
  const btn = document.getElementById('report-btn');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Exporting…';
  try {
    const r = await E.exportReport(currentDoc.id, LAST_MAPPED);
    if(!(r && r.ok)) alert('Report failed: ' + (r && r.error || 'unknown error'));
  } catch (err) { alert('Report errored: ' + err.message); }
  finally { btn.innerHTML = orig; btn.disabled = false; }
});

// Document export (pdf | docx | md). Unlike Report/Certify this needs no verification result —
// the document can be exported at any point in the pipeline.
(function wireDocExport(){
  const btn = document.getElementById('export-doc-btn');
  const menu = document.getElementById('export-doc-menu');
  if(!btn || !menu) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.querySelectorAll('button[data-fmt]').forEach(item => {
    item.addEventListener('click', async () => {
      if(!E || !currentDoc) return;
      menu.hidden = true;
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = 'Exporting…';
      try {
        const r = await E.exportDoc(currentDoc.id, item.dataset.fmt);
        if(!(r && r.ok)) alert('Export failed: ' + (r && r.error || 'unknown error'));
      } catch (err) { alert('Export errored: ' + err.message); }
      finally { btn.innerHTML = orig; btn.disabled = false; }
    });
  });
})();

document.getElementById('certify-btn').addEventListener('click', async () => {
  if(!E || !currentDoc || !LAST_MAPPED) return;
  const btn = document.getElementById('certify-btn');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Certifying…';
  try {
    const res = await E.certify(currentDoc.id, LAST_MAPPED);
    if (res && res.ok) {
      btn.innerHTML = res.certNumber;                 // show the issued cert id on the button
      // reflect the new lifecycle state in the top-bar pill
      const pill = document.getElementById('doc-status');
      if(pill){ pill.className = 'pill warn'; pill.textContent = 'certified'; }
      currentDoc.status = 'certified'; currentDoc.cert_number = res.certNumber;
      const pubBtn = document.getElementById('publish-btn'); if(pubBtn) pubBtn.disabled = false;  // certified → can publish
    } else {
      btn.innerHTML = orig; btn.disabled = false;
      alert('Certify failed: ' + (res && res.error || 'unknown error'));
    }
  } catch (err) {
    btn.innerHTML = orig; btn.disabled = false;
    alert('Certify errored: ' + err.message);
  }
});

document.getElementById('publish-btn').addEventListener('click', async () => {
  if(!E || !currentDoc) return;
  const ref = (prompt('Optional — public copy URL or file path (leave blank to skip):', '') || '').trim() || null;
  const btn = document.getElementById('publish-btn');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Publishing…';
  try {
    const res = await E.publish(currentDoc.id, ref);
    if (res && res.ok) {
      const pill = document.getElementById('doc-status');
      if(pill){ pill.className = 'pill ok'; pill.textContent = 'published'; }
      currentDoc.status = 'published'; currentDoc.public_copy_ref = ref;
      btn.innerHTML = 'Published';
    } else {
      btn.innerHTML = orig; btn.disabled = false;
      alert('Publish failed: ' + (res && res.error || 'unknown error'));
    }
  } catch (err) {
    btn.innerHTML = orig; btn.disabled = false;
    alert('Publish errored: ' + err.message);
  }
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

/* ---------- drag-drop import (works over either view) ---------- */
(function(){
  let depth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const show = on => document.body.classList.toggle('drop-hover', on);
  window.addEventListener('dragenter', e => { if(!hasFiles(e)) return; e.preventDefault(); depth++; show(true); });
  window.addEventListener('dragover', e => { if(!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', e => { if(!hasFiles(e)) return; depth = Math.max(0, depth - 1); if(!depth) show(false); });
  window.addEventListener('drop', async e => {
    if(!hasFiles(e)) return;
    e.preventDefault(); depth = 0; show(false);
    if(!E || !E.importPath || !E.pathForFile){ alert('Import bridge unavailable — restart the app.'); return; }
    const files = Array.from(e.dataTransfer.files || []);
    let imported = 0, errs = [];
    for(const f of files){
      const p = E.pathForFile(f);
      if(!p){ errs.push(`${f.name}: no file path`); continue; }
      try {
        const r = await E.importPath(p);
        if(r && r.ok) imported++;
        else errs.push(`${f.name}: ${(r && r.error) || 'failed'}`);
      } catch(err){ errs.push(`${f.name}: ${err.message}`); }
    }
    if(imported) await loadIndex();
    if(errs.length) alert(`Imported ${imported} of ${files.length}.\n\nNot imported:\n` + errs.join('\n'));
  });
})();

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
