/* Zoe's Canvas — the window IS an infinite pannable/zoomable surface. Each whole DOCUMENT (a saga
   tab, blocks flowing inside as a formatted page) is a movable / resizable object you can stack,
   minimize, and close. main supplies content + per-doc layout state (position/size/hidden/minimized);
   the operator's arrangement persists (lib/canvas_layout). Content is read-only (Echo owns blocks);
   the spatial/UI layer is Side-Quest-owned. The tray lists every doc (incl. closed) and focuses one. */
'use strict';
const $ = (id) => document.getElementById(id);
const surface = $('surface'), board = $('board'), trayEl = $('tray'), trayRows = $('trayRows'),
      countEl = $('count'), msgEl = $('msg');

let panX = 0, panY = 0, zoom = 1;
let docPos = {};                 // tabKey -> {x,y} (for tray focus)
let panning = false, panSX = 0, panSY = 0, panPX = 0, panPY = 0;
let drag = null;                 // moving a document
let resizing = null;             // resizing a document
let activeKey = null;
let zTop = 10;                   // stacking order; raising a card on touch lets you pile them

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Defense-in-depth sanitize for rich-HTML blocks (docx → html) before innerHTML: strip scripts,
// inline event handlers, and javascript: URLs. (main also sanitizes at extraction time.)
function sanitizeHtml(html) {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|link|meta)\b[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

// markdown → HTML. Fuller than the old lite pass: fenced code, headings h1-h6, horizontal rules,
// blockquotes, and GROUPED ordered/unordered lists (the old one wrapped every bullet in its own <ul>,
// so rich documents rendered like flat raw text). Inline handled by inline().
function md(src) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  const out = []; let para = []; let list = null;   // list = { tag:'ul'|'ol', items:[] }
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag} class="b-list">${list.items.map(t => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const fence = /^\s*```/.test(line);
    if (fence) { flush(); const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; } i++; out.push(`<pre class="b-code"><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    if (line === '') { flush(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); const l = h[1].length; out.push(`<h${l} class="b-heading">${inline(h[2])}</h${l}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); out.push('<hr class="b-hr">'); i++; continue; }   // --- *** ___
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) { flushPara(); flushList(); const buf = [bq[1]]; i++; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push(`<blockquote class="b-quote">${inline(buf.join(' '))}</blockquote>`); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); if (list && list.tag !== 'ul') flushList(); if (!list) list = { tag: 'ul', items: [] }; list.items.push(ul[1]); i++; continue; }
    if (ol) { flushPara(); if (list && list.tag !== 'ol') flushList(); if (!list) list = { tag: 'ol', items: [] }; list.items.push(ol[1]); i++; continue; }
    flushList(); para.push(line); i++;
  }
  flush();
  return out.join('');
}
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(txt)}</a>`);
  return t;
}
function when(ts) { if (!ts) return ''; try { return new Date(ts * 1000).toLocaleString(); } catch { return ''; } }

function blockContent(b) {
  if (b.type === 'heading') { const lvl = b.view.level || 2; return `<h${lvl} class="b-heading">${esc(b.view.text)}</h${lvl}>`; }
  if (b.type === 'paragraph') return `<div class="b-paragraph">${md(b.view.markdown)}</div>`;
  if (b.type === 'table') {
    const head = b.view.headers.length ? `<thead><tr>${b.view.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
    const body = `<tbody>${b.view.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    const cap = b.view.caption ? `<div class="tcaption">${esc(b.view.caption)}</div>` : '';
    const tools = `<div class="tbl-tools"><button class="tbl-dl" title="Download as CSV (opens in Excel/Sheets)">⬇ CSV</button></div>`;
    return `<div class="b-tablewrap">${tools}<table class="b-table">${head}${body}</table>${cap}</div>`;
  }
  if (b.type === 'chart') {
    const v = b.view;
    const meta = `<div class="chart-meta">${esc(v.title || 'Chart')} · ${esc(v.kind)} · ${v.points.length} pt</div>`;
    const head = `<thead><tr><th>${esc(v.xKey || 'x')}</th>${v.yKeys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead>`;
    const body = `<tbody>${v.points.map(pt => `<tr><td>${esc(pt.x)}</td>${v.yKeys.map(k => `<td>${esc(pt[k])}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return `${meta}<table class="b-table">${head}${body}</table>`;
  }
  if (b.type === 'image') {
    if (!b.view.src) return `<div class="fallback"><div class="cnote">image (no source)</div></div>`;
    return `<img class="b-image" src="${esc(b.view.src)}" alt="${esc(b.view.alt)}" draggable="false">`;
  }
  if (b.type === 'pdf') {
    if (!b.view.src) return `<div class="fallback"><div class="cnote">pdf (no source)</div></div>`;
    return `<iframe class="b-pdf" src="${esc(b.view.src)}" title="${esc(b.view.alt)}"></iframe>`;
  }
  if (b.type === 'html') return `<div class="b-html">${sanitizeHtml(b.view.html)}</div>`;
  if (b.type === 'document_file') {
    if (b.view.src) return `<iframe class="b-pdf" src="${esc(b.view.src)}" title="${esc(b.view.alt)}"></iframe>`;
    if (b.view.html) return `<div class="b-html">${sanitizeHtml(b.view.html)}</div>`;
    return `<div class="fallback"><div class="cnote">document (no embeddable content)</div></div>`;
  }
  const note = b.known ? `${esc(b.type)} — renderer arrives in a later slice.` : `unknown block type "${esc(b.type)}".`;
  return `<div class="fallback"><div class="cnote">${note}</div><pre>${esc(b.view.preview)}</pre></div>`;
}

function docCard(doc) {
  const t = doc.tab, pos = doc.pos || { x: 48, y: 48 };
  const style = `left:${pos.x}px;top:${pos.y}px`
    + (doc.w ? `;width:${doc.w}px` : '')
    + (doc.h && !doc.minimized ? `;height:${doc.h}px` : '');
  const inner = doc.stream.blocks.length ? doc.stream.blocks.map(blockContent).join('') : '<div class="doc-empty">No content yet.</div>';
  return `<div class="doc${doc.minimized ? ' minimized' : ''}" data-key="${esc(t.key)}" style="${style}">
    <div class="doc-head">
      <span class="grip">⠿</span>
      <span class="dtitle">${esc(t.title)}</span>
      <span class="mode ${esc(t.mode)}">${esc(t.mode)}</span>
      <button class="dbtn" data-act="download" title="Download (Markdown / PDF / Word)">⬇</button>
      <button class="dbtn" data-act="min" title="${doc.minimized ? 'Restore' : 'Minimize'}">${doc.minimized ? '▢' : '–'}</button>
      <button class="dbtn" data-act="close" title="Close (keep in tray)">✕</button>
    </div>
    <div class="doc-body">${inner}</div>
    <div class="resize-grip" title="Resize"></div>
  </div>`;
}

// ---- document export (Markdown / PDF / Word) ---------------------------------------------------
let docsByKey = {};
function blockToMd(b) {
  const v = b.view || {};
  switch (b.type) {
    case 'heading': return `${'#'.repeat(Math.min(6, v.level || 2))} ${v.text || ''}`;
    case 'paragraph': return v.markdown || '';
    case 'table': {
      const h = v.headers || [], rows = v.rows || [];
      if (!h.length && !rows.length) return '';
      const head = h.length ? `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |` : '';
      const body = (rows || []).map(r => `| ${r.join(' | ')} |`).join('\n');
      return [head, body].filter(Boolean).join('\n');
    }
    case 'image': return v.src ? `![${v.alt || ''}](${v.src})` : '';
    case 'chart': return `_[chart: ${v.title || 'chart'} — ${(v.points || []).length} points]_`;
    default: return v.preview ? v.preview : '';
  }
}
function docToMarkdown(doc) {
  const title = (doc.tab && doc.tab.title) ? `# ${doc.tab.title}\n\n` : '';
  return title + (doc.stream.blocks || []).map(blockToMd).filter(s => s && s.trim()).join('\n\n') + '\n';
}
function docToExportHtml(doc) {
  const title = (doc.tab && doc.tab.title) || 'Document';
  const body = (doc.stream.blocks || []).map(blockContent).join('');
  return `<h1 class="ex-title">${esc(title)}</h1>${body}`;
}
function safeName(s) { return String(s || 'document').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document'; }
function downloadBlob(name, mime, data) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportDoc(doc, fmt) {
  if (!doc) return;
  if (fmt === 'md') { downloadBlob(safeName(doc.tab && doc.tab.title) + '.md', 'text/markdown', docToMarkdown(doc)); return; }
  // PDF / Word → main renders the doc's HTML into a real file (Electron printToPDF / html-to-docx) + opens it.
  try {
    const r = await window.sq.canvas.exportDoc({ title: (doc.tab && doc.tab.title) || 'Document', html: docToExportHtml(doc), markdown: docToMarkdown(doc), format: fmt });
    if (!r || !r.ok) msgEl.innerHTML = `<span class="err">⚠ export failed: ${esc((r && r.error) || 'unknown')}</span>`, msgEl.style.display = 'block';
  } catch (e) { console.error('[canvas] export error:', e.message); }
}
let _dlMenu = null;
function closeDownloadMenu() { if (_dlMenu) { _dlMenu.remove(); _dlMenu = null; } }
function openDownloadMenu(btn, doc) {
  closeDownloadMenu();
  const m = document.createElement('div'); m.className = 'dl-menu';
  m.innerHTML = `<button data-fmt="md">Markdown (.md)</button><button data-fmt="pdf">PDF</button><button data-fmt="docx">Word (.docx)</button>`;
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.round(r.right - 150)}px`; m.style.top = `${Math.round(r.bottom + 4)}px`;
  m.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { exportDoc(doc, b.dataset.fmt); closeDownloadMenu(); } });
  document.body.appendChild(m); _dlMenu = m;
}
document.addEventListener('click', (e) => { if (_dlMenu && !e.target.closest('.dl-menu') && !e.target.closest('[data-act="download"]')) closeDownloadMenu(); });

function trayRow(doc) {
  const t = doc.tab;
  return `<div class="titem${t.key === activeKey ? ' active' : ''}${doc.hidden ? ' closed' : ''}" data-key="${esc(t.key)}" data-hidden="${doc.hidden ? 1 : 0}">
    <div class="nm">${esc(t.title)}</div>
    <div class="sub"><span class="mode ${esc(t.mode)}">${esc(t.mode)}</span>${doc.stream.summary.total} block${doc.stream.summary.total === 1 ? '' : 's'}${doc.hidden ? ' · closed' : ''}</div>
  </div>`;
}

function applyTransform() { board.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
function raise(card) { if (card) card.style.zIndex = ++zTop; }

function renderTray(docs) {
  const visible = docs.filter(d => !d.hidden);
  trayRows.innerHTML = docs.length ? docs.map(trayRow).join('') : '<div class="titem"><div class="nm" style="color:var(--tx-dim)">No documents yet.</div></div>';
  trayRows.querySelectorAll('.titem').forEach(el => el.dataset.key && el.addEventListener('click', () => {
    if (el.dataset.hidden === '1') reopenDoc(el.dataset.key); else focusDoc(el.dataset.key);
  }));
  const closed = docs.length - visible.length;
  countEl.textContent = `${visible.length} open${closed ? ` · ${closed} closed` : ''}`;
  msgEl.style.display = visible.length ? 'none' : 'block';
  if (!visible.length) msgEl.innerHTML = docs.length ? 'All documents are closed.<div class="small">Open one from the ☰ tray.</div>' : 'Canvas is empty.<div class="small">Drop a document, or documents appear as Zoe produces deliverables.</div>';
}
// FULL render — rebuilds every card (positions/sizes re-applied from the server). Use on structural change.
function render(docs) {
  docPos = {}; for (const d of docs) docPos[d.tab.key] = d.pos || { x: 48, y: 48 };
  board.innerHTML = docs.filter(d => !d.hidden).map(docCard).join('');
  renderTray(docs);
}
// IN-PLACE patch — update ONLY each card's body content (the part that grows as Zoe builds), leaving the
// card element, its POSITION, SIZE, and scroll untouched. This keeps cards where you placed them and at
// the size you set across the auto-refresh (a full re-render would snap them back to the server defaults).
function structureSig(docs) { return (docs || []).map(d => `${d.tab.key}:${d.hidden ? 'h' : ''}${d.minimized ? 'm' : ''}`).sort().join('|'); }
function patchBodies(docs) {
  docPos = {}; for (const d of docs) docPos[d.tab.key] = d.pos || { x: 48, y: 48 };
  for (const d of docs) {
    if (d.hidden) continue;
    const card = board.querySelector(`.doc[data-key="${(window.CSS && CSS.escape) ? CSS.escape(d.tab.key) : d.tab.key}"]`);
    const body = card && card.querySelector('.doc-body');
    if (!body) continue;
    const inner = d.stream.blocks.length ? d.stream.blocks.map(blockContent).join('') : '<div class="doc-empty">No content yet.</div>';
    if (body.innerHTML !== inner) body.innerHTML = inner;   // only touch the DOM when content actually changed
  }
  renderTray(docs);
}

let _canvasSig = '', _structSig = '';
async function loadCanvas(retries = 6, force = false) {
  try {
    const res = await window.sq.canvas.getAll();
    if (!res || !res.ok) {
      if (retries > 0) { msgEl.textContent = 'Waiting for the engine…'; msgEl.style.display = 'block'; setTimeout(() => loadCanvas(retries - 1, force), 1500); return; }
      msgEl.innerHTML = `<span class="err">⚠ ${esc((res && res.error) || 'failed to load canvas')}</span>`; msgEl.style.display = 'block'; return;
    }
    const docs = res.docs || [];
    docsByKey = {}; for (const d of docs) if (d && d.tab) docsByKey[d.tab.key] = d;   // for the download/export menu
    // CHANGE-DETECTION: skip when nothing changed (unless forced), so the auto-refresh poll is a no-op
    // between passes.
    const sig = JSON.stringify(docs);
    if (sig === _canvasSig && !force) return;
    // NEVER re-render mid-interaction — don't consume the sig either, so it applies on the next poll after
    // the drag/resize/pan ends. This is what stops a poll from yanking a card you're moving/resizing.
    if (!force && (drag || resizing || panning)) return;
    _canvasSig = sig;
    const struct = structureSig(docs);
    if (force || struct !== _structSig) {   // cards added/removed/minimized/closed → full render
      _structSig = struct;
      const keep = activeKey;
      render(docs);
      if (keep) { try { selectDoc(keep); } catch {} }
    } else {                                 // content-only growth → patch bodies IN PLACE (keep pos/size/scroll)
      patchBodies(docs);
    }
  } catch (e) {
    if (retries > 0) { setTimeout(() => loadCanvas(retries - 1, force), 1500); return; }
    msgEl.innerHTML = `<span class="err">⚠ ${esc(e.message || String(e))}</span>`; msgEl.style.display = 'block';
  }
}

// SELECT: raise + highlight a card WITHOUT moving the view (this is what a card click/drag does —
// no surprise "snap"/recenter).
function selectDoc(key) {
  activeKey = key;
  trayRows.querySelectorAll('.titem').forEach(el => el.classList.toggle('active', el.dataset.key === key));
  const card = board.querySelector(`.doc[data-key="${(window.CSS && CSS.escape) ? CSS.escape(key) : key}"]`);
  board.querySelectorAll('.doc').forEach(el => el.classList.toggle('focus', el === card));
  if (card) raise(card);
  return card;
}
// FOCUS: select AND recenter the view on the document — a deliberate "jump to" (tray click / drop),
// never on a plain card click.
function focusDoc(key) {
  selectDoc(key);
  const p = docPos[key]; if (!p) return;
  zoom = 1; panX = 48 - p.x; panY = 48 - p.y; applyTransform();
}

async function reopenDoc(key) { try { await window.sq.canvas.updateDoc(key, { hidden: false }); } catch {} await loadCanvas(0); focusDoc(key); }

/* ---- interactions ---- */
board.addEventListener('click', (e) => {
  const btn = e.target.closest('.dbtn'); if (!btn) return;
  const card = btn.closest('.doc'); const key = card.dataset.key;
  if (btn.dataset.act === 'download') { e.stopPropagation(); openDownloadMenu(btn, docsByKey[key]); return; }
  if (btn.dataset.act === 'close') { try { window.sq.canvas.updateDoc(key, { hidden: true }); } catch {} loadCanvas(0); }
  else if (btn.dataset.act === 'min') {
    const min = !card.classList.contains('minimized');
    card.classList.toggle('minimized', min);
    btn.textContent = min ? '▢' : '–'; btn.title = min ? 'Restore' : 'Minimize';
    if (min) card.style.height = '';   // header-only; drop any fixed height
    try { window.sq.canvas.updateDoc(key, { minimized: min }); } catch {}
  }
});

// Download a table block as CSV (Excel/Sheets-openable). Serialized from the rendered rows so it
// matches exactly what the operator sees; BOM + CRLF for Excel, RFC-4180 quoting.
board.addEventListener('click', (e) => {
  const dl = e.target.closest('.tbl-dl'); if (!dl) return;
  e.stopPropagation();
  const table = dl.closest('.b-tablewrap') && dl.closest('.b-tablewrap').querySelector('table');
  if (!table) return;
  const csv = [...table.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('th,td')].map(cell => {
      const v = cell.textContent || '';
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')
  ).join('\r\n');
  const card = dl.closest('.doc'), titleEl = card && card.querySelector('.dtitle');
  const name = ((titleEl && titleEl.textContent) || 'contacts').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'contacts';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} a.remove(); }, 0);
});

surface.addEventListener('mousedown', (e) => {
  if (e.target.closest('.dbtn') || e.target.closest('.tbl-dl')) return;   // button click handled separately
  const grip = e.target.closest('.resize-grip');
  if (grip) {
    const card = grip.closest('.doc');
    resizing = { el: card, key: card.dataset.key, sx: e.clientX, sy: e.clientY, startW: card.offsetWidth, startH: card.offsetHeight };
    raise(card); e.preventDefault(); return;
  }
  const head = e.target.closest('.doc-head');
  if (head) {
    const card = head.closest('.doc');
    drag = { el: card, key: card.dataset.key, sx: e.clientX, sy: e.clientY, startLeft: parseFloat(card.style.left) || 0, startTop: parseFloat(card.style.top) || 0, moved: false };
    card.classList.add('dragging'); selectDoc(card.dataset.key); e.preventDefault(); return;   // select (raise), do NOT recenter
  }
  if (e.target.closest('.doc')) return;                          // inside body: allow text selection
  panning = true; panSX = e.clientX; panSY = e.clientY; panPX = panX; panPY = panY; surface.classList.add('grabbing');
});

window.addEventListener('mousemove', (e) => {
  if (resizing) {
    const w = Math.max(240, resizing.startW + (e.clientX - resizing.sx) / zoom);
    const h = Math.max(120, resizing.startH + (e.clientY - resizing.sy) / zoom);
    resizing.el.style.width = w + 'px'; resizing.el.style.height = h + 'px';
  } else if (drag) {
    drag.el.style.left = (drag.startLeft + (e.clientX - drag.sx) / zoom) + 'px';   // free move (stack/overlap; no edge snap)
    drag.el.style.top = (drag.startTop + (e.clientY - drag.sy) / zoom) + 'px';
    drag.moved = true;
  } else if (panning) {
    panX = panPX + (e.clientX - panSX); panY = panPY + (e.clientY - panSY); applyTransform();
  }
});

window.addEventListener('mouseup', () => {
  if (resizing) {
    const w = Math.round(resizing.el.offsetWidth), h = Math.round(resizing.el.offsetHeight);
    try { window.sq.canvas.updateDoc(resizing.key, { w, h }); } catch {}
    resizing = null;
  }
  if (drag) {
    drag.el.classList.remove('dragging');
    if (drag.moved && drag.key) {
      const x = Math.round(parseFloat(drag.el.style.left) || 0), y = Math.round(parseFloat(drag.el.style.top) || 0);
      docPos[drag.key] = { x, y };
      try { window.sq.canvas.setDocPos(drag.key, x, y); } catch {}
    }
    drag = null;
  }
  if (panning) { panning = false; surface.classList.remove('grabbing'); }
});

surface.addEventListener('wheel', (e) => {
  if (e.target.closest('.doc-body')) return;     // scroll inside a document, don't zoom
  e.preventDefault();
  const rect = surface.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const old = zoom;
  const f = e.deltaY < 0 ? 1.07 : 0.935;         // gentle step so it doesn't lurch
  zoom = Math.max(0.4, Math.min(2.2, zoom * f));
  panX = cx - ((cx - panX) * (zoom / old));
  panY = cy - ((cy - panY) * (zoom / old));
  applyTransform();
}, { passive: false });

/* ---- drag-and-drop a file onto the canvas → a document at the drop point ---- */
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function showToast(t) { const el = $('toast'); if (!el) return; el.textContent = t; el.classList.add('show'); clearTimeout(showToast._t); showToast._t = setTimeout(() => el.classList.remove('show'), 2800); }
function boardCoords(e) { const r = surface.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left - panX) / zoom), y: Math.round((e.clientY - r.top - panY) / zoom) }; }

surface.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; surface.classList.add('drop-hover'); });
surface.addEventListener('dragleave', (e) => { if (e.target === surface) surface.classList.remove('drop-hover'); });
surface.addEventListener('drop', async (e) => {
  e.preventDefault(); surface.classList.remove('drop-hover');
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!files.length) return;
  const base = boardCoords(e);
  let i = 0, lastKey = null, okN = 0;
  for (const f of files) {
    const x = base.x + i * 30, y = base.y + i * 30; i += 1;
    const p = window.sq.pathForFile ? window.sq.pathForFile(f) : null;
    if (!p) { showToast(`Couldn't resolve path for ${f.name}`); continue; }
    try {
      const res = await window.sq.canvas.dropDoc(p, x, y);
      if (res && res.ok) { okN += 1; lastKey = res.tabKey; } else { showToast(`Drop failed: ${(res && res.error) || f.name}`); }
    } catch (err) { showToast(`Drop error: ${err.message}`); }
  }
  // Full render to pick up the new card, then just SELECT it (raise/highlight) — do NOT focusDoc, which
  // recenters the whole board on it and makes the view "jump" even though the doc is already sitting where
  // you dropped it.
  if (okN) { await loadCanvas(0, true); if (lastKey) { try { selectDoc(lastKey); } catch {} } showToast(`Added ${okN} document${okN === 1 ? '' : 's'}`); }
});

$('trayBtn').addEventListener('click', () => trayEl.classList.toggle('open'));
$('refreshBtn').addEventListener('click', () => loadCanvas(0, true));
$('resetBtn').addEventListener('click', async () => { try { await window.sq.canvas.resetLayout(); } catch {} loadCanvas(0, true); });

/* ---- Meet-in-canvas pane (Slice 6) — host Google Meet in a webview on Zoe's own Google session,
   so she joins as herself without monopolizing her dedicated CDP browser. Fixed floating panel
   (not on the zoom/pan board); a shield over the webview captures the mouse during drag/resize. ---- */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const meetpane = $('meetpane'), meetHead = $('meetHead'), meetBody = $('meetBody'), meetTitle = $('meetTitle');
let meetWV = null, meetPlaced = false;

let meetPartition = null;
// ONE meeting pane, reused per platform (only one meeting at a time). Meet and Teams both mount here,
// each on its own session partition. A <webview>'s partition is fixed at creation, so switching
// platforms rebuilds the element. Meet's behavior is unchanged (mountMeet → this with zoe-google).
function mountMeeting(info, partition, defaultTitle) {
  const url = info && info.url; if (!url) return;
  meetTitle.textContent = (info && info.title) || defaultTitle;
  if (meetWV && meetPartition !== partition) { try { meetWV.remove(); } catch {} meetWV = null; }
  if (!meetWV) {
    meetWV = document.createElement('webview');
    meetWV.setAttribute('partition', partition);              // Zoe's own Google / Teams session
    meetWV.setAttribute('allowpopups', '');
    meetWV.setAttribute('useragent', CHROME_UA);              // present as Chrome (avoid Meet AND Teams "unsupported browser")
    meetBody.appendChild(meetWV);
    meetPartition = partition;
  }
  meetWV.src = url;
  if (!meetPlaced) { meetpane.style.left = Math.max(20, window.innerWidth - 844) + 'px'; meetpane.style.top = '58px'; meetPlaced = true; }
  meetpane.hidden = false; meetpane.classList.remove('minimized'); $('meetMin').textContent = '–';
}
function mountMeet(info) { mountMeeting(info, 'persist:zoe-google', 'Google Meet'); }
// Teams needs a WARMUP: a cold load of the meeting URL triggered a silent-SSO iframe that Microsoft's
// CSP blocked, so she never authenticated in. Load Teams home first (the ported cookies establish the
// session there cleanly), then navigate the SAME pane to the meeting URL once it has settled.
let teamsTarget = null;
function mountTeams(info) {
  const url = info && info.url; if (!url) return;
  teamsTarget = url;
  mountMeeting({ ...info, url: 'https://teams.microsoft.com/v2/' }, 'persist:zoe-teams', (info && info.title) || 'Microsoft Teams');
  if (!meetWV) return;
  const go = () => { if (teamsTarget === url) { const t = teamsTarget; teamsTarget = null; try { meetWV.src = t; } catch {} } };
  // Fire after the home page's first load settles (gives auth a moment); { once } so it only swaps once.
  meetWV.addEventListener('did-finish-load', () => setTimeout(go, 3500), { once: true });
}
function closeMeet() { if (meetWV) { try { meetWV.src = 'about:blank'; } catch {} meetWV.remove(); meetWV = null; } meetpane.hidden = true; meetpane.classList.remove('minimized'); }
$('meetClose').addEventListener('click', closeMeet);
$('meetReload').addEventListener('click', () => { if (meetWV) { try { meetWV.reload(); } catch {} } });
$('meetMin').addEventListener('click', () => { const m = !meetpane.classList.contains('minimized'); meetpane.classList.toggle('minimized', m); $('meetMin').textContent = m ? '▢' : '–'; });

let mDrag = null, mResize = null;
meetHead.addEventListener('mousedown', (e) => {
  if (e.target.closest('.dbtn')) return;
  mDrag = { sx: e.clientX, sy: e.clientY, sl: meetpane.offsetLeft, st: meetpane.offsetTop };
  meetHead.classList.add('dragging'); meetpane.classList.add('interacting'); e.preventDefault();
});
$('meetResize').addEventListener('mousedown', (e) => {
  mResize = { sx: e.clientX, sy: e.clientY, w: meetpane.offsetWidth, h: meetpane.offsetHeight };
  meetpane.classList.add('interacting'); e.preventDefault(); e.stopPropagation();
});
window.addEventListener('mousemove', (e) => {
  if (mDrag) { meetpane.style.left = Math.max(0, mDrag.sl + (e.clientX - mDrag.sx)) + 'px'; meetpane.style.top = Math.max(40, mDrag.st + (e.clientY - mDrag.sy)) + 'px'; }
  else if (mResize) { meetpane.style.width = Math.max(360, mResize.w + (e.clientX - mResize.sx)) + 'px'; meetpane.style.height = Math.max(280, mResize.h + (e.clientY - mResize.sy)) + 'px'; }
});
window.addEventListener('mouseup', () => { if (mDrag) { meetHead.classList.remove('dragging'); mDrag = null; } if (mResize) mResize = null; meetpane.classList.remove('interacting'); });

if (window.sq && window.sq.onMeetJoin) window.sq.onMeetJoin(mountMeet);
if (window.sq && window.sq.onTeamsJoin) window.sq.onTeamsJoin(mountTeams);

/* ---- Full-ingestion video pane (own pane, AUDIO ON) — the gate for deep-watching a video/live for
   full ingestion (soundtrack → transcription; needed for content without CCs). Mirrors the Meet pane
   (drag/resize/shield) but never mutes and autoplays. Reuses the .meetpane chrome. ---- */
const ingestpane = $('ingestpane'), ingestHead = $('ingestHead'), ingestBody = $('ingestBody'), ingestTitle = $('ingestTitle');
let ingestWV = null, ingestPlaced = false, ingestBase = '';
async function mountIngest(info) {
  const url = info && info.url; if (!url) return;
  const id = FV ? FV.youtubeId(url) : null;
  ingestTitle.textContent = (info && info.title) || 'Full ingestion';
  if (!ingestBase) { try { const pb = await window.sq.feeds.playerBase(); ingestBase = (pb && pb.base) || ''; } catch {} }
  if (ingestWV) { try { ingestWV.remove(); } catch {} ingestWV = null; }
  ingestWV = document.createElement('webview');
  ingestWV.setAttribute('partition', 'persist:zoe-media');
  ingestWV.setAttribute('allowpopups', '');
  // AUDIO ON + autoplay (a=1) via the clean local player when it's a YouTube id; else load the URL directly.
  ingestWV.setAttribute('src', (id && ingestBase) ? `${ingestBase}?v=${id}&a=1` : url);
  ingestBody.appendChild(ingestWV);
  if (!ingestPlaced) { ingestpane.style.width = '880px'; ingestpane.style.height = '560px'; ingestpane.style.left = Math.max(20, Math.round((window.innerWidth - 900) / 2)) + 'px'; ingestpane.style.top = '70px'; ingestPlaced = true; }
  ingestpane.hidden = false; ingestpane.classList.remove('minimized');
}
function closeIngest() { if (ingestWV) { try { ingestWV.src = 'about:blank'; } catch {} ingestWV.remove(); ingestWV = null; } ingestpane.hidden = true; }
$('ingestClose').addEventListener('click', closeIngest);
$('ingestReload').addEventListener('click', () => { if (ingestWV) { try { ingestWV.reload(); } catch {} } });
let iDrag = null, iResize = null;
ingestHead.addEventListener('mousedown', (e) => { if (e.target.closest('.dbtn')) return; iDrag = { sx: e.clientX, sy: e.clientY, sl: ingestpane.offsetLeft, st: ingestpane.offsetTop }; ingestHead.classList.add('dragging'); ingestpane.classList.add('interacting'); e.preventDefault(); });
$('ingestResize').addEventListener('mousedown', (e) => { iResize = { sx: e.clientX, sy: e.clientY, w: ingestpane.offsetWidth, h: ingestpane.offsetHeight }; ingestpane.classList.add('interacting'); e.preventDefault(); e.stopPropagation(); });
window.addEventListener('mousemove', (e) => {
  if (iDrag) { ingestpane.style.left = Math.max(0, iDrag.sl + (e.clientX - iDrag.sx)) + 'px'; ingestpane.style.top = Math.max(40, iDrag.st + (e.clientY - iDrag.sy)) + 'px'; }
  else if (iResize) { ingestpane.style.width = Math.max(360, iResize.w + (e.clientX - iResize.sx)) + 'px'; ingestpane.style.height = Math.max(280, iResize.h + (e.clientY - iResize.sy)) + 'px'; }
});
window.addEventListener('mouseup', () => { if (iDrag) { ingestHead.classList.remove('dragging'); iDrag = null; } if (iResize) iResize = null; ingestpane.classList.remove('interacting'); });
if (window.sq && window.sq.onVideoIngest) window.sq.onVideoIngest(mountIngest);

/* ---- Monitors widget (news feeds) — the persistent live-monitor wall. Fetches merged feed items
   via window.sq.feeds.*, renders newest-first with new-item highlight, auto-refreshes while open.
   Display-only here (Side Quest half); storage + her cognition over items = Zoe-builder. ---- */
const FV = window.FeedsView;
const monitors = $('monitors'), monList = $('monList'), monSources = $('monSources'), monN = $('monN'), monVideos = $('monVideos');
const monSrcHead = $('monSrcHead'), monSrcChev = $('monSrcChev'), monSrcLbl = $('monSrcLbl');
const monSeen = new Set();
let monPrimed = false, monTimer = null, monTuner = null;   // monTuner = topical-balance config (from feeds.fetch / tunerGet)
const MON_REFRESH_MS = 2 * 60 * 1000;
const NT = window.NewsTopics, NR = window.NewsRank;
const catLabel = (k) => (NT && NT.BY_KEY[k] && NT.BY_KEY[k].label) || '';

function renderMonitors(items, sources) {
  // Collapse cross-outlet SYNDICATION for display only (the collector keeps every copy for corroboration):
  // 5 metros reprinting one wire story → one card with a "+N outlets" badge. Un-blots the firehose.
  const collapsed = FV ? FV.collapseDuplicates(items) : (items || []);
  // NEWS TUNER: balance topics (reserve hard-news slots / weight / cap) so a hot topic (World Cup) can't
  // flood the feed. Base score = recency. No tuner/module yet → the plain collapsed list (unchanged).
  let arranged = collapsed;
  if (NR && monTuner) {
    try {
      arranged = NR.arrange(collapsed, monTuner, {
        slots: 50, reserved: (monTuner.reservedSlots && monTuner.reservedSlots.feed) || 0,
        scoreOf: (it) => it.publishedMs || 0,
      }).items;
    } catch {}
  }
  const marked = FV ? FV.markNew(arranged, monSeen) : arranged.map(i => ({ ...i, isNew: false }));
  const now = Date.now();
  monList.innerHTML = marked.length ? marked.map(it => `
    <div class="mon-item${monPrimed && it.isNew ? ' new' : ''}">
      <div class="it-top"><span class="it-src">${esc(it.source)}</span>${it.category ? `<span class="it-cat">${esc(catLabel(it.category) || it.category)}</span>` : ''}${it.dupCount > 1 ? `<span class="it-dup" title="${esc((it.dupSources || []).join(', '))}">+${it.dupOutlets - 1} more outlet${it.dupOutlets - 1 === 1 ? '' : 's'}</span>` : ''}<span class="it-ago">${esc(FV ? FV.relTime(it.publishedMs, now) : '')}</span></div>
      <div class="it-title">${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noreferrer">${esc(it.title)}</a>` : esc(it.title)}</div>
      ${it.summary ? `<div class="it-sum">${esc(it.summary)}</div>` : ''}
    </div>`).join('') : '<div class="mon-empty">No items yet. Add a feed URL above, or hit ⟳.</div>';
  const upd = new Date(now); const hh = String(upd.getHours()).padStart(2, '0'), mm = String(upd.getMinutes()).padStart(2, '0'), ss = String(upd.getSeconds()).padStart(2, '0');
  monN.textContent = `${marked.length ? `${marked.length} items · ` : ''}updated ${hh}:${mm}:${ss}`;
  monSources.innerHTML = (sources || []).map(s => `<span class="mon-src${s.ok ? '' : ' bad'}" title="${esc(s.sourceUrl)}">${esc(s.source)}<span class="x" data-url="${esc(s.sourceUrl)}">×</span></span>`).join('');
  monSources.querySelectorAll('.x').forEach(el => el.addEventListener('click', () => removeFeed(el.dataset.url)));
  const badCount = (sources || []).filter(s => !s.ok).length;
  monSrcLbl.textContent = `sources (${(sources || []).length})${badCount ? ` · ${badCount} down` : ''}`;
  // seed the seen-set so the NEXT fetch highlights only genuinely new items (first load isn't a flood)
  for (const it of marked) monSeen.add(it.id);
  monPrimed = true;
}
async function loadFeeds() {
  monN.textContent = '…';
  try {
    const res = await window.sq.feeds.fetch(30);
    if (!res || !res.ok) { monList.innerHTML = `<div class="mon-empty err">⚠ ${esc((res && res.error) || 'fetch failed')}</div>`; monN.textContent = ''; return; }
    if (res.tuner) monTuner = res.tuner;   // topical-balance config rides along with the fetch
    renderMonitors(res.items || [], res.sources || []);
  } catch (e) { monList.innerHTML = `<div class="mon-empty err">⚠ ${esc(e.message)}</div>`; monN.textContent = ''; }
}
async function removeFeed(url) { try { await window.sq.feeds.remove(url); } catch {} await loadFeeds(); }

// Embedded YouTube monitors at the bottom of the widget (paused until clicked → no echo/cacophony).
async function loadVideos() {
  try {
    const [res, pb] = await Promise.all([window.sq.feeds.videoList(), window.sq.feeds.playerBase()]);
    renderVideos((res && res.videos) || [], (pb && pb.base) || '');
  } catch {}
}
function renderVideos(videos, playerBase) {
  // <webview> (not <iframe>): a file:// page can't host a YouTube embed (Error 153 — no web origin).
  // MUST be built with createElement — <webview> tags injected via innerHTML don't instantiate in
  // Electron (same reason the Meet pane creates its webview programmatically). Loaded top-level in a
  // webview the player's origin is youtube.com, so it plays; the partition keeps it off her main browser.
  monVideos.innerHTML = '';
  for (const v of (videos || [])) {
    const id = FV ? FV.youtubeId(v.url) : null;
    if (!id) continue;
    const wrap = document.createElement('div'); wrap.className = 'vid';
    const x = document.createElement('button'); x.className = 'vx'; x.title = 'Remove'; x.textContent = '×';
    x.addEventListener('click', async () => { try { await window.sq.feeds.videoRemove(v.url); } catch {} loadVideos(); });
    const spk = document.createElement('button'); spk.className = 'vspk'; spk.title = 'Unmute (mutes the others)'; spk.textContent = '🔇';
    const ing = document.createElement('button'); ing.className = 'ving'; ing.title = 'Full ingestion (own pane, audio on)'; ing.textContent = '⤢';
    ing.addEventListener('click', () => { try { window.sq.ingestVideo(v.url, v.title || ''); } catch {} });
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:zoe-media');
    wv.setAttribute('allowpopups', '');
    // Clean chrome-free player via the local http origin (frames the embed with a matching ?origin=,
    // dodging Error 153). Fall back to the full watch page only if the player server isn't up. Muted by
    // default so multiple tiles don't blast; 🔊 unmutes just this one.
    wv.setAttribute('src', playerBase ? `${playerBase}?v=${id}` : `https://www.youtube.com/watch?v=${id}`);
    wv.addEventListener('dom-ready', () => { try { wv.setAudioMuted(true); } catch {} });
    spk.addEventListener('click', () => {
      const on = spk.textContent === '🔇';
      monVideos.querySelectorAll('webview').forEach(o => { try { o.setAudioMuted(!(on && o === wv)); } catch {} });
      monVideos.querySelectorAll('.vspk').forEach(b => { b.textContent = '🔇'; });
      spk.textContent = on ? '🔊' : '🔇';
    });
    wrap.appendChild(x); wrap.appendChild(spk); wrap.appendChild(ing); wrap.appendChild(wv);
    monVideos.appendChild(wrap);
  }
}

// Smart add: a YouTube URL → a video tile; anything else → an RSS/Atom feed.
async function addMonitor(url) {
  if (!url) return;
  if (FV && FV.youtubeId(url)) { const r = await window.sq.feeds.videoAdd(url); if (r && r.ok) { $('monAdd').value = ''; await loadVideos(); } }
  else { const r = await window.sq.feeds.add(url); if (r && r.ok) { $('monAdd').value = ''; monPrimed = false; monSeen.clear(); await loadFeeds(); } }
}

// NEWS BRIEFING panel (Phase B) — the on-demand "dam" snapshot: freshen + render the schema-locked brief.
const monBriefPanel = $('monBriefPanel'), monBriefBody = $('monBriefBody');
// markdown-lite → HTML (headers / bold / italic / links / lists / blockquotes). The brief is our own
// deterministic format, so this small renderer is enough (no md library in the renderer).
function mdLite(md) {
  const lines = String(md || '').split('\n'); let html = '', inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const ln of lines) {
    if (/^### /.test(ln)) { closeList(); html += '<h4>' + inline(ln.slice(4)) + '</h4>'; }
    else if (/^## /.test(ln)) { closeList(); html += '<h3>' + inline(ln.slice(3)) + '</h3>'; }
    else if (/^# /.test(ln)) { closeList(); html += '<h2>' + inline(ln.slice(2)) + '</h2>'; }
    else if (/^> /.test(ln)) { closeList(); html += '<blockquote>' + inline(ln.slice(2)) + '</blockquote>'; }
    else if (/^- /.test(ln)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(ln.slice(2)) + '</li>'; }
    else if (ln.trim() === '') { closeList(); }
    else { closeList(); html += '<p>' + inline(ln) + '</p>'; }
  }
  closeList();
  return html;
}
// The drawer is a sibling of .monitors (which clips overflow), so JS pins it flush to the monitor's
// right edge — flipping to the LEFT if it would run off the viewport — and tracks drag/resize.
function positionBriefDrawer() {
  const gap = 8, w = monBriefPanel.offsetWidth || 400;
  const mL = monitors.offsetLeft, mT = monitors.offsetTop, mW = monitors.offsetWidth, mH = monitors.offsetHeight;
  let left = mL + mW + gap;
  if (left + w > window.innerWidth - 8) left = Math.max(8, mL - w - gap);   // flip left when there's no room on the right
  monBriefPanel.style.left = left + 'px';
  monBriefPanel.style.top = mT + 'px';
  monBriefPanel.style.height = mH + 'px';
}
async function showBriefing() {
  if (!monBriefPanel.hidden) { monBriefPanel.hidden = true; return; }        // toggle closed
  try { $('monTunePanel').hidden = true; } catch {}                          // one drawer at a time
  monBriefPanel.hidden = false;
  positionBriefDrawer();
  const b = $('monBrief'); if (b) b.classList.remove('pulse');
  monBriefBody.innerHTML = '<div class="mon-empty">Compiling the briefing…</div>';
  try {
    const r = await window.sq.feeds.briefing();
    if (!r || !r.ok) { monBriefBody.innerHTML = `<div class="mon-empty err">⚠ ${esc((r && r.error) || 'briefing failed')}</div>`; return; }
    monBriefBody.innerHTML = mdLite(r.markdown) + `<div class="mon-brief-foot">${r.viaCloud ? 'cloud-written' : 'auto-compiled'} · ${r.storyCount} stories tracked · ${r.freshItems} fresh items</div>`;
  } catch (e) { monBriefBody.innerHTML = `<div class="mon-empty err">⚠ ${esc(e.message)}</div>`; }
}
$('monBrief').addEventListener('click', showBriefing);
$('monBriefClose').addEventListener('click', () => { monBriefPanel.hidden = true; });
window.addEventListener('resize', () => { if (!monBriefPanel.hidden) positionBriefDrawer(); try { if (!monTunePanel.hidden) positionTuneDrawer(); } catch {} });
// hourly layer push → pulse the briefing button so the operator knows a fresh hour has compiled
try { window.sq.feeds.onLayer(() => { const b = $('monBrief'); if (b && monBriefPanel.hidden) b.classList.add('pulse'); }); } catch {}

// ---- TOPIC TUNER panel (news tuner slice 6): per-category weight/cap sliders + reserved hard-news slots ----
const monTunePanel = $('monTunePanel'), monTuneBody = $('monTuneBody');
function positionTuneDrawer() {
  const gap = 8, w = monTunePanel.offsetWidth || 400;
  const mL = monitors.offsetLeft, mT = monitors.offsetTop, mW = monitors.offsetWidth, mH = monitors.offsetHeight;
  let left = mL + mW + gap;
  if (left + w > window.innerWidth - 8) left = Math.max(8, mL - w - gap);
  monTunePanel.style.left = left + 'px'; monTunePanel.style.top = mT + 'px'; monTunePanel.style.height = mH + 'px';
}
function renderTunerRows() {
  const cfg = monTuner || (NR ? NR.defaultTuner() : null);
  if (!cfg || !NT) { monTuneBody.innerHTML = '<div class="mon-empty">tuner unavailable</div>'; return; }
  const hd = '<div class="mon-tune-hd"><span>topic</span><span>mute ← weight → boost</span><span>cap%</span><span>🛡</span></div>';
  monTuneBody.innerHTML = hd + NT.TAXONOMY.map((t) => {
    const c = cfg.categories[t.key] || { weight: 1, capPct: null, protected: t.protected };
    const w = (c.weight == null ? 1 : c.weight);
    return `<div class="mon-tune-row" data-key="${t.key}">
      <span class="tc-name${c.protected ? ' prot' : ''}" title="${esc(t.label)}">${esc(t.label)}</span>
      <input class="tc-w" type="range" min="0" max="3" step="0.1" value="${w}" title="weight (0 = mute)">
      <input class="tc-cap" type="number" min="0" max="100" placeholder="—" value="${c.capPct == null ? '' : c.capPct}" title="max % of the surface (blank = uncapped)">
      <span class="tc-prot${c.protected ? ' on' : ''}" title="protected — counts toward the reserved hard-news slots">🛡</span>
    </div>`;
  }).join('');
  $('monTuneRsvFeed').value = (cfg.reservedSlots && cfg.reservedSlots.feed) || 0;
  $('monTuneRsvBrief').value = (cfg.reservedSlots && cfg.reservedSlots.brief) || 0;
  monTuneBody.querySelectorAll('.tc-prot').forEach((el) => el.addEventListener('click', () => el.classList.toggle('on')));
}
function collectTuner() {
  const cats = {};
  monTuneBody.querySelectorAll('.mon-tune-row').forEach((row) => {
    const capRaw = row.querySelector('.tc-cap').value.trim();
    cats[row.dataset.key] = {
      weight: parseFloat(row.querySelector('.tc-w').value),
      capPct: capRaw === '' ? null : Math.max(0, Math.min(100, parseFloat(capRaw) || 0)),
      protected: row.querySelector('.tc-prot').classList.contains('on'),
    };
  });
  return { version: 1, reservedSlots: { feed: parseInt($('monTuneRsvFeed').value, 10) || 0, brief: parseInt($('monTuneRsvBrief').value, 10) || 0 }, categories: cats };
}
async function showTuner() {
  if (!monTunePanel.hidden) { monTunePanel.hidden = true; return; }
  monBriefPanel.hidden = true;                                   // one drawer at a time
  if (!monTuner) { try { const r = await window.sq.feeds.tunerGet(); if (r && r.ok) monTuner = r.tuner; } catch {} }
  monTunePanel.hidden = false; positionTuneDrawer(); renderTunerRows();
}
$('monTune').addEventListener('click', showTuner);
$('monTuneClose').addEventListener('click', () => { monTunePanel.hidden = true; });
$('monTuneReset').addEventListener('click', () => { monTuner = NR ? NR.defaultTuner() : monTuner; renderTunerRows(); });
$('monTuneSave').addEventListener('click', async () => {
  const cfg = collectTuner();
  try { const r = await window.sq.feeds.tunerSet(cfg); if (r && r.ok) monTuner = r.tuner; } catch {}
  monTunePanel.hidden = true;
  loadFeeds();                                                   // re-arrange the feed with the new config
});

function openMonitors() {
  monitors.hidden = false;
  document.body.classList.add('mon-open');   // reserve the docked monitor's column (surface insets right)
  loadFeeds();                   // always pull fresh on open (news moves; a stale wall reads as "broken")
  loadVideos();                  // videos: cheap (no network) — refresh every open so re-seeds show
  if (!monTimer) monTimer = setInterval(loadFeeds, MON_REFRESH_MS);
}
function closeMonitors() { monitors.hidden = true; document.body.classList.remove('mon-open'); monBriefPanel.hidden = true; try { monTunePanel.hidden = true; } catch {} if (monTimer) { clearInterval(monTimer); monTimer = null; } }
$('monitorsBtn').addEventListener('click', () => { if (monitors.hidden) openMonitors(); else closeMonitors(); });
$('monClose').addEventListener('click', closeMonitors);
$('monRefresh').addEventListener('click', loadFeeds);
// Source selector collapses by default (20+ chips otherwise dwarf the feed); click the bar to toggle.
monSrcHead.addEventListener('click', () => { const collapsed = monSources.classList.toggle('collapsed'); monSrcChev.textContent = collapsed ? '▸' : '▾'; });
$('monAddBtn').addEventListener('click', () => addMonitor($('monAdd').value.trim()));
$('monAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMonitor($('monAdd').value.trim()); });

/* ---- People rail — a left-docked waterfall of contact cards discovered from dropped documents. Fetches
   recent Puller contacts on open (newest-first) + receives a live push per new discovery (main →
   contacts:card), which pops the rail open and flashes the new card. Click a card's briefing → Puller. ---- */
const people = $('people'), pplList = $('pplList'), pplN = $('pplN');
// stable dedup key across fetch + live push (person by targetId, place/event by their key/name)
function cardKeyOf(c) {
  const t = c.type || 'person';
  if (t === 'person') return c.targetId != null ? 'p' + c.targetId : 'person:' + String(c.name || '').toLowerCase();
  return t + ':' + String(c.key || c.name || '').toLowerCase();
}
function cardHtml(c, isNew) {
  const _key = cardKeyOf(c);
  c = applyEdits(c);                          // merge any manual reference correction (persisted in meta)
  const t = c.type || 'person';
  const avatar = (t === 'person' && c.photo)
    ? `<img class="pc-photo" src="${esc(c.photo)}" alt="${esc(c.name)}" draggable="false" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pc-initials',textContent:'${esc((c.initials || '?').replace(/'/g, ''))}'}))">`
    : `<div class="pc-initials pc-av-${esc(t)}">${esc(c.initials || '?')}</div>`;
  const rows = [];
  let sub = '', roleLine = '', grade = '', brief = '', expand = '', actions = '', social = '';
  if (t === 'place') {
    if (c.address) rows.push(`<div class="pc-row"><span class="pc-ic">📍</span>${esc(c.address)}</div>`);
    sub = c.note ? `<div class="pc-bio">${esc(c.note)}</div>` : '';
    roleLine = 'Place';
  } else if (t === 'event') {
    if (c.date) rows.push(`<div class="pc-row"><span class="pc-ic">🕒</span>${esc(c.date)}</div>`);
    if (c.location) rows.push(`<div class="pc-row"><span class="pc-ic">📍</span>${esc(c.location)}</div>`);
    sub = c.note ? `<div class="pc-bio">${esc(c.note)}</div>` : '';
    roleLine = 'Event';
  } else if (t === 'org') {
    sub = c.bio ? `<div class="pc-bio">${esc(c.bio)}</div>` : '';
    roleLine = c.role || 'Organization';
  } else {
    if (c.email) rows.push(`<div class="pc-row"><span class="pc-ic">✉</span><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>`);
    if (c.phone) rows.push(`<div class="pc-row"><span class="pc-ic">☎</span>${esc(c.phone)}</div>`);
    if (c.address) rows.push(`<div class="pc-row"><span class="pc-ic">⌂</span>${esc(c.address)}</div>`);
    sub = c.bio ? `<div class="pc-bio">${esc(c.bio)}</div>` : '';
    roleLine = c.role || '';
    grade = c.grade ? `<span class="pc-grade g-${esc(c.grade)}" title="confidence ${esc(c.grade)}">${esc(c.grade)}</span>` : '';
    // INLINE EXPAND — the complete CRM entry, revealed on click (the card is a CRM contact).
    if (c.crm && Array.isArray(c.crm.fields)) {
      const fr = c.crm.fields.map(f => `<div class="pc-crm-row"><span class="k">${esc(f.k)}</span><span class="v">${esc(f.v)}</span></div>`).join('');
      const notes = c.crm.notes ? `<div class="pc-crm-notes">${esc(c.crm.notes)}</div>` : '';
      const wiki = c.crm.wikipedia ? `<a class="pc-crm-wiki" href="${esc(c.crm.wikipedia)}" target="_blank" rel="noreferrer">Wikipedia ↗</a>` : '';
      expand = `<div class="pc-crm">${fr}${notes}${wiki}</div>`;
    }
    const crmBtn = (c.crm && c.crm.crmId != null) ? `<button class="pc-crmbtn" data-crm="${esc(String(c.crm.crmId))}">Open in CRM →</button>` : '';
    const briefBtn = c.targetId != null ? `<button class="pc-briefing" data-target="${esc(String(c.targetId))}">Full briefing →</button>` : '';
    actions = (crmBtn || briefBtn) ? `<div class="pc-actions">${crmBtn}${briefBtn}</div>` : '';
    // Discovered social handles (maigret) — corroborated but UNVERIFIED (grade-E). Labeled so nobody
    // mistakes them for confirmed CRM handles; each links out to the profile for a human to eyeball.
    if (Array.isArray(c.social) && c.social.length) {
      const links = c.social.map(s => `<a class="pc-social-link" href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.site || s.url)} ↗</a>`).join('');
      social = `<div class="pc-social"><div class="pc-social-lbl">Possible handles · unverified</div><div class="pc-social-links">${links}</div></div>`;
    }
  }
  const expandable = expand ? ' pc-can-expand' : '';
  const editMark = cardEdits[_key] ? '<span class="pc-editmark" title="manually edited">✎</span>' : '';
  return `<div class="ppl-card ppl-${esc(t)}${expandable}${isNew ? ' new' : ''}" data-card="${esc(_key)}">
    <div class="pc-head">${avatar}<div class="pc-id"><div class="pc-name">${esc(c.name)}${editMark}</div>${roleLine ? `<div class="pc-role">${esc(roleLine)}</div>` : ''}</div>${grade}<button class="pc-edit" title="Edit references">✎</button></div>
    ${rows.length ? `<div class="pc-rows">${rows.join('')}</div>` : ''}${sub}${social}${expand}${actions}${brief}
  </div>`;
}

// ---- inline reference editing (people / places / events) — corrections persist in meta (window.sq.setMeta),
// applied on render. NO main-process handler → NO app reboot; a card refresh picks up the new UI. ----------
const cardEdits = {};   // cardKey -> patch object (loaded from meta once, applied by applyEdits)
const cardData = {};    // cardKey -> the last raw card object (so a card can be re-rendered on save/cancel)
const EDIT_FIELDS = {
  person: [['name', 'Name'], ['role', 'Role'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Address']],
  org:    [['name', 'Name'], ['role', 'Role'], ['bio', 'About']],
  place:  [['name', 'Name'], ['address', 'Address'], ['note', 'Note']],
  event:  [['name', 'Name'], ['date', 'Date'], ['location', 'Location'], ['note', 'Note']],
};
function applyEdits(c) {
  const p = cardEdits[cardKeyOf(c)];
  return (p && typeof p === 'object') ? Object.assign({}, c, p) : c;
}
function cardEditFormHtml(c) {
  const fields = EDIT_FIELDS[c.type || 'person'] || EDIT_FIELDS.person;
  const inputs = fields.map(([k, label]) =>
    `<label class="pc-ef"><span>${esc(label)}</span><input class="pc-ei" data-k="${esc(k)}" value="${esc(c[k] == null ? '' : String(c[k]))}"></label>`).join('');
  return `<div class="pc-editform">${inputs}<div class="pc-ef-actions"><button class="pc-edit-save">Save</button><button class="pc-edit-cancel">Cancel</button></div></div>`;
}
// re-render one card in place; editing=true swaps in the edit form.
function refreshCard(key, editing) {
  const c = cardData[key]; if (!c) return;
  const el = pplList.querySelector(`.ppl-card[data-card="${CSS.escape(key)}"]`); if (!el) return;
  if (editing) el.outerHTML = `<div class="ppl-card ppl-${esc(c.type || 'person')} pc-editing" data-card="${esc(key)}">${cardEditFormHtml(applyEdits(c))}</div>`;
  else el.outerHTML = cardHtml(c, false);
}
function saveEdit(key) {
  const el = pplList.querySelector(`.ppl-card[data-card="${CSS.escape(key)}"]`); if (!el) return;
  const patch = {};
  el.querySelectorAll('.pc-ei').forEach((inp) => { patch[inp.dataset.k] = String(inp.value || '').trim(); });
  if (!patch.name) delete patch.name;         // never blank the name (it'd drop the card from the rail)
  cardEdits[key] = patch;
  try { window.sq.setMeta('cardedit:' + key, JSON.stringify(patch)); } catch (e) {}
  refreshCard(key, false);
}
// load a persisted correction for a card that just appeared, and re-render it if one exists.
async function ensureOverride(c) {
  const key = cardKeyOf(c);
  if (key in cardEdits) { if (cardEdits[key]) refreshCard(key, false); return; }
  cardEdits[key] = null;                       // reserve so a burst of the same card only loads once
  try { const raw = await window.sq.getMeta('cardedit:' + key); if (raw) { cardEdits[key] = JSON.parse(raw); refreshCard(key, false); } }
  catch (e) {}
}
function pplCount() { pplN.textContent = String(pplList.querySelectorAll('.ppl-card').length || ''); }
function renderPeople(cards) {
  const list = (Array.isArray(cards) ? cards : []).filter(c => c && c.name);
  for (const c of list) cardData[cardKeyOf(c)] = c;
  pplList.innerHTML = list.length ? list.map(c => cardHtml(c, false)).join('') : '<div class="ppl-empty">No cards yet.<br>Drop a document on the canvas.</div>';
  pplCount();
  for (const c of list) ensureOverride(c);                 // apply any persisted reference corrections
}
function prependCard(c) {
  if (!c || !c.name) return;
  cardData[cardKeyOf(c)] = c;
  const existing = pplList.querySelector(`.ppl-card[data-card="${CSS.escape(cardKeyOf(c))}"]`);
  if (existing) existing.remove();                         // same object already shown → moves to top, refreshed
  const empty = pplList.querySelector('.ppl-empty'); if (empty) empty.remove();
  pplList.insertAdjacentHTML('afterbegin', cardHtml(c, true));
  pplCount();
  ensureOverride(c);
}
async function loadPeople() {
  try { const r = await window.sq.contacts.recent(60); renderPeople((r && r.cards) || []); }
  catch (e) { pplList.innerHTML = `<div class="ppl-empty">⚠ ${esc(e.message)}</div>`; }
}
function openPeople() { people.hidden = false; document.body.classList.add('ppl-open'); loadPeople(); }
function closePeople() { people.hidden = true; document.body.classList.remove('ppl-open'); }
$('peopleBtn').addEventListener('click', () => { if (people.hidden) openPeople(); else closePeople(); });
$('pplClose').addEventListener('click', closePeople);
pplList.addEventListener('click', (e) => {
  // inline reference editing: ✎ opens the form, Save persists (meta), Cancel restores.
  const editBtn = e.target.closest('.pc-edit');
  if (editBtn) { e.stopPropagation(); const cc = editBtn.closest('.ppl-card'); if (cc) refreshCard(cc.dataset.card, true); return; }
  const saveBtn = e.target.closest('.pc-edit-save');
  if (saveBtn) { e.stopPropagation(); const cc = saveBtn.closest('.ppl-card'); if (cc) saveEdit(cc.dataset.card); return; }
  const cancelBtn = e.target.closest('.pc-edit-cancel');
  if (cancelBtn) { e.stopPropagation(); const cc = cancelBtn.closest('.ppl-card'); if (cc) refreshCard(cc.dataset.card, false); return; }
  if (e.target.closest('.pc-editform')) { e.stopPropagation(); return; }   // clicks inside the form never toggle expand
  const crmBtn = e.target.closest('.pc-crmbtn');
  if (crmBtn && crmBtn.dataset.crm) { e.stopPropagation(); try { window.sq.contacts.openCrm(Number(crmBtn.dataset.crm)); } catch (err) {} return; }
  const brief = e.target.closest('.pc-briefing');
  if (brief && brief.dataset.target) { e.stopPropagation(); try { window.sq.contacts.openBriefing(Number(brief.dataset.target)); } catch (err) {} return; }
  if (e.target.closest('a')) return;                       // let mailto:/wiki links through
  const card = e.target.closest('.ppl-card.pc-can-expand'); // click the card body → reveal the full CRM entry
  if (card) card.classList.toggle('pc-expanded');
});
// live push: a doc drop just discovered someone → pop the rail open (if closed) and flash the new card in
try { window.sq.contacts.onCard((c) => { if (people.hidden) { people.hidden = false; document.body.classList.add('ppl-open'); } prependCard(c); }); } catch (e) {}

// The monitor is DOCKED (a hard right-side container) — it no longer floats, drags, or free-resizes.
// Its width is fixed and the surface reserves its column, so drag/resize handlers are intentionally gone.

loadCanvas();
// AUTO-REFRESH: poll so documents Zoe is BUILDING (research deliverables growing pass-by-pass) appear and
// grow LIVE without a manual refresh. Change-detection in loadCanvas means an unchanged canvas is a no-op
// (no flicker). Paused while the window is hidden/minimized.
const CANVAS_REFRESH_MS = 5000;
setInterval(() => { if (!document.hidden) loadCanvas(0); }, CANVAS_REFRESH_MS);

// USAGE PILL — Zoe's own metered model-token usage (Ollama exposes no usage API, so we show what SHE spends,
// windowed to track alongside the Ollama plan reset). Total over the window + a live /hr rate; per-model on hover.
(function () {
  const pill = document.getElementById('usagePill');
  if (!pill || !window.sq || !window.sq.usageSummary) { if (pill) pill.hidden = true; return; }
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n | 0));
  async function tick() {
    try {
      const s = await window.sq.usageSummary();
      if (!s || !s.ok) { pill.hidden = true; return; }
      pill.hidden = false;
      pill.innerHTML = `⚡ <b>${fmt(s.total)}</b> tok ${s.label || ''}${s.rate ? ` · ${fmt(s.rate)}/hr` : ''}`;
      const byModel = Object.entries(s.byModel || {});
      const lines = byModel.length ? byModel.map(([m, t]) => `${m}: ${fmt(t)}`).join('\n') : 'no calls yet in this window';
      pill.title = `Zoe's measured model usage (${s.calls || 0} calls)\n${lines}\n\n(measured locally — Ollama exposes no usage API)`;
    } catch { pill.hidden = true; }
  }
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, 12000);
})();
