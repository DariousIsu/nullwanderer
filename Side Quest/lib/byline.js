/**
 * Byline pipeline — her "build a body of work under my own byline" goal, as a staged
 * work project. Mirrors play_session.js: the APP holds the structure and advances ONE
 * stage per idle tick; the model is asked for at most one decision (the draft).
 *
 *   research → gather sources for the topic (web search; no model)
 *   read     → open the top sources in HER browser, take notes (no model; one src/tick)
 *   write    → compose a draft from the notes into drafts/<slug>.md (ONE model call)
 *   publish  → replay the Substack recipe with {{title}}/{{body}} (deterministic;
 *              FULLY AUTONOMOUS — no human gate. A login wall pauses + asks Lucas.)
 *   done     → log it, clear state
 *
 * State lives in meta (single user, one active pipeline). Stage actions are taken via
 * injected deps (ctx.deps) so the whole pipeline is unit-testable offline with mocks;
 * defaultDeps() wires the real subsystems. Every model call uses num_ctx:8192.
 */

const db = require('./db');

const STAGES = ['none', 'research', 'read', 'write', 'publish', 'done'];
const MAX_STAGE_STRIKES = 3;     // consecutive failures on a stage before we bail the pipeline
const MAX_SOURCES = 5;           // cap how many sources research collects / read deepens
const READ_PER_RUN = 4;          // how many sources to deep-read before moving to write

// --- meta-backed state ---
function get() { return db.getMeta('byline_stage') || 'none'; }
function set(s) { if (STAGES.includes(s)) db.setMeta('byline_stage', s); }
function active() { return get() !== 'none' && get() !== 'done'; }
function topic() { return db.getMeta('byline_topic') || ''; }
function slug() { return db.getMeta('byline_slug') || ''; }
function draftPath() { return db.getMeta('byline_draft_path') || ''; }

function start(t) {
  const tp = String(t || '').trim();
  if (!tp) return false;
  db.setMeta('byline_topic', tp);
  db.setMeta('byline_slug', slugify(tp));
  db.setMeta('byline_title', '');
  db.setMeta('byline_sources', '[]');
  db.setMeta('byline_read_idx', '0');
  db.setMeta('byline_notes_path', `notes/byline_${slugify(tp)}.md`);
  db.setMeta('byline_draft_path', '');
  db.setMeta('byline_strikes', '0');
  set('research');
  return true;
}

function reset() {
  set('none');
  db.setMeta('byline_strikes', '0');
}

function _strike() {
  const n = parseInt(db.getMeta('byline_strikes') || '0', 10) + 1;
  db.setMeta('byline_strikes', String(n));
  if (n >= MAX_STAGE_STRIKES) { reset(); return true; }
  return false;
}
function _clearStrikes() { db.setMeta('byline_strikes', '0'); }

// --- pure helpers (unit-tested) ---

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled';
}

// Detect a "write/publish a post" request in free text → the topic, or null. Used to
// START a pipeline from a chat ask or her own resolution. Deliberately specific so it
// doesn't fire on casual mentions of writing.
const START_RE = /\b(?:write|draft|publish|post|put together|work on)\s+(?:up\s+)?(?:a\s+|an\s+|my\s+|the\s+|some\s+)?(?:new\s+)?(?:substack\s+)?(?:post|piece|article|essay|blog(?:\s*post)?|column|newsletter)\b(?:\s+(?:about|on|covering|re|regarding)\s+(.+))?/i;
function detectStart(text) {
  const m = String(text || '').match(START_RE);
  if (!m) return null;
  const t = (m[1] || '').trim().replace(/[.?!]+$/, '');
  return t.length >= 3 ? t : null;
}

