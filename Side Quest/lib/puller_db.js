/**
 * lib/puller_db.js — Puller's dossier store (Slice 0: schema + data-access layer).
 *
 * Puller is a person/org research workbench: it accumulates EVIDENCE (observations, append-only),
 * derives a current best-guess profile (beliefs), and refines per-domain email-pattern beliefs via
 * the negative-signal loop (studio/puller_beliefs). This module owns persistence only — the belief
 * MATH is pure in studio/puller_beliefs, and the verify→update→propose ORCHESTRATION is Slice 4.
 *
 * Backed by its OWN sqlite file (data/puller.db), isolated from sq.db / editor.db / Echo. The store
 * references CRM/Echo rows by id only (Target.crm_id) — it never edits them. PULLER_DB_PATH overrides
 * for smokes; ':memory:' is supported. Mirrors the lib/editor_registry idiom (init/_db/close, WAL).
 *
 * Data spine:
 *   targets          person/org dossier subjects   (status: adhoc → promoted, nullable crm_id)
 *   observations     atomic evidence               (APPEND-ONLY; never updated)
 *   beliefs          derived current answers        (one active per (target, type))
 *   pattern_beliefs  per-domain email-pattern Beta state (the §4 store; pure state kept as json)
 *   revisions        the propose→approve gate       (destructive belief flips await your decision)
 *   retest_queue     §4.5 negative-signal retests   (FIFO + backoff)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'person' CHECK(kind IN ('person','org')),
  name TEXT NOT NULL,
  company TEXT,
  domain TEXT,
  function TEXT,                       -- GR / PR / comms / ... (free text, a lens)
  priority TEXT,
  status TEXT NOT NULL DEFAULT 'adhoc' CHECK(status IN ('adhoc','promoted')),
  crm_id TEXT,                         -- ref CRM row id once promoted (null while ad-hoc)
  notes TEXT,
  photo_url TEXT,                      -- official headshot URL grabbed at discovery (team/bio page)
  photo_path TEXT,                     -- local copy (data/faces/<id>.jpg) — the reference for face-matching
  face_embedding TEXT,                 -- json 512-d ArcFace embedding of the reference headshot (cached)
  merged_into INTEGER,                 -- F4: survivor id once this target is merged away (NULL = live)
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tgt_status ON targets(status);
CREATE INDEX IF NOT EXISTS idx_tgt_domain ON targets(domain);
CREATE INDEX IF NOT EXISTS idx_tgt_crm ON targets(crm_id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  target_id INTEGER NOT NULL REFERENCES targets(id),
  attr TEXT NOT NULL,                  -- email / email_pattern / role / employer / phone / name / ...
  value TEXT,
  kind TEXT,                           -- verify / press_page / lda / linkedin / manual / derived / ...
  source TEXT,
  source_url TEXT,
  source_date TEXT,
  confidence REAL,
  meta TEXT,                           -- json sidecar (raw status, vendor, etc.)
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_target ON observations(target_id);
CREATE INDEX IF NOT EXISTS idx_obs_attr ON observations(target_id, attr);

CREATE TABLE IF NOT EXISTS beliefs (
  id INTEGER PRIMARY KEY,
  target_id INTEGER NOT NULL REFERENCES targets(id),
  type TEXT NOT NULL,                  -- email / role / employer / phone / affiliation / ...
  value TEXT,
  confidence REAL,
  derivation TEXT,                     -- how this was derived (rule name / note)
  supporting_obs TEXT,                 -- json array of observation ids
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','rejected')),
  send_state TEXT,                     -- delivery/verify MARKER (email): verified / bounced / rerun_pending /
                                       -- exhausted / catchall / untested. The single key list-pulls + the
                                       -- rerun batch filter on (rerun_pending = flipped to a new best-guess,
                                       -- awaiting the next verification upload).
  updated_at INTEGER NOT NULL,
  UNIQUE(target_id, type)
);
CREATE INDEX IF NOT EXISTS idx_belief_target ON beliefs(target_id);

CREATE TABLE IF NOT EXISTS pattern_beliefs (
  domain TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,            -- the pure {patterns, is_catch_all} state from puller_beliefs
  is_catch_all INTEGER NOT NULL DEFAULT 0,   -- denormalized for quick filtering
  last_observation INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('belief','pattern')),
  subject_ref TEXT NOT NULL,           -- belief.id (as text) OR domain
  target_id INTEGER REFERENCES targets(id),  -- for display grouping (null for domain-level)
  attr TEXT,                           -- belief type / 'email_pattern'
  from_value TEXT,
  to_value TEXT,
  trigger_obs_id INTEGER REFERENCES observations(id),
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rev_status ON revisions(status);
CREATE INDEX IF NOT EXISTS idx_rev_target ON revisions(target_id);

CREATE TABLE IF NOT EXISTS retest_queue (
  id INTEGER PRIMARY KEY,
  target_id INTEGER REFERENCES targets(id),
  person TEXT,
  company TEXT,
  domain TEXT,
  patterns_tried TEXT,                 -- json array
  next_pattern TEXT,
  previous_attempts TEXT,              -- json array of {email, result}
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','retried','verified','patterns_exhausted','unreachable_via_pattern','error')),
  queued_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_retest_status ON retest_queue(status);

-- F4 correction loop: an append-only, REVERSIBLE log of operator (or auto-sweep) identity corrections.
-- Every merge/reassign/split records exactly what moved (moved_obs = json obs ids) so it can be undone.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY,
  op TEXT NOT NULL CHECK(op IN ('merge','reassign','split')),
  from_target INTEGER,                 -- source target (merge: absorbed; reassign/split: donor)
  into_target INTEGER,                 -- destination target
  moved_obs TEXT,                      -- json array of observation ids moved (for exact revert)
  actor TEXT,                          -- 'operator' | 'auto-sweep' | tool name
  confidence REAL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied','reverted')),
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_corr_status ON corrections(status);
CREATE INDEX IF NOT EXISTS idx_corr_from ON corrections(from_target);
`;

function init(opts = {}) {
  if (db) return db;
  const dbPath = opts.path || process.env.PULLER_DB_PATH || path.join(DATA_DIR, 'puller.db');
  if (dbPath !== ':memory:') { try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {} }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // MIGRATION: add photo columns to a pre-existing targets table (CREATE IF NOT EXISTS won't add them).
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(targets)`).all().map((c) => c.name));
    if (!cols.has('photo_url')) db.exec(`ALTER TABLE targets ADD COLUMN photo_url TEXT`);
    if (!cols.has('photo_path')) db.exec(`ALTER TABLE targets ADD COLUMN photo_path TEXT`);
    if (!cols.has('face_embedding')) db.exec(`ALTER TABLE targets ADD COLUMN face_embedding TEXT`);
    // F4: merged_into points a tombstoned (merged-away) target at its survivor; NULL = live.
    if (!cols.has('merged_into')) db.exec(`ALTER TABLE targets ADD COLUMN merged_into INTEGER`);
    // send_state MARKER: add to a pre-existing beliefs table (delivery/verify state for list-pulls + rerun).
    const bcols = new Set(db.prepare(`PRAGMA table_info(beliefs)`).all().map((c) => c.name));
    if (!bcols.has('send_state')) {
      db.exec(`ALTER TABLE beliefs ADD COLUMN send_state TEXT`);
      // one-time BACKFILL: seed the marker from each email belief's latest verification observation on its
      // HELD value, so the existing corpus (e.g. last night's delivery-log results) is immediately
      // list-pullable instead of blank until re-verified. Runs once — the guard above won't fire again.
      db.exec(`UPDATE beliefs SET send_state = (
        SELECT CASE o.kind WHEN 'verified' THEN 'verified' WHEN 'bounce' THEN 'bounced' WHEN 'accept_all' THEN 'catchall' END
        FROM observations o
        WHERE o.target_id = beliefs.target_id AND o.attr = 'email'
          AND LOWER(o.value) = LOWER(beliefs.value) AND o.kind IN ('verified','bounce','accept_all')
        ORDER BY o.captured_at DESC LIMIT 1)
        WHERE beliefs.type = 'email' AND send_state IS NULL`);
    }
    // index the marker AFTER the column is guaranteed present (fresh DB has it via SCHEMA; existing via the
    // ALTER above) — putting this in SCHEMA fails on an existing beliefs table that predates the column.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_belief_sendstate ON beliefs(type, send_state)`);
  } catch (e) { /* fresh DB already has them via SCHEMA */ }
  return db;
}
function _db() { return db || init(); }
function close() { if (db) { try { db.close(); } catch {} db = null; } }
const now = () => Date.now();
const j = (v) => (v == null ? null : JSON.stringify(v));
const pj = (s, dflt) => { if (s == null) return dflt; try { return JSON.parse(s); } catch { return dflt; } };

