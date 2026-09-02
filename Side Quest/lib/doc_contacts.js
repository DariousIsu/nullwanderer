/* lib/doc_contacts.js — make her OWN RESEARCH reachable by the contacts query.
 *
 * The failure this closes, measured live (2026-07-20). Lucas asked her to finish the Louisiana parish
 * rosters. She answered:
 *
 *     "I checked our records and searched, but I couldn't pin down specific organization and leadership
 *      contact information for those rosters just yet. I can go ahead and pull that data together for
 *      you now if you'd like."
 *
 * She was offering to go research what she already held. The `documents` table carried 390 parish-context
 * documents containing 1,468 individual addresses on gov/parish domains — pgovernale@stmaryparishla.gov,
 * tweaver@caddo.org, mnewcomb@rppj.com. gatherHeldContacts reads Puller and CRM and then returns; the
 * research corpus was structurally invisible to it. The data was never missing, only unreachable.
 *
 * This is the store + lane between the two. Extraction itself is lib/contact_extract.js (already built,
 * already refuses to invent an email); this module decides WHAT to scan, keeps the provenance, and hands
 * the contacts query a shape it already understands.
 *
 * ── DISCIPLINES ────────────────────────────────────────────────────────────────────────────────
 *
 * CITED OR NOTHING. Every row carries the document id it came from. These contacts are EXTRACTED, not
 * verified — an unsourced one could never be checked, and would be indistinguishable from a CRM record
 * that someone actually confirmed. They rank below both existing sources for that reason.
 *
 * ONE ROW PER PERSON PER DOCUMENT. The same official in three documents is three citations of one fact.
 * Collapsing at write time would discard corroboration, so the store keeps them and `search()` folds
 * them, reporting how many documents agreed.
 *
 * SCAN LEDGER, NOT A RESCAN. Extraction is a model call per ~6k chunk; blindly re-running a 6,593-document
 * corpus is the expensive mistake. A document is scanned once per version — its own updated_ts is the key,
 * so an edited document re-extracts and an unchanged one never does.
 *
 * STATE IS INFERRED ONLY WHEN THE DOCUMENT SAYS SO. The contacts query filters by state, and a wrong state
 * silently drops a real contact out of a filtered answer (or worse, files a Louisiana official under Texas).
 * So: exactly one US state named in the document → use it; zero or several → null, and the contact simply
 * doesn't match a state filter. An honest null loses a filter; a guess corrupts the record.
 */
'use strict';

let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

// Full state names + the postal codes, for the single-state inference below. Codes are matched only in
// isolation (word-boundaried, upper-case) so "IN", "OR", "ME", "OK" as ordinary words don't register.
const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
// Longest first so "West Virginia" is consumed before "Virginia" can match inside it — the same trap
// that beats.findBeatsInText hit.
const STATE_NAMES_DESC = Object.entries(STATES).sort((a, b) => b[1].length - a[1].length);

// The single US state this text is about, or null. Requires unanimity: several states named means we
// cannot attribute a contact to one of them, and guessing would file an official under the wrong state.
function inferState(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  let scan = t;
  const found = new Set();
  for (const [code, name] of STATE_NAMES_DESC) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig');
    if (re.test(scan)) { found.add(code); scan = scan.replace(new RegExp(re.source, 'ig'), ' '); }
    if (found.size > 1) return null;
  }
  // Postal codes only in address position (", LA 70501" / ", LA."), never as a bare word — "IN", "OR",
  // "ME" and "OK" are ordinary English and would otherwise match constantly.
  for (const code of Object.keys(STATES)) {
    if (new RegExp(`,\\s*${code}\\b(?=[\\s.,]|\\s*\\d{5})`, 'g').test(t)) { found.add(code); if (found.size > 1) return null; }
  }
  return found.size === 1 ? [...found][0] : null;
}

