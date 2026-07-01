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

function md(src) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  const out = []; let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (line === '') { flush(); continue; }
    if (h) { flush(); out.push(`<h${h[1].length} class="b-heading">${inline(h[2])}</h${h[1].length}>`); continue; }
    if (li) { flush(); out.push(`<ul><li>${inline(li[1])}</li></ul>`); continue; }
    para.push(line);
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
    return `<table class="b-table">${head}${body}</table>${cap}`;
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
      <button class="dbtn" data-act="min" title="${doc.minimized ? 'Restore' : 'Minimize'}">${doc.minimized ? '▢' : '–'}</button>
      <button class="dbtn" data-act="close" title="Close (keep in tray)">✕</button>
    </div>
    <div class="doc-body">${inner}</div>
    <div class="resize-grip" title="Resize"></div>
  </div>`;
}

function trayRow(doc) {
  const t = doc.tab;
  return `<div class="titem${t.key === activeKey ? ' active' : ''}${doc.hidden ? ' closed' : ''}" data-key="${esc(t.key)}" data-hidden="${doc.hidden ? 1 : 0}">
    <div class="nm">${esc(t.title)}</div>
    <div class="sub"><span class="mode ${esc(t.mode)}">${esc(t.mode)}</span>${doc.stream.summary.total} block${doc.stream.summary.total === 1 ? '' : 's'}${doc.hidden ? ' · closed' : ''}</div>
  </div>`;
}

function applyTransform() { board.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
function raise(card) { if (card) card.style.zIndex = ++zTop; }

function render(docs) {
  docPos = {}; for (const d of docs) docPos[d.tab.key] = d.pos || { x: 48, y: 48 };
  const visible = docs.filter(d => !d.hidden);
  board.innerHTML = visible.map(docCard).join('');
  trayRows.innerHTML = docs.length ? docs.map(trayRow).join('') : '<div class="titem"><div class="nm" style="color:var(--tx-dim)">No documents yet.</div></div>';
  trayRows.querySelectorAll('.titem').forEach(el => el.dataset.key && el.addEventListener('click', () => {
    if (el.dataset.hidden === '1') reopenDoc(el.dataset.key); else focusDoc(el.dataset.key);
  }));
  const closed = docs.length - visible.length;
  countEl.textContent = `${visible.length} open${closed ? ` · ${closed} closed` : ''}`;
  msgEl.style.display = visible.length ? 'none' : 'block';
  if (!visible.length) msgEl.innerHTML = docs.length ? 'All documents are closed.<div class="small">Open one from the ☰ tray.</div>' : 'Canvas is empty.<div class="small">Drop a document, or documents appear as Zoe produces deliverables.</div>';
}

async function loadCanvas(retries = 6) {
  try {
    const res = await window.sq.canvas.getAll();
    if (!res || !res.ok) {
      if (retries > 0) { msgEl.textContent = 'Waiting for the engine…'; msgEl.style.display = 'block'; setTimeout(() => loadCanvas(retries - 1), 1500); return; }
      msgEl.innerHTML = `<span class="err">⚠ ${esc((res && res.error) || 'failed to load canvas')}</span>`; msgEl.style.display = 'block'; return;
    }
    render(res.docs || []);
  } catch (e) {
    if (retries > 0) { setTimeout(() => loadCanvas(retries - 1), 1500); return; }
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
  if (btn.dataset.act === 'close') { try { window.sq.canvas.updateDoc(key, { hidden: true }); } catch {} loadCanvas(0); }
  else if (btn.dataset.act === 'min') {
    const min = !card.classList.contains('minimized');
    card.classList.toggle('minimized', min);
    btn.textContent = min ? '▢' : '–'; btn.title = min ? 'Restore' : 'Minimize';
    if (min) card.style.height = '';   // header-only; drop any fixed height
    try { window.sq.canvas.updateDoc(key, { minimized: min }); } catch {}
  }
});

surface.addEventListener('mousedown', (e) => {
  if (e.target.closest('.dbtn')) return;                         // button click handled separately
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
  if (okN) { await loadCanvas(0); if (lastKey) focusDoc(lastKey); showToast(`Added ${okN} document${okN === 1 ? '' : 's'}`); }
});

$('trayBtn').addEventListener('click', () => trayEl.classList.toggle('open'));
$('refreshBtn').addEventListener('click', () => loadCanvas(0));
$('resetBtn').addEventListener('click', async () => { try { await window.sq.canvas.resetLayout(); } catch {} loadCanvas(0); });

/* ---- Meet-in-canvas pane (Slice 6) — host Google Meet in a webview on Zoe's own Google session,
   so she joins as herself without monopolizing her dedicated CDP browser. Fixed floating panel
   (not on the zoom/pan board); a shield over the webview captures the mouse during drag/resize. ---- */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const meetpane = $('meetpane'), meetHead = $('meetHead'), meetBody = $('meetBody'), meetTitle = $('meetTitle');
let meetWV = null, meetPlaced = false;

function mountMeet(info) {
  const url = info && info.url; if (!url) return;
  meetTitle.textContent = (info && info.title) || 'Google Meet';
  if (!meetWV) {
    meetWV = document.createElement('webview');
    meetWV.setAttribute('partition', 'persist:zoe-google');   // Zoe's own Google session
    meetWV.setAttribute('allowpopups', '');
    meetWV.setAttribute('useragent', CHROME_UA);              // present as Chrome (avoid Meet "unsupported browser")
    meetBody.appendChild(meetWV);
  }
  meetWV.src = url;
  if (!meetPlaced) { meetpane.style.left = Math.max(20, window.innerWidth - 844) + 'px'; meetpane.style.top = '58px'; meetPlaced = true; }
  meetpane.hidden = false; meetpane.classList.remove('minimized'); $('meetMin').textContent = '–';
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
const monSeen = new Set();
let monPrimed = false, monTimer = null;
const MON_REFRESH_MS = 2 * 60 * 1000;

function renderMonitors(items, sources) {
  const marked = FV ? FV.markNew(items, monSeen) : (items || []).map(i => ({ ...i, isNew: false }));
  const now = Date.now();
  monList.innerHTML = marked.length ? marked.map(it => `
    <div class="mon-item${monPrimed && it.isNew ? ' new' : ''}">
      <div class="it-top"><span class="it-src">${esc(it.source)}</span><span class="it-ago">${esc(FV ? FV.relTime(it.publishedMs, now) : '')}</span></div>
      <div class="it-title">${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noreferrer">${esc(it.title)}</a>` : esc(it.title)}</div>
      ${it.summary ? `<div class="it-sum">${esc(it.summary)}</div>` : ''}
    </div>`).join('') : '<div class="mon-empty">No items yet. Add a feed URL above, or hit ⟳.</div>';
  const upd = new Date(now); const hh = String(upd.getHours()).padStart(2, '0'), mm = String(upd.getMinutes()).padStart(2, '0'), ss = String(upd.getSeconds()).padStart(2, '0');
  monN.textContent = `${marked.length ? `${marked.length} items · ` : ''}updated ${hh}:${mm}:${ss}`;
  monSources.innerHTML = (sources || []).map(s => `<span class="mon-src${s.ok ? '' : ' bad'}" title="${esc(s.sourceUrl)}">${esc(s.source)}<span class="x" data-url="${esc(s.sourceUrl)}">×</span></span>`).join('');
  monSources.querySelectorAll('.x').forEach(el => el.addEventListener('click', () => removeFeed(el.dataset.url)));
  // seed the seen-set so the NEXT fetch highlights only genuinely new items (first load isn't a flood)
  for (const it of marked) monSeen.add(it.id);
  monPrimed = true;
}
async function loadFeeds() {
  monN.textContent = '…';
  try {
    const res = await window.sq.feeds.fetch(30);
    if (!res || !res.ok) { monList.innerHTML = `<div class="mon-empty err">⚠ ${esc((res && res.error) || 'fetch failed')}</div>`; monN.textContent = ''; return; }
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

function openMonitors() {
  monitors.hidden = false;
  loadFeeds();                   // always pull fresh on open (news moves; a stale wall reads as "broken")
  loadVideos();                  // videos: cheap (no network) — refresh every open so re-seeds show
  if (!monTimer) monTimer = setInterval(loadFeeds, MON_REFRESH_MS);
}
function closeMonitors() { monitors.hidden = true; if (monTimer) { clearInterval(monTimer); monTimer = null; } }
$('monitorsBtn').addEventListener('click', () => { if (monitors.hidden) openMonitors(); else closeMonitors(); });
$('monClose').addEventListener('click', closeMonitors);
$('monRefresh').addEventListener('click', loadFeeds);
$('monAddBtn').addEventListener('click', () => addMonitor($('monAdd').value.trim()));
$('monAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMonitor($('monAdd').value.trim()); });

// drag + resize (fixed pane; no webview, so no shield needed)
let monDrag = null, monResize = null;
$('monHead').addEventListener('mousedown', (e) => { if (e.target.closest('.dbtn')) return; monDrag = { sx: e.clientX, sy: e.clientY, sl: monitors.offsetLeft, st: monitors.offsetTop }; $('monHead').classList.add('dragging'); e.preventDefault(); });
$('monResize').addEventListener('mousedown', (e) => { monResize = { sx: e.clientX, sy: e.clientY, w: monitors.offsetWidth, h: monitors.offsetHeight }; e.preventDefault(); e.stopPropagation(); });
window.addEventListener('mousemove', (e) => {
  if (monDrag) { monitors.style.left = Math.max(0, monDrag.sl + (e.clientX - monDrag.sx)) + 'px'; monitors.style.top = Math.max(40, monDrag.st + (e.clientY - monDrag.sy)) + 'px'; }
  else if (monResize) { monitors.style.width = Math.max(280, monResize.w + (e.clientX - monResize.sx)) + 'px'; monitors.style.height = Math.max(220, monResize.h + (e.clientY - monResize.sy)) + 'px'; }
});
window.addEventListener('mouseup', () => { if (monDrag) { $('monHead').classList.remove('dragging'); monDrag = null; } if (monResize) monResize = null; });

loadCanvas();
