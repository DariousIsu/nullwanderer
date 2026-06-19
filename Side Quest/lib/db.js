const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'sq.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK(speaker IN ('user','ai_thought','ai_said')),
  content TEXT NOT NULL,
  model TEXT,
  truncated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_session_ts ON turns(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_speaker_ts ON turns(speaker, ts);

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  prompt_used TEXT NOT NULL,
  content TEXT NOT NULL,
  source_turn_start INTEGER,
  source_turn_end INTEGER,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_reflections_ts ON reflections(ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS monologue (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  model TEXT,
  content TEXT NOT NULL,
  feed_context TEXT,
  surfaced_as_turn_id INTEGER,
  type TEXT DEFAULT 'thought',
  query TEXT,
  urls TEXT
);
CREATE INDEX IF NOT EXISTS idx_monologue_ts ON monologue(ts);
`;

// Idempotent migrations. Column adds first; indexes that depend on new columns last.
const MIGRATIONS = [
  `ALTER TABLE monologue ADD COLUMN type TEXT DEFAULT 'thought'`,
  `ALTER TABLE monologue ADD COLUMN query TEXT`,
  `ALTER TABLE monologue ADD COLUMN urls TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_monologue_type_ts ON monologue(type, ts)`,
  `CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    claim TEXT NOT NULL,
    evidence_turn_ids TEXT,
    confidence REAL DEFAULT 0.7,
    status TEXT DEFAULT 'held',
    first_held_at INTEGER NOT NULL,
    last_confirmed_at INTEGER,
    last_challenged_at INTEGER,
    revision_history TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commitments_status_ts ON commitments(status, ts)`,
  // open_threads — goals/tasks she is actively pursuing across ticks.
  // Distinct from commitments (beliefs) — these are intentions/work-in-progress.
  // status: pending → active → (stalled|resolved|abandoned)
  // parent_id enables Park-style hierarchical decomposition of compound goals.
  `CREATE TABLE IF NOT EXISTS open_threads (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','stalled','resolved','abandoned')),
    parent_id INTEGER REFERENCES open_threads(id),
    source_turn_id INTEGER,
    created_ts INTEGER NOT NULL,
    last_touched_ts INTEGER NOT NULL,
    resolved_ts INTEGER,
    progress_notes TEXT,
    mention_count INTEGER DEFAULT 0,
    action_count INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_open_threads_status_ts ON open_threads(status, last_touched_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_open_threads_parent ON open_threads(parent_id)`,
  // protocols — durable user-AI negotiated agreements. ALWAYS injected, never aged.
  // Distinct memory class from turns (history), commitments (AI beliefs), or
  // open_threads (transient tasks). These are the rules of engagement.
  //   category: safe_word | mode_command | boundary | preference | rule
  //   action: hard_break_rp | enter_rp_mode | exit_rp_mode | none (description-only)
  `CREATE TABLE IF NOT EXISTS protocols (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('safe_word','mode_command','boundary','preference','rule')),
    trigger_phrase TEXT,
    action TEXT,
    description TEXT NOT NULL,
    source_turn_ids TEXT,
    established_ts INTEGER NOT NULL,
    last_confirmed_ts INTEGER NOT NULL,
    last_invoked_ts INTEGER,
    invoke_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','revised','revoked'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_protocols_status ON protocols(status)`,
  `CREATE INDEX IF NOT EXISTS idx_protocols_trigger ON protocols(trigger_phrase)`,
  // inbound_messages — replies from chat bots Eloise is watching.
  // Queued by ChatWatcher when a bot finishes streaming. Injected into Stheno's
  // next-turn context as <incoming> system block; marked consumed once injected.
  `CREATE TABLE IF NOT EXISTS inbound_messages (
    id INTEGER PRIMARY KEY,
    tab_url TEXT NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    message_index INTEGER,
    received_ts INTEGER NOT NULL,
    consumed_ts INTEGER,
    source TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbound_consumed ON inbound_messages(consumed_ts, received_ts)`
];

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // Apply idempotent migrations for upgrades from older schemas
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e) { /* duplicate column — ignore */ }
  }
}

