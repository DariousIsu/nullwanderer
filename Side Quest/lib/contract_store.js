/**
 * lib/contract_store.js — THE CONTRACT STORE (contract-agent slice 0, docs/CONTRACT_AGENT_SPEC_2026-08-22.md §4).
 *
 * A contract is the persistent state of one deliverable being produced by the contract agent: named
 * slots, the two-way channel (inbox from the user via the steering router, outbox of surfacings to be
 * voiced), open questions with flagged default assumptions, and the append-only wavelog — the truth
 * substrate every status claim must trace to. Replay-safe by construction: every wave commits before
 * anything surfaces, so a reboot resumes at the last committed wave (the canvas_docs pattern, not a
 * second source of truth for content — slot content lives in the dataset/canvas/notes stores it refs).
 *
 * Own sqlite file (data/contracts.db), WAL, purely local. CONTRACTS_DB_PATH overrides for smokes;
 * ':memory:' supported. The store is PRIMITIVES ONLY — composition (what a wave does, when questions
 * open, how surfacings are voiced) belongs to lib/contract_agent.js (slice 1) and main.js wiring.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contracts (
  contract_id  TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  ask_verbatim TEXT NOT NULL,
  origin_turn  INTEGER,
  topic_tokens TEXT NOT NULL DEFAULT '[]',
  entities     TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'open',
  budget       TEXT NOT NULL DEFAULT '{}',
  agent        TEXT NOT NULL DEFAULT '{}',
  opened_ts    INTEGER NOT NULL,
  updated_ts   INTEGER NOT NULL,
  closed_ts    INTEGER
);
CREATE TABLE IF NOT EXISTS slots (
  slot_id     TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  content_ref TEXT,
  citations   TEXT NOT NULL DEFAULT '[]',
  flags       TEXT NOT NULL DEFAULT '[]',
  updated_ts  INTEGER NOT NULL,
  PRIMARY KEY (contract_id, slot_id)
);
CREATE TABLE IF NOT EXISTS inbox (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id        TEXT NOT NULL,
  ts                 INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  text               TEXT NOT NULL,
  slot_id            TEXT,
  binding_confidence REAL,
  ack_say_ref        TEXT,
  consumed_wave      INTEGER,
  superseded_by      INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  slot_id     TEXT,
  text        TEXT NOT NULL,
  question_id TEXT,
  voiced_ts   INTEGER
);
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  slot_id     TEXT,
  text        TEXT NOT NULL,
  options     TEXT,
  assumption  TEXT NOT NULL,
  window_ms   INTEGER NOT NULL,
  asked_ts    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  answer      TEXT
);
CREATE TABLE IF NOT EXISTS wavelog (
  wave_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  TEXT NOT NULL,
  wave_n       INTEGER NOT NULL,
  started_ts   INTEGER NOT NULL,
  ended_ts     INTEGER,
  plan_summary TEXT,
  actions      TEXT NOT NULL DEFAULT '[]',
  tokens       INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT
);
CREATE INDEX IF NOT EXISTS idx_slots_contract    ON slots(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_contract    ON inbox(contract_id, id);
CREATE INDEX IF NOT EXISTS idx_outbox_unvoiced   ON outbox(contract_id, voiced_ts);
CREATE INDEX IF NOT EXISTS idx_questions_open    ON questions(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_wavelog_contract  ON wavelog(contract_id, wave_n);
`;

function init(opts = {}) {
  if (db) return db;
  const dbPath = opts.path || process.env.CONTRACTS_DB_PATH || path.join(DATA_DIR, 'contracts.db');
  if (dbPath !== ':memory:') { try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {} }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
function _db() { return db || init(); }
function close() { if (db) { try { db.close(); } catch {} db = null; } }
const now = () => Date.now();
const str = (v) => (v == null ? '' : String(v));
const _j = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
// No entropy: ts + a monotonic per-process counter. The store is single-writer (her process), so
// this is collision-safe, and id minting stays byte-stable under the deterministic entropy mode.
let _seq = 0;
const _id = (pfx) => `${pfx}-${Date.now().toString(36)}-${(++_seq).toString(36)}`;

// Contract lifecycle: closed/abandoned are terminal; closing may fall BACK to open (a failed
// delivery audit reopens the offending slots — the done-claim is structurally unreachable, §11).
const _TRANSITIONS = {
  open: ['waiting_answer', 'closing', 'abandoned'],
  waiting_answer: ['open', 'closing', 'abandoned'],
  closing: ['closed', 'open', 'abandoned'],
  closed: [],
  abandoned: [],
};
const SLOT_STATUSES = ['open', 'filled', 'flagged', 'blocked_on_question'];

function _row(r) {
  if (!r) return null;
  return {
    contractId: r.contract_id, title: r.title, askVerbatim: r.ask_verbatim, originTurn: r.origin_turn,
    topicTokens: _j(r.topic_tokens, []), entities: _j(r.entities, []), status: r.status,
    budget: _j(r.budget, {}), agent: _j(r.agent, {}),
    openedTs: r.opened_ts, updatedTs: r.updated_ts, closedTs: r.closed_ts,
  };
}
function _touch(id) { _db().prepare(`UPDATE contracts SET updated_ts = ? WHERE contract_id = ?`).run(now(), id); }

function openContract({ title, askVerbatim, originTurn = null, topicTokens = [], entities = [], budget = {} } = {}) {
  if (!str(title) || !str(askVerbatim)) return null;
  const id = _id('ct');
  _db().prepare(
    `INSERT INTO contracts (contract_id, title, ask_verbatim, origin_turn, topic_tokens, entities, status, budget, agent, opened_ts, updated_ts)
     VALUES (?,?,?,?,?,?,'open',?,'{}',?,?)`
  ).run(id, str(title), str(askVerbatim), originTurn, JSON.stringify(topicTokens || []), JSON.stringify(entities || []), JSON.stringify(budget || {}), now(), now());
  return getContract(id);
}
function getContract(id) { return _row(_db().prepare(`SELECT * FROM contracts WHERE contract_id = ?`).get(str(id))); }
function listOpen() {
  return _db().prepare(`SELECT * FROM contracts WHERE status IN ('open','waiting_answer','closing') ORDER BY opened_ts ASC`).all().map(_row);
}
// Open + recently-touched closed contracts — the router's view: a STATUS ask about work that just
// finished must read the store ("done — here's what landed"), not fall through to doc recall
// (the p119 status-leg finding). Steering/answer binding stays live-only in the verdict.
function listRecent({ sinceMs = 24 * 3600 * 1000 } = {}) {
  return _db().prepare(`SELECT * FROM contracts WHERE status IN ('open','waiting_answer','closing') OR updated_ts >= ? ORDER BY updated_ts DESC LIMIT 12`).all(Date.now() - sinceMs).map(_row);
}
function setStatus(id, status) {
  const c = getContract(id);
  if (!c || !(_TRANSITIONS[c.status] || []).includes(status)) return false;
  _db().prepare(`UPDATE contracts SET status = ?, updated_ts = ?, closed_ts = CASE WHEN ? IN ('closed','abandoned') THEN ? ELSE closed_ts END WHERE contract_id = ?`)
    .run(status, now(), status, now(), str(id));
  return true;
}
function patchAgent(id, patch = {}) {
  const c = getContract(id);
  if (!c) return false;
  _db().prepare(`UPDATE contracts SET agent = ?, updated_ts = ? WHERE contract_id = ?`)
    .run(JSON.stringify({ ...c.agent, ...patch }), now(), str(id));
  return true;
}

// ── slots ───────────────────────────────────────────────────────────────────────────────────────
function upsertSlot({ contractId, slotId, description = '', status = 'open', contentRef = null, citations = null, flags = null } = {}) {
  if (!str(contractId) || !str(slotId) || !SLOT_STATUSES.includes(status)) return false;
  if (!getContract(contractId)) return false;
  const prev = _db().prepare(`SELECT * FROM slots WHERE contract_id = ? AND slot_id = ?`).get(str(contractId), str(slotId));
  _db().prepare(
    `INSERT INTO slots (slot_id, contract_id, description, status, content_ref, citations, flags, updated_ts) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(contract_id, slot_id) DO UPDATE SET description=excluded.description, status=excluded.status,
       content_ref=excluded.content_ref, citations=excluded.citations, flags=excluded.flags, updated_ts=excluded.updated_ts`
  ).run(str(slotId), str(contractId), str(description) || (prev ? prev.description : ''), status,
    contentRef == null ? (prev ? prev.content_ref : null) : str(contentRef),
    JSON.stringify(citations == null ? _j(prev && prev.citations, []) : citations),
    JSON.stringify(flags == null ? _j(prev && prev.flags, []) : flags), now());
  _touch(contractId);
  return true;
}
function slots(contractId) {
  return _db().prepare(`SELECT * FROM slots WHERE contract_id = ? ORDER BY slot_id`).all(str(contractId)).map((s) => ({
    slotId: s.slot_id, contractId: s.contract_id, description: s.description, status: s.status,
    contentRef: s.content_ref, citations: _j(s.citations, []), flags: _j(s.flags, []), updatedTs: s.updated_ts,
  }));
}
function addSlotFlag(contractId, slotId, flag) {
  const s = slots(contractId).find((x) => x.slotId === str(slotId));
  if (!s) return false;
  // A flag RESOLVES an unresolved slot (open/blocked → flagged: the honest hole) and merely LABELS a
  // resolved one (filled stays filled). THE FLAG-DOESN'T-RESOLVE BUG (boot_p118 waves 6-9, live): an
  // open slot kept status 'open' after flag_slot, so the driver's honest "can't fill this" never
  // counted as resolved — done refused three waves straight against a slot it believed settled.
  const next = (s.status === 'blocked_on_question' || s.status === 'open') ? 'flagged' : s.status;
  return upsertSlot({ contractId, slotId, description: s.description, status: next, contentRef: s.contentRef, citations: s.citations, flags: [...s.flags, flag] });
}

// ── inbox (user → agent; the steering router writes here) ───────────────────────────────────────
function postInbox({ contractId, kind, text, slotId = null, bindingConfidence = null, ackSayRef = null } = {}) {
  if (!str(contractId) || !str(kind) || !str(text) || !getContract(contractId)) return null;
  const r = _db().prepare(
    `INSERT INTO inbox (contract_id, ts, kind, text, slot_id, binding_confidence, ack_say_ref) VALUES (?,?,?,?,?,?,?)`
  ).run(str(contractId), now(), str(kind), str(text), slotId == null ? null : str(slotId), bindingConfidence, ackSayRef == null ? null : str(ackSayRef));
  _touch(contractId);
  return r.lastInsertRowid;
}
function readInbox(contractId, { unconsumedOnly = true } = {}) {
  const rows = _db().prepare(
    `SELECT * FROM inbox WHERE contract_id = ? AND superseded_by IS NULL${unconsumedOnly ? ' AND consumed_wave IS NULL' : ''} ORDER BY id ASC`
  ).all(str(contractId));
  return rows.map((m) => ({ id: m.id, contractId: m.contract_id, ts: m.ts, kind: m.kind, text: m.text, slotId: m.slot_id, bindingConfidence: m.binding_confidence, ackSayRef: m.ack_say_ref, consumedWave: m.consumed_wave }));
}
function markInboxConsumed(ids, waveN) {
  const st = _db().prepare(`UPDATE inbox SET consumed_wave = ? WHERE id = ? AND consumed_wave IS NULL`);
  let n = 0;
  for (const id of [].concat(ids || [])) n += st.run(waveN, id).changes;
  return n;
}
// The misroute repair (§8): a tombstoned message is never applied — and if a wave already consumed
// it, the tombstone stays visible in readInbox(unconsumedOnly:false) history so the NEXT replan can
// see and reverse it. supersededBy = the replacement message id, or 0 for a plain retraction.
function tombstoneInbox(id, supersededBy = 0) {
  return _db().prepare(`UPDATE inbox SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`).run(supersededBy, id).changes > 0;
}

// ── outbox (agent → user; the surfacing voicer drains this) ─────────────────────────────────────
const OUTBOX_KINDS = ['finding', 'question', 'judgment_call', 'milestone', 'blocked'];
function postOutbox({ contractId, kind, text, slotId = null, questionId = null } = {}) {
  if (!str(contractId) || !OUTBOX_KINDS.includes(kind) || !str(text) || !getContract(contractId)) return null;
  const r = _db().prepare(`INSERT INTO outbox (contract_id, ts, kind, slot_id, text, question_id) VALUES (?,?,?,?,?,?)`)
    .run(str(contractId), now(), kind, slotId == null ? null : str(slotId), str(text), questionId == null ? null : str(questionId));
  _touch(contractId);
  return r.lastInsertRowid;
}
function unvoiced() {
  return _db().prepare(`SELECT * FROM outbox WHERE voiced_ts IS NULL ORDER BY id ASC`).all()
    .map((o) => ({ id: o.id, contractId: o.contract_id, ts: o.ts, kind: o.kind, slotId: o.slot_id, text: o.text, questionId: o.question_id }));
}
function markVoiced(id) { return _db().prepare(`UPDATE outbox SET voiced_ts = ? WHERE id = ? AND voiced_ts IS NULL`).run(now(), id).changes > 0; }

// ── questions (every one ships with a flagged default — the loop never stalls, §9) ──────────────
function openQuestion({ contractId, slotId = null, text, options = null, assumption, windowMs } = {}) {
  if (!str(contractId) || !str(text) || !str(assumption) || !(windowMs > 0) || !getContract(contractId)) return null;
  const qid = _id('q');
  _db().prepare(`INSERT INTO questions (question_id, contract_id, slot_id, text, options, assumption, window_ms, asked_ts) VALUES (?,?,?,?,?,?,?,?)`)
    .run(qid, str(contractId), slotId == null ? null : str(slotId), str(text), options ? JSON.stringify(options) : null, str(assumption), windowMs, now());
  if (slotId != null) {
    const s = slots(contractId).find((x) => x.slotId === str(slotId));
    if (s) upsertSlot({ contractId, slotId, description: s.description, status: 'blocked_on_question', contentRef: s.contentRef, citations: s.citations, flags: s.flags });
  }
  _touch(contractId);
  return getQuestion(qid);
}
function getQuestion(qid) {
  const q = _db().prepare(`SELECT * FROM questions WHERE question_id = ?`).get(str(qid));
  if (!q) return null;
  return { questionId: q.question_id, contractId: q.contract_id, slotId: q.slot_id, text: q.text, options: _j(q.options, null), assumption: q.assumption, windowMs: q.window_ms, askedTs: q.asked_ts, status: q.status, answer: _j(q.answer, null) };
}
function openQuestions(contractId) {
  return _db().prepare(`SELECT question_id FROM questions WHERE contract_id = ? AND status = 'open' ORDER BY asked_ts ASC`).all(str(contractId)).map((r) => getQuestion(r.question_id));
}
function answerQuestion(qid, { text, turnRef = null } = {}) {
  const q = getQuestion(qid);
  if (!q || q.status !== 'open' || !str(text)) return false;
  _db().prepare(`UPDATE questions SET status = 'answered', answer = ? WHERE question_id = ?`).run(JSON.stringify({ text: str(text), ts: now(), turnRef }), str(qid));
  if (q.slotId != null) {
    const s = slots(q.contractId).find((x) => x.slotId === q.slotId);
    if (s && s.status === 'blocked_on_question') upsertSlot({ contractId: q.contractId, slotId: q.slotId, description: s.description, status: 'open', contentRef: s.contentRef, citations: s.citations, flags: s.flags });
  }
  _touch(q.contractId);
  return true;
}
// Expired → the agent proceeds on the flagged assumption; the flag SURVIVES into the deliverable.
function expireDueQuestions(nowTs = now()) {
  const due = _db().prepare(`SELECT question_id FROM questions WHERE status = 'open' AND asked_ts + window_ms <= ?`).all(nowTs).map((r) => getQuestion(r.question_id));
  for (const q of due) {
    _db().prepare(`UPDATE questions SET status = 'expired' WHERE question_id = ?`).run(q.questionId);
    if (q.slotId != null) addSlotFlag(q.contractId, q.slotId, { kind: 'assumption', text: q.assumption, questionId: q.questionId });
  }
  return due;
}
function expiredQuestions(contractId) {
  return _db().prepare(`SELECT question_id FROM questions WHERE contract_id = ? AND status = 'expired' ORDER BY asked_ts ASC`).all(str(contractId)).map((r) => getQuestion(r.question_id));
}

// ── THE LATE-ANSWER RE-OPEN (slice 4, §9) ───────────────────────────────────────────────────────
// An answer that arrives AFTER its question expired reworks ONLY what the answer changes — never a
// contract restart. The question becomes 'answered_late'; its slot re-opens for rework with THIS
// question's assumption flag replaced by a rework note (a superseded assumption must not survive
// into the reworked deliverable — the supersession history lives on the question row); the next
// wave learns WHY via a 'late_answer' inbox message; and a contract that already shipped comes back
// OPEN for the scoped rework. closed→open exists ONLY through this door — answerQuestion still
// refuses non-open questions and setStatus still refuses closed→anything.
const REWORK_WAVE_ALLOWANCE = 2;
function reopenFromLateAnswer(qid, { text, turnRef = null } = {}) {
  const q = getQuestion(qid);
  if (!q || q.status !== 'expired' || !str(text)) return null;
  const c = getContract(q.contractId);
  if (!c || c.status === 'abandoned') return null;
  _db().prepare(`UPDATE questions SET status = 'answered_late', answer = ? WHERE question_id = ?`)
    .run(JSON.stringify({ text: str(text), ts: now(), turnRef }), str(qid));
  let slotReopened = null;
  if (q.slotId != null) {
    const s = slots(q.contractId).find((x) => x.slotId === q.slotId);
    if (s) {
      const kept = s.flags.filter((f) => !(f && f.kind === 'assumption' && f.questionId === q.questionId));
      kept.push({ kind: 'rework', text: `late answer supersedes the assumption "${str(q.assumption).slice(0, 120)}"`, questionId: q.questionId });
      upsertSlot({ contractId: q.contractId, slotId: q.slotId, description: s.description, status: 'open', contentRef: s.contentRef, citations: s.citations, flags: kept });
      slotReopened = q.slotId;
    }
  }
  const wasClosed = c.status === 'closed';
  if (c.status === 'closing' || c.status === 'waiting_answer') setStatus(c.contractId, 'open');
  else if (wasClosed) _db().prepare(`UPDATE contracts SET status = 'open', closed_ts = NULL, updated_ts = ? WHERE contract_id = ?`).run(now(), c.contractId);
  // A spent wave budget gets a bounded rework allowance — the scoped rework needs waves to run.
  // (12 mirrors contract_agent.DEFAULT_MAX_WAVES — the agent's fallback when budget.maxWaves is unset.)
  const k = counts(q.contractId);
  const effMax = (c.budget && c.budget.maxWaves) || 12;
  if (k.wavesDone >= effMax) {
    _db().prepare(`UPDATE contracts SET budget = ? WHERE contract_id = ?`).run(JSON.stringify({ ...c.budget, maxWaves: k.wavesDone + REWORK_WAVE_ALLOWANCE }), c.contractId);
  }
  patchAgent(q.contractId, { budgetBlockedPosted: false });
  const inboxId = postInbox({
    contractId: q.contractId, kind: 'late_answer', slotId: q.slotId,
    text: `LATE ANSWER to your expired question "${str(q.text).slice(0, 140)}": "${str(text).slice(0, 300)}". Rework ONLY ${q.slotId ? `slot ${q.slotId}` : 'what this answer changes'} under this answer — the assumption "${str(q.assumption).slice(0, 120)}" is superseded; everything else stands.`,
  });
  _touch(q.contractId);
  return { contractId: q.contractId, slotId: slotReopened, wasClosed, inboxId };
}

// ── wavelog (append-only; the truth substrate — commits BEFORE anything surfaces) ───────────────
// Idempotent resume: if an unfinished wave exists (a reboot mid-wave), beginWave returns IT with
// resumed:true instead of stacking a new one — the resume point IS the interrupted wave.
function beginWave(contractId, planSummary = '') {
  if (!getContract(contractId)) return null;
  const openW = _db().prepare(`SELECT * FROM wavelog WHERE contract_id = ? AND ended_ts IS NULL ORDER BY wave_n DESC LIMIT 1`).get(str(contractId));
  if (openW) return { waveId: openW.wave_id, waveN: openW.wave_n, resumed: true };
  const n = ((_db().prepare(`SELECT MAX(wave_n) AS m FROM wavelog WHERE contract_id = ?`).get(str(contractId)) || {}).m || 0) + 1;
  const r = _db().prepare(`INSERT INTO wavelog (contract_id, wave_n, started_ts, plan_summary) VALUES (?,?,?,?)`).run(str(contractId), n, now(), str(planSummary));
  patchAgent(contractId, { lastWaveTs: now(), waveN: n });
  return { waveId: r.lastInsertRowid, waveN: n, resumed: false };
}
function endWave(waveId, { actions = [], tokens = 0, outcome = '' } = {}) {
  const ch = _db().prepare(`UPDATE wavelog SET ended_ts = ?, actions = ?, tokens = ?, outcome = ? WHERE wave_id = ? AND ended_ts IS NULL`)
    .run(now(), JSON.stringify(actions || []), tokens | 0, str(outcome), waveId).changes;
  return ch > 0;
}
function waveLog(contractId) {
  return _db().prepare(`SELECT * FROM wavelog WHERE contract_id = ? ORDER BY wave_n ASC`).all(str(contractId)).map((w) => ({
    waveId: w.wave_id, waveN: w.wave_n, startedTs: w.started_ts, endedTs: w.ended_ts, planSummary: w.plan_summary,
    actions: _j(w.actions, []), tokens: w.tokens, outcome: w.outcome,
  }));
}

// Newest wave start across ALL contracts — the anti-fab gate's POSITIVE source: a real contract
// wave IS a real agent run, so the invented-agent gate accepts it as evidence (spec §7).
function lastWaveTs() { try { const r = _db().prepare('SELECT MAX(started_ts) AS m FROM wavelog').get(); return (r && r.m) || 0; } catch { return 0; } }

// ── the boot resume read + the status-truth read ────────────────────────────────────────────────
function counts(contractId) {
  const d = _db(), id = str(contractId);
  const by = {};
  for (const r of d.prepare(`SELECT status, COUNT(*) AS n FROM slots WHERE contract_id = ? GROUP BY status`).all(id)) by[r.status] = r.n;
  return {
    slots: by,
    wavesDone: (d.prepare(`SELECT COUNT(*) AS n FROM wavelog WHERE contract_id = ? AND ended_ts IS NOT NULL`).get(id) || {}).n || 0,
    inboxPending: (d.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE contract_id = ? AND consumed_wave IS NULL AND superseded_by IS NULL`).get(id) || {}).n || 0,
    outboxUnvoiced: (d.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE contract_id = ? AND voiced_ts IS NULL`).get(id) || {}).n || 0,
    questionsOpen: (d.prepare(`SELECT COUNT(*) AS n FROM questions WHERE contract_id = ? AND status = 'open'`).get(id) || {}).n || 0,
  };
}
function resumeOpenContracts() {
  return listOpen().map((c) => {
    const openW = _db().prepare(`SELECT wave_n FROM wavelog WHERE contract_id = ? AND ended_ts IS NULL ORDER BY wave_n DESC LIMIT 1`).get(c.contractId);
    const lastDone = _db().prepare(`SELECT MAX(wave_n) AS m FROM wavelog WHERE contract_id = ? AND ended_ts IS NOT NULL`).get(c.contractId);
    return { ...c, interruptedWaveN: openW ? openW.wave_n : null, lastCompletedWaveN: (lastDone && lastDone.m) || 0, counts: counts(c.contractId) };
  });
}

module.exports = {
  init, _db, close,
  openContract, getContract, listOpen, listRecent, setStatus, patchAgent,
  upsertSlot, slots, addSlotFlag, SLOT_STATUSES,
  postInbox, readInbox, markInboxConsumed, tombstoneInbox,
  postOutbox, unvoiced, markVoiced, OUTBOX_KINDS,
  openQuestion, getQuestion, openQuestions, answerQuestion, expireDueQuestions,
  expiredQuestions, reopenFromLateAnswer,
  beginWave, endWave, waveLog, lastWaveTs,
  counts, resumeOpenContracts,
};
