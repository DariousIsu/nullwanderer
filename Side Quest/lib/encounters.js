/* lib/encounters.js — THE ENCOUNTER LOG. The primitive beneath the object model.
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2, §5, §6, §7.
 *
 * Lucas's philosophy, verbatim: "An object is real because it has been ENCOUNTERED in some fashion —
 * news, research, conversation, doc drops. The program merges like objects, adding together all data
 * gathered, and using any additional sources of validation which increases its certainty. The calls we
 * use in this process are cheap SPECIFICALLY BECAUSE we make so many."
 *
 * So this module holds two things and nothing else:
 *   record()  — every lane writes an encounter here. Append-only. Cheap, high-volume, no judgement.
 *   grade()   — judgement happens at READ time, from the accumulated log, per claim class.
 *
 * ── WHY GRADING LIVES AT READ TIME ──────────────────────────────────────────────────────────────
 *
 * Because a grade is a function of everything encountered so far, and "so far" keeps changing. Writing a
 * grade down freezes an answer that the next encounter would have changed; the whole model is that the
 * fifth source raises certainty on a claim first seen years earlier. The log is ground truth; grades,
 * objects and edges are all DERIVED.
 *
 * ── APPEND-ONLY IS NOT TIDINESS ─────────────────────────────────────────────────────────────────
 *
 * A wrong merge is the one unrecoverable failure. While every encounter keeps its own identity, an
 * un-merge is possible. Nothing here updates or deletes; the unique index makes re-recording idempotent
 * rather than inflationary, which is also §3's rule that a document may never corroborate a claim it is
 * itself the origin of — enforced where it cannot be forgotten.
 *
 * ── GRADING IS PER CLAIM CLASS (§5) ─────────────────────────────────────────────────────────────
 *
 * Lucas was explicit that contact and biographical facts differ in UPDATE MECHANICS, not just
 * thresholds. Contact decays and overwrites — a phone stops being true when someone leaves. Biography
 * accumulates and appends — "CPA at Firm X, 2021" does not stop being true when she is elected in 2026,
 * it becomes history. Existence never decays at all. One universal ladder would be wrong for all three.
 *
 * Interpretive claims are not graded as truth at any level. See INTERPRETIVE below.
 */
'use strict';

const og = require('./origin');
let _db = null;
const db = () => (_db || (_db = require('./db')));

// ── claim classes ────────────────────────────────────────────────────────────────────────────────
const CLASSES = ['existence', 'contact', 'biographical', 'structural', 'interpretive'];

// Grade ladder, ordered. Comparison is by RANK so "grade gates replacement" (§7) is a numeric test.
const RANK = { 'A+': 6, A: 5, 'A-': 4, 'B+': 3, B: 2, C: 1 };
const rankOf = (g) => RANK[g] || 0;

// Source authority. An official record substitutes for roughly one ordinary source (§6.3) — the
// truth-discovery literature is consistent that source reliability, not vote count, decides conflicts.
//
// `operator` is Lucas handing her a document. It has no URL and never will, but its provenance is
// KNOWN and better than most of the web — so it grades alongside an official record rather than falling
// through to `unknown`. Origin being null is correct for these and must not be read as weakness: a
// hand-delivered memo has no publisher to walk to, which is a different fact from having no source.
//
// `stated` is Lucas SAYING something in conversation, with no document behind it. Deliberately NOT
// the same as `operator` (Lucas handing her a document, which has an artifact and known provenance).
//
// Lucas, 2026-07-20: *"we can consider user input non-validating without documentation. so it would
// still create the object as an unverified and then seek to validate with a real source."*
//
// So a stated encounter CREATES the object and carries ZERO evidentiary weight. It is a pointer to go
// look, never a source. This matters more than it sounds: conversation is the one stream where a
// mis-extracted claim would otherwise wear the principal's own authority as its evidence, and a
// wrong fact sourced to Lucas is worse than a missing one. It is excluded from the independent-source
// count in gradeValue rather than merely ranked low, because "two sources" must never mean "he
// mentioned it twice".
const AUTHORITIES = ['verified', 'operator', 'official', 'ordinary', 'unknown', 'stated'];

