'use strict';
/**
 * lib/entity_match.js — the PRECISION MATCHER core of the node-resolution-&-fusion gate
 * (docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md §2, build step 1). Decides whether an incoming entity is the
 * SAME as an existing one — PRECISION-FIRST, so it never reproduces the two failures this system actually made:
 *   • the Howell FALSE MERGE  — "Janet D. Howell (VA)" ≠ "William J. Howell (VA)" (different given names)
 *   • the LAMP FAN-OUT        — a membership edge fanned onto every same-surname legislator in a state
 *
 * Grounded tiers: Tier-1 DETERMINISTIC (a shared strong identifier — QID / OCD / FEC / bioguide / contact /
 * lda → safe auto-merge, order-independent per Swoosh); Tier-2 rule-gated PROBABILISTIC behind HARD GATES
 * (given-name compatibility + corroboration beyond name+jurisdiction). Anything ambiguous, or where >1
 * candidate plausibly matches, → REVIEW, never an auto-merge (the anti-fan rule). A Fellegi-Sunter weight is
 * carried as an auxiliary CONFIDENCE, but the DECISION is the rule engine (so it's deterministic + testable).
 *
 * PURE (no I/O, no db, no model). Blocking (candidate generation) and the collective/neighbor tie-break are
 * separate stages that feed this matcher — here we decide ONE pair, or resolve one candidate against a set.
 */

// --- name / id parsing ------------------------------------------------------------------------------
// Bracket tags carry strong ids in our graph: [wd:Q123], [FEC:C0001234] / [C0001234], [M000244] (bioguide),
// [lda_client:119039], [8-hex] (openstates uuid frag), bare [Q123]. Jurisdiction is a trailing (VA)/(US-VA)/(US-US).
const { normalizeCivic } = require('./civic_canon');

const NICK = {
  bill: 'william', will: 'william', billy: 'william', bob: 'robert', rob: 'robert', bobby: 'robert',
  dick: 'richard', rich: 'richard', rick: 'richard', jim: 'james', jimmy: 'james', joe: 'joseph', joey: 'joseph',
  tom: 'thomas', tommy: 'thomas', mike: 'michael', dave: 'david', dan: 'daniel', danny: 'daniel',
  chris: 'christopher', matt: 'matthew', tony: 'anthony', ed: 'edward', eddie: 'edward', steve: 'stephen',
  ken: 'kenneth', sam: 'samuel', ben: 'benjamin', andy: 'andrew', greg: 'gregory', jeff: 'jeffrey', geoff: 'jeffrey',
  larry: 'lawrence', fred: 'frederick', nick: 'nicholas', pat: 'patrick', pate: 'patrick',
  liz: 'elizabeth', beth: 'elizabeth', betty: 'elizabeth', kim: 'kimberly', sue: 'susan', peggy: 'margaret',
  meg: 'margaret', maggie: 'margaret', kate: 'katherine', katie: 'katherine', cathy: 'catherine', chuck: 'charles',
  charlie: 'charles', hank: 'henry', jack: 'john', johnny: 'john', tina: 'christina', deb: 'deborah', debbie: 'deborah',
};
function _canonGiven(g) { const s = String(g || '').toLowerCase().replace(/\.$/, '').trim(); return NICK[s] || s; }
function _isInitial(g) { const s = String(g || '').replace(/\./g, '').trim(); return s.length === 1; }

