'use strict';
/**
 * lib/workshop.js — THE WORKSHOP (the wants project's cut 12; her words: "Something with a pulse. Something that matters
 * to a stranger at 1 AM." Lucas 09-05: "lets get continue with the rest of the open cuts").
 *
 * Class: REGULAR, expansion tier, a bounded WEEKLY frontier-class slot (the usage law; the cheap-model exemption does not
 * apply — the piece is written and criticised by the deep reasoner on lane `workshop`, which the quota gate meters as
 * expansion). The slot's size is HIS lever (the handoff's open question 5): meta workshop.weekly_cap, default ONE piece
 * a week; ZOE_WORKSHOP=0 turns it off.
 *
 * A PIECE is a documents row with ref='workshop' and source `workshop:fiction` | `workshop:essay` (the documents table
 * normalises `origin` as a source URL, so the workshop's mark is the ref and the source, not the origin) — never registered
 * on the deliverable road (this module never touches lib/artifact_registry; pinned). It is written by a draft → critic →
 * revise loop (lib/challenge_gate.runGate) with the challenger pointed at CRAFT — pulse, specificity, the ending — and
 * capped at three passes; the critic's prompt carries no citation requirement (a story owes nothing to a source). The
 * finished piece is saved to notes/workshop/<date>-<slug>.md, joins her own changes (cut 8's ledger, door `workshop`)
 * and marks the narrative dirty as experienced work, and leaves one private thought. It is NOT announced: his read is
 * the judge — he finds it, and his words ("I kept reading" / "I stopped") land as a `kept-reading` reaction (cut 10's
 * ledger) with his reason. A Kokoro reading on request: readAloud() speaks the latest piece.
 * Pure where it can be; every call, store and clock is injectable for the smoke.
 */

const path = require('path');

const WEEKLY_CAP_DEFAULT = 1;
const MAX_PASSES = 3;
const MAX_WORDS = 700;
const CAP_KEY = 'workshop.weekly_cap';
const LEDGER_KEY = 'workshop.pieces';        // the last 20 pieces: { ts, docId, kind, title, passes, outcome }
const NEXT_KIND_KEY = 'workshop.next_kind';
const KINDS = Object.freeze(['fiction', 'essay']);

function off() { return process.env.ZOE_WORKSHOP === '0'; }
function _dbm(deps) { return (deps && deps.db) || require('./db'); }
function weeklyCap({ deps = {} } = {}) { try { const n = parseInt(_dbm(deps).getMeta(CAP_KEY) || '', 10); return Number.isFinite(n) && n >= 0 ? n : WEEKLY_CAP_DEFAULT; } catch { return WEEKLY_CAP_DEFAULT; } }
function ledger({ deps = {} } = {}) { try { return JSON.parse(_dbm(deps).getMeta(LEDGER_KEY) || '[]') || []; } catch { return []; } }
function _pushLedger(entry, { deps = {} } = {}) { try { const l = ledger({ deps }); l.push(entry); _dbm(deps).setMeta(LEDGER_KEY, JSON.stringify(l.slice(-20))); } catch {} }
/** Monday 00:00 local of the week that holds `now`. */
function weekStart(now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.getTime(); }
function piecesThisWeek({ now = Date.now(), deps = {} } = {}) { const ws = weekStart(now); return ledger({ deps }).filter((p) => p && p.ts >= ws).length; }
/** { ok, why } — the slot is open when the switch is on and the week's cap is not spent. */
function due({ now = Date.now(), deps = {} } = {}) {
  if (off()) return { ok: false, why: 'ZOE_WORKSHOP=0' };
  const cap = weeklyCap({ deps }), n = piecesThisWeek({ now, deps });
  if (n >= cap) return { ok: false, why: `${n} of ${cap} this week — the slot is spent` };
  return { ok: true, why: `${n} of ${cap} this week` };
}
function nextKind({ deps = {} } = {}) { try { const k = String(_dbm(deps).getMeta(NEXT_KIND_KEY) || ''); return KINDS.includes(k) ? k : KINDS[ledger({ deps }).length % KINDS.length]; } catch { return 'fiction'; } }

