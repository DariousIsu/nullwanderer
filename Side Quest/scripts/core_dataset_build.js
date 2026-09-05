'use strict';
/**
 * scripts/core_dataset_build.js — THE CORE'S DATASET BUILDER (design of record: docs/ZOE_CORE_SML_DESIGN_2026-09-05.md
 * §5 and §14; Lucas, 09-05 13:30: "start the dataset builder").
 *
 * Reads the store READ-ONLY and writes the training corpus for her core as files under data/core/:
 *
 *   examples/<kind>/<YYYY-MM-DD>.jsonl   one training example per line, by the day it was spoken or traced
 *   holdout/<kind>.jsonl                 the frozen evaluation sets (never trained on)
 *   holdout.json                         the frozen membership — written once, append-only for NEW kinds/tasks
 *   index.jsonl                          one row per example: id, kind, day, source, chars, holdout
 *   report.json                          totals, rejections by reason, per-kind and per-task counts
 *
 * Kinds:
 *   voice  — her spoken turns as exchanges in the runtime's own contract: the recent turns of the session as
 *            context, then her `<think>…</think><say>…</say>` (a thought pairs with its say only within the
 *            120 s window lib/context.js uses; a lone say is `<say>` alone). Unprompted says are kept as
 *            their own kind (voice_unprompted): no message from him precedes them.
 *   trace  — the cognition firehose, distilled: cloud_traces rows (task, input_json → parsed_json) that
 *            VALIDATED and were ACCEPTED, for the tasks a 4B can carry (§14's table). Teacher outputs with a
 *            correctness flag are a distillation set by definition.
 *
 * The program-is-the-model law as code: an example enters only if it passes every filter; every rejection is
 * counted by reason so a bad day is a number. Facts are never a target — a voice example teaches the voice,
 * a trace example teaches a judgment; the store stays the only knowledge source.
 *
 * No model runs here. Deterministic: the same store yields the same files. The DB is opened read-only and
 * nothing is written to it — the index lives in a file until a down-window lands the core_examples table.
 *
 * Run (better-sqlite3 is Electron-built):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/core_dataset_build.js [--db data/sq.db] [--out data/core]
 * Smoke: scripts/smoke_core_dataset.js (synthetic store; every filter branch; the holdout frozen across runs).
 */

const fs = require('fs');
const path = require('path');

