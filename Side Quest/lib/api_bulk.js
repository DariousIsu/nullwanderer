/*
 * lib/api_bulk.js — the API stream's BULK-PULL mode (large paginated corpora → memory objects).
 *
 * Snapshots (lib/api_stream) are one small call for a latest value. BULK is the other shape Lucas earmarked
 * ("bulk data updates on things like wikipedia, legislation, and court rulings"): large, paginated, INCREMENTAL.
 * This is the first slice — LEGISLATION via Echo's legiscan_* domain tools (which already handle auth + the
 * LegiScan API), orchestrated + landed here. It generalizes: a "source" is just a discover→list→detail→land
 * shape; court rulings (courtlistener_*) and Wikipedia (mediawiki_*) slot in as more sources later.
 *
 * INCREMENTAL by construction (no re-processing unchanged data):
 *   • session level — legiscan carries a `session_hash`; a session whose hash is unchanged is skipped entirely.
 *   • bill level    — each bill carries a `change_hash`; only a new/changed bill is (re)landed.
 * RESUMABLE — bounded `billLimit` per pass; a session truncated by the cap keeps its old stored hash so the
 *   next pass re-enters it and continues (already-landed bills skip via change_hash). Legislation moves slowly,
 *   so the scheduler cadence is conservative.
 *
 * Landed bills ride the SAME promotion rail as news/api docs (doc_store.land → promoteDocumentsPass →
 * extract_entities_from_doc) so a bill becomes connected memory objects. Own bulk state tables live in the
 * isolated data/api_stream.db (via api_store). Deps (dispatch/landDoc/now) injected → offline-testable.
 */
'use strict';
const store = require('./api_store');

// Hard-coded job set (Lucas: start everything hard-coded). One legiscan job per state; states via env, small
// default so the first backfill is bounded. Adding a state = one more entry; adding a SOURCE = a new job kind.
const STATES = String(process.env.LEGISCAN_STATES || 'FL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
function jobs() { return STATES.map((st) => ({ id: `legiscan:${st}`, source: 'legiscan', state: st })); }

// LegiScan bill status codes → labels (for the readable evidence doc).
const STATUS = { 0: 'Prefiled', 1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Passed', 5: 'Vetoed', 6: 'Failed' };
const statusLabel = (s) => STATUS[Number(s)] || `status ${s}`;

// --- bulk state schema (own tables in the shared isolated api_stream.db) ---
let _ready = false;
function ensureBulkSchema() {
  store.ensureSchema();   // opens the DB + its own tables
  if (_ready) return;
  store.get().exec(`
    CREATE TABLE IF NOT EXISTS bulk_sessions (
      job_id       TEXT NOT NULL,
      session_id   INTEGER NOT NULL,
      session_hash TEXT,                 -- last hash we FULLY drained (unchanged → skip the whole session)
      ts           INTEGER,
      PRIMARY KEY (job_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS bulk_records (
      job_id       TEXT NOT NULL,
      record_id    TEXT NOT NULL,        -- e.g. legiscan:<bill_id>
      source       TEXT,
      change_hash  TEXT,                 -- the source's change token for this record
      landed_hash  TEXT,                 -- change_hash last LANDED into memory (== change_hash ⇒ up to date)
      title        TEXT,
      ts           INTEGER,
      PRIMARY KEY (job_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_records_job ON bulk_records(job_id);
  `);
  _ready = true;
}

// --- state accessors ---
function storedSessionHashes(jobId) {
  ensureBulkSchema();
  const out = {};
  for (const r of store.get().prepare('SELECT session_id, session_hash FROM bulk_sessions WHERE job_id = ?').all(jobId)) out[r.session_id] = r.session_hash;
  return out;
}
function putSession(jobId, sessionId, sessionHash, ts) {
  ensureBulkSchema();
  store.get().prepare('INSERT INTO bulk_sessions (job_id, session_id, session_hash, ts) VALUES (@j,@s,@h,@t) ON CONFLICT(job_id, session_id) DO UPDATE SET session_hash=@h, ts=@t')
    .run({ j: jobId, s: sessionId, h: sessionHash || null, t: ts });
}
function getRecord(jobId, recordId) {
  ensureBulkSchema();
  return store.get().prepare('SELECT * FROM bulk_records WHERE job_id = ? AND record_id = ?').get(jobId, recordId) || null;
}
function putRecord(jobId, recordId, source, changeHash, landedHash, title, ts) {
  ensureBulkSchema();
  store.get().prepare('INSERT INTO bulk_records (job_id, record_id, source, change_hash, landed_hash, title, ts) VALUES (@j,@r,@src,@c,@l,@t,@ts) ON CONFLICT(job_id, record_id) DO UPDATE SET change_hash=@c, landed_hash=@l, title=@t, ts=@ts')
    .run({ j: jobId, r: recordId, src: source, c: changeHash || null, l: landedHash || null, t: title || null, ts });
}
function countRecords(jobId) { ensureBulkSchema(); return store.get().prepare('SELECT COUNT(*) n FROM bulk_records WHERE job_id = ?').get(jobId).n; }

// --- PURE ---
// Sessions worth processing: recent-enough (year_end/start >= minYear) AND whose hash changed since we last
// fully drained them. Newest first (active legislation leads). `storedMap` = session_id → last drained hash.
function sessionsToProcess(sessions, storedMap = {}, { minYear = 0 } = {}) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => {
      const yr = Number(s.year_end) || Number(s.year_start) || 0;
      if (yr < minYear) return false;
      const h = s.session_hash || s.dataset_hash || '';
      return storedMap[s.session_id] !== h;               // unchanged (already drained) → skip
    })
    .sort((a, b) => (Number(b.year_start) || 0) - (Number(a.year_start) || 0));
}

