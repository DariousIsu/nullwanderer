/**
 * lib/civic_store.js — the STRUCTURED home for researched governing bodies and who holds their
 * seats (docs/CIVIC_BODY_SCHEMA_DESIGN.md, Lucas-approved 2026-07-30).
 *
 * Why it exists, measured: 120 open county-compilation threads and hundreds of researched boards
 * had nowhere to LAND — prose deliverables and graph nodes only. Nothing queryable, countable,
 * diffable, or exportable, which is why roster/contact-sheet deliverables never worked and why her
 * own db_query(county_election_boards) calls errored. Her subconscious diagnosed this twice,
 * independently, and the log watcher minted a need from the same failures.
 *
 * The five load-bearing rules (each one is a decision, not an accident):
 *   1. SUPERSEDE, NEVER OVERWRITE — a changed seat writes a NEW row and stamps superseded_by on
 *      the old one. "Who chaired this in 2024" stays answerable and a bad scrape is revertible.
 *   2. COMPLETENESS IS DERIVED — current members counted against cardinality.seats, never stored.
 *      A stored `complete` flag is false the moment a seat turns over.
 *   3. NOT A PERSON STORE — the CRM stays authoritative (crm-is-the-ultimate-store). This owns
 *      SEATS and points at people. Someone on four boards is four rows here and one CRM row.
 *   4. CONTACT DETAILS ONLY FROM THE BODY'S OWN SOURCE — pattern-derived addresses belong in
 *      Puller, which already has the belief/confidence machinery.
 *   5. CONFIDENCE GRADES, IT DOES NOT GATE — everything lands marked and visible; a weak claim is
 *      outranked, never refused at the door (let-it-in-mark-and-churn).
 *
 * Pure + deps-injected (every caller may pass {db}); offline-smokeable; fail-soft — a broken write
 * returns a reason, never throws into a research pass.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
function _db(deps) { return (deps && deps.db) || require('./db'); }

const LEVELS = new Set(['county', 'municipal', 'township', 'school_district', 'state', 'special_district', 'other']);
const FUNCTIONS = new Set(['governing', 'elections', 'school', 'judicial', 'planning', 'other']);
// Researched sources outrank backfill: a prose-extracted row may never supersede a researched one.
// 'aggregator' (2026-08-07, roster-refresh state tier): a maintained machine-readable aggregation
// of official sources (Openstates people data). Researched-grade — it may supersede prior rows —
// but labeled honestly as one aggregator, not 'official'; confidence carries the difference.
const RESEARCHED_KINDS = new Set(['official', 'news', 'wiki', 'held_doc', 'operator', 'aggregator']);

// A body's stable identity — the SAME key cardinality and absence use, so a roster, its seat
// denominator and its gap record all line up without a translation layer.
function keyFor(title) {
  try { return require('./body_key').normalizeBody(title); } catch { return str(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
}

// ── bodies ────────────────────────────────────────────────────────────────────────────────────
// Idempotent: a second sighting UPDATES the descriptive fields it actually carries (never blanking
// what it doesn't know) and refreshes updated_ts. Unknown level/function fall back to 'other'
// rather than refusing the row — an unclassified body still needs somewhere to live.
function upsertBody({ title, level = 'other', function: fn = 'other', state = null, place = null, officialUrl = null, selection = null, termYears = null, notes = null } = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const t = str(title).replace(/\s+/g, ' ').trim();
  if (t.length < 3) return { ok: false, reason: 'a body needs a real title' };
  const key = keyFor(t);
  const lv = LEVELS.has(str(level)) ? str(level) : 'other';
  const fu = FUNCTIONS.has(str(fn)) ? str(fn) : 'other';
  try {
    const d = _db(deps).getDb();
    const cur = d.prepare('SELECT body_key FROM civic_bodies WHERE body_key = ?').get(key);
    if (cur) {
      d.prepare(`UPDATE civic_bodies SET title = ?, level = ?, function = ?,
        state = COALESCE(?, state), place = COALESCE(?, place), official_url = COALESCE(?, official_url),
        selection = COALESCE(?, selection), term_years = COALESCE(?, term_years), notes = COALESCE(?, notes),
        updated_ts = ? WHERE body_key = ?`)
        .run(t, lv, fu, state, place, officialUrl, selection, termYears, notes, nowMs, key);
      return { ok: true, bodyKey: key, created: false };
    }
    d.prepare(`INSERT INTO civic_bodies (body_key, title, level, function, state, place, official_url, selection, term_years, notes, first_seen_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, t, lv, fu, state, place, officialUrl, selection, termYears, notes, nowMs, nowMs);
    return { ok: true, bodyKey: key, created: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function getBody(bodyKeyOrTitle, { deps = {} } = {}) {
  const key = keyFor(bodyKeyOrTitle);
  try { return _db(deps).getDb().prepare('SELECT * FROM civic_bodies WHERE body_key = ?').get(key) || null; } catch { return null; }
}

// ── memberships ───────────────────────────────────────────────────────────────────────────────
// A seat sighting. Same person+role already current →
//   · nothing materially changed  → touch nothing (no row churn on a re-read of the same page)
//   · something changed           → the old row is SUPERSEDED by the new one (history preserved)
// A backfill row may never supersede a researched one (rule 3 of the backfill discipline): it is
// dropped instead, so prose extraction can never quietly overwrite something we actually verified.
const _MATERIAL = ['district', 'party', 'term_start', 'term_end', 'email', 'phone'];
function recordMembership(m = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const bodyKey = m.bodyKey ? str(m.bodyKey) : keyFor(m.bodyTitle);
  const name = str(m.personName).replace(/\s+/g, ' ').trim();
  if (!bodyKey) return { ok: false, reason: 'no body' };
  if (name.length < 2) return { ok: false, reason: 'a membership needs the person name the source printed' };
  const sourceKind = str(m.sourceKind) || 'operator';
  const isBackfill = !RESEARCHED_KINDS.has(sourceKind);
  const role = m.role == null ? null : str(m.role);
  try {
    const d = _db(deps).getDb();
    if (!d.prepare('SELECT 1 FROM civic_bodies WHERE body_key = ?').get(bodyKey)) return { ok: false, reason: `unknown body "${bodyKey}" — upsertBody first` };
    const cur = d.prepare(`SELECT * FROM civic_memberships WHERE body_key = ? AND person_name = ?
      AND COALESCE(role,'') = COALESCE(?,'') AND superseded_by IS NULL ORDER BY observed_ts DESC LIMIT 1`).get(bodyKey, name, role);
    if (cur) {
      if (isBackfill && RESEARCHED_KINDS.has(str(cur.source_kind))) {
        return { ok: true, skipped: 'backfill never supersedes a researched row', id: cur.id };
      }
      const changed = _MATERIAL.some((f) => {
        const incoming = m[f === 'term_start' ? 'termStart' : f === 'term_end' ? 'termEnd' : f];
        return incoming != null && str(incoming) !== str(cur[f]);
      });
      if (!changed) {
        // Same facts seen again: keep ONE row, but let a better source raise its grade.
        const conf = Number(m.confidence);
        if (isFinite(conf) && conf > Number(cur.confidence || 0)) {
          d.prepare('UPDATE civic_memberships SET confidence = ?, source_url = COALESCE(?, source_url), source_kind = ?, observed_ts = ? WHERE id = ?')
            .run(conf, m.sourceUrl || null, sourceKind, nowMs, cur.id);
          return { ok: true, id: cur.id, regraded: true };
        }
        return { ok: true, id: cur.id, unchanged: true };
      }
    }
    const info = d.prepare(`INSERT INTO civic_memberships
      (body_key, person_name, role, district, party, term_start, term_end, crm_id, puller_id, email, phone, source_url, source_kind, doc_ref, confidence, observed_ts, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(bodyKey, name, role, m.district || null, m.party || null, m.termStart || null, m.termEnd || null,
        m.crmId || null, m.pullerId || null, m.email || null, m.phone || null, m.sourceUrl || null, sourceKind,
        m.docRef || null, isFinite(Number(m.confidence)) ? Number(m.confidence) : 0.5, nowMs);
    if (cur) d.prepare('UPDATE civic_memberships SET superseded_by = ? WHERE id = ?').run(info.lastInsertRowid, cur.id);
    return { ok: true, id: info.lastInsertRowid, superseded: cur ? cur.id : null };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// SEAT-GRAIN recorder (roster-refresh organ, 2026-08-07): an elected SEAT has exactly one holder,
// so recording the current officeholder supersedes every other live row of that body.
// recordMembership deliberately lets different names coexist (right for multi-seat boards); only a
// caller that KNOWS the body is single-seat may use this door.
function recordSeatHolder(m = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const r = recordMembership(m, { deps, nowMs });
  if (!r.ok || !r.id) return r;
  const bodyKey = m.bodyKey ? str(m.bodyKey) : keyFor(m.bodyTitle);
  const replaced = [];
  try {
    const d = _db(deps).getDb();
    const others = d.prepare('SELECT id, person_name FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL AND id != ?').all(bodyKey, r.id);
    for (const o of others) {
      d.prepare('UPDATE civic_memberships SET superseded_by = ? WHERE id = ?').run(r.id, o.id);
      replaced.push(o.person_name);
    }
  } catch (e) { return { ...r, replaced, replaceError: e.message }; }
  return { ...r, replaced };
}

// CHAMBER-GRAIN recorder (roster-refresh state tier, 2026-08-07): a FULL-membership refresh.
// Fresh members are recorded (coexisting — recordMembership's normal multi-seat semantics); live
// rows whose person the fresh roster no longer contains are superseded — the DEPARTURE is the
// change-flag. Guard: a roster under 10 members never supersedes anything (a stub or truncated
// feed must not mass-retire a chamber).
function recordRoster({ bodyKey, bodyTitle, members = [], sourceKind, sourceUrl } = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const key = bodyKey ? str(bodyKey) : keyFor(bodyTitle);
  if (!key) return { ok: false, reason: 'no body' };
  const out = { ok: true, stored: 0, unchanged: 0, departed: [], failures: [] };
  const fresh = new Set();
  let markerId = null;                       // newest row of this refresh — departures point here
  for (const m of members) {
    const r = recordMembership({ ...m, bodyKey: key, sourceKind: m.sourceKind || sourceKind, sourceUrl: m.sourceUrl || sourceUrl }, { deps, nowMs });
    if (!r.ok) { out.failures.push(`${m.personName}: ${r.reason}`); continue; }
    fresh.add(str(m.personName).replace(/\s+/g, ' ').trim().toLowerCase());
    if (r.id) markerId = r.id;
    if (r.unchanged || r.regraded) out.unchanged++; else out.stored++;
  }
  if (fresh.size >= 10 && markerId) {
    try {
      const d = _db(deps).getDb();
      const others = d.prepare('SELECT id, person_name FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL').all(key);
      for (const o of others) {
        if (!fresh.has(str(o.person_name).replace(/\s+/g, ' ').trim().toLowerCase())) {
          d.prepare('UPDATE civic_memberships SET superseded_by = ? WHERE id = ?').run(markerId, o.id);
          out.departed.push(o.person_name);
        }
      }
    } catch (e) { out.departError = e.message; }
  }
  return out;
}

// The CURRENT roster (superseded rows excluded), best-graded first.
function roster(bodyKeyOrTitle, { deps = {} } = {}) {
  const key = keyFor(bodyKeyOrTitle);
  try {
    return _db(deps).getDb().prepare(`SELECT * FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL
      ORDER BY confidence DESC, person_name ASC`).all(key);
  } catch { return []; }
}

// HELD ROSTERS FOR A TEXT (2026-08-08, the all-pending parish fill): the edit executor marked all
// 64 parishes "(pending verification)" while 12 live rosters sat in this store — instructed to
// check "held stores", the model took the lazy valid exit rather than composing the queries. The
// cure is DETERMINISTIC INJECTION (same shape as recheck_queue.heldContext): give the caller a
// compact digest of every live roster whose body matches the text, so the facts are IN the prompt
// and pending marks are only honest where this digest is silent. Matching is by the body_key's
// DISTINCTIVE words (generic civic nouns stripped) — "st landry parish police jury" matches a doc
// that mentions St. Landry, never every doc that says "parish".
const _GENERIC_BODY_WORDS = new Set(['parish', 'county', 'city', 'town', 'village', 'council', 'police', 'jury', 'commission', 'board', 'government', 'consolidated', 'of', 'the', 'and', 'state', 'house', 'senate', 'representatives', 'louisiana']);
function heldRostersFor(text, { limit = 40, deps = {} } = {}) {
  const hay = str(text).toLowerCase();
  if (!hay.trim()) return [];
  let bodies = [];
  try { bodies = _db(deps).getDb().prepare(`SELECT DISTINCT body_key FROM civic_memberships WHERE superseded_by IS NULL`).all(); } catch { return []; }
  const out = [];
  for (const b of bodies) {
    const words = String(b.body_key).split(/\s+/).filter((w) => w.length > 2 && !_GENERIC_BODY_WORDS.has(w));
    if (!words.length || !words.every((w) => hay.includes(w))) continue;
    const rows = roster(b.body_key, { deps });
    if (!rows.length) continue;
    const named = rows.map((r) => `${r.person_name}${r.role && !/^member$/i.test(r.role) ? ` (${r.role})` : ''}${r.district ? ` [${r.district}]` : ''}`);
    out.push({ bodyKey: b.body_key, count: rows.length, line: `${b.body_key} — ${rows.length} held: ${named.join('; ')}` });
    if (out.length >= limit) break;
  }
  return out;
}

// FRESH-HOT DEPTH (2026-08-08, the law's second half): a mention doesn't only warm the GAPS —
// what we HOLD on the neighborhood gets staleness-checked too. Bodies matching the text whose
// NEWEST live observation is older than maxAgeMs are re-verify candidates (not gaps: we hold a
// roster, it has just aged). Same distinctive-word matching as heldRostersFor. 30d default:
// local rosters churn on elections/appointments; a month-old observation is worth one cheap pass.
function staleRostersFor(text, { maxAgeMs = 30 * 24 * 3600 * 1000, limit = 5, now = Date.now(), deps = {} } = {}) {
  const hay = str(text).toLowerCase();
  if (!hay.trim()) return [];
  let bodies = [];
  try { bodies = _db(deps).getDb().prepare(`SELECT body_key, MAX(observed_ts) newest, COUNT(*) n FROM civic_memberships WHERE superseded_by IS NULL GROUP BY body_key`).all(); } catch { return []; }
  const out = [];
  for (const b of bodies) {
    const words = String(b.body_key).split(/\s+/).filter((w) => w.length > 2 && !_GENERIC_BODY_WORDS.has(w));
    if (!words.length || !words.every((w) => hay.includes(w))) continue;
    if ((now - (b.newest || 0)) < maxAgeMs) continue;
    out.push({ bodyKey: b.body_key, count: b.n, ageDays: Math.round((now - (b.newest || 0)) / 86400000) });
    if (out.length >= limit) break;
  }
  return out;
}

// Every version of a seat, oldest first — what supersession preserves.
function history(bodyKeyOrTitle, personName, { deps = {} } = {}) {
  try {
    return _db(deps).getDb().prepare(`SELECT * FROM civic_memberships WHERE body_key = ? AND person_name = ?
      ORDER BY observed_ts ASC`).all(keyFor(bodyKeyOrTitle), str(personName).trim());
  } catch { return []; }
}

// COMPLETENESS, DERIVED — filled seats vs the cardinality denominator. seats=null means we do not
// know the denominator yet, which is an HONEST answer, not 0% (the standing question behind all
// 120 county threads is exactly this one).
function completeness(bodyKeyOrTitle, { deps = {} } = {}) {
  const key = keyFor(bodyKeyOrTitle);
  try {
    const d = _db(deps).getDb();
    const filled = d.prepare('SELECT COUNT(*) n FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL').get(key).n;
    let seats = null;
    try { const c = d.prepare('SELECT seats FROM cardinality WHERE body = ?').get(key); if (c) seats = c.seats; } catch {}
    return { bodyKey: key, filled, seats, complete: seats != null ? filled >= seats : null, missing: seats != null ? Math.max(0, seats - filled) : null };
  } catch { return { bodyKey: key, filled: 0, seats: null, complete: null, missing: null }; }
}

// THE STANDING QUESTION: which bodies are short of their known denominator. Bodies with no known
// seat count are reported separately rather than silently counted as complete or incomplete.
function incomplete({ state = null, level = null, limit = 200 } = {}, { deps = {} } = {}) {
  try {
    const where = ['1=1']; const args = [];
    if (state) { where.push('b.state = ?'); args.push(str(state)); }
    if (level) { where.push('b.level = ?'); args.push(str(level)); }
    const rows = _db(deps).getDb().prepare(`
      SELECT b.body_key, b.title, b.state, b.level, c.seats,
             (SELECT COUNT(*) FROM civic_memberships m WHERE m.body_key = b.body_key AND m.superseded_by IS NULL) filled
      FROM civic_bodies b LEFT JOIN cardinality c ON c.body = b.body_key
      WHERE ${where.join(' AND ')} ORDER BY b.state, b.title LIMIT ?`).all(...args, Math.max(1, Math.min(1000, limit)));
    return {
      incomplete: rows.filter((r) => r.seats != null && r.filled < r.seats).map((r) => ({ ...r, missing: r.seats - r.filled })),
      complete: rows.filter((r) => r.seats != null && r.filled >= r.seats).length,
      unknownDenominator: rows.filter((r) => r.seats == null).map((r) => ({ body_key: r.body_key, title: r.title, filled: r.filled })),
    };
  } catch { return { incomplete: [], complete: 0, unknownDenominator: [] }; }
}

module.exports = { keyFor, upsertBody, getBody, recordMembership, recordSeatHolder, recordRoster, roster, heldRostersFor, staleRostersFor, history, completeness, incomplete, LEVELS, FUNCTIONS, RESEARCHED_KINDS };