// Sources whose authority substitutes for roughly one ordinary source (§6.3). `stated` is not one.
const isAuthoritative = (r) => r && (r.authority === 'official' || r.authority === 'operator');

// Non-evidentiary: creates the object, never grades it.
const isStated = (r) => !!r && r.authority === 'stated';

// SINGLE-TRUTH vs MULTI-TRUTH — the distinction the truth-discovery literature insists on (§10): a
// person has one birth date but may hold several roles. Only single-truth claims can CONFLICT; for the
// rest, a second value is accumulation, not disagreement.
//
// This was caught on live data, and it is the difference between §5a and §5b restated: contact
// OVERWRITES, so two phone numbers compete and the newer supersedes. Biography APPENDS — "CPA at Firm X,
// 2021" does not stop being true when she is elected in 2026, it becomes history. Structural edges are
// plainly plural: Bobby Wilson is `WARD 1` and `CATAHOULA PARISH POLICE JURY`, which read as a contested
// claim under the first version of this module and are simply both true. Flagging accumulation as
// conflict would spend cleaning-research passes on facts that were never in dispute.
const SINGLE_TRUTH = new Set(['contact', 'existence']);

// Identity key. Normalised so "Melissa Bosch", "melissa  bosch" and "Bosch, Melissa." converge, without
// being so aggressive that distinct people collapse — a false merge is unrecoverable, a missed one is not.
function objectKey(type, label) {
  const s = String(label == null ? '' : label).toLowerCase().trim()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return `${String(type || 'thing').toLowerCase()}:${s}`;
}

// ── WRITE ────────────────────────────────────────────────────────────────────────────────────────
//
// One encounter = one source asserting one thing about one object. `observed_at` is the SOURCE'S date
// and defaults to null rather than to now(): guessing it would let a 2021 PDF read as current evidence,
// which is precisely the failure the field exists to prevent. Unknown stays unknown.
function record(enc) {
  if (!enc || !enc.object_type || !enc.claim_class) return null;
  const key = enc.object_key || objectKey(enc.object_type, enc.object_label);
  if (!key) return null;
  if (!CLASSES.includes(enc.claim_class)) return null;
  const authority = AUTHORITIES.includes(enc.authority) ? enc.authority : 'unknown';
  // Origin travels WITH the claim. Grading cannot go back and ask the document later — by then the
  // claim has been separated from where it came from, which is exactly how facts become ungradeable.
  const origin = enc.origin ? og.normalizeUrl(enc.origin) : null;
  const host = enc.origin_host || (origin ? og.hostOf(origin) : null);
  try {
    const info = db().getDb().prepare(
      `INSERT INTO encounters
         (object_type, object_key, object_label, claim_class, claim_key, claim_value,
          source_kind, source_ref, origin, origin_host, content_hash, authority, observed_at, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`
    ).run(
      String(enc.object_type), key, enc.object_label ? String(enc.object_label).slice(0, 300) : null,
      enc.claim_class, enc.claim_key || null, enc.claim_value == null ? null : String(enc.claim_value).slice(0, 2000),
      enc.source_kind || null, enc.source_ref || null,
      origin, host, enc.content_hash || null, authority,
      Number.isFinite(enc.observed_at) ? enc.observed_at : null, Date.now()
    );
    return info.changes ? info.lastInsertRowid : 0; // 0 = already recorded; not an error, and not a second vote
  } catch (e) { console.error('[encounters] record failed:', e.message); return null; }
}

function recordMany(list) {
  const rows = Array.isArray(list) ? list.filter(Boolean) : [];
  let added = 0, seen = 0;
  for (const r of rows) { const id = record(r); if (id) added += 1; else if (id === 0) seen += 1; }
  return { added, alreadyKnown: seen, total: rows.length };
}