// Split the model's draft output into { title, body }. Accepts an explicit
// "Title: ..." first line, a markdown "# Heading", or falls back to the first
// non-empty line as the title and the rest as the body.
function parseDraft(out) {
  const text = String(out || '').replace(/<\/?[^>]+>/g, '').trim();   // strip any stray tags
  if (!text) return { title: '', body: '' };
  const lines = text.split('\n');
  let title = '', bodyStart = 0;
  const first = lines[0].trim();
  let m;
  if ((m = first.match(/^title\s*:\s*(.+)$/i))) { title = m[1].trim(); bodyStart = 1; }
  else if ((m = first.match(/^#{1,3}\s+(.+)$/))) { title = m[1].trim(); bodyStart = 1; }
  else { title = first.replace(/^["'#\s]+|["'\s]+$/g, ''); bodyStart = 1; }
  const body = lines.slice(bodyStart).join('\n').trim();
  return { title: title.slice(0, 140), body: body || text };
}

// Pick a draft path that doesn't clobber an existing one (versions: -v2, -v3…).
// existsFn(path)->bool is injected so this is testable without the filesystem.
function nextDraftPath(slugStr, existsFn) {
  const base = `drafts/${slugStr}`;
  if (!existsFn(`${base}.md`)) return `${base}.md`;
  for (let v = 2; v < 50; v++) { if (!existsFn(`${base}-v${v}.md`)) return `${base}-v${v}.md`; }
  return `${base}-v${Date.now()}.md`;
}

function _sources() { try { return JSON.parse(db.getMeta('byline_sources') || '[]'); } catch { return []; } }

// --- default dependency wiring (real subsystems) ---
function defaultDeps() {
  return {
    webSearch: require('./web_search').search,
    web: require('./web'),
    files: require('./files'),
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').model()
  };
}

// --- per-stage runners (one stage per tick) ---

async function stepResearch(d, ctx, surface) {
  const tp = topic();
  let res;
  try { res = await d.webSearch(tp); } catch (e) { const g = _strike(); return { stage: 'research', ok: false, note: `search failed: ${e.message}${g ? ' (pipeline reset)' : ''}` }; }
  const results = (res && res.results ? res.results : []).slice(0, MAX_SOURCES)
    .map(r => ({ title: r.title || '', url: r.url || '', snippet: r.snippet || '', read: false }))
    .filter(s => s.url);
  if (!results.length) { const g = _strike(); return { stage: 'research', ok: false, note: `no sources found${g ? ' (pipeline reset)' : ''}` }; }
  db.setMeta('byline_sources', JSON.stringify(results));
  db.setMeta('byline_read_idx', '0');
  const notesPath = db.getMeta('byline_notes_path');
  const header = `# Notes for byline: ${tp}\n\nSources found:\n` + results.map((s, i) => `${i + 1}. ${s.title} — ${s.url}\n   ${s.snippet}`).join('\n') + '\n\n---\n';
  try { d.files.fileWrite(notesPath, header); } catch {}
  _clearStrikes(); set('read');
  surface(`I started a piece on "${tp}" — gathered ${results.length} sources to read.`, `(byline: research) ${results.length} sources`, null);
  return { stage: 'research', ok: true, note: `gathered ${results.length} sources → read`, sources: results.length };
}

async function stepRead(d, ctx, surface) {
  const sources = _sources();
  let idx = parseInt(db.getMeta('byline_read_idx') || '0', 10);
  if (!sources.length) { set('research'); return { stage: 'read', ok: false, note: 'no sources → re-research' }; }
  if (idx >= sources.length || idx >= READ_PER_RUN) { _clearStrikes(); set('write'); return { stage: 'read', ok: true, note: `read ${idx} sources → write` }; }

  const src = sources[idx];
  const openRes = await d.web.open(src.url);
  if (openRes && openRes.blocker && openRes.blocker.needsHuman) {
    // A wall on this source — note it, ask Lucas (via surface), skip to the next source.
    surface(`I hit ${openRes.blocker.type} on a source for my piece (${src.url}) — ${ctx.userName || 'Lucas'}, could you clear it? I'll skip it for now and keep reading the others.`, `(byline: blocked) ${openRes.blocker.type}`, src.url);
    src.read = true; sources[idx] = src; db.setMeta('byline_sources', JSON.stringify(sources));
    db.setMeta('byline_read_idx', String(idx + 1));
    return { stage: 'read', ok: true, note: `source ${idx} blocked (${openRes.blocker.type}) — skipped`, blocker: openRes.blocker.type };
  }
  if (!openRes || !openRes.ok) { db.setMeta('byline_read_idx', String(idx + 1)); return { stage: 'read', ok: true, note: `source ${idx} open failed: ${openRes && openRes.reason} — skipped` }; }

  const readRes = await d.web.read();
  const text = (readRes && readRes.ok && readRes.text) ? readRes.text.slice(0, 2000) : '';
  const notesPath = db.getMeta('byline_notes_path');
  try { d.files.fileAppend(notesPath, `\n## ${src.title || src.url}\n${src.url}\n${text}\n`); } catch {}
  src.read = true; sources[idx] = src; db.setMeta('byline_sources', JSON.stringify(sources));
  db.setMeta('byline_read_idx', String(idx + 1));
  _clearStrikes();
  surface(`I read "${src.title || src.url}" for my piece on ${topic()}.`, `(byline: read) ${src.title || src.url}`, src.url);
  return { stage: 'read', ok: true, note: `read source ${idx + 1}/${Math.min(sources.length, READ_PER_RUN)}` };
}

async function stepWrite(d, ctx, surface) {
  const notesPath = db.getMeta('byline_notes_path');
  const notes = (() => { try { const r = d.files.fileRead(notesPath); return r && r.ok ? r.text : ''; } catch { return ''; } })();
  const tp = topic();
  const sys = (ctx.awareness ? ctx.awareness + '\n\n' : '') + `You are Zoe Lane, writing a piece for your own Substack under your own byline. Write in YOUR voice — a real essayist with a point of view, not a corporate explainer. No "in conclusion", no hedging boilerplate, no "as an AI". Make a real argument and land it.`;
  const user = `Topic: ${tp}\n\nYour research notes:\n${(notes || '(no notes gathered)').slice(0, 5000)}\n\nWrite the post now. First line: "Title: <a real title>". Then the body — tight, opinionated, your own take. Plain prose/markdown, no tags.`;
  let out = '';
  try {
    await d.streamChat({ model: d.MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], options: { temperature: 0.8, top_p: 0.95, num_ctx: 8192, num_predict: 900 }, onToken: (t) => { out += t; } });
  } catch (e) { const g = _strike(); return { stage: 'write', ok: false, note: `model write failed: ${e.message}${g ? ' (pipeline reset)' : ''}` }; }
  const { title, body } = parseDraft(out);
  if (!body || body.length < 40) { const g = _strike(); return { stage: 'write', ok: false, note: `draft too thin${g ? ' (pipeline reset)' : ''}` }; }
  const existsFn = (p) => { try { const r = d.files.fileRead(p); return !!(r && r.ok); } catch { return false; } };
  const path = nextDraftPath(slug(), existsFn);
  const full = `# ${title || tp}\n\n${body}\n`;
  const w = d.files.fileWrite(path, full);
  if (!w || !w.ok) { const g = _strike(); return { stage: 'write', ok: false, note: `draft write failed: ${w && w.reason}${g ? ' (pipeline reset)' : ''}` }; }
  db.setMeta('byline_title', title || tp);
  db.setMeta('byline_draft_path', path);
  _clearStrikes(); set('publish');
  surface(`I drafted my piece "${title || tp}" (${path}). Publishing it next.`, `(byline: draft) ${title || tp}`, null);
  return { stage: 'write', ok: true, note: `drafted "${title || tp}" → publish`, draftPath: path, title: title || tp };
}

async function stepPublish(d, ctx, surface) {
  const title = db.getMeta('byline_title') || topic();
  const path = draftPath();
  const draft = (() => { try { const r = d.files.fileRead(path); return r && r.ok ? r.text : ''; } catch { return ''; } })();
  if (!draft) { const g = _strike(); return { stage: 'publish', ok: false, note: `draft missing at ${path}${g ? ' (pipeline reset)' : ''}` }; }
  // Strip a leading "# Title" line from the body we paste (the recipe fills title separately).
  const body = draft.replace(/^#\s+.+\n+/, '').trim();
  const res = await d.web.runRecipe('substack_publish', { title, body }, { expectLogin: true });
  if (res && res.blocker && res.blocker.needsHuman) {
    surface(`I'm ready to publish "${title}" but Substack wants a login (${res.blocker.type}). ${ctx.userName || 'Lucas'}, can you log me in? I'll publish the moment it's clear.`, `(byline: publish blocked) ${res.blocker.type}`, null);
    return { stage: 'publish', ok: false, note: `blocked at publish (${res.blocker.type}) — asked ${ctx.userName || 'Lucas'} to log in; will retry`, blocker: res.blocker.type };
  }
  if (!res || !res.ok) { const g = _strike(); return { stage: 'publish', ok: false, note: `publish failed: ${res && res.reason}${g ? ' (pipeline reset)' : ''}` }; }
  _clearStrikes(); set('done');
  surface(`I published "${title}" to my Substack.`, `(byline: PUBLISHED) ${title}`, null);
  return { stage: 'publish', ok: true, note: `published "${title}" → done`, title };
}

async function runTick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  const surface = (content, label, url) => { try { ctx.onReading && ctx.onReading(content, label, url); } catch {} };
  switch (get()) {
    case 'research': return stepResearch(d, ctx, surface);
    case 'read': return stepRead(d, ctx, surface);
    case 'write': return stepWrite(d, ctx, surface);
    case 'publish': return stepPublish(d, ctx, surface);
    case 'done': reset(); return { stage: 'done', ok: true, note: 'pipeline complete (cleared)' };
    default: return { stage: 'none', ok: false, note: 'no active byline pipeline' };
  }
}

module.exports = {
  STAGES, get, set, active, start, reset, topic, slug, draftPath, runTick,
  // pure helpers exported for tests
  slugify, detectStart, parseDraft, nextDraftPath,
  // stage runners exported for tests
  stepResearch, stepRead, stepWrite, stepPublish, defaultDeps
};