// ---- targets -------------------------------------------------------------------------------------

function createTarget({ kind = 'person', name, company = null, domain = null, function: fn = null,
                        priority = null, status = 'adhoc', crmId = null, notes = null } = {}) {
  if (!name) throw new Error('createTarget: name required');
  const ts = now();
  const info = _db().prepare(
    `INSERT INTO targets (kind, name, company, domain, function, priority, status, crm_id, notes, created_at, last_accessed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(kind, name, company, domain, fn, priority, status, crmId, notes, ts, ts);
  return getTarget(info.lastInsertRowid);
}
function getTarget(id) { return _db().prepare(`SELECT * FROM targets WHERE id = ?`).get(id) || null; }
function listTargets({ status = null, domain = null, limit = 200, offset = 0, includeMerged = false } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (domain) { where.push('domain = ?'); args.push(domain); }
  if (!includeMerged) where.push('merged_into IS NULL');   // F4: merged-away targets are hidden by default
  const sql = `SELECT * FROM targets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY last_accessed_at DESC LIMIT ? OFFSET ?`;
  return _db().prepare(sql).all(...args, limit, offset);
}
// Resolve a target by one of its email values (held belief first, then any observation) — the bridge
// for ingesting a vendor bounce file keyed only by email. Case-insensitive. null if no match.
function findTargetByEmail(email) {
  const e = String(email == null ? '' : email).trim().toLowerCase();
  if (!e) return null;
  const b = _db().prepare(`SELECT target_id FROM beliefs WHERE type='email' AND lower(value) = ? ORDER BY id LIMIT 1`).get(e);
  if (b) return liveTarget(b.target_id);
  const o = _db().prepare(`SELECT target_id FROM observations WHERE attr='email' AND lower(value) = ? ORDER BY id LIMIT 1`).get(e);
  return o ? liveTarget(o.target_id) : null;
}
// Follow a target's merge chain to the surviving row (so a resolver never hands back a tombstone).
function liveTarget(id, guard = 0) {
  const t = getTarget(id);
  if (!t) return null;
  if (t.merged_into != null && guard < 20) return liveTarget(t.merged_into, guard + 1);
  return t;
}

// Resolve a target by NAME — for meeting-mention → known-card resolution ("Russ" pops Russ Walker's card).
// Exact full-name first; else a UNIQUE token/prefix/suffix match (a first name → the one full name it fits).
// Ambiguous (>1 candidate) → null (bias to clarify; don't pop the wrong person). Case-insensitive.
function findTargetByName(name) {
  // strip a leading honorific ("Sen. Alexander" → "alexander") so titled mentions still resolve
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^(sen|rep|dr|mr|mrs|ms|hon|gov|rev|prof|amb|congressman|congresswoman|senator|representative)\.?\s+/i, '').trim();
  if (n.length < 2) return null;
  const rows = _db().prepare(`SELECT * FROM targets WHERE merged_into IS NULL`).all();
  let hits = rows.filter((t) => String(t.name || '').toLowerCase() === n);
  if (hits.length) return hits.length === 1 ? hits[0] : null;
  hits = rows.filter((t) => {
    const tn = String(t.name || '').toLowerCase();
    const toks = tn.split(/\s+/);
    return toks.includes(n) || tn.startsWith(n + ' ') || tn.endsWith(' ' + n);
  });
  return hits.length === 1 ? hits[0] : null;
}

// Attach an official headshot to a target: photo_url (the source URL) and/or photo_path (a local copy).
// Only sets a value when the target doesn't already have one (a CRM photo / earlier grab wins). Consume-only
// w.r.t. the CRM — this is the Puller's own discovered facet.
function setPhoto(id, { url = null, path: p = null, overwrite = false } = {}) {
  const t = getTarget(id); if (!t) return null;
  const nextUrl = (overwrite || !t.photo_url) ? (url || t.photo_url || null) : t.photo_url;
  const nextPath = (overwrite || !t.photo_path) ? (p || t.photo_path || null) : t.photo_path;
  _db().prepare(`UPDATE targets SET photo_url = ?, photo_path = ?, last_accessed_at = ? WHERE id = ?`).run(nextUrl, nextPath, now(), id);
  return getTarget(id);
}

// Cache the reference face embedding (json array) computed from the target's headshot — so the profile-
// confirmation lane doesn't re-embed the reference on every candidate check.
function setFaceEmbedding(id, embedding) {
  _db().prepare(`UPDATE targets SET face_embedding = ?, last_accessed_at = ? WHERE id = ?`).run(embedding == null ? null : j(embedding), now(), id);
  return getTarget(id);
}
function getFaceEmbedding(id) {
  const r = _db().prepare(`SELECT face_embedding FROM targets WHERE id = ?`).get(id);
  return r ? pj(r.face_embedding, null) : null;
}

// Promote an ad-hoc dossier into the CRM (records the crm row id; status → promoted).
function promoteTarget(id, crmId) {
  _db().prepare(`UPDATE targets SET status = 'promoted', crm_id = ?, last_accessed_at = ? WHERE id = ?`)
    .run(crmId, now(), id);
  return getTarget(id);
}

// ---- observations (APPEND-ONLY) ------------------------------------------------------------------

function addObservation(targetId, { attr, value = null, kind = null, source = null, sourceUrl = null,
                                    sourceDate = null, confidence = null, meta = null } = {}) {
  if (!attr) throw new Error('addObservation: attr required');
  const info = _db().prepare(
    `INSERT INTO observations (target_id, attr, value, kind, source, source_url, source_date, confidence, meta, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(targetId, attr, value, kind, source, sourceUrl, sourceDate, confidence, j(meta), now());
  return info.lastInsertRowid;
}
function _obsRow(r) { return r ? { ...r, meta: pj(r.meta, null) } : null; }
function listObservations(targetId, { attr = null } = {}) {
  const where = ['target_id = ?'], args = [targetId];
  if (attr) { where.push('attr = ?'); args.push(attr); }
  return _db().prepare(`SELECT * FROM observations WHERE ${where.join(' AND ')} ORDER BY captured_at ASC, id ASC`)
    .all(...args).map(_obsRow);
}
// BULK degree map: observation count per target, in ONE grouped query. buildPopulation (the F4 dedup
// sweep) previously called listObservations(id).length PER target — ~67k queries that each LOADED every
// observation row just to count it — which pegged the main thread for seconds every sweep. This returns a
// Map<target_id, count> in a single pass so the whole population's degrees cost one query, not 67k.
function observationCounts() {
  const m = new Map();
  for (const r of _db().prepare(`SELECT target_id, COUNT(*) c FROM observations GROUP BY target_id`).all()) m.set(r.target_id, r.c);
  return m;
}

// Per-node BLACKLIST: the set of email addresses that have BOUNCED for this target (lower-cased). The
// next-guess logic must never re-offer any of these — this is the durable "don't retry a dead address"
// record (the bounce observations already store it; this is the read the guard consults).
function failedAddresses(targetId) {
  return new Set(_db().prepare(
    `SELECT DISTINCT LOWER(value) v FROM observations WHERE target_id = ? AND kind = 'bounce' AND value LIKE '%@%'`
  ).all(targetId).map((r) => r.v));
}

// ---- beliefs (one active per (target, type)) -----------------------------------------------------

function upsertBelief(targetId, type, { value = null, confidence = null, derivation = null,
                                        supportingObs = null, status = 'active', sendState = null } = {}) {
  _db().prepare(
    `INSERT INTO beliefs (target_id, type, value, confidence, derivation, supporting_obs, status, send_state, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(target_id, type) DO UPDATE SET
       value = excluded.value, confidence = excluded.confidence, derivation = excluded.derivation,
       supporting_obs = excluded.supporting_obs, status = excluded.status,
       send_state = COALESCE(excluded.send_state, beliefs.send_state),   -- preserve the marker unless explicitly set
       updated_at = excluded.updated_at`
  ).run(targetId, type, value, confidence, derivation, j(supportingObs), status, sendState, now());
  return getBelief(targetId, type);
}
function _beliefRow(r) { return r ? { ...r, supporting_obs: pj(r.supporting_obs, []) } : null; }
function getBelief(targetId, type) {
  return _beliefRow(_db().prepare(`SELECT * FROM beliefs WHERE target_id = ? AND type = ?`).get(targetId, type));
}
// BULK belief-value map: the active value of ONE belief type across the whole population, in a single
// query (Map<target_id, value>). Same purpose as observationCounts — buildPopulation needed the 'role'
// belief per target and was doing 67k getBelief() calls. One active belief per (target,type) by schema, so
// no ambiguity. Used by the F4 dedup sweep to avoid the per-target query storm.
function beliefValuesByType(type) {
  const m = new Map();
  for (const r of _db().prepare(`SELECT target_id, value FROM beliefs WHERE type = ? AND status = 'active'`).all(type)) {
    if (!m.has(r.target_id)) m.set(r.target_id, r.value);
  }
  return m;
}
// Set ONLY the delivery/verify marker (leaves value/confidence untouched) — the single write path for
// send_state transitions (verified / bounced / rerun_pending / exhausted / catchall).
function markSendState(targetId, type, sendState) {
  _db().prepare(`UPDATE beliefs SET send_state = ?, updated_at = ? WHERE target_id = ? AND type = ?`)
    .run(sendState, now(), targetId, type);
  return getBelief(targetId, type);
}
// List-pull / rerun-batch query: live beliefs at a given send_state ('rerun_pending' = ready for the next
// verification upload; 'verified' = send-ready). sendState=null → the untagged (never-tested) tail.
function listBeliefsBySendState({ sendState = 'verified', type = 'email', limit = 5000 } = {}) {
  const pred = sendState == null ? 'b.send_state IS NULL' : 'b.send_state = ?';
  const args = sendState == null ? [type, limit] : [type, sendState, limit];
  return _db().prepare(
    `SELECT b.*, t.name AS target_name, t.company, t.domain AS target_domain, t.function
     FROM beliefs b JOIN targets t ON t.id = b.target_id
     WHERE b.type = ? AND ${pred} AND b.status = 'active' AND t.merged_into IS NULL
     ORDER BY b.confidence DESC LIMIT ?`).all(...args).map(_beliefRow);
}
function listBeliefs(targetId) {
  return _db().prepare(`SELECT * FROM beliefs WHERE target_id = ? ORDER BY type ASC`).all(targetId).map(_beliefRow);
}

// ---- pattern beliefs (bridge to studio/puller_beliefs: persists the pure state json) -------------

function getPatternState(domain) {
  const r = _db().prepare(`SELECT state_json FROM pattern_beliefs WHERE domain = ?`).get(domain);
  return r ? pj(r.state_json, { patterns: {}, is_catch_all: false }) : { patterns: {}, is_catch_all: false };
}
function savePatternState(domain, state) {
  const isCatch = state && state.is_catch_all ? 1 : 0;
  const ts = now();
  _db().prepare(
    `INSERT INTO pattern_beliefs (domain, state_json, is_catch_all, last_observation, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET
       state_json = excluded.state_json, is_catch_all = excluded.is_catch_all,
       last_observation = excluded.last_observation, updated_at = excluded.updated_at`
  ).run(domain, j(state || { patterns: {}, is_catch_all: false }), isCatch, ts, ts);
  return getPatternState(domain);
}

// ---- revisions (the propose → approve gate) ------------------------------------------------------

function proposeRevision({ subjectKind, subjectRef, targetId = null, attr = null, fromValue = null,
                           toValue = null, triggerObsId = null, rationale = null } = {}) {
  if (!subjectKind || subjectRef == null) throw new Error('proposeRevision: subjectKind + subjectRef required');
  const info = _db().prepare(
    `INSERT INTO revisions (subject_kind, subject_ref, target_id, attr, from_value, to_value, trigger_obs_id, rationale, status, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`
  ).run(subjectKind, String(subjectRef), targetId, attr, fromValue, toValue, triggerObsId, rationale, now());
  return info.lastInsertRowid;
}
function decideRevision(id, decision) {
  if (decision !== 'accepted' && decision !== 'rejected') throw new Error(`decideRevision: bad decision ${decision}`);
  _db().prepare(`UPDATE revisions SET status = ?, decided_at = ? WHERE id = ?`).run(decision, now(), id);
  return _db().prepare(`SELECT * FROM revisions WHERE id = ?`).get(id) || null;
}
function listRevisions({ status = 'pending', targetId = null } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (targetId != null) { where.push('target_id = ?'); args.push(targetId); }
  return _db().prepare(`SELECT * FROM revisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`)
    .all(...args);
}

// ---- retest queue (§4.5) -------------------------------------------------------------------------

function enqueueRetest({ targetId = null, person = null, company = null, domain = null,
                         patternsTried = [], nextPattern = null, previousAttempts = [] } = {}) {
  const info = _db().prepare(
    `INSERT INTO retest_queue (target_id, person, company, domain, patterns_tried, next_pattern, previous_attempts, status, queued_at)
     VALUES (?,?,?,?,?,?,?, 'queued', ?)`
  ).run(targetId, person, company, domain, j(patternsTried), nextPattern, j(previousAttempts), now());
  return info.lastInsertRowid;
}
function _retestRow(r) {
  return r ? { ...r, patterns_tried: pj(r.patterns_tried, []), previous_attempts: pj(r.previous_attempts, []) } : null;
}
function listRetests({ status = 'queued', limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  return _db().prepare(`SELECT * FROM retest_queue ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                        ORDER BY queued_at ASC LIMIT ?`).all(...args, limit).map(_retestRow);
}
function updateRetest(id, { status = null, patternsTried = null, nextPattern = null, previousAttempts = null } = {}) {
  const sets = [], args = [];
  if (status !== null) { sets.push('status = ?'); args.push(status); }
  if (patternsTried !== null) { sets.push('patterns_tried = ?'); args.push(j(patternsTried)); }
  if (nextPattern !== null) { sets.push('next_pattern = ?'); args.push(nextPattern); }
  if (previousAttempts !== null) { sets.push('previous_attempts = ?'); args.push(j(previousAttempts)); }
  if (!sets.length) return null;
  sets.push('updated_at = ?'); args.push(now());
  _db().prepare(`UPDATE retest_queue SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return _retestRow(_db().prepare(`SELECT * FROM retest_queue WHERE id = ?`).get(id));
}

// ---- corrections (F4: reversible identity fixes — merge / reassign / split) ----------------------

function _logCorrection({ op, fromTarget = null, intoTarget = null, movedObs = [], actor = 'operator',
                         confidence = null, reason = null }) {
  const info = _db().prepare(
    `INSERT INTO corrections (op, from_target, into_target, moved_obs, actor, confidence, reason, status, created_at)
     VALUES (?,?,?,?,?,?,?, 'applied', ?)`
  ).run(op, fromTarget, intoTarget, j(movedObs), actor, confidence, reason, now());
  return info.lastInsertRowid;
}
function getCorrection(id) {
  const r = _db().prepare(`SELECT * FROM corrections WHERE id = ?`).get(id);
  return r ? { ...r, moved_obs: pj(r.moved_obs, []) } : null;
}

// A cheap high-water fingerprint of the store: MAX(targets.id):MAX(observations.id). Advances on any new
// target or observation, so a write-triggered dedup tick can skip the O(n²) sweep when nothing changed
// (mirrors Echo's civic_fingerprint gate). Instant — two indexed MAX() reads.
function storeFingerprint() {
  const t = _db().prepare(`SELECT MAX(id) m FROM targets`).get();
  const o = _db().prepare(`SELECT MAX(id) m FROM observations`).get();
  return `${(t && t.m) || 0}:${(o && o.m) || 0}`;
}
function listCorrections({ status = null, limit = 200 } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  return _db().prepare(`SELECT * FROM corrections ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                        ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
    .map(r => ({ ...r, moved_obs: pj(r.moved_obs, []) }));
}

// Merge `fromId` INTO `intoId`: move every observation, adopt any belief the survivor lacks (or that the
// donor holds at higher confidence), then tombstone the donor (merged_into = survivor). Fully reversible
// via unmergeTarget — the correction row records exactly which observations moved.
function mergeTarget(fromId, intoId, { actor = 'operator', confidence = null, reason = null } = {}) {
  if (fromId === intoId) throw new Error('mergeTarget: cannot merge a target into itself');
  const from = getTarget(fromId), into = getTarget(intoId);
  if (!from || !into) throw new Error('mergeTarget: both targets must exist');
  if (from.merged_into != null) throw new Error('mergeTarget: source already merged');
  const tx = _db().transaction(() => {
    const obs = _db().prepare(`SELECT id FROM observations WHERE target_id = ?`).all(fromId).map(r => r.id);
    for (const oid of obs) _db().prepare(`UPDATE observations SET target_id = ? WHERE id = ?`).run(intoId, oid);
    // adopt donor beliefs the survivor is missing or holds weaker
    for (const b of listBeliefs(fromId)) {
      const cur = getBelief(intoId, b.type);
      if (!cur || (Number(b.confidence) || 0) > (Number(cur.confidence) || 0)) {
        upsertBelief(intoId, b.type, { value: b.value, confidence: b.confidence,
          derivation: `merged-from:${fromId}`, supportingObs: b.supporting_obs, status: 'active' });
      }
    }
    _db().prepare(`UPDATE targets SET merged_into = ?, last_accessed_at = ? WHERE id = ?`).run(intoId, now(), fromId);
    return _logCorrection({ op: 'merge', fromTarget: fromId, intoTarget: intoId, movedObs: obs, actor, confidence, reason });
  });
  const correctionId = tx();
  return { correctionId, movedObs: getCorrection(correctionId).moved_obs.length, into: getTarget(intoId) };
}

// Undo any correction: move its recorded observations back to the donor and un-tombstone (merge), or back
// to the source (reassign/split). Belief edits are left as-is (append-only history); the identity linkage
// — which is what corrupts recall — is what gets restored.
function unmergeTarget(correctionId) {
  const c = getCorrection(correctionId);
  if (!c || c.status !== 'applied') return null;
  const tx = _db().transaction(() => {
    const back = c.op === 'split' ? c.from_target : c.from_target;   // observations always return to from_target
    for (const oid of (c.moved_obs || [])) _db().prepare(`UPDATE observations SET target_id = ? WHERE id = ?`).run(back, oid);
    if (c.op === 'merge') _db().prepare(`UPDATE targets SET merged_into = NULL, last_accessed_at = ? WHERE id = ?`).run(now(), c.from_target);
    _db().prepare(`UPDATE corrections SET status = 'reverted', reverted_at = ? WHERE id = ?`).run(now(), correctionId);
  });
  tx();
  return { reverted: correctionId, op: c.op, restored: (c.moved_obs || []).length };
}

// Reassign ONE observation to another target (operator: "this evidence belongs to a different person").
function reassignObservation(obsId, toTargetId, { actor = 'operator', reason = null } = {}) {
  const o = _db().prepare(`SELECT * FROM observations WHERE id = ?`).get(obsId);
  if (!o) throw new Error('reassignObservation: no such observation');
  if (!getTarget(toTargetId)) throw new Error('reassignObservation: destination target missing');
  const fromId = o.target_id;
  _db().prepare(`UPDATE observations SET target_id = ? WHERE id = ?`).run(toTargetId, obsId);
  const correctionId = _logCorrection({ op: 'reassign', fromTarget: fromId, intoTarget: toTargetId, movedObs: [obsId], actor, reason });
  return { correctionId, from: fromId, to: toTargetId };
}

// Split: pull a subset of observations off `fromId` into a NEW target (operator: "this attractor is really
// two people"). Creates the new target and moves the given observations to it; reversible.
function splitTarget(fromId, { obsIds = [], name, company = null, domain = null, actor = 'operator', reason = null } = {}) {
  const from = getTarget(fromId);
  if (!from) throw new Error('splitTarget: source missing');
  if (!name) throw new Error('splitTarget: new target name required');
  if (!Array.isArray(obsIds) || !obsIds.length) throw new Error('splitTarget: obsIds required');
  const tx = _db().transaction(() => {
    const t = createTarget({ kind: from.kind, name, company: company || from.company, domain: domain || from.domain });
    const moved = [];
    for (const oid of obsIds) {
      const o = _db().prepare(`SELECT target_id FROM observations WHERE id = ?`).get(oid);
      if (o && o.target_id === fromId) { _db().prepare(`UPDATE observations SET target_id = ? WHERE id = ?`).run(t.id, oid); moved.push(oid); }
    }
    const correctionId = _logCorrection({ op: 'split', fromTarget: fromId, intoTarget: t.id, movedObs: moved, actor, reason });
    return { correctionId, newTargetId: t.id, moved: moved.length };
  });
  return tx();
}

module.exports = {
  init, close,
  createTarget, getTarget, liveTarget, listTargets, promoteTarget, setPhoto, setFaceEmbedding, getFaceEmbedding, findTargetByEmail, findTargetByName,
  addObservation, listObservations, observationCounts, failedAddresses,
  upsertBelief, getBelief, beliefValuesByType, listBeliefs, markSendState, listBeliefsBySendState,
  getPatternState, savePatternState,
  proposeRevision, decideRevision, listRevisions,
  enqueueRetest, listRetests, updateRetest,
  mergeTarget, unmergeTarget, reassignObservation, splitTarget, getCorrection, listCorrections, storeFingerprint,
};
