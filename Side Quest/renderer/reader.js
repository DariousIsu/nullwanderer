/* Reader / Library surface — operator corpus reader. Calls window.sq.reader.* over IPC (main maps
   list_projects/recent_documents/get_document via studio/doc_view.js). Project filter + title
   filter drive a document list; opening a doc renders its structured blocks (the substrate) with
   inline markdown. Read-only. */
'use strict';
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), readerEl = $('reader'), headEl = $('listhead'), projEl = $('proj'), qEl = $('q');
let all = [];          // docs in the current project/recent scope
let activeId = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// inline markdown → safe html: escape, then **bold**, *italic* / _italic_.
function inlineMd(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}

function renderList() {
  const term = qEl.value.trim().toLowerCase();
  const items = all.filter(d => !term || d.title.toLowerCase().includes(term));
  headEl.textContent = `${items.length} document${items.length === 1 ? '' : 's'}`;
  if (!items.length) { rowsEl.innerHTML = `<div class="status">No documents.</div>`; return; }
  rowsEl.innerHTML = items.map(d => `
    <div class="ditem${d.id === activeId ? ' active' : ''}" data-id="${esc(d.id)}">
      <div class="ti">${esc(d.title)}</div>
      <div class="mt">${d.sourceExt ? `<span class="ext">${esc(d.sourceExt)}</span>` : ''}${d.project ? `<span>${esc(d.project)}</span>` : ''}${d.date ? `<span>${esc(d.date)}</span>` : ''}</div>
    </div>`).join('');
  rowsEl.querySelectorAll('.ditem').forEach(el => el.addEventListener('click', () => openDoc(el.dataset.id)));
}

// render the structured blocks → readable HTML (group consecutive list_items into <ul>).
function bodyHtml(blocks) {
  const out = []; let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const b of blocks) {
    if (b.type === 'list_item') { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inlineMd(b.text)}</li>`); continue; }
    closeList();
    if (b.type === 'heading') { const lvl = Math.min(4, Math.max(2, (b.level || 1) + 1)); out.push(`<h${lvl}>${inlineMd(b.text)}</h${lvl}>`); }
    else if (b.type === 'code') out.push(`<pre>${esc(b.text)}</pre>`);
    else if (b.type === 'table') out.push(`<pre>${esc(b.text)}</pre>`);
    else out.push(`<p>${inlineMd(b.text)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function renderDoc(doc) {
  if (!doc) { readerEl.innerHTML = `<div class="err">⚠ document not found</div>`; return; }
  const meta = [
    doc.sourceExt && `<span class="mchip">${esc(doc.sourceExt)}</span>`,
    doc.project && `<span>${esc(doc.project)}</span>`,
    doc.date && `<span>${esc(doc.date)}</span>`,
    doc.method && `<span>via ${esc(doc.method)}</span>`,
    ...doc.meta.map(m => `<span class="mchip">${esc(m.key)}: ${esc(m.value).slice(0, 60)}</span>`),
  ].filter(Boolean).join('');
  // Prefer the faithful rich HTML (mammoth, from the canonical .docx — real headings, lists,
  // tables, emphasis + embedded images). Fall back to the structured blocks for other formats.
  const body = doc.html
    ? `<div class="rich">${doc.html}</div>`
    : (doc.blocks.length ? bodyHtml(doc.blocks) : '<div class="status">Empty document.</div>');
  readerEl.innerHTML = `<div class="doc">
    <div class="doc-head"><div class="doc-title">${esc(doc.title)}</div><div class="doc-meta">${meta}</div></div>
    <div class="doc-body">${body}</div>
  </div>`;
  readerEl.scrollTop = 0;
}

// PDFs render full-fidelity in Chromium's native viewer: pull the canonical bytes → blob → iframe.
async function renderPdf(doc) {
  readerEl.innerHTML = `<div class="status">Loading PDF…</div>`;
  try {
    const res = await window.sq.reader.bytes(doc.id);
    if (!res || !res.ok || !res.base64) { renderDoc(doc); return; }   // fall back to extracted text
    const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    readerEl.innerHTML = `<iframe class="pdfframe" src="${url}#toolbar=1"></iframe>`;
  } catch (e) { renderDoc(doc); }
}

async function openDoc(id) {
  activeId = Number(id);
  rowsEl.querySelectorAll('.ditem').forEach(el => el.classList.toggle('active', Number(el.dataset.id) === activeId));
  readerEl.innerHTML = `<div class="status">Loading document…</div>`;
  try {
    const res = await window.sq.reader.get(activeId);
    if (!res || !res.ok) { readerEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load')}</div>`; return; }
    if (res.doc && res.doc.sourceExt === 'pdf') return renderPdf(res.doc);
    renderDoc(res.doc);
  } catch (e) { readerEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

async function loadList(project) {
  headEl.textContent = 'Loading…';
  try {
    const res = await window.sq.reader.list(project || null);
    if (!res || !res.ok) { rowsEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed')}</div>`; headEl.textContent = ''; return; }
    all = res.docs || [];
    renderList();
  } catch (e) { rowsEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; headEl.textContent = ''; }
}

projEl.addEventListener('change', () => loadList(projEl.value));
qEl.addEventListener('input', renderList);

(async () => {
  try {
    const res = await window.sq.reader.projects();
    if (res && res.ok) {
      projEl.innerHTML = `<option value="">All recent</option>` + res.projects
        .map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.count ? ` (${p.count})` : ''}</option>`).join('');
    }
  } catch (e) { /* leave All only */ }
  await loadList(null);
})();