// ── READ ─────────────────────────────────────────────────────────────────────────────────────────
function forObject(key, { claimClass = null, claimKey = null, limit = 2000 } = {}) {
  if (!key) return [];
  const w = ['object_key = ?'], a = [key];
  if (claimClass) { w.push('claim_class = ?'); a.push(claimClass); }
  if (claimKey) { w.push('claim_key = ?'); a.push(claimKey); }
  a.push(Math.max(1, limit | 0));
  try {
    return db().getDb().prepare(
      `SELECT * FROM encounters WHERE ${w.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...a) || [];
  } catch { return []; }
}

// ── GRADE ────────────────────────────────────────────────────────────────────────────────────────
//
// Per claim class, applied to the encounters supporting ONE value. `ind` is origin.independence() —
// min(distinct origins, distinct texts) — so neither syndication nor a site repeating itself inflates.
function gradeValue(claimClass, rows) {
  // Stated-in-conversation claims are stripped BEFORE independence is computed, so they can never
  // contribute to the source count. Everything below then grades only real evidence.
  const all = Array.isArray(rows) ? rows : [];
  const stated = all.filter(isStated).length;
  const evidence = all.filter((r) => !isStated(r));
  // Known ONLY because Lucas said so → the object exists, the claim is unverified, and it is work to
  // do. Null grade (not 'C') on purpose: a C means one real source looked and found this. This means
  // nobody has looked yet, which is a different state and drives a different action.
  if (!evidence.length) {
    return { grade: null, unverified: true, stated, ind: og.independence([]) };
  }
  const rows_ = evidence;
  const ind = og.independence(rows_);
  const n = ind.count;
  const official = rows_.some(isAuthoritative);
  const verified = rows_.some((r) => r.authority === 'verified');

  switch (claimClass) {
    // §5a — DECAYS, newer supersedes. Verification (a bounce test, a reply, a connect) is the only A+;
    // no amount of documents attesting to a phone number proves it still rings.
    case 'contact':
      if (verified) return { grade: 'A+', ind };
      if (n >= 3) return { grade: 'A', ind };
      if (official && n >= 2) return { grade: 'A-', ind };
      if (official) return { grade: 'B+', ind };
      return { grade: n >= 2 ? 'B' : 'C', ind };

    // §5b — ACCUMULATES, never overwritten. An official record alone is already A-; one more source
    // makes it A+. Ordinary sources can pile up without ever reaching what a record gives on its own.
    case 'biographical':
      if (official && n >= 2) return { grade: 'A+', ind };
      if (official) return { grade: 'A-', ind };
      if (n >= 3) return { grade: 'B+', ind };
      return { grade: n >= 2 ? 'B' : 'C', ind };

    // §5c — NEVER DECAYS. A 2021 document is permanent evidence the person existed then, however stale
    // their phone number is. Nothing here is time-weighted, deliberately.
    case 'existence':
      if (official && n >= 2) return { grade: 'A', ind };
      if (official || n >= 3) return { grade: 'A-', ind };
      return { grade: n >= 2 ? 'B' : 'C', ind };

    // §5d — observable and checkable; ordinary corroboration applies.
    case 'structural':
      if (official && n >= 2) return { grade: 'A', ind };
      if (official) return { grade: 'A-', ind };
      if (n >= 3) return { grade: 'B+', ind };
      return { grade: n >= 2 ? 'B' : 'C', ind };

    // §5e — INTERPRETIVE CLAIMS ARE NEVER GRADED AS TRUTH.
    //
    // Lucas: "N sources characterize is a better concept to follow — everything can be true until
    // proven otherwise." "This speech was about election integrity" is a judgement, not an observation.
    // Grading it would launder three summarisers reaching for the same word into a Grade-A fact about
    // the world. So the return carries `characterizations` and a null grade: a fact about DISCOURSE.
    default:
      return { grade: null, characterizations: n, ind };
  }
}

// One claim, fully judged: which value wins, how well attested, and whether it needs cleaning.
//
// §7 — conflicts are a WORK TRIGGER, not something to display. Both values are retained with their
// sources; the winner is decided by GRADE, never by volume, so a well-sourced A+ cannot be displaced by
// a pile of Cs. A close rival sets `cleaning`, which is the signal to go verify the dispute, not a
// prompt to answer the user with "sources disagree".
function gradeClaim(key, { claimClass = 'biographical', claimKey = null } = {}) {
  const rows = forObject(key, { claimClass, claimKey });
  if (!rows.length) return { value: null, grade: null, count: 0, sources: 0, contested: false, cleaning: false, values: [] };

  const byValue = new Map();
  for (const r of rows) {
    const v = r.claim_value == null ? '' : String(r.claim_value);
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(r);
  }

  const values = [...byValue.entries()].map(([value, rs]) => {
    const g = gradeValue(claimClass, rs);
    // Recency is the tiebreak for DECAYING classes only. observed_at may be null (unknown source date);
    // an undated source must not outrank a dated one, so it sorts last rather than as now().
    const latest = rs.reduce((m, r) => Math.max(m, r.observed_at || 0), 0);
    return {
      value: value || null, grade: g.grade, sources: g.ind.count, encounters: rs.length,
      unproven: g.ind.unproven, syndicated: g.ind.syndicated, official: rs.some(isAuthoritative),
      latest, characterizations: g.characterizations,
      // Known only because it was SAID — no evidence has been found yet. This is what turns a
      // conversational mention into work to do rather than a fact she holds.
      unverified: !!g.unverified, stated: g.stated || rs.filter(isStated).length,
    };
  });

  const decays = claimClass === 'contact';
  values.sort((a, b) => (rankOf(b.grade) - rankOf(a.grade))
    || (decays ? b.latest - a.latest : 0)
    || (b.sources - a.sources) || (b.encounters - a.encounters));

  const single = SINGLE_TRUTH.has(claimClass);
  const top = values[0];
  // A rival only exists where the claim can only have ONE answer. For multi-truth classes every value
  // is held on its own merits and `value` is merely the best-attested of them, not a winner.
  const rival = single ? (values[1] || null) : null;
  return {
    value: top.value,
    grade: top.grade,
    count: rows.length,
    sources: top.sources,
    unproven: !!top.unproven,
    official: !!top.official,
    characterizations: top.characterizations,
    // UNVERIFIED = the object exists because someone said so, and nothing has corroborated it. Lucas's
    // rule: user input is non-validating without documentation — it creates the object, then we go
    // looking. This flag is the "go looking" signal.
    unverified: !!top.unverified,
    stated: top.stated || 0,
    multi: !single && values.length > 1,
    // A competing value exists at all. Retained and visible either way — §7, nothing is ever deleted.
    contested: !!rival,
    // …and it is close enough to be worth researching. Refutation requires an A-grade source (§13.2),
    // so a rival two full grades down is noise to retain, not a dispute to spend a research pass on.
    // The floor matters as much: two C claims disputing each other is not a dispute, it is an object
    // nobody has researched yet — which low grade already says, without spending a verification pass.
    cleaning: !!rival && rankOf(top.grade) >= RANK.B && rankOf(rival.grade) >= rankOf(top.grade) - 1,
    values,
  };
}

// Everything known about one object, graded. This is the read the object model is FOR: the object is
// not a record, it is what the log adds up to.
function profile(key) {
  const rows = forObject(key);
  if (!rows.length) return null;
  const claims = [];
  const seen = new Set();
  for (const r of rows) {
    const sig = `${r.claim_class}|${r.claim_key || ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    claims.push({ claimClass: r.claim_class, claimKey: r.claim_key, ...gradeClaim(key, { claimClass: r.claim_class, claimKey: r.claim_key }) });
  }
  const labels = [...new Set(rows.map((r) => r.object_label).filter(Boolean))];
  return {
    key, type: rows[0].object_type, labels,
    firstSeen: rows[0].ingested_at, encounters: rows.length,
    sources: og.independence(rows).count,
    claims,
  };
}

function stats() {
  try {
    const d = db().getDb();
    const g = (q) => { try { return d.prepare(q).get().c; } catch { return 0; } };
    return {
      encounters: g('SELECT COUNT(*) c FROM encounters'),
      objects: g('SELECT COUNT(*) c FROM (SELECT 1 FROM encounters GROUP BY object_key)'),
      withOrigin: g('SELECT COUNT(*) c FROM encounters WHERE origin_host IS NOT NULL'),
      byClass: (() => {
        try { return d.prepare('SELECT claim_class, COUNT(*) c FROM encounters GROUP BY claim_class').all(); } catch { return []; }
      })(),
    };
  } catch { return { encounters: 0, objects: 0, withOrigin: 0, byClass: [] }; }
}

module.exports = { CLASSES, AUTHORITIES, SINGLE_TRUTH, isAuthoritative, isStated, RANK, rankOf, objectKey, record, recordMany, forObject, gradeValue, gradeClaim, profile, stats };