// A bill's markdown evidence doc → the promotion rail extracts objects (sponsors/subjects) from real text.
function buildBillDoc(bill, job) {
  return `# ${bill.number || 'Bill'} — ${bill.title || '(untitled)'}\n\n` +
    `**State:** ${job.state}  \n**Status:** ${statusLabel(bill.status)}  \n` +
    `**Last action:** ${bill.last_action || ''}${bill.last_action_date ? ` (${bill.last_action_date})` : ''}  \n` +
    `**LegiScan:** ${bill.url || ''}\n\n${bill.description || ''}`.trim();
}

// Call an Echo domain tool through the injected dispatch → parsed JSON (or null). Fail-soft.
async function callTool(dispatch, name, args) {
  if (typeof dispatch !== 'function') return null;
  try {
    const r = await dispatch({ kind: 'do', name, args });
    if (!r || !r.ok) return null;
    try { return JSON.parse(r.text); } catch { return null; }
  } catch { return null; }
}

// Run ONE bulk job: discover sessions → for each changed session, list bills → land each new/changed bill
// (bounded by billLimit; a truncated session is NOT marked drained so it resumes next pass). Returns a summary.
async function runBulk(job, { dispatch, landDoc, now = Date.now(), sessionLimit = 6, billLimit = 50, minYear = null, log } = {}) {
  ensureBulkSchema();
  const res = { jobId: job.id, sessions: 0, billsSeen: 0, landed: 0, truncated: false };
  if (typeof dispatch !== 'function') return res;
  const yr = minYear != null ? minYear : new Date(now).getFullYear();

  const sess = await callTool(dispatch, 'legiscan_session_list', { state: job.state });
  const stored = storedSessionHashes(job.id);
  const todo = sessionsToProcess((sess && sess.sessions) || [], stored, { minYear: yr }).slice(0, sessionLimit);

  for (const s of todo) {
    const ml = await callTool(dispatch, 'legiscan_master_list', { session_id: s.session_id });
    const bills = (ml && ml.bills) || [];
    let sessionDone = true;
    for (const b of bills) {
      res.billsSeen++;
      const rid = `legiscan:${b.bill_id}`;
      const prev = getRecord(job.id, rid);
      if (prev && prev.landed_hash && prev.landed_hash === b.change_hash) continue;   // unchanged → skip
      if (res.landed >= billLimit) { sessionDone = false; res.truncated = true; break; }   // bounded; resume next pass
      if (typeof landDoc === 'function') {
        try {
          await landDoc({ title: `Bill — ${b.number}: ${b.title}`.slice(0, 120), body: buildBillDoc(b, job), source: 'legislation', ref: `bill:${rid}`, understanding: b.description || b.title || '' });
          putRecord(job.id, rid, 'legiscan', b.change_hash, b.change_hash, b.title, now);
          res.landed++;
        } catch (e) { log && log(`[bulk:${job.id}] land failed ${rid}: ${e && e.message}`); }
      }
    }
    if (sessionDone) { putSession(job.id, s.session_id, s.session_hash || s.dataset_hash, now); res.sessions++; }
    else break;   // hit the per-pass cap mid-session → stop; this session re-enters next pass
  }
  if (log) log(`[bulk:${job.id}] ${res.sessions} sessions drained, ${res.billsSeen} bills seen, ${res.landed} landed${res.truncated ? ' (capped — resumes next pass)' : ''}`);
  return res;
}

// Run every configured bulk job (the scheduler tick). Conservative: legislation moves slowly.
async function runDueBulk({ dispatch, landDoc, now = Date.now(), billLimit = 50, log } = {}) {
  const out = [];
  for (const job of jobs()) out.push(await runBulk(job, { dispatch, landDoc, now, billLimit, log }));
  return out;
}

module.exports = {
  jobs, statusLabel, ensureBulkSchema,
  storedSessionHashes, putSession, getRecord, putRecord, countRecords,
  sessionsToProcess, buildBillDoc, callTool, runBulk, runDueBulk,
};
