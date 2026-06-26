/* Creator surface — thin Tiptap host + clinical assist panel.
 * The block ⇄ ProseMirror bridge and all analysis run in MAIN (window.sq.creator.*); this renderer
 * mounts the editor, drives the toolbar + autosave, and renders the panel:
 *   • Statistics  — live, deterministic
 *   • Corrections — proofread squiggles + accept/reject (local 24B leaf)
 *   • Research    — entities → "what your database knows" + complementary web/academic
 *   • Assist      — cloud writing advisor: additions / direction / tone
 * The model never edits the doc; the operator disposes. */
'use strict';
const C = (window.sq && window.sq.creator) || null;
const Z = window.ZoeEditor || null;

let editor = null, currentId = null, dirty = false, saveTimer = null, scanTimer = null;
const $ = (id) => document.getElementById(id);
const pickerEl = $('picker'), newBtn = $('new-btn'), saveBtn = $('save-btn'), stateEl = $('savestate');
const wrapEl = $('editorwrap'), emptyEl = $('empty'), fmtbar = $('fmtbar');

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function setState(s) {  // '' | 'dirty' | 'saving' | 'saved'
  stateEl.className = 'savestate' + (s === 'dirty' ? ' dirty' : s === 'saved' ? ' saved' : '');
  stateEl.textContent = s === 'dirty' ? '• unsaved' : s === 'saving' ? 'saving…' : s === 'saved' ? 'saved' : '';
  saveBtn.disabled = !(currentId != null && s === 'dirty');
}

/* ---------- statistics (deterministic) ---------- */
function renderStats(s) {
  s = s || {};
  $('st-words').textContent = (s.words || 0).toLocaleString();
  $('st-chars').textContent = (s.chars || 0).toLocaleString();
  $('st-sentences').textContent = (s.sentences || 0).toLocaleString();
  $('st-paragraphs').textContent = (s.paragraphs || 0).toLocaleString();
  $('st-reading').textContent = s.words ? `${s.readingMin} min` : '—';
}
function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(runScan, 500); }
async function runScan() { if (!C || !editor) return; try { const r = await C.scan(editor.getJSON()); if (r && r.ok) renderStats(r.stats); } catch (e) {} }

/* ---------- decoration plugin (shared: proofread squiggles + entity highlights) ---------- */
const corrKey = (Z && Z.PluginKey) ? new Z.PluginKey('clinicalDecos') : null;
const corrPlugin = (Z && Z.Plugin && corrKey) ? new Z.Plugin({
  key: corrKey,
  state: {
    init: () => Z.DecorationSet.empty,
    apply(tr, old) { const meta = tr.getMeta(corrKey); if (meta && meta.decorations) return meta.decorations; return old.map(tr.mapping, tr.doc); },
  },
  props: { decorations(state) { return corrKey.getState(state); } },
}) : null;
function segments() { const segs = []; if (editor) editor.state.doc.descendants((node, pos) => { if (node.isText && node.text) segs.push({ text: node.text, from: pos }); }); return segs; }
function assignRanges(items, textOf, segs) {
  const used = [];
  for (const it of items) {
    it._range = null; const needle = textOf(it); if (!needle) continue;
    for (const seg of segs) {
      let idx = seg.text.indexOf(needle);
      while (idx >= 0) { const from = seg.from + idx, to = from + needle.length; if (!used.some(r => from < r.to && to > r.from)) { it._range = { from, to }; used.push({ from, to }); break; } idx = seg.text.indexOf(needle, idx + 1); }
      if (it._range) break;
    }
  }
}
function applyDecorations() {
  if (!editor || !corrKey) return;
  const decos = [];
  for (const c of corrections) if (c._range) decos.push(Z.Decoration.inline(c._range.from, c._range.to, { class: 'corr-mark corr-' + c.type }));
  for (const e of entities) if (e._range && (e.matched || e.external)) decos.push(Z.Decoration.inline(e._range.from, e._range.to, { class: 'ent-mark' }));
  editor.view.dispatch(editor.state.tr.setMeta(corrKey, { decorations: Z.DecorationSet.create(editor.state.doc, decos) }));
}