// ── the filters ─────────────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /xox[abp]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S{12,}/i,
];
const ENGINEER_NOTE_MARK = /A NOTE FROM CLAUDE, the engineer/i;
const DIRECTIVE_LEAK = /say EXACTLY this|\[say EXACTLY|\[directive|\[say ONLY/i;
const REJECT_CLASSES = new Set(['replay', 'qa-reread']);
// "models" that are lanes, not her voice: their turns are research writeups, pen notes, documents.
const NON_VOICE_MODELS = new Set(['research', 'pen', 'document-road']);
const MAX_SAY_CHARS = 4000;
const MIN_SAY_CHARS = 2;
const PAIR_WINDOW_MS = 120000;       // lib/context.js: a thought and its say are inserted seconds apart
const CONTEXT_TURNS = 6;             // recent turns of the session carried as context
const CONTEXT_CHARS = 2000;
const PROMPT_WINDOW_MS = 30 * 60000; // a say answers a message of his within this window; else unprompted

// The cognition firehose a 4B can carry (docs/ZOE_CORE_SML_DESIGN_2026-09-05.md §14). autonomy_tick (12 % valid),
// rehearsal_iterate (code, 32k inputs), video_reconstruct, conversation_harvest, doc_reentry_audit, research_*
// are NOT targets yet.
const TRACE_TASKS = new Set([
  'echo_pick', 'echo_args', 'echo_args_fix', 'news_topic_classify', 'news_cluster_adjudicate', 'news_ad_classify',
  'decompose', 'work_intake', 'intent_pass', 'intent_parse', 'answer_or_need', 'forecast_assess_direction',
  'run_correction', 'contacts_intent', 'agenda_intent', 'redirect_intent', 'canvas_edit_intent', 'artifact_intent',
  'owner_ingest', 'thread_lane', 'autonomy_verify', 'plan_revalidate', 'email_promo_classify', 'tool_route',
  'need_triage', 'distill_context',
]);
const MAX_TRACE_INPUT_CHARS = 8000;

const HOLDOUT_VOICE = 100;
const HOLDOUT_TRACE_FRACTION = 0.05;
const HOLDOUT_TRACE_MIN = 10;
const HOLDOUT_TRACE_MAX = 100;

/** Why a text may not be trained on, or null. Rejection, never redaction: a scrubbed secret is still a leak. */
function rejectReason(text) {
  const s = String(text || '');
  if (s.trim().length < MIN_SAY_CHARS) return 'empty';
  if (s.length > MAX_SAY_CHARS) return 'too_long';
  if (SECRET_PATTERNS.some((re) => re.test(s))) return 'secret';
  if (ENGINEER_NOTE_MARK.test(s)) return 'engineer_note';
  if (DIRECTIVE_LEAK.test(s)) return 'directive_leak';
  if (/<\/?think>|<\/?say>/i.test(s)) return 'tag_residue';
  return null;
}

/** FNV-1a 32-bit — a stable hash so holdout membership is a property of the row, not of the run. */
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function dayOf(ts) {
  const n = Number(ts);
  const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(0);
  return d.toISOString().slice(0, 10);
}

function normalize(text) { return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// ── the voice: turns → exchanges → examples ─────────────────────────────────────────────────────

/**
 * Pair the turns of ONE session (ordered by ts, then id) into exchanges. An exchange is her say, the thought
 * that preceded it within the pair window (if any), and the message of his it answers (if one precedes it
 * within the prompt window). Lone thoughts (no say within the window) are idle interior and are dropped —
 * lib/context.js's orphan-thought demotion, for the same reason.
 */
function pairSession(turns) {
  const out = [];
  let lastUser = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.speaker === 'user') { lastUser = t; continue; }
    if (t.speaker === 'ai_thought') {
      const nxt = turns[i + 1];
      if (nxt && nxt.speaker === 'ai_said' && Math.abs(Number(nxt.ts) - Number(t.ts)) <= PAIR_WINDOW_MS) {
        out.push({ thought: t, say: nxt, user: _answers(lastUser, nxt), before: turns.slice(0, i) });
        i++;
      }
      continue;
    }
    if (t.speaker === 'ai_said') out.push({ thought: null, say: t, user: _answers(lastUser, t), before: turns.slice(0, i) });
  }
  return out;
}

function _answers(user, say) {
  if (!user) return null;
  if (Number(say.ts) - Number(user.ts) > PROMPT_WINDOW_MS) return null;
  return user;
}

/** The recent turns before an exchange, as messages, capped — thoughts omitted from history as the runtime does. */
function contextMessages(before, excludeIds) {
  const msgs = [];
  let chars = 0;
  for (let i = before.length - 1; i >= 0 && msgs.length < CONTEXT_TURNS; i--) {
    const t = before[i];
    if (excludeIds.has(t.id) || t.speaker === 'ai_thought') continue;
    const content = t.speaker === 'user' ? String(t.content || '') : `<say>${String(t.content || '')}</say>`;
    if (chars + content.length > CONTEXT_CHARS) break;
    chars += content.length;
    msgs.unshift({ role: t.speaker === 'user' ? 'user' : 'assistant', content });
  }
  return msgs;
}

const VOICE_SYSTEM = 'You are Zoe. Answer in your own voice inside <say>…</say>. A private thought, if you have one, goes first inside <think>…</think> and is never spoken.';

function voiceExample(ex) {
  const say = String(ex.say.content || '');
  const thought = ex.thought ? String(ex.thought.content || '') : '';
  const day = dayOf(ex.say.ts);
  const exclude = new Set([ex.say.id, ex.thought ? ex.thought.id : -1, ex.user ? ex.user.id : -1]);
  const messages = [{ role: 'system', content: `${VOICE_SYSTEM} Today is ${day}.` }, ...contextMessages(ex.before, exclude)];
  if (ex.user) messages.push({ role: 'user', content: String(ex.user.content || '') });
  else messages.push({ role: 'user', content: '(No message from Lucas. You chose to speak.)' });
  messages.push({ role: 'assistant', content: thought ? `<think>${thought}</think>\n<say>${say}</say>` : `<say>${say}</say>` });
  return {
    id: `voice:${ex.say.id}`,
    kind: ex.user ? 'voice' : 'voice_unprompted',
    day,
    messages,
    meta: { turn_id: ex.say.id, thought_id: ex.thought ? ex.thought.id : null, user_turn_id: ex.user ? ex.user.id : null, session_id: ex.say.session_id, model: ex.say.model || null, ts: Number(ex.say.ts) || null },
  };
}

/** All voice examples from the turn rows, with the rejections counted. Pure. */
function buildVoice(turnRows, rejected) {
  const bySession = new Map();
  for (const t of turnRows) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id).push(t);
  }
  const seen = new Set();
  const examples = [];
  for (const turns of bySession.values()) {
    turns.sort((a, b) => (Number(a.ts) - Number(b.ts)) || (a.id - b.id));
    for (const ex of pairSession(turns)) {
      const s = ex.say;
      let reason = null;
      if (Number(s.truncated) === 1) reason = 'truncated';
      else if (REJECT_CLASSES.has(String(s.speech_class || ''))) reason = `class_${s.speech_class}`;
      else if (NON_VOICE_MODELS.has(String(s.model || ''))) reason = 'non_voice_lane';
      else reason = rejectReason(s.content) || (ex.thought ? rejectReason(ex.thought.content) : null);
      if (!reason) {
        const key = normalize(s.content);
        if (seen.has(key)) reason = 'duplicate'; else seen.add(key);
      }
      if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; continue; }
      examples.push(voiceExample(ex));
    }
  }
  return examples;
}