function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}

function startSession() {
  const info = getDb().prepare('INSERT INTO sessions (started_at) VALUES (?)').run(Date.now());
  return info.lastInsertRowid;
}

function endSession(id) {
  if (!id) return;
  getDb().prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
}

function insertTurn({ sessionId, speaker, content, model = null, truncated = 0 }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO turns (session_id, ts, speaker, content, model, truncated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, ts, speaker, content, model, truncated);
  return { id: info.lastInsertRowid, ts };
}

function getRecentTurns(n) {
  // last N turns across history, oldest first
  const rows = getDb()
    .prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

function getRecentDisplayTurns(n) {
  // user + ai_thought + ai_said — renderer pairs thought with following said
  const rows = getDb()
    .prepare(`SELECT * FROM turns WHERE speaker IN ('user','ai_thought','ai_said') ORDER BY id DESC LIMIT ?`)
    .all(n);
  return rows.reverse();
}

function insertMonologue({ content, model = null, feedContext = null, type = 'thought', query = null, urls = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO monologue (ts, model, content, feed_context, type, query, urls) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ts, model, content, feedContext ? JSON.stringify(feedContext) : null, type, query, urls ? JSON.stringify(urls) : null);
  return { id: info.lastInsertRowid, ts };
}

function getRecentMonologue(n) {
  const rows = getDb()
    .prepare('SELECT * FROM monologue ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

function getRecentMonologueByType(type, n) {
  const rows = getDb()
    .prepare('SELECT * FROM monologue WHERE type = ? ORDER BY id DESC LIMIT ?')
    .all(type, n);
  return rows.reverse();
}

// --- Commitments ---

function insertCommitment({ claim, evidenceTurnIds = [], confidence = 0.7 }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO commitments
      (ts, claim, evidence_turn_ids, confidence, status, first_held_at, last_confirmed_at)
      VALUES (?, ?, ?, ?, 'held', ?, ?)`)
    .run(ts, claim, JSON.stringify(evidenceTurnIds), confidence, ts, ts);
  return { id: info.lastInsertRowid, ts };
}

function getHeldCommitments(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM commitments WHERE status = 'held' ORDER BY last_confirmed_at DESC LIMIT ?`)
    .all(limit);
}

function getAllCommitments(limit = 100) {
  return getDb()
    .prepare(`SELECT * FROM commitments ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

function reviseCommitment(id, { newClaim, reason, triggeredByTurnId }) {
  const now = Date.now();
  const current = getDb().prepare('SELECT * FROM commitments WHERE id = ?').get(id);
  if (!current) return null;
  const history = current.revision_history ? JSON.parse(current.revision_history) : [];
  history.push({
    ts: now,
    old_claim: current.claim,
    new_claim: newClaim,
    reason,
    triggered_by_turn_id: triggeredByTurnId
  });
  getDb()
    .prepare(`UPDATE commitments
      SET claim = ?, revision_history = ?, last_confirmed_at = ?
      WHERE id = ?`)
    .run(newClaim, JSON.stringify(history), now, id);
  return { id, ts: now };
}

function markCommitmentStatus(id, status, { reason = null, triggeredByTurnId = null } = {}) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT revision_history FROM commitments WHERE id = ?').get(id);
  if (!cur) return null;
  const history = cur.revision_history ? JSON.parse(cur.revision_history) : [];
  history.push({ ts: now, status, reason, triggered_by_turn_id: triggeredByTurnId });
  getDb()
    .prepare(`UPDATE commitments
      SET status = ?, revision_history = ?, last_challenged_at = ?
      WHERE id = ?`)
    .run(status, JSON.stringify(history), now, id);
  return { id, ts: now };
}

function confirmCommitment(id, turnId) {
  const now = Date.now();
  getDb().prepare('UPDATE commitments SET last_confirmed_at = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

function countCommitmentsByStatus() {
  return getDb()
    .prepare(`SELECT status, COUNT(*) as n FROM commitments GROUP BY status`)
    .all();
}

// --- Open Threads (intentions / goals / tasks the agent is pursuing) ---

function insertOpenThread({ content, parentId = null, sourceTurnId = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO open_threads
      (content, status, parent_id, source_turn_id, created_ts, last_touched_ts)
      VALUES (?, 'pending', ?, ?, ?, ?)`)
    .run(content, parentId, sourceTurnId, ts, ts);
  return { id: info.lastInsertRowid, ts };
}

// Active threads ordered by recency-of-touch; returns oldest-touched first within active
// (so the staler ones rise; the agent's prompt sees what's been neglected)
function getActiveOpenThreads(limit = 10) {
  return getDb()
    .prepare(`SELECT * FROM open_threads
      WHERE status IN ('pending','active','stalled')
      ORDER BY last_touched_ts ASC LIMIT ?`)
    .all(limit);
}

function getAllOpenThreads(limit = 200) {
  return getDb()
    .prepare(`SELECT * FROM open_threads ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

function getOpenThread(id) {
  return getDb().prepare('SELECT * FROM open_threads WHERE id = ?').get(id);
}

function markOpenThreadStatus(id, status, { reason = null } = {}) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT progress_notes FROM open_threads WHERE id = ?').get(id);
  if (!cur) return null;
  const notes = cur.progress_notes ? JSON.parse(cur.progress_notes) : [];
  notes.push({ ts: now, status, reason });
  const isResolved = status === 'resolved' || status === 'abandoned';
  if (isResolved) {
    getDb()
      .prepare(`UPDATE open_threads
        SET status = ?, progress_notes = ?, last_touched_ts = ?, resolved_ts = ?
        WHERE id = ?`)
      .run(status, JSON.stringify(notes), now, now, id);
  } else {
    getDb()
      .prepare(`UPDATE open_threads
        SET status = ?, progress_notes = ?, last_touched_ts = ?
        WHERE id = ?`)
      .run(status, JSON.stringify(notes), now, id);
  }
  return { id, ts: now };
}

function touchOpenThread(id, note = null) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT progress_notes, status FROM open_threads WHERE id = ?').get(id);
  if (!cur) return null;
  const notes = cur.progress_notes ? JSON.parse(cur.progress_notes) : [];
  if (note) notes.push({ ts: now, progress: note });
  // pending → active on first touch
  const newStatus = cur.status === 'pending' ? 'active' : cur.status;
  getDb()
    .prepare(`UPDATE open_threads
      SET status = ?, progress_notes = ?, last_touched_ts = ?
      WHERE id = ?`)
    .run(newStatus, JSON.stringify(notes), now, id);
  return { id, ts: now };
}

function incrementThreadMention(id) {
  getDb().prepare('UPDATE open_threads SET mention_count = mention_count + 1 WHERE id = ?').run(id);
}

function incrementThreadAction(id) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE open_threads SET action_count = action_count + 1, last_touched_ts = ? WHERE id = ?')
    .run(now, id);
}

function countOpenThreadsByStatus() {
  return getDb()
    .prepare(`SELECT status, COUNT(*) as n FROM open_threads GROUP BY status`)
    .all();
}

function getRecentReflections(n) {
  const rows = getDb()
    .prepare('SELECT * FROM reflections ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

function insertReflection({ promptUsed, content, sourceTurnStart, sourceTurnEnd, model = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO reflections (ts, prompt_used, content, source_turn_start, source_turn_end, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ts, promptUsed, content, sourceTurnStart, sourceTurnEnd, model);
  return { id: info.lastInsertRowid, ts };
}

function getTurnsSinceId(turnId) {
  return getDb()
    .prepare('SELECT * FROM turns WHERE id > ? ORDER BY id ASC')
    .all(turnId);
}

// --- Protocols (durable user-AI negotiated agreements) ---

function insertProtocol({ category, triggerPhrase = null, action = null, description, sourceTurnIds = [] }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO protocols
      (category, trigger_phrase, action, description, source_turn_ids, established_ts, last_confirmed_ts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
    .run(category, triggerPhrase, action, description, JSON.stringify(sourceTurnIds), ts, ts);
  return { id: info.lastInsertRowid, ts };
}

function getActiveProtocols() {
  return getDb()
    .prepare(`SELECT * FROM protocols WHERE status = 'active' ORDER BY category, id`)
    .all();
}

function getAllProtocols() {
  return getDb()
    .prepare(`SELECT * FROM protocols ORDER BY id DESC`)
    .all();
}

function getProtocolByTrigger(phrase) {
  if (!phrase) return null;
  return getDb()
    .prepare(`SELECT * FROM protocols WHERE status = 'active' AND lower(trigger_phrase) = lower(?) LIMIT 1`)
    .get(phrase);
}

function confirmProtocol(id) {
  const now = Date.now();
  getDb().prepare('UPDATE protocols SET last_confirmed_ts = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

function invokeProtocol(id) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE protocols SET last_invoked_ts = ?, invoke_count = invoke_count + 1, last_confirmed_ts = ? WHERE id = ?')
    .run(now, now, id);
  return { id, ts: now };
}

function revokeProtocol(id) {
  getDb().prepare(`UPDATE protocols SET status = 'revoked' WHERE id = ?`).run(id);
  return { id };
}

// --- Inbound messages (queued chat-bot replies awaiting consumption) ---

function insertInbound({ tabUrl, speaker = null, text, messageIndex = null, source = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO inbound_messages
      (tab_url, speaker, text, message_index, received_ts, source)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tabUrl, speaker, text, messageIndex, ts, source);
  return { id: info.lastInsertRowid, ts };
}

function getPendingInbounds(limit = 8) {
  return getDb()
    .prepare(`SELECT * FROM inbound_messages WHERE consumed_ts IS NULL ORDER BY received_ts ASC LIMIT ?`)
    .all(limit);
}

function markInboundConsumed(id) {
  const now = Date.now();
  getDb().prepare('UPDATE inbound_messages SET consumed_ts = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

function markAllInboundsConsumed() {
  const now = Date.now();
  const info = getDb()
    .prepare('UPDATE inbound_messages SET consumed_ts = ? WHERE consumed_ts IS NULL')
    .run(now);
  return { ts: now, changed: info.changes };
}

// Sum of completed session durations + current open session age (ms).
// Used for the "you've been awake X hours total" awareness block.
function getCumulativeSessionTime() {
  const rows = getDb()
    .prepare('SELECT started_at, ended_at FROM sessions')
    .all();
  const now = Date.now();
  let total = 0;
  for (const r of rows) {
    const end = r.ended_at || now;  // open session counts up to now
    if (r.started_at && end > r.started_at) total += (end - r.started_at);
  }
  return total;
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = {
  init,
  startSession,
  endSession,
  insertTurn,
  getRecentTurns,
  getRecentDisplayTurns,
  getRecentReflections,
  insertReflection,
  getTurnsSinceId,
  insertMonologue,
  getRecentMonologue,
  getRecentMonologueByType,
  insertCommitment,
  getHeldCommitments,
  getAllCommitments,
  reviseCommitment,
  markCommitmentStatus,
  confirmCommitment,
  countCommitmentsByStatus,
  insertOpenThread,
  getActiveOpenThreads,
  getAllOpenThreads,
  getOpenThread,
  markOpenThreadStatus,
  touchOpenThread,
  incrementThreadMention,
  incrementThreadAction,
  countOpenThreadsByStatus,
  insertProtocol,
  getActiveProtocols,
  getAllProtocols,
  getProtocolByTrigger,
  confirmProtocol,
  invokeProtocol,
  revokeProtocol,
  insertInbound,
  getPendingInbounds,
  markInboundConsumed,
  markAllInboundsConsumed,
  getCumulativeSessionTime,
  getMeta,
  setMeta,
  DB_PATH
};