/* ---------- corrections (proofread leaf) ---------- */
let corrections = [], proofInFlight = false, bgOn = false, bgTimer = null, lastProofText = '';
function setCorrStatus(t, working) { const el = $('corr-status'); if (el) { el.textContent = t || ''; el.className = 'corr-status' + (working ? ' working' : ''); } }
function mapCorrections() { if (editor) assignRanges(corrections, c => c.original, segments()); }
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
function acceptCorrection(id) {
  const c = corrections.find(x => x.id === id); if (!c || !editor) return;
  mapCorrections();
  if (c._range) editor.chain().focus().command(({ tr }) => { tr.insertText(c.suggestion, c._range.from, c._range.to); return true; }).run();
  corrections = corrections.filter(x => x.id !== id); afterCorrChange();
}
function dismissCorrection(id) { corrections = corrections.filter(x => x.id !== id); afterCorrChange(); }
function afterCorrChange() { mapCorrections(); applyDecorations(); renderCorrections(); }
async function proofreadNow() {
  if (!C || !editor || proofInFlight) return;
  proofInFlight = true; setCorrStatus('checking…', true); const b = $('check-btn'); if (b) b.disabled = true;
  try {
    const res = await C.proofread(editor.getJSON(), null);
    if (res && res.ok) {
      corrections = (res.corrections || []).map(c => ({ ...c })); lastProofText = editor.getText();
      mapCorrections(); applyDecorations(); renderCorrections();
      setCorrStatus(corrections.length ? `${corrections.length} suggestion${corrections.length === 1 ? '' : 's'}` : 'no issues found');
    } else setCorrStatus('check failed');
  } catch (e) { setCorrStatus('check failed'); } finally { proofInFlight = false; const x = $('check-btn'); if (x) x.disabled = false; }
}
function scheduleBgProof() { if (!bgOn) return; clearTimeout(bgTimer); bgTimer = setTimeout(() => { if (bgOn && !proofInFlight && editor && editor.getText() !== lastProofText) proofreadNow(); }, 2500); }

/* ---------- research (entities → DB match + complementary) ---------- */
let entities = [], lastContext = '', researchInFlight = false;
function setEntStatus(t, working) { const el = $('ent-status'); if (el) { el.textContent = t || ''; el.className = 'corr-status' + (working ? ' working' : ''); } }
function mapEntities() { if (editor) assignRanges(entities.filter(e => e.matched || e.external), e => e.mention, segments()); }
function visibleEntities() { return entities.filter(e => e.matched || e.external); }
function renderEntities() {
  const el = $('entities'), cnt = $('ent-count');
  const vis = visibleEntities();
  if (cnt) cnt.textContent = vis.length ? `(${vis.length})` : '';
  if (!el) return;
  el.innerHTML = vis.map(e => {
    if (e.matched) {
      const cands = e.candidates.map(c => `<div class="ecand">${escapeHtml(c.name)}${c.type ? ` <span class="etype">${escapeHtml(c.subtype || c.type)}</span>` : ''}${c.summary ? `<div class="esum">${escapeHtml(c.summary)}</div>` : ''}</div>`).join('');
      const rel = (e.related && e.related.length) ? `<div class="erel"><b>Related:</b> ${e.related.map(escapeHtml).join(' · ')}</div>` : '';
      return `<div class="ecard matched"><div class="et"><span class="emention">${escapeHtml(e.mention)}</span><span class="ekind">in database</span></div>${cands}${rel}</div>`;
    }
    const x = e.external;
    return `<div class="ecard ext"><div class="et"><span class="emention">${escapeHtml(e.mention)}</span><span class="ekind">${escapeHtml(x.provenance || 'web')}</span></div>
      <div class="ecand">${escapeHtml(x.title || '(untitled)')}${x.source ? ` <span class="etype">${escapeHtml(x.source)}</span>` : ''}${x.snippet ? `<div class="esum">${escapeHtml(x.snippet)}</div>` : ''}</div>
      ${x.url ? `<button class="cbtn eopen" data-eext="${escapeHtml(x.url)}">↗ Open in browser</button>` : ''}</div>`;
  }).join('');
}
async function runResearch() {
  if (!C || !editor || researchInFlight) return;
  researchInFlight = true; const web = $('web-toggle') ? $('web-toggle').checked : true;
  setEntStatus(web ? 'scanning entities + web…' : 'scanning entities…', true);
  const b = $('research-btn'); if (b) b.disabled = true;
  try {
    const res = await C.research(editor.getJSON(), web);
    if (res && res.ok) {
      entities = (res.entities || []).map(e => ({ ...e })); lastContext = res.context || '';
      mapEntities(); applyDecorations(); renderEntities();
      const vis = visibleEntities().length;
      setEntStatus(vis ? `${vis} entit${vis === 1 ? 'y' : 'ies'} found` : 'no database matches');
    } else setEntStatus(res && res.error ? ('failed: ' + res.error) : 'scan failed');
  } catch (e) { setEntStatus('scan failed'); } finally { researchInFlight = false; const x = $('research-btn'); if (x) x.disabled = false; }
}