// ── the firehose: cloud_traces → examples ───────────────────────────────────────────────────────

function traceExample(row) {
  const day = dayOf(row.ts);
  return {
    id: `trace:${row.id}`,
    kind: 'trace',
    task: row.task,
    day,
    messages: [
      { role: 'system', content: `Task: ${row.task}. Read the input and return only the JSON output this task requires.` },
      { role: 'user', content: String(row.input_json || '') },
      { role: 'assistant', content: String(row.parsed_json || row.raw_response || '') },
    ],
    meta: { trace_id: row.id, task: row.task, model: row.model || null, ts: Number(row.ts) || null, repaired: Number(row.repaired) === 1 },
  };
}

/** All trace examples, with the rejections counted. Pure. */
function buildTraces(traceRows, rejected) {
  const examples = [];
  for (const r of traceRows) {
    let reason = null;
    if (!TRACE_TASKS.has(String(r.task || ''))) reason = 'task_not_target';
    else if (Number(r.valid) !== 1 || Number(r.accepted) !== 1) reason = 'invalid_or_unaccepted';
    else if (String(r.input_json || '').length > MAX_TRACE_INPUT_CHARS) reason = 'input_too_long';
    else if (!String(r.parsed_json || r.raw_response || '').trim()) reason = 'empty_output';
    else if (SECRET_PATTERNS.some((re) => re.test(String(r.input_json || '')) || re.test(String(r.parsed_json || '')))) reason = 'secret';
    if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; continue; }
    examples.push(traceExample(r));
  }
  return examples;
}

// ── the holdout: frozen once, append-only for new kinds and tasks ────────────────────────────────

/**
 * Decide holdout membership. `frozen` is the prior membership (from holdout.json) and is never shrunk or
 * changed; a kind or task with no prior entry is sampled now by the lowest stable hashes and frozen too.
 * Returns { membership, added } where membership = { voice: [ids], trace: { task: [ids] } }.
 */
function decideHoldout(examples, frozen) {
  const membership = { voice: [...((frozen && frozen.voice) || [])], trace: Object.assign({}, (frozen && frozen.trace) || {}) };
  let added = 0;
  const byHash = (arr) => arr.slice().sort((a, b) => stableHash(a.id) - stableHash(b.id) || (a.id < b.id ? -1 : 1));

  if (!frozen || !Array.isArray(frozen.voice)) {
    const prompted = examples.filter((e) => e.kind === 'voice');
    membership.voice = byHash(prompted).slice(0, HOLDOUT_VOICE).map((e) => e.id);
    added += membership.voice.length;
  }
  const byTask = new Map();
  for (const e of examples) if (e.kind === 'trace') { if (!byTask.has(e.task)) byTask.set(e.task, []); byTask.get(e.task).push(e); }
  for (const [task, arr] of byTask) {
    if (Array.isArray(membership.trace[task])) continue;
    const n = Math.min(HOLDOUT_TRACE_MAX, Math.max(HOLDOUT_TRACE_MIN, Math.round(arr.length * HOLDOUT_TRACE_FRACTION)));
    membership.trace[task] = byHash(arr).slice(0, Math.min(n, arr.length)).map((e) => e.id);
    added += membership.trace[task].length;
  }
  return { membership, added };
}

function holdoutSet(membership) {
  const s = new Set(membership.voice || []);
  for (const ids of Object.values(membership.trace || {})) for (const id of ids) s.add(id);
  return s;
}

// ── the build ───────────────────────────────────────────────────────────────────────────────────

function readStore(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const turns = db.prepare('SELECT id, session_id, ts, speaker, content, model, truncated, unprompted, speech_class FROM turns ORDER BY session_id, ts, id').all();
    let traces = [];
    try {
      traces = db.prepare('SELECT id, ts, task, model, input_json, raw_response, parsed_json, valid, accepted, repaired FROM cloud_traces ORDER BY id').all();
    } catch (e) { if (!/no such table/i.test(String(e.message))) throw e; }
    return { turns, traces };
  } finally { db.close(); }
}

function _rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function _mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