function parseEntity(rec = {}) {
  const raw = String((rec && rec.name) || '').trim();
  const ids = {};
  // pull bracket tags → strong ids
  let s = raw.replace(/\[([^\]]+)\]/g, (_m, inner) => {
    const t = String(inner).trim(); let m;
    if ((m = /^wd:(Q\d+)$/i.exec(t)) || (m = /^(Q\d+)$/i.exec(t))) ids.wikidata = m[1].toUpperCase();
    else if ((m = /^(?:FEC:)?(C\d{7,})$/i.exec(t))) ids.fec = m[1].toUpperCase();                 // FEC committee (C0…)
    else if ((m = /^(?:FEC:)?([HSP]\d[A-Z]{2}\d{3,})$/i.exec(t))) ids.fec = m[1].toUpperCase();     // FEC candidate (H4CA22120)
    else if ((m = /^([A-Z]\d{6})$/.exec(t))) ids.bioguide = m[1].toUpperCase();                     // bioguide (R000508, any letter)
    else if (/^ocd-[a-z]+\//i.test(t)) ids.ocd = t.toLowerCase();                                   // ocd-person/…
    else if ((m = /^lda_client:(\d+)$/i.exec(t))) ids.lda = m[1];
    else if (/^[0-9a-f]{8}$/i.test(t)) ids.openstates = t.toLowerCase();                             // openstates uuid frag
    return ' ';
  });
  // explicit ids passed on the record (from anchored evidence, not the surface name)
  if (rec.contact_id != null) ids.contact = String(rec.contact_id);
  if (rec.ocd) ids.ocd = String(rec.ocd).toLowerCase();
  if (rec.wikidata) ids.wikidata = String(rec.wikidata).toUpperCase();
  // trailing jurisdiction (VA) / (US-VA) / (US-US)
  let jurisdiction = rec.jurisdiction || null;
  const jm = /\(\s*(US-US|US-[A-Z]{2}|[A-Z]{2})\s*\)\s*$/.exec(s);
  if (jm) { jurisdiction = jm[1].toUpperCase(); s = s.slice(0, jm.index).trim(); }
  // clean name: drop remaining parentheticals + punctuation → tokens
  const clean = s.replace(/\([^)]*\)/g, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = clean.split(' ').filter((t) => t && t.length > 0);
  const type = String(rec.type || rec.entity_type || '').toLowerCase() || null;
  const isPerson = type === 'person' || (!type && toks.length >= 2 && toks.length <= 4);
  return {
    __parsed: true,
    display: raw, nameKey: clean.toLowerCase(), normKey: normalizeCivic(raw), tokens: toks, type, isPerson,
    given: isPerson && toks.length >= 2 ? toks[0] : null,   // a single-token person name is a SURNAME, not a given
    surname: isPerson && toks.length ? toks[toks.length - 1] : null,
    jurisdiction: jurisdiction ? String(jurisdiction).toUpperCase() : null,
    ids,
    birthYear: rec.birthYear != null ? String(rec.birthYear) : null,
    office: rec.office ? String(rec.office).toLowerCase() : null,
    party: rec.party ? String(rec.party).toLowerCase() : null,
  };
}

// --- primitives -------------------------------------------------------------------------------------
const ID_KEYS = ['wikidata', 'fec', 'bioguide', 'ocd', 'contact', 'openstates', 'lda'];
// A shared strong id of the SAME system = the same real entity (Tier-1 deterministic). Different systems'
// ids never CONFLICT (a wikidata id and an openstates id are orthogonal), so only agreement matters here.
function sharedStrongId(a, b) {
  for (const k of ID_KEYS) if (a.ids[k] && b.ids[k] && a.ids[k] === b.ids[k]) return k;
  return null;
}
// A CONFLICTING strong id (two different ids in the SAME system) = provably different entities. Guards against
// a probabilistic merge overriding hard evidence (two distinct wikidata QIDs are two distinct things).
function conflictingStrongId(a, b) {
  for (const k of ID_KEYS) if (a.ids[k] && b.ids[k] && a.ids[k] !== b.ids[k]) return k;
  return null;
}
function _jurCode(j) { const m = /([A-Z]{2})$/.exec(String(j || '').toUpperCase()); return m ? m[1] : null; }
function jurisdictionCompatible(a, b) {
  const ja = _jurCode(a.jurisdiction), jb = _jurCode(b.jurisdiction);
  if (!ja || !jb) return true;                 // unknown on either side → not a conflict
  if (ja === jb) return true;
  return ja === 'US' || jb === 'US';           // federal umbrella is compatible with a state
}
// The given-name signal — the load-bearing precision axis for people.
//   'conflict'  → two different real given names ("Janet" vs "William")     → HARD non-match
//   'full-agree'→ both full given names present + equal/nickname-equivalent → strong corroboration
//   'weak'      → one absent, or only an initial agreement ("W." vs "William")
function givenSignal(a, b) {
  const ga = a.given, gb = b.given;
  if (!ga || !gb) return 'weak';
  if (_isInitial(ga) || _isInitial(gb)) {
    const la = String(ga)[0].toLowerCase(), lb = String(gb)[0].toLowerCase();
    return la === lb ? 'weak' : 'conflict';    // an initial that DISagrees is still a conflict
  }
  const na = _canonGiven(ga), nb = _canonGiven(gb);
  return na === nb ? 'full-agree' : 'conflict';
}
function surnameAgree(a, b) {
  if (!a.surname || !b.surname) return false;
  return a.surname.toLowerCase() === b.surname.toLowerCase();
}
// Corroboration BEYOND name+jurisdiction — a non-name field that agrees (birth year, office, party).
function nonNameCorroboration(a, b) {
  if (a.birthYear && b.birthYear && a.birthYear === b.birthYear) return 'birthYear';
  if (a.office && b.office && a.office === b.office) return 'office';
  if (a.party && b.party && a.party === b.party && (a.office || b.office)) return 'party+office';
  return null;
}