/* ---------- assist (cloud writing advisor) ---------- */
let adviceInFlight = false;
function setAdviceStatus(t, working) { const el = $('advice-status'); if (el) { el.textContent = t || ''; el.className = 'corr-status' + (working ? ' working' : ''); } }
function renderAdvice(advice, cloud) {
  const el = $('advice'), meta = $('advice-meta');
  advice = advice || { additions: [], directions: [], tone: [] };
  const total = advice.additions.length + advice.directions.length + advice.tone.length;
  if (meta) meta.textContent = total ? (cloud ? '· cloud' : '· local') : '';
  if (!el) return;
  const bucket = (label, items, fmt) => items.length ? `<div class="abucket"><div class="alabel">${label}</div>${items.map(fmt).join('')}</div>` : '';
  el.innerHTML =
    bucket('Additions', advice.additions, a => `<div class="acard"><div class="atitle">${escapeHtml(a.title)}</div>${a.detail ? `<div class="adetail">${escapeHtml(a.detail)}</div>` : ''}</div>`) +
    bucket('Direction', advice.directions, a => `<div class="acard"><div class="atitle">${escapeHtml(a.title)}</div>${a.detail ? `<div class="adetail">${escapeHtml(a.detail)}</div>` : ''}</div>`) +
    bucket('Tone', advice.tone, a => `<div class="acard"><div class="atitle">${escapeHtml(a.observation)}</div>${a.suggestion ? `<div class="adetail">${escapeHtml(a.suggestion)}</div>` : ''}</div>`);
}
async function runAdvise() {
  if (!C || !editor || adviceInFlight) return;
  adviceInFlight = true; setAdviceStatus('thinking (cloud)…', true); const b = $('advise-btn'); if (b) b.disabled = true;
  try {
    const res = await C.advise(editor.getJSON(), lastContext);
    if (res && res.ok) {
      renderAdvice(res.advice, res.cloud);
      const total = (res.advice.additions.length + res.advice.directions.length + res.advice.tone.length);
      setAdviceStatus(total ? '' : 'no suggestions');
    } else setAdviceStatus(res && res.error ? ('failed: ' + res.error) : 'failed');
  } catch (e) { setAdviceStatus('failed'); } finally { adviceInFlight = false; const x = $('advise-btn'); if (x) x.disabled = false; }
}

/* ---------- editor mount ---------- */
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
  refreshToolbar(); runScan(); resetAssist();
}
function resetAssist() {
  corrections = []; entities = []; lastContext = ''; lastProofText = '';
  if (editor && corrPlugin) { try { editor.registerPlugin(corrPlugin); } catch (e) {} }
  applyDecorations(); renderCorrections(); renderEntities(); renderAdvice(null, false);
  setCorrStatus(''); setEntStatus(''); setAdviceStatus('');
}

/* ---------- save ---------- */
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1500); }
async function saveNow() {
  if (!C || !editor || currentId == null || !dirty) return;
  setState('saving');
  try { const res = await C.save(currentId, editor.getJSON()); if (res && res.ok) { dirty = false; setState('saved'); } else setState('dirty'); } catch (e) { setState('dirty'); }
}