/**
 * Build the corpus. `store` may be injected ({ turns, traces }) for the smoke; otherwise read from `db`.
 * Rewrites examples/ and holdout/ every run; holdout.json is created once and only ever appended to.
 */
function build({ db = path.join(__dirname, '..', 'data', 'sq.db'), out = path.join(__dirname, '..', 'data', 'core'), store = null, log = () => {} } = {}) {
  const t0 = Date.now();
  const src = store || readStore(db);
  const rejected = { voice: {}, trace: {} };
  const voice = buildVoice(src.turns || [], rejected.voice);
  const traces = buildTraces(src.traces || [], rejected.trace);
  const examples = [...voice, ...traces];

  _mkdirp(out);
  const holdoutPath = path.join(out, 'holdout.json');
  let frozen = null;
  if (fs.existsSync(holdoutPath)) { try { frozen = JSON.parse(fs.readFileSync(holdoutPath, 'utf8')); } catch { frozen = null; } }
  const { membership, added } = decideHoldout(examples, frozen);
  if (!frozen || added > 0) fs.writeFileSync(holdoutPath, JSON.stringify({ frozen_at: (frozen && frozen.frozen_at) || new Date().toISOString(), updated_at: new Date().toISOString(), ...membership }, null, 1));
  const held = holdoutSet(membership);

  const exDir = path.join(out, 'examples');
  const hoDir = path.join(out, 'holdout');
  _rmrf(exDir); _rmrf(hoDir); _mkdirp(exDir); _mkdirp(hoDir);
  const files = new Map();
  const append = (file, line) => { if (!files.has(file)) files.set(file, []); files.get(file).push(line); };
  const index = [];
  const perKind = {}; const perTask = {}; let heldN = 0;
  for (const e of examples) {
    const isHeld = held.has(e.id);
    const chars = e.messages.reduce((n, m) => n + m.content.length, 0);
    const line = JSON.stringify({ id: e.id, kind: e.kind, task: e.task || undefined, day: e.day, messages: e.messages, meta: e.meta });
    if (isHeld) { heldN++; append(path.join(hoDir, `${e.kind}.jsonl`), line); }
    else append(path.join(exDir, e.kind, `${e.day}.jsonl`), line);
    perKind[e.kind] = (perKind[e.kind] || 0) + 1;
    if (e.task) perTask[e.task] = (perTask[e.task] || 0) + 1;
    index.push(JSON.stringify({ id: e.id, kind: e.kind, task: e.task || undefined, day: e.day, source: e.meta.turn_id != null ? `turns:${e.meta.turn_id}` : `cloud_traces:${e.meta.trace_id}`, chars, holdout: isHeld }));
  }
  for (const [file, lines] of files) { _mkdirp(path.dirname(file)); fs.writeFileSync(file, lines.join('\n') + '\n'); }
  fs.writeFileSync(path.join(out, 'index.jsonl'), index.join('\n') + (index.length ? '\n' : ''));

  const report = {
    built_at: new Date().toISOString(), db: store ? '(injected)' : db, ms: Date.now() - t0,
    turns_read: (src.turns || []).length, traces_read: (src.traces || []).length,
    examples: examples.length, train: examples.length - heldN, holdout: heldN, holdout_added: added,
    per_kind: perKind, per_task: perTask, rejected,
    files: files.size,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  log(describe(report));
  return report;
}

function describe(r) {
  const rej = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
  const tasks = Object.entries(r.per_task).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `[core-dataset] ${r.examples} examples (${r.train} train + ${r.holdout} holdout${r.holdout_added ? `, ${r.holdout_added} newly frozen` : ''}) from ${r.turns_read} turns + ${r.traces_read} traces in ${r.ms} ms → ${r.files} files`,
    `  kinds: ${Object.entries(r.per_kind).map(([k, v]) => `${k}:${v}`).join(' ')}`,
    `  tasks: ${tasks || 'none'}`,
    `  rejected voice: ${rej(r.rejected.voice)}`,
    `  rejected trace: ${rej(r.rejected.trace)}`,
  ].join('\n');
}

module.exports = {
  build, describe, buildVoice, buildTraces, pairSession, voiceExample, traceExample, rejectReason, decideHoldout,
  stableHash, dayOf, TRACE_TASKS, HOLDOUT_VOICE, PAIR_WINDOW_MS, MAX_TRACE_INPUT_CHARS,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const dbPath = path.resolve(opt('--db', path.join(__dirname, '..', 'data', 'sq.db')));
  const outDir = path.resolve(opt('--out', path.join(__dirname, '..', 'data', 'core')));
  try {
    build({ db: dbPath, out: outDir, log: console.log });
  } catch (e) {
    console.error(`[core-dataset] FAILED: ${e && e.stack || e}`);
    process.exit(1);
  }
}