// --- TYPE reconciliation (YAGO-style compatibility lattice) -----------------------------------------
// Source types are NOISY (a legislature appears as government_body / organization / office_held / even a
// mistyped person). So type is never trusted as hard identity — but it IS used: types in the same civic-body
// CLUSTER may co-refer (compatible); a person is DISJOINT from non-persons, a bill from non-bills, etc. The
// merge rule (in matchPair) NEVER auto-merges across a disjoint boundary without a shared strong id.
const TYPE_CLUSTERS = [
  new Set(['government_body', 'organization', 'committee', 'office_held', 'government', 'agency']),
];
const DISJOINT_KIND = new Set(['person', 'bill', 'place', 'event', 'document', 'concept', 'legal_instrument', 'poll', 'decision']);
function _clusterOf(t) { for (const c of TYPE_CLUSTERS) if (c.has(t)) return c; return null; }
// typeRelation(a,b) → 'same' | 'compatible' | 'disjoint' | 'unknown'. Missing type on either side → 'unknown'
// (never blocks — we don't punish absent metadata).
function typeRelation(a, b) {
  const ta = String(a.type || '').toLowerCase(), tb = String(b.type || '').toLowerCase();
  if (!ta || !tb) return 'unknown';
  if (ta === tb) return 'same';
  const ca = _clusterOf(ta), cb = _clusterOf(tb);
  if (ca && ca === cb) return 'compatible';
  if (DISJOINT_KIND.has(ta) || DISJOINT_KIND.has(tb)) return 'disjoint';
  return 'unknown';
}

// --- Fellegi-Sunter auxiliary confidence (bits of evidence; NOT the decision) -----------------------
// Per-field m = P(agree | same), u = P(agree | different). Agreement weight = log2(m/u). Conservative civic
// priors; carried as `confidence` for downstream ranking — the rule engine below owns the decision.
const FS = {
  surname: { m: 0.95, u: 0.02 }, given: { m: 0.90, u: 0.02 }, jurisdiction: { m: 0.97, u: 0.15 },
  birthYear: { m: 0.97, u: 0.008 }, office: { m: 0.85, u: 0.03 }, party: { m: 0.80, u: 0.20 },
};
function _fsBits(a, b) {
  let bits = 0;
  const add = (f, agree) => { const p = FS[f]; if (!p) return; bits += Math.log2(agree ? p.m / p.u : (1 - p.m) / (1 - p.u)); };
  if (a.surname && b.surname) add('surname', surnameAgree(a, b));
  if (a.given && b.given) add('given', givenSignal(a, b) === 'full-agree');
  if (a.jurisdiction && b.jurisdiction) add('jurisdiction', jurisdictionCompatible(a, b) && _jurCode(a.jurisdiction) === _jurCode(b.jurisdiction));
  if (a.birthYear && b.birthYear) add('birthYear', a.birthYear === b.birthYear);
  if (a.office && b.office) add('office', a.office === b.office);
  if (a.party && b.party) add('party', a.party === b.party);
  return Math.round(bits * 100) / 100;
}