/* ---------- toolbar ---------- */
const CMDS = {
  h1: e => e.toggleHeading({ level: 1 }), h2: e => e.toggleHeading({ level: 2 }), h3: e => e.toggleHeading({ level: 3 }),
  paragraph: e => e.setParagraph(), bold: e => e.toggleBold(), italic: e => e.toggleItalic(), code: e => e.toggleCode(),
  bulletList: e => e.toggleBulletList(), orderedList: e => e.toggleOrderedList(), codeBlock: e => e.toggleCodeBlock(),
};
fmtbar.addEventListener('click', ev => { const b = ev.target.closest('[data-cmd]'); if (!b || !editor) return; const fn = CMDS[b.dataset.cmd]; if (!fn) return; fn(editor.chain().focus()).run(); refreshToolbar(); });
function isOn(cmd) { if (!editor) return false; if (cmd === 'h1') return editor.isActive('heading', { level: 1 }); if (cmd === 'h2') return editor.isActive('heading', { level: 2 }); if (cmd === 'h3') return editor.isActive('heading', { level: 3 }); return editor.isActive(cmd); }
function refreshToolbar() { fmtbar.querySelectorAll('[data-cmd]').forEach(b => b.classList.toggle('on', isOn(b.dataset.cmd))); }

/* ---------- doc open / list ---------- */
async function openDoc(id) {
  if (!C) return; if (dirty) await saveNow();
  const res = await C.get(id); if (!res || !res.ok) return;
  currentId = res.doc.id; emptyEl.hidden = true; wrapEl.hidden = false;
  mountEditor(res.docJson); dirty = false; setState('saved'); pickerEl.value = String(currentId);
}
async function refreshList(selectId) {
  if (!C) return;
  const res = await C.list(); const docs = (res && res.documents) || [];
  pickerEl.innerHTML = `<option value="">— open a draft —</option>` + docs.map(d => `<option value="${d.id}">${escapeHtml(d.title || '(untitled)')}${d.status && d.status !== 'in-process' ? ` · ${escapeHtml(d.status)}` : ''}</option>`).join('');
  if (selectId != null) pickerEl.value = String(selectId);
}

/* ---------- wiring ---------- */
pickerEl.addEventListener('change', () => { const v = pickerEl.value; if (v) openDoc(Number(v)); });
newBtn.addEventListener('click', async () => {
  if (!C) return; if (dirty) await saveNow();
  const res = await C.newDoc('Untitled draft');
  if (res && res.ok) { await refreshList(res.doc.id); currentId = res.doc.id; emptyEl.hidden = true; wrapEl.hidden = false; mountEditor(res.docJson); dirty = false; setState('saved'); }
});
saveBtn.addEventListener('click', saveNow);
$('check-btn').addEventListener('click', proofreadNow);
$('bg-toggle').addEventListener('change', e => { bgOn = e.target.checked; if (bgOn) scheduleBgProof(); });
$('corrections').addEventListener('click', e => {
  const a = e.target.closest('[data-acc]'); if (a) { acceptCorrection(a.dataset.acc); return; }
  const d = e.target.closest('[data-dis]'); if (d) { dismissCorrection(d.dataset.dis); return; }
});
$('research-btn').addEventListener('click', runResearch);
$('entities').addEventListener('click', e => { const x = e.target.closest('[data-eext]'); if (x && C.openExternal) C.openExternal(x.dataset.eext); });
$('advise-btn').addEventListener('click', runAdvise);
window.addEventListener('beforeunload', () => { if (dirty && C && currentId != null && editor) C.save(currentId, editor.getJSON()); });

/* ---------- boot ---------- */
if (!Z) emptyEl.innerHTML = '<div class="big">Editor failed to load</div><div class="small">vendor/tiptap.bundle.js missing — run <code>npm run build:editor</code>.</div>';
else if (!C) emptyEl.innerHTML = '<div class="big">Bridge offline</div><div class="small">window.sq.creator unavailable.</div>';
else refreshList();