// THE STATE, FROM PROVENANCE RATHER THAN PROSE. A research document records where it came from:
// `ref` is "directed-<focusId>", and that focus carries the beat it was seeded from
// ("county-commissions-la"), whose suffix is the state. That is what the run was ACTUALLY researching —
// far stronger than counting state names in the text, which returns null the moment a Louisiana roster
// happens to mention a neighbouring state. Falls back to the text scan for documents with no research
// provenance (dropped PDFs, emails), and to null when neither is decisive.
function stateForDoc({ ref = null, title = '', body = '' } = {}) {
  const m = String(ref || '').match(/^directed-(\d+)$/);
  if (m) {
    try {
      const beat = db().getMeta(`focus.${m[1]}.beat`) || '';
      const suffix = beat.match(/-([a-z]{2})$/i);
      if (suffix && STATES[suffix[1].toUpperCase()]) return suffix[1].toUpperCase();
    } catch { /* fall through to the text scan */ }
  }
  return inferState(`${title || ''}\n${body || ''}`);
}

const emailKey = (e) => (e ? String(e).trim().toLowerCase() : null);

// Documents that still need scanning: never scanned, or edited since their scan. Ordered newest-first so
// the most recent research becomes reachable soonest.
// `match` narrows to documents whose title or body contains a phrase — so a specific backlog (the
// Louisiana parish corpus) can be worked first instead of waiting for a newest-first sweep to reach it
// through thousands of unrelated documents.
function pendingDocs({ limit = 200, minLength = 200, match = null } = {}) {
  try {
    const like = match ? `%${String(match)}%` : null;
    const filter = like ? `AND (d.title LIKE ? OR d.body LIKE ?)` : '';
    const args = like ? [minLength, like, like, limit] : [minLength, limit];
    return db().getDb().prepare(
      `SELECT d.id, d.title, d.ref, d.updated_ts, LENGTH(d.body) AS len
         FROM documents d
         LEFT JOIN doc_contacts_scanned s ON s.doc_id = d.id
        WHERE d.body IS NOT NULL AND LENGTH(d.body) >= ?
          AND (s.doc_id IS NULL OR IFNULL(s.doc_updated_ts, -1) <> IFNULL(d.updated_ts, -1))
          ${filter}
        ORDER BY d.id DESC
        LIMIT ?`).all(...args) || [];
  } catch { return []; }
}

function recordScan(docId, { docUpdatedTs = null, found = 0, chunks = 0, now = Date.now() } = {}) {
  try {
    db().getDb().prepare(
      `INSERT INTO doc_contacts_scanned (doc_id, doc_updated_ts, scanned_ts, found, chunks)
       VALUES (?,?,?,?,?)
       ON CONFLICT(doc_id) DO UPDATE SET
         doc_updated_ts = excluded.doc_updated_ts, scanned_ts = excluded.scanned_ts,
         found = excluded.found, chunks = excluded.chunks`
    ).run(Number(docId), docUpdatedTs, now, Number(found) || 0, Number(chunks) || 0);
    return true;
  } catch { return false; }
}

// Store one extracted person. Requires a name AND at least one reachable detail — a bare name is not a
// contact, and padding the roster with unreachable names would make the count look better than the data.
function upsert(row, { docId, docTitle = null, state = null, now = Date.now() } = {}) {
  if (!row || !row.name || !docId) return false;
  if (!row.email && !row.phone) return false;
  try {
    db().getDb().prepare(
      `INSERT INTO doc_contacts (email_key, name, email, phone, title, company, state, doc_id, doc_title, confidence, created_ts, updated_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(doc_id, name, COALESCE(email_key,'')) DO UPDATE SET
         phone = COALESCE(excluded.phone, phone), title = COALESCE(excluded.title, title),
         company = COALESCE(excluded.company, company), state = COALESCE(excluded.state, state),
         updated_ts = excluded.updated_ts`
    ).run(emailKey(row.email), String(row.name).slice(0, 200), row.email || null, row.phone || null,
      row.title || null, row.company || null, state, Number(docId), docTitle ? String(docTitle).slice(0, 200) : null,
      typeof row.confidence === 'number' ? row.confidence : 0.8, now, now);
    logEncounters(row, { docId, state });
    return true;
  } catch { return false; }
}