// --- the decision: matchPair -----------------------------------------------------------------------
// Returns { decision:'match'|'review'|'no-match', tier, reason, confidence(bits) }. Precision-first.
function matchPair(recA, recB) {
  const a = recA.__parsed ? recA : parseEntity(recA);
  const b = recB.__parsed ? recB : parseEntity(recB);
  const confidence = _fsBits(a, b);

  const sid = sharedStrongId(a, b);
  if (sid) {
    // a shared strong id is authoritative even across a type boundary (same QID = same real entity); a crossed
    // DISJOINT boundary is a type ERROR to reconcile — flagged (typeConflict), never silently kept apart.
    if (typeRelation(a, b) === 'disjoint') return { decision: 'match', tier: 'strong-id', reason: `shared ${sid}/type-conflict(${a.type}≠${b.type})`, confidence, typeConflict: true };
    return { decision: 'match', tier: 'strong-id', reason: `shared ${sid}`, confidence };
  }

  // Two different ids in the SAME system → provably distinct; never merge (may still be a name coincidence).
  const conflict = conflictingStrongId(a, b);

  if (a.isPerson && b.isPerson) {
    const gs = givenSignal(a, b);
    if (gs === 'conflict') return { decision: 'no-match', tier: 'gate', reason: 'given-name-conflict', confidence };
    if (!surnameAgree(a, b)) return { decision: 'no-match', tier: 'gate', reason: 'surname-differs', confidence };
    if (!jurisdictionCompatible(a, b)) {
      // same surname, different jurisdiction → could be a move; never auto-merge, hand to review.
      return { decision: 'review', tier: 'probabilistic', reason: 'surname-agree/jurisdiction-differs', confidence };
    }
    if (conflict) return { decision: 'review', tier: 'probabilistic', reason: `name-agree/${conflict}-id-conflict`, confidence };
    const corr = nonNameCorroboration(a, b);
    if (gs === 'full-agree' && (a.jurisdiction || b.jurisdiction || corr)) {
      // full given+surname match within a compatible jurisdiction (or with a corroborating field) → merge.
      return { decision: 'match', tier: 'probabilistic', reason: corr ? `full-name+${corr}` : 'full-name+jurisdiction', confidence };
    }
    if (corr) return { decision: 'match', tier: 'probabilistic', reason: `surname+jurisdiction+${corr}`, confidence };
    // surname (+jurisdiction) only, given weak/absent, no corroboration → INSUFFICIENT (the Chang/LAMP case).
    return { decision: 'review', tier: 'probabilistic', reason: 'insufficient-corroboration (name+jurisdiction only)', confidence };
  }

  // Non-person (org / place / event / concept): no given-name axis. Require an exact normalized-name match,
  // and without a shared strong id it is at most REVIEW (identical names ≠ identical entity — CITY OF
  // SACRAMENTO vs CITY OF WEST SACRAMENTO differ; two "CITY OF SACRAMENTO" with distinct lda ids need a human).
  // name-agree on the EXACT nameKey OR the abbreviation-folded normKey ("U.S. Senate" ≡ "United States Senate").
  // Still only REVIEW without a shared strong id — surfacing a variant-form dup for adjudication, never an
  // auto-merge (precision unchanged; the merge comes from a strong id or the collective tie-break).
  if ((a.nameKey && a.nameKey === b.nameKey) || (a.normKey && a.normKey === b.normKey)) {
    if (conflict) return { decision: 'review', tier: 'probabilistic', reason: `name-agree/${conflict}-id-conflict`, confidence };
    // still only REVIEW (never auto-merge on name), but TAG the type relation so a downstream sweep/collective
    // step can target compatible-type same-name variants (safe-ish dups) vs disjoint-type ones (hold — likely
    // different, or a mistype needing a human).
    const base = (a.nameKey && a.nameKey === b.nameKey) ? 'name-agree' : 'normkey-agree';
    const tr = typeRelation(a, b);
    return { decision: 'review', tier: 'probabilistic', reason: `${base}/${tr}-type/no-shared-id`, confidence, typeRel: tr };
  }
  return { decision: 'no-match', tier: 'gate', reason: 'name-differs', confidence };
}

// --- resolve one candidate against a blocked set (the ANTI-FAN rule) --------------------------------
// Given the incoming record + its blocking candidates, decide what to do. A single deterministic (strong-id)
// match wins outright. Otherwise: exactly one probabilistic 'match' and no competing match/review → take it;
// ANY ambiguity (≥2 plausible, or a lone 'review') → REVIEW (hold), NEVER fan the relation onto all of them.
// Returns { action:'merge'|'mint'|'review', target?, tier, reason, ranked:[{cand,decision,confidence}] }.
function resolveAgainst(incoming, candidates = []) {
  const inc = parseEntity(incoming);
  const ranked = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const r = matchPair(inc, c);
    return { cand: c, decision: r.decision, tier: r.tier, reason: r.reason, confidence: r.confidence };
  }).sort((x, y) => y.confidence - x.confidence);

  const strong = ranked.filter((r) => r.decision === 'match' && r.tier === 'strong-id');
  if (strong.length === 1) return { action: 'merge', target: strong[0].cand, tier: 'strong-id', reason: strong[0].reason, ranked };
  if (strong.length > 1) return { action: 'review', tier: 'strong-id', reason: 'multiple strong-id matches (data conflict)', ranked };

  const matches = ranked.filter((r) => r.decision === 'match');
  const reviews = ranked.filter((r) => r.decision === 'review');
  if (matches.length === 1 && reviews.length === 0) return { action: 'merge', target: matches[0].cand, tier: matches[0].tier, reason: matches[0].reason, ranked };
  if (matches.length >= 1 || reviews.length >= 1) return { action: 'review', tier: 'probabilistic', reason: 'ambiguous — multiple candidates plausible (anti-fan hold)', ranked };
  return { action: 'mint', tier: 'none', reason: 'no candidate matched', ranked };   // genuinely new → mint (Slice 2)
}

module.exports = {
  parseEntity, sharedStrongId, conflictingStrongId, jurisdictionCompatible, givenSignal, surnameAgree,
  nonNameCorroboration, typeRelation, matchPair, resolveAgainst,
};
