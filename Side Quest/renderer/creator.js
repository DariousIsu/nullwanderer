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

// ---- clinical panel: proofread corrections + in-document squiggles (Slice 3) ----
// The model (caged in main) returns candidate corrections; here we anchor each to a real text
// range, render it as a squiggle decoration + a panel card, and let the operator accept/reject.
let corrections = [];        // [{id,type,original,suggestion,message, _range}]
let proofInFlight = false;
let bgOn = false;
let bgTimer = null;
let lastProofText = '';
const corrKey = (Z && Z.PluginKey) ? new Z.PluginKey('corrDecos') : null;
const corrPlugin = (Z && Z.Plugin && corrKey) ? new Z.Plugin({
  key: corrKey,
  state: {
    init: () => Z.DecorationSet.empty,
    apply(tr, old) {
      const meta = tr.getMeta(corrKey);
      if (meta && meta.decorations) return meta.decorations;
      return old.map(tr.mapping, tr.doc);   // track edits between scans
    },
  },
  props: { decorations(state) { return corrKey.getState(state); } },
}) : null;

// Map each correction's verbatim span to a ProseMirror range by searching text nodes. Claims
// occurrences greedily so two corrections on the same word don't collide. Spans that cross a mark
// boundary (rare) simply don't get a range — the card still works, just no squiggle.
function mapCorrections() {
  if (!editor) return;
  const segs = [];
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text) segs.push({ text: node.text, from: pos }); });
  const used = [];
  for (const c of corrections) {
    c._range = null;
    for (const seg of segs) {
      let idx = seg.text.indexOf(c.original);
      while (idx >= 0) {
        const from = seg.from + idx, to = from + c.original.length;
        if (!used.some(r => from < r.to && to > r.from)) { c._range = { from, to }; used.push({ from, to }); break; }
        idx = seg.text.indexOf(c.original, idx + 1);
      }
      if (c._range) break;
    }
  }
}
function applyDecorations() {
  if (!editor || !corrKey) return;
  const decos = [];
  for (const c of corrections) {
    if (c._range) decos.push(Z.Decoration.inline(c._range.from, c._range.to, { class: 'corr-mark corr-' + c.type }));
  }
  const set = Z.DecorationSet.create(editor.state.doc, decos);
  editor.view.dispatch(editor.state.tr.setMeta(corrKey, { decorations: set }));
}
function renderCorrections() {
  const el = $('corrections'), cnt = $('corr-count');
  if (cnt) cnt.textContent = corrections.length ? `(${corrections.length})` : '';
  if (!el) return;
  el.innerHTML = corrections.map(c => `
    <div class="ccard ${c.type}" data-id="${c.id}">
      <div class="ct"><span class="ctype">${escapeHtml(c.type)}</span></div>
      <div class="cfix"><span class="old">${escapeHtml(c.original)}</span> &rarr; <span class="new">${escapeHtml(c.suggestion)}</span></div>
      ${c.message ? `<div class="cmsg">${escapeHtml(c.message)}</div>` : ''}
      <div class="cact"><button class="cbtn acc" data-acc="${c.id}">Accept</button><button class="cbtn" data-dis="${c.id}">Dismiss</button></div>
    </div>`).join('');
}
function setCorrStatus(t, working) { const el = $('corr-status'); if (el) { el.textContent = t || ''; el.className = 'corr-status' + (working ? ' working' : ''); } }

function acceptCorrection(id) {
  const c = corrections.find(x => x.id === id); if (!c || !editor) return;
  mapCorrections();
  if (c._range) {
    const { from, to } = c._range;
    editor.chain().focus().command(({ tr }) => { tr.insertText(c.suggestion, from, to); return true; }).run();
  }
  corrections = corrections.filter(x => x.id !== id);
  afterCorrChange();
}
function dismissCorrection(id) { corrections = corrections.filter(x => x.id !== id); afterCorrChange(); }
function afterCorrChange() { mapCorrections(); applyDecorations(); renderCorrections(); }

async function proofreadNow() {
  if (!C || !editor || proofInFlight) return;
  proofInFlight = true; setCorrStatus('checking…', true);
  const btn = $('check-btn'); if (btn) btn.disabled = true;
  try {
    const res = await C.proofread(editor.getJSON(), null);
    if (res && res.ok) {
      corrections = (res.corrections || []).map(c => ({ ...c }));
      lastProofText = editor.getText();
      mapCorrections(); applyDecorations(); renderCorrections();
      setCorrStatus(corrections.length ? `${corrections.length} suggestion${corrections.length === 1 ? '' : 's'}` : 'no issues found');
    } else setCorrStatus('check failed');
  } catch (e) { setCorrStatus('check failed'); }
  finally { proofInFlight = false; const b = $('check-btn'); if (b) b.disabled = false; }
}
// background mode: re-check a couple seconds after typing stops, only if the text actually changed
// and no pass is in flight (single-flight, idle-gated). Per-block-hash incrementality is a later refinement.
function scheduleBgProof() {
  if (!bgOn) return;
  clearTimeout(bgTimer);
  bgTimer = setTimeout(() => { if (bgOn && !proofInFlight && editor && editor.getText() !== lastProofText) proofreadNow(); }, 2500);
}
function resetCorrections() {
  corrections = []; lastProofText = '';
  if (editor && corrPlugin) { try { editor.registerPlugin(corrPlugin); } catch (e) { /* already registered */ } }
  applyDecorations(); renderCorrections(); setCorrStatus('');
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
    onUpdate: () => { dirty = true; setState('dirty'); scheduleSave(); scheduleScan(); scheduleBgProof(); },
    onSelectionUpdate: refreshToolbar,
    onTransaction: refreshToolbar,
  });
  refreshToolbar();
  runScan();           // initial statistics for the just-loaded document
  resetCorrections();  // clear prior doc's corrections + (re)register the decoration plugin
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
// corrections: manual check, background toggle, and card accept/dismiss (delegated)
$('check-btn').addEventListener('click', proofreadNow);
$('bg-toggle').addEventListener('change', e => { bgOn = e.target.checked; if (bgOn) scheduleBgProof(); });
$('corrections').addEventListener('click', e => {
  const a = e.target.closest('[data-acc]'); if (a) { acceptCorrection(a.dataset.acc); return; }
  const d = e.target.closest('[data-dis]'); if (d) { dismissCorrection(d.dataset.dis); return; }
});
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