// The same extraction, written to the universal log (docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2). This
// table is a people-contact store, which is the Puller's job and is scheduled to collapse into it (§12);
// the encounter log is where the fact belongs permanently, so it is written to BOTH rather than migrated
// under a live system. The doc_contacts row stays the query surface; this is the graded substrate.
//
// Every encounter carries the DOCUMENT'S origin and content hash, not the contact's. That is what makes
// independence computable later: the same official in three copies of one PDF is one text and one
// origin, and origin.independence() can only see that if the hash travels with the claim.
// The document's own date, or null. Shared by every doc-derived encounter so one document cannot end up
// with two different observed_at values depending on which claim was being written.
function docObservedAt(doc) {
  try {
    if (!doc || !doc.body) return null;
    const fn = String(doc.ref || '').split(/[\\/]/).pop();
    const d = require('./observed_at').extractObservedAt({ text: doc.body, title: doc.title, filename: fn });
    return d ? d.ts : null;
  } catch { return null; }
}

function logEncounters(row, { docId, state }) {
  try {
    const enc = require('./encounters');
    const doc = db().getDocument(Number(docId)) || {};
    // An official record substitutes for roughly one ordinary source (§6.3) — but only where we actually
    // KNOW the origin. Most of the legacy corpus has none, and guessing would invent authority.
    const gov = doc.origin_host && /(^|\.)(gov|mil)$|(^|\.)[a-z]{2}\.us$/i.test(doc.origin_host);   // audit S15: only STATE-gov xx.us, not any .us (open-registration TLD)
    const base = {
      object_type: 'person',
      object_label: row.name,
      source_kind: 'document',
      source_ref: `doc:${docId}`,
      origin: doc.origin || null,
      origin_host: doc.origin_host || null,
      content_hash: doc.content_hash || null,
      authority: gov ? 'official' : 'unknown',
      // observed_at is the SOURCE's own date, extracted from the document (W1) — NEVER created_ts,
      // which is when WE ingested it. A 2021 roster ingested today must not read as current evidence.
      // Null whenever the document does not state a date it is willing to stand behind.
      observed_at: docObservedAt(doc),
    };
    const list = [{ ...base, claim_class: 'existence' }];
    if (row.email) list.push({ ...base, claim_class: 'contact', claim_key: 'email', claim_value: String(row.email).toLowerCase() });
    if (row.phone) list.push({ ...base, claim_class: 'contact', claim_key: 'phone', claim_value: row.phone });
    if (row.title) list.push({ ...base, claim_class: 'biographical', claim_key: 'title', claim_value: row.title });
    if (row.company) list.push({ ...base, claim_class: 'structural', claim_key: 'affiliated_with', claim_value: row.company });
    if (state) list.push({ ...base, claim_class: 'structural', claim_key: 'state', claim_value: state });
    enc.recordMany(list);
  } catch (e) { console.error('[doc_contacts] encounter log failed:', e.message); }
}

// Folded view for the contacts query: one entry per person, carrying how many DOCUMENTS attest to them.
// Corroboration across independent documents is a real signal, so it is surfaced rather than averaged away.
function search({ state = null, limit = 5000 } = {}) {
  try {
    const where = state ? `WHERE state = ?` : '';
    const args = state ? [String(state).toUpperCase(), limit] : [limit];
    return db().getDb().prepare(
      `SELECT name, email, MAX(phone) AS phone, MAX(title) AS title, MAX(company) AS company,
              MAX(state) AS state, MAX(confidence) AS confidence,
              COUNT(DISTINCT doc_id) AS doc_count, MIN(doc_id) AS doc_id, MIN(doc_title) AS doc_title
         FROM doc_contacts ${where}
        GROUP BY LOWER(name), COALESCE(email_key,'')
        ORDER BY doc_count DESC, name ASC
        LIMIT ?`).all(...args) || [];
  } catch { return []; }
}

function stats() {
  try {
    const d = db().getDb();
    return {
      contacts: d.prepare('SELECT COUNT(*) c FROM doc_contacts').get().c,
      people: d.prepare('SELECT COUNT(*) c FROM (SELECT 1 FROM doc_contacts GROUP BY LOWER(name), COALESCE(email_key,\'\'))').get().c,
      docsScanned: d.prepare('SELECT COUNT(*) c FROM doc_contacts_scanned').get().c,
      docsPending: pendingDocs({ limit: 100000 }).length,
    };
  } catch { return { contacts: 0, people: 0, docsScanned: 0, docsPending: 0 }; }
}

module.exports = { STATES, inferState, stateForDoc, emailKey, pendingDocs, recordScan, upsert, search, stats };
