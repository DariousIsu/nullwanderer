/**
 * lib/editor_registry.js — the Editor Studio's document registry + lifecycle log (B1).
 *
 * A THIN Zoe-side index over documents that flow through the Editor pipeline. It does NOT
 * store document content or duplicate Echo: Echo's `documents` table owns the content
 * (title/path/markdown/frontmatter) and `skuld.verification_session` owns the QA + cert spine
 * (status machine, parent_session_id re-audit chain, author_name, certificate_doc_path,
 * findings). This layer adds ONLY what Echo lacks for View A + the bounded lifecycle:
 *   - pipeline membership (which docs entered through the studio — a lens, not a silo),
 *   - the 3-state PUBLICATION lifecycle (in-process → certified → published) + close-out,
 *   - editor `last_accessed` (View A recency default),
 *   - the author-tagged ITERATION log (version chain; doc author is immutable, change_author isn't),
 *   - the canonical CFC cert registry (CFC-YYYY-MM-DD-<rev>, parent chain), and
 *   - a thin check-run POINTER/cache to verification_session ids (for index display).
 *
 * Backed by its OWN sqlite file (data/editor.db) — isolated from sq.db (no contention with the
 * live Electron app) and from Echo (no repo edits). EDITOR_DB_PATH overrides for smokes.
 * References Echo rows by id/path only.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');

let db = null;

const STATUSES = ['in-process', 'certified', 'published'];
// Allowed forward (or idempotent) publication transitions. The QA state machine lives in Echo's
// verification_session; this is only the publication lifecycle the studio owns.
const STATUS_RANK = { 'in-process': 0, 'certified': 1, 'published': 2 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_documents (
  id INTEGER PRIMARY KEY,
  echo_doc_id INTEGER,                 -- ref Echo documents.id (null until ingested / native-only)
  echo_doc_path TEXT,
  title TEXT NOT NULL,
  author TEXT,                         -- IMMUTABLE after register (enforced in code)
  project TEXT,
  doc_type TEXT,
  topics TEXT,                         -- json array, cached from Echo subject tags (View A facets)
  status TEXT NOT NULL DEFAULT 'in-process' CHECK(status IN ('in-process','certified','published')),
  current_version INTEGER NOT NULL DEFAULT 1,
  cert_number TEXT,                    -- latest cert (full history in certificates)
  public_copy_ref TEXT,                -- url OR file path, set at close-out (published)
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pipe_status ON pipeline_documents(status);
CREATE INDEX IF NOT EXISTS idx_pipe_accessed ON pipeline_documents(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_pipe_echo ON pipeline_documents(echo_doc_id);

CREATE TABLE IF NOT EXISTS iterations (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES pipeline_documents(id),
  version INTEGER NOT NULL,
  change_author TEXT,                  -- who made THIS change (may differ from the immutable doc author)
  source TEXT NOT NULL DEFAULT 'edit' CHECK(source IN ('native','upload','edit')),
  change_summary TEXT,
  content_ref TEXT,                    -- pointer to the working copy / Echo doc version
  created_at INTEGER NOT NULL,
  UNIQUE(doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_iter_doc ON iterations(doc_id, version);

CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES pipeline_documents(id),
  version INTEGER NOT NULL,
  verification_session_id TEXT,        -- ref skuld.verification_session.session_id (authoritative)
  tier TEXT,
  model TEXT,
  status TEXT,                         -- cached from the session for index display
  findings_count INTEGER DEFAULT 0,
  resolved_count INTEGER DEFAULT 0,
  report_ref TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_check_doc ON check_runs(doc_id);
CREATE INDEX IF NOT EXISTS idx_check_session ON check_runs(verification_session_id);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES pipeline_documents(id),
  cert_number TEXT NOT NULL UNIQUE,    -- CFC-YYYY-MM-DD-<rev>
  parent_cert_id INTEGER REFERENCES certificates(id),  -- re-audits point at the parent cert
  verification_session_id TEXT,
  check_run_id INTEGER REFERENCES check_runs(id),
  grade TEXT,
  scoreline TEXT,
  cert_doc_ref TEXT,                   -- Echo certificate_doc_path
  issued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cert_doc ON certificates(doc_id);
`;

function init(opts = {}) {
  if (db) return db;
  const dbPath = opts.path || process.env.EDITOR_DB_PATH || path.join(DATA_DIR, 'editor.db');
  if (dbPath !== ':memory:') { try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {} }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
function _db() { return db || init(); }
function close() { if (db) { try { db.close(); } catch {} db = null; } }
const now = () => Date.now();

// Access/activity timestamp that is STRICTLY greater than the current max, so an accessed or
// just-edited doc always floats to the top of the recency index even when several actions land
// inside one clock millisecond (View A's default order depends on this being monotonic).
function nextAccessTs() {
  const m = _db().prepare(`SELECT MAX(last_accessed_at) AS m FROM pipeline_documents`).get();
  return Math.max(now(), (m && m.m ? m.m : 0) + 1);
}

// ---- pure helpers (cert-number formatting; issuance algorithm itself is B4) ----

// CFC-YYYY-MM-DD-<rev>. rev is a zero-padded daily sequence (collision-free, sortable).
function formatCertNumber(dateStr, seq) {
  return `CFC-${dateStr}-${String(seq).padStart(2, '0')}`;
}
// Derive the YYYY-MM-DD stamp from an epoch-ms value (UTC-stable for deterministic tests).
function dateStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- registry / lifecycle ----

// Register a document into the Editor pipeline (status in-process) + open its iteration chain at v1.
// Author is captured here and treated as IMMUTABLE — there is no setter that changes it.
function registerDocument({ echoDocId = null, echoDocPath = null, title, author = null, project = null,
                            docType = null, topics = null, source = 'upload', changeAuthor = null,
                            changeSummary = 'initial import', contentRef = null } = {}) {
  if (!title) throw new Error('registerDocument: title required');
  const ts = now();
  const d = _db();
  const tx = d.transaction(() => {
    const info = d.prepare(
      `INSERT INTO pipeline_documents (echo_doc_id, echo_doc_path, title, author, project, doc_type, topics, status, current_version, created_at, last_accessed_at)
       VALUES (?,?,?,?,?,?,?, 'in-process', 1, ?, ?)`
    ).run(echoDocId, echoDocPath, title, author, project, docType, topics ? JSON.stringify(topics) : null, ts, ts);
    const docId = info.lastInsertRowid;
    d.prepare(
      `INSERT INTO iterations (doc_id, version, change_author, source, change_summary, content_ref, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`
    ).run(docId, changeAuthor || author, source, changeSummary, contentRef, ts);
    return docId;
  });
  return getDocument(tx());
}

function _row(r) {
  if (!r) return null;
  return { ...r, topics: r.topics ? safeParse(r.topics) : [] };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return []; } }

function getDocument(id) {
  return _row(_db().prepare(`SELECT * FROM pipeline_documents WHERE id = ?`).get(id));
}
function getByEchoDocId(echoDocId) {
  return _row(_db().prepare(`SELECT * FROM pipeline_documents WHERE echo_doc_id = ? ORDER BY id DESC LIMIT 1`).get(echoDocId));
}

// View A index. Default order = last-accessed desc (recency). Sortable columns + filter facets.
// Full-text search rides Echo's FTS (scoped to pipeline docs) — here we only do simple column filters.
const SORTABLE = { title: 'title', author: 'author', cert: 'cert_number', version: 'current_version',
                   accessed: 'last_accessed_at', status: 'status', created: 'created_at' };
function listDocuments({ status = null, author = null, topic = null, titleLike = null,
                         sort = 'accessed', dir = 'desc', limit = 100, offset = 0 } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (author) { where.push('author = ?'); args.push(author); }
  if (titleLike) { where.push('title LIKE ?'); args.push(`%${titleLike}%`); }
  if (topic) { where.push('topics LIKE ?'); args.push(`%${JSON.stringify(topic).slice(1, -1)}%`); } // crude facet over the cached json
  const col = SORTABLE[sort] || 'last_accessed_at';
  const ord = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sql = `SELECT * FROM pipeline_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${col} ${ord} LIMIT ? OFFSET ?`;
  return _db().prepare(sql).all(...args, limit, offset).map(_row);
}

function touchAccessed(docId) {
  _db().prepare(`UPDATE pipeline_documents SET last_accessed_at = ? WHERE id = ?`).run(nextAccessTs(), docId);
  return getDocument(docId);
}

// Append a new iteration (a correction pass / re-import). Bumps current_version. The document's
// AUTHOR never changes; change_author records who made this revision.
function addIteration(docId, { changeAuthor = null, source = 'edit', changeSummary = null, contentRef = null } = {}) {
  const d = _db();
  const doc = getDocument(docId);
  if (!doc) throw new Error(`addIteration: no document ${docId}`);
  const ts = now();
  const version = doc.current_version + 1;
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO iterations (doc_id, version, change_author, source, change_summary, content_ref, created_at)
               VALUES (?,?,?,?,?,?,?)`).run(docId, version, changeAuthor, source, changeSummary, contentRef, ts);
    d.prepare(`UPDATE pipeline_documents SET current_version = ?, last_accessed_at = ? WHERE id = ?`).run(version, nextAccessTs(), docId);
  });
  tx();
  return { version };
}
function listIterations(docId) {
  return _db().prepare(`SELECT * FROM iterations WHERE doc_id = ? ORDER BY version ASC`).all(docId);
}

// Record a check-run pointer to an Echo verification_session (authoritative state stays in skuld).
function recordCheckRun(docId, { verificationSessionId = null, tier = null, model = null, status = null,
                                 findingsCount = 0, resolvedCount = 0, reportRef = null, version = null } = {}) {
  const doc = getDocument(docId);
  if (!doc) throw new Error(`recordCheckRun: no document ${docId}`);
  const info = _db().prepare(
    `INSERT INTO check_runs (doc_id, version, verification_session_id, tier, model, status, findings_count, resolved_count, report_ref, started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(docId, version || doc.current_version, verificationSessionId, tier, model, status, findingsCount, resolvedCount, reportRef, now());
  return info.lastInsertRowid;
}
function updateCheckRun(id, { status = null, findingsCount = null, resolvedCount = null, reportRef = null, finished = false } = {}) {
  const sets = [], args = [];
  if (status !== null) { sets.push('status = ?'); args.push(status); }
  if (findingsCount !== null) { sets.push('findings_count = ?'); args.push(findingsCount); }
  if (resolvedCount !== null) { sets.push('resolved_count = ?'); args.push(resolvedCount); }
  if (reportRef !== null) { sets.push('report_ref = ?'); args.push(reportRef); }
  if (finished) { sets.push('finished_at = ?'); args.push(now()); }
  if (!sets.length) return;
  _db().prepare(`UPDATE check_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}
function latestCheckRun(docId) {
  return _db().prepare(`SELECT * FROM check_runs WHERE doc_id = ? ORDER BY id DESC LIMIT 1`).get(docId);
}

// Publication lifecycle. Forward-or-idempotent only (no regressing published→in-process).
function setStatus(docId, status) {
  if (!STATUSES.includes(status)) throw new Error(`setStatus: bad status ${status}`);
  const doc = getDocument(docId);
  if (!doc) throw new Error(`setStatus: no document ${docId}`);
  if (STATUS_RANK[status] < STATUS_RANK[doc.status]) {
    throw new Error(`setStatus: cannot regress ${doc.status} → ${status}`);
  }
  _db().prepare(`UPDATE pipeline_documents SET status = ?, last_accessed_at = ? WHERE id = ?`).run(status, nextAccessTs(), docId);
  return getDocument(docId);
}

// Attach a certificate (re-audits pass parentCertId). Sets the doc's cert_number + → 'certified'.
function attachCertificate(docId, { certNumber, parentCertId = null, verificationSessionId = null,
                                    checkRunId = null, grade = null, scoreline = null, certDocRef = null } = {}) {
  if (!certNumber) throw new Error('attachCertificate: certNumber required');
  const d = _db();
  const tx = d.transaction(() => {
    const info = d.prepare(
      `INSERT INTO certificates (doc_id, cert_number, parent_cert_id, verification_session_id, check_run_id, grade, scoreline, cert_doc_ref, issued_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(docId, certNumber, parentCertId, verificationSessionId, checkRunId, grade, scoreline, certDocRef, now());
    const doc = getDocument(docId);
    const newStatus = STATUS_RANK['certified'] > STATUS_RANK[doc.status] ? 'certified' : doc.status;
    d.prepare(`UPDATE pipeline_documents SET cert_number = ?, status = ?, last_accessed_at = ? WHERE id = ?`)
      .run(certNumber, newStatus, nextAccessTs(), docId);
    return info.lastInsertRowid;
  });
  return tx();
}
function listCertificates(docId) {
  return _db().prepare(`SELECT * FROM certificates WHERE doc_id = ? ORDER BY issued_at ASC`).all(docId);
}

// Close-out: mark actually-published, record the public copy (url or file). Terminal state.
function closeOut(docId, { publicCopyRef = null } = {}) {
  const doc = getDocument(docId);
  if (!doc) throw new Error(`closeOut: no document ${docId}`);
  const ts = now();
  _db().prepare(`UPDATE pipeline_documents SET status = 'published', published_at = ?, public_copy_ref = ?, last_accessed_at = ? WHERE id = ?`)
    .run(ts, publicCopyRef, nextAccessTs(), docId);
  return getDocument(docId);
}

module.exports = {
  init, close, STATUSES,
  registerDocument, getDocument, getByEchoDocId, listDocuments, touchAccessed,
  addIteration, listIterations,
  recordCheckRun, updateCheckRun, latestCheckRun,
  setStatus, attachCertificate, listCertificates, closeOut,
  // pure helpers
  formatCertNumber, dateStamp,
};
