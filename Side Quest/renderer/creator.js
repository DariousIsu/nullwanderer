/* Creator surface — thin Tiptap host. The block ⇄ ProseMirror bridge runs in MAIN
 * (studio/creator_view via window.sq.creator.*); this renderer only mounts the editor, drives a
 * small formatting toolbar, and round-trips the ProseMirror JSON to the document substrate.
 * Slice 1: author + persist. The clinical assist panel (stats/corrections/sources/fact-check)
 * is a later slice — the rail shows a placeholder. */
'use strict';
const C = (window.sq && window.sq.creator) || null;
const Z = window.ZoeEditor || null;

let editor = null;
let currentId = null;
let dirty = false;
let saveTimer = null;
let scanTimer = null;

const $ = (id) => document.getElementById(id);
const pickerEl = $('picker'), newBtn = $('new-btn'), saveBtn = $('save-btn'), stateEl = $('savestate');
const wrapEl = $('editorwrap'), emptyEl = $('empty'), fmtbar = $('fmtbar');

// ---- clinical panel: document statistics (Slice 2) ----
function renderStats(s) {
  s = s || {};
  $('st-words').textContent = (s.words || 0).toLocaleString();
  $('st-chars').textContent = (s.chars || 0).toLocaleString();
  $('st-sentences').textContent = (s.sentences || 0).toLocaleString();
  $('st-paragraphs').textContent = (s.paragraphs || 0).toLocaleString();
  $('st-reading').textContent = s.words ? `${s.readingMin} min` : '—';
}
function clearStats() { ['words', 'chars', 'sentences', 'paragraphs', 'reading'].forEach(k => { const el = $('st-' + k); if (el) el.textContent = '—'; }); }
function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(runScan, 500); }
async function runScan() {
  if (!C || !editor) return;
  try { const res = await C.scan(editor.getJSON()); if (res && res.ok) renderStats(res.stats); }
  catch (e) { /* stats are best-effort; never block editing */ }
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function setState(s) {  // '' | 'dirty' | 'saving' | 'saved'
  stateEl.className = 'savestate' + (s === 'dirty' ? ' dirty' : s === 'saved' ? ' saved' : '');
  stateEl.textContent = s === 'dirty' ? '• unsaved' : s === 'saving' ? 'saving…' : s === 'saved' ? 'saved' : '';
  saveBtn.disabled = !(currentId != null && s === 'dirty');
}

function mountEditor(docJson) {
  if (editor) { editor.destroy(); editor = null; }
  editor = new Z.Editor({
    element: $('editor'),
    extensions: [Z.StarterKit.configure({ blockquote: false, horizontalRule: false })],
    content: docJson || { type: 'doc', content: [{ type: 'paragraph' }] },
    autofocus: 'end',
    onUpdate: () => { dirty = true; setState('dirty'); scheduleSave(); scheduleScan(); },
    onSelectionUpdate: refreshToolbar,
    onTransaction: refreshToolbar,
  });
  refreshToolbar();
  runScan();   // initial statistics for the just-loaded document
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1500); }

async function saveNow() {
  if (!C || !editor || currentId == null || !dirty) return;
  setState('saving');
  try {
    const res = await C.save(currentId, editor.getJSON());
    if (res && res.ok) { dirty = false; setState('saved'); }
    else setState('dirty');
  } catch (e) { setState('dirty'); }
}

// toolbar commands (each receives a focused chain, queues its command, then .run())
const CMDS = {
  h1: e => e.toggleHeading({ level: 1 }), h2: e => e.toggleHeading({ level: 2 }), h3: e => e.toggleHeading({ level: 3 }),
  paragraph: e => e.setParagraph(),
  bold: e => e.toggleBold(), italic: e => e.toggleItalic(), code: e => e.toggleCode(),
  bulletList: e => e.toggleBulletList(), orderedList: e => e.toggleOrderedList(), codeBlock: e => e.toggleCodeBlock(),
};
fmtbar.addEventListener('click', ev => {
  const b = ev.target.closest('[data-cmd]'); if (!b || !editor) return;
  const fn = CMDS[b.dataset.cmd]; if (!fn) return;
  fn(editor.chain().focus()).run();
  refreshToolbar();
});

function isOn(cmd) {
  if (!editor) return false;
  if (cmd === 'h1') return editor.isActive('heading', { level: 1 });
  if (cmd === 'h2') return editor.isActive('heading', { level: 2 });
  if (cmd === 'h3') return editor.isActive('heading', { level: 3 });
  return editor.isActive(cmd);
}
function refreshToolbar() {
  fmtbar.querySelectorAll('[data-cmd]').forEach(b => b.classList.toggle('on', isOn(b.dataset.cmd)));
}

async function openDoc(id) {
  if (!C) return;
  if (dirty) await saveNow();
  const res = await C.get(id);
  if (!res || !res.ok) { return; }
  currentId = res.doc.id;
  emptyEl.hidden = true; wrapEl.hidden = false;
  mountEditor(res.docJson);
  dirty = false; setState('saved');
  pickerEl.value = String(currentId);
}

async function refreshList(selectId) {
  if (!C) return;
  const res = await C.list();
  const docs = (res && res.documents) || [];
  pickerEl.innerHTML = `<option value="">— open a draft —</option>` +
    docs.map(d => `<option value="${d.id}">${escapeHtml(d.title || '(untitled)')}${d.status && d.status !== 'in-process' ? ` · ${escapeHtml(d.status)}` : ''}</option>`).join('');
  if (selectId != null) pickerEl.value = String(selectId);
}

pickerEl.addEventListener('change', () => { const v = pickerEl.value; if (v) openDoc(Number(v)); });
newBtn.addEventListener('click', async () => {
  if (!C) return;
  if (dirty) await saveNow();
  const res = await C.newDoc('Untitled draft');
  if (res && res.ok) {
    await refreshList(res.doc.id);
    currentId = res.doc.id;
    emptyEl.hidden = true; wrapEl.hidden = false;
    mountEditor(res.docJson);
    dirty = false; setState('saved');
  }
});
saveBtn.addEventListener('click', saveNow);
// best-effort flush if the surface is torn down with unsaved edits
window.addEventListener('beforeunload', () => { if (dirty && C && currentId != null && editor) C.save(currentId, editor.getJSON()); });

// boot
if (!Z) {
  emptyEl.innerHTML = '<div class="big">Editor failed to load</div><div class="small">vendor/tiptap.bundle.js missing — run <code>npm run build:editor</code>.</div>';
} else if (!C) {
  emptyEl.innerHTML = '<div class="big">Bridge offline</div><div class="small">window.sq.creator unavailable.</div>';
} else {
  refreshList();
}