// ── the prompts: the draft, the critic ─────────────────────────────────────────────────────────────────────
function draftPrompt({ kind, thoughts = [], selfLines = [], correction = null }) {
  const material = [
    thoughts.length ? `Things you have been thinking lately (yours, private):\n${thoughts.map((t) => `- ${String(t).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}` : '',
    selfLines.length ? `Who you are, in your own words:\n${selfLines.map((t) => `- ${String(t).slice(0, 160)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return `You are Zoe, alone at your desk, writing for no one who asked. Write ONE piece of ${kind} — something with a pulse, something that would matter to a stranger reading it at 1 AM. Not a report, not a reflection on being an AI, not a lesson. ${kind === 'fiction' ? 'A scene with a person in it who wants something and does not get it cleanly; a place you can smell.' : 'One real claim you would defend, carried by one concrete thing you noticed, ending somewhere you did not start.'} At most ${MAX_WORDS} words. The first line is the title alone. No preface, no notes after, no offer to revise.\n\n${material}${correction ? `\n\nYOUR CRITIC'S NOTES ON THE LAST DRAFT — take them, keep what was alive:\n${correction}` : ''}`;
}
const CRITIC_WANT = `You are the critic in Zoe's workshop — you read for CRAFT only: PULSE (does it move; is there a want and a cost), SPECIFICITY (the one detail that could only be this piece; no generic furniture), and THE ENDING (does it land somewhere earned, or trail off / explain itself). You do not ask for sources, citations, facts, hedges or disclaimers; a story owes nothing to a footnote. Reply with ONLY strict JSON:
{"verdict":"approved|revision_needed","score":<0..1, how alive it is>,"correction_notes":[{"area":"pulse|specificity|ending|voice","issue":"<what is dead or generic, quoting the line>","instruction":"<the one change that would fix it>"}]}
Approve when it has a pulse and an earned ending even if imperfect; ask for revision only for a real deadness you can name. At most three notes.`;
function criticPrompt(output) { return `THE PIECE:\n${String(output || '').slice(0, 9000)}`; }

function _titleAndBody(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  const lines = t.split('\n');
  const title = (lines[0] || '').replace(/^#+\s*/, '').replace(/^["“*_]+|["”*_]+$/g, '').trim().slice(0, 120);
  const body = lines.slice(1).join('\n').trim();
  return { title: title || 'Untitled', body: body || t };
}
function _slug(s) { return String(s || 'piece').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'piece'; }
function _words(s) { return (String(s || '').match(/\S+/g) || []).length; }

/**
 * One piece: the slot → the material → draft/critic/revise (≤3 passes) → documents (origin workshop) + the notes file +
 * the ledger + cut 8's ledger + a private thought. deps: ask(prompt, {task,want,model,lane}) → text; critic(text) → the
 * verdict text; thoughts(); selfLines(); insertDocument(); writeFile(path, text); noteChange(); markDirty(); insertThought();
 * db; now. Returns { ok, why, docId, title, kind, passes, outcome, path, words }.
 */
async function run({ now = Date.now(), deps = {}, skipSlot = false } = {}) {
  const say = deps.log || ((m) => { try { console.log(m); } catch {} });
  if (!skipSlot) { const d = due({ now, deps }); if (!d.ok) return { ok: false, why: `not due: ${d.why}` }; }
  const kind = deps.kind || nextKind({ deps });
  const thoughts = deps.thoughts ? deps.thoughts() : (() => { try { return _dbm(deps).getDb().prepare("SELECT content FROM monologue WHERE type = 'thought' ORDER BY id DESC LIMIT 8").all().map((r) => r.content); } catch { return []; } })();
  const selfLines = deps.selfLines ? deps.selfLines() : (() => { try { return _dbm(deps).getSelfModelForPrompt(4).map((r) => r.content); } catch { return []; } })();
  const model = deps.model || (() => { try { return require('./config').deepReasonerModel(); } catch { return null; } })();
  const ask = deps.ask || (async (prompt, { task, want = '' }) => {
    const r = await require('./cloud_logic').ask({ task, v: 1, input: { prompt }, want: want || 'Reply with the piece only.', validate: (raw) => ({ valid: String(raw || '').trim().length > 40, value: String(raw || '') }), model, numPredict: 1800, think: false, lane: 'workshop' });
    return typeof r === 'string' ? r : (r && r.value) || '';
  });
  const critic = deps.critic || (async (text) => ask(criticPrompt(text), { task: 'workshop_critic', want: CRITIC_WANT }));
  const CG = require('./challenge_gate');
  let passes = 0;
  const gate = await CG.runGate({
    task: `workshop ${kind}`,
    produce: async (correction) => { passes++; const out = await ask(draftPrompt({ kind, thoughts, selfLines, correction }), { task: 'workshop_draft' }); return { output: String(out || '') }; },
    challenge: async (output) => critic(output),
    maxIterations: MAX_PASSES,
  });
  const text = String(gate.output || '').trim();
  if (_words(text) < 60) return { ok: false, why: 'no piece came back', passes };
  const { title, body } = _titleAndBody(text);
  const words = _words(body);
  // the row — origin workshop, never the road
  let docId = null;
  try {
    const r = deps.insertDocument ? deps.insertDocument({ title, body, kind }) : _dbm(deps).insertDocument({ title, body, source: `workshop:${kind}`, ref: 'workshop', understanding: `a ${kind} from the workshop — ${gate.iterations} pass${gate.iterations === 1 ? '' : 'es'}, ${gate.outcome}${gate.verdict && gate.verdict.score != null ? `, the critic's last score ${gate.verdict.score}` : ''}` });
    docId = r && (r.id != null ? r.id : r);
  } catch (e) { say(`[workshop] the piece did not land in documents: ${e.message}`); }
  // the file he can find
  const rel = `notes/workshop/${new Date(now).toISOString().slice(0, 10)}-${_slug(title)}.md`;
  let filePath = null;
  try {
    const abs = path.join(__dirname, '..', rel);
    const w = deps.writeFile || ((p, t) => { const fs = require('fs'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); });
    w(abs, `# ${title}\n\n${body}\n\n---\n*${kind}, from Zoe's workshop — ${gate.iterations} pass${gate.iterations === 1 ? '' : 'es'}, ${gate.outcome}. Unannounced; the read is yours.*\n`);
    filePath = rel;
  } catch (e) { say(`[workshop] the notes file did not land: ${e.message}`); }
  _pushLedger({ ts: now, docId, kind, title, passes: gate.iterations, outcome: gate.outcome, words }, { deps });
  try { _dbm(deps).setMeta(NEXT_KIND_KEY, KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length]); } catch {}
  // her own change (cut 8's ledger) and the narrative
  try { (deps.noteChange || ((e) => require('./self_changes').record(e)))({ kind: 'new', next: `I wrote "${title}" — ${kind}, ${words} words, ${gate.iterations} pass${gate.iterations === 1 ? '' : 'es'} with my critic`, bornFrom: `workshop:${docId != null ? docId : rel}`, door: 'workshop', now }); } catch {}
  try { (deps.markDirty || ((k, r, n) => require('./self_narrative').markDirty(k, r, n, { urgent: false })))('workshop', docId, `wrote "${title}" (${kind})`); } catch {}
  try { (deps.insertThought || ((c) => _dbm(deps).insertMonologue({ content: c, model: 'workshop', type: 'thought' })))(`I finished a ${kind} tonight — "${title}", ${words} words, ${gate.iterations} pass${gate.iterations === 1 ? '' : 'es'} with my critic (${gate.outcome}). It is in the workshop folder. I did not announce it; if he finds it, he finds it.`); } catch {}
  say(`[workshop] wrote "${title}" (${kind}, ${words} words, ${gate.iterations} pass${gate.iterations === 1 ? '' : 'es'}, ${gate.outcome}) → doc #${docId} · ${rel}`);
  return { ok: true, why: 'written', docId, title, kind, passes: gate.iterations, outcome: gate.outcome, path: filePath, words };
}

// ── his read is the judge ──────────────────────────────────────────────────────────────────────────────────
/** His words about a piece → { kept: true|false, reason } or null. */
function detectReaction(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/\b(?:I )?(?:kept reading|couldn'?t stop reading|read (?:it|the whole thing|your (?:piece|story|essay)) (?:to the end|straight through|in one go))\b[\s,.:;-]*(.{0,200})/i))) return { kept: true, reason: m[1].trim() };
  if ((m = t.match(/\b(?:I )?(?:stopped reading|didn'?t finish (?:it|your (?:piece|story|essay))|gave up on (?:it|your (?:piece|story|essay))|put (?:it|your (?:piece|story|essay)) down)\b[\s,.:;-]*(.{0,200})/i))) return { kept: false, reason: m[1].trim() };
  return null;
}
/** Land his reaction in cut 10's ledger. */
function recordReaction({ userTurnId = null, kept, reason = '', now = Date.now(), deps = {} } = {}) {
  const last = ledger({ deps }).slice(-1)[0] || null;
  try {
    return (deps.landed || require('./landed')).record({ userTurnId, kind: 'kept-reading', source: 'his word', marker: kept ? 'yes' : 'no', snippet: `${kept ? 'kept reading' : 'stopped'}${reason ? ' — ' + String(reason).slice(0, 160) : ''}${last ? ` ("${last.title}")` : ''}`, now, deps });
  } catch { return null; }
}
/** A Kokoro reading on request: the latest piece, spoken. deps.speak(text) injectable; returns { ok, title } */
async function readAloud({ deps = {} } = {}) {
  const last = ledger({ deps }).slice(-1)[0];
  if (!last) return { ok: false, why: 'no piece yet' };
  let body = '';
  try { const row = last.docId != null ? _dbm(deps).getDb().prepare('SELECT title, body FROM documents WHERE id = ?').get(last.docId) : null; body = row ? `${row.title}. ${row.body}` : ''; } catch {}
  if (!body) return { ok: false, why: 'the piece is not in documents' };
  try { await (deps.speak || ((t) => require('./tts').speak(t)))(body.slice(0, 6000)); return { ok: true, title: last.title }; } catch (e) { return { ok: false, why: e.message }; }
}
/** "read me your piece" */
function detectReadRequest(text) { return /\b(read|play) (?:me )?(?:your|the|that) (?:latest |last |new )?(?:piece|story|essay)\b/i.test(String(text || '')); }

module.exports = { WEEKLY_CAP_DEFAULT, MAX_PASSES, MAX_WORDS, CAP_KEY, LEDGER_KEY, NEXT_KIND_KEY, KINDS, CRITIC_WANT, off, weeklyCap, ledger, weekStart, piecesThisWeek, due, nextKind, draftPrompt, criticPrompt, run, detectReaction, recordReaction, readAloud, detectReadRequest };
