'use strict';
/**
 * lib/strong_id.js — T2: a strong identifier pulls a bare name IN. PURE detector + proposal builder.
 *
 * docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §6. Measured live: 287 pairs in graph_entities where the SAME
 * cleaned name exists twice, once plain and once carrying a strong id — `Duke Energy` and `Duke Energy
 * [Q1264404]`, `Microsoft` and `Microsoft [Q2283]`. Two rows, one company, and every fact about it split
 * across both.
 *
 * ── WHY THIS IS NOT WHAT THE DESIGN FIRST SAID ──────────────────────────────────────────────────
 *
 * §6 originally proposed making the strong id the IDENTITY KEY. Measuring it first showed that inverted:
 * it would key the tagged row as `wd:Q1264404` and leave the bare row at `concept:duke energy` — still
 * two objects, and now the tagged one sits on a key no future untagged mention can ever land on. It
 * MANUFACTURES the split it was meant to heal. (In the encounter log the payoff is nil either way: 45 of
 * 30,641 objects carry an id and zero duplicate keys exist to collapse.)
 *
 * So the id is not the key. The NAME stays the identity, and the id is evidence that two names are one
 * thing — which is exactly `entity_match`'s Tier-1 deterministic rule, already built and tested. This
 * module decides WHAT should merge; applying it against a store is the caller's job, the same split
 * `identity_dedup` uses.
 *
 * ── PRECISION-FIRST, BECAUSE A FALSE MERGE IS THE UNRECOVERABLE ONE ─────────────────────────────
 *
 * "Duke Energy" is almost certainly the company. "Andrew Johnson" is NOT almost certainly the president —
 * bare mentions of a common personal name are the attractor case that produced the Tracy bug and the
 * Howell false merge. Three gates, all of which must pass, or it goes to review:
 *
 *   ONE TWIN     the bare name has EXACTLY ONE id-bearing counterpart (the anti-fan rule). Two tagged
 *                twins means the bare mentions are ambiguous by construction.
 *   ONE TYPE     both rows agree on entity_type. Disagreement is T3's job to adjudicate with evidence.
 *   LOW DEGREE   a bare node with many edges has probably absorbed several distinct referents already.
 *                Merging it would fuse strangers, so it is FLAGGED for a split, never merged — the same
 *                degree tell identity_dedup splits on.
 *
 * PURE. No db, no IO, no model.
 */

const { parseEntity } = require('./entity_match');

// Above this many relations, a bare node is treated as a possible attractor rather than a fragment.
// identity_dedup uses the same signal for the same reason; the threshold is deliberately low because the
// cost of holding one merge back is a duplicate, and the cost of getting it wrong is fused strangers.
const ATTRACTOR_DEGREE = 12;

// Id systems that identify a PERSON by construction. A bioguide code is a member of Congress; an
// ocd-person id is a person. This is grounded in the id scheme itself rather than guessed from the shape
// of the name — "Duke Energy" and "Andrew Johnson" are both two tokens, and no name heuristic separates
// them. A person twin is held for review: bare personal names are the documented attractor case.
const PERSON_ID_SYSTEMS = new Set(['bioguide', 'ocd']);
const isPersonId = (ids) => Object.keys(ids || {}).some((k) => PERSON_ID_SYSTEMS.has(k)
  || (k === 'fec' && /^[HSP]/i.test(String(ids[k]))));   // FEC H/S/P = candidate (a person); C = committee

// ── THE QID PROBLEM, AND WHY THIS GATE PERMITS RATHER THAN CLASSIFIES ───────────────────────────
//
// A bioguide code says "person" by construction. A Wikidata QID says nothing — Q1264404 is a utility and
// Q34296 is Woodrow Wilson, and the id alone cannot tell them apart. The first cut of this module held
// bioguide people and cheerfully merged `Ron DeSantis` → `Ron DeSantis [wd:Q3105215]`, which is the same
// risk under a different id scheme. Incoherent, so: a QID pair needs POSITIVE evidence of being an
// institution before it may merge.
//
// This is a name pattern, and §2a-ii settled what a name pattern is allowed to do: PROPOSE, never assert.
// It is used here only to PERMIT a merge that is already gated three other ways — it never sets a type,
// and its absence is not a claim that the row IS a person. Unknown holds. That keeps the failure mode on
// the recoverable side: a held duplicate is a duplicate, a wrong merge is forever.
//
// The real answer is resolving the QID against Wikidata (§2a-ii step 1), which types it authoritatively
// with no model call. Until that runs, the institutional markers below are the conservative stand-in.
//
// WORD BOUNDARIES ARE LOAD-BEARING. Without them the short alternatives match inside ordinary names:
// `n\.?a` matched Bren·na, A·nna and Ro·na·ld, so this gate merged `Ronald Reagan` and `Anna Morton` —
// the exact rows it exists to hold. Caught by reading the live plan, not by the suite.
const INSTITUTION_RE = new RegExp('\\b(?:' + [
  'universit(y|ies)', 'college', 'school', 'academy', 'institute', 'foundation', 'department',
  'ministry', 'agency', 'authority', 'commission', 'committee', 'board', 'bureau', 'council',
  'association', 'society', 'hospital', 'clinic', 'center', 'centre', 'laborator(y|ies)', 'museum',
  'library', 'church', 'bank', 'corporation', 'company', 'holdings', 'group', 'systems?', 'services',
  'partners', 'technologies', 'industries', 'energy', 'airlines', 'motors', 'pharmaceuticals',
  'inc', 'llc', 'ltd', 'plc', 'pbc', 'l\\.?p', 'n\\.?a',
  'state of', 'city of', 'county of', 'town of', 'village of', 'district', 'republic', 'kingdom',
  'united states', 'u\\.s\\.', 'federal', 'national', 'international',
].join('|') + ')\\b', 'i');
const looksInstitutional = (name) => INSTITUTION_RE.test(String(name || ''));

// One row → { id, name, type, degree, ids, idSig, bareKey }. `bareKey` is the cleaned name with bracket
// tags removed, which is what makes the tagged and untagged rows comparable at all.
function describe(row = {}) {
  const p = parseEntity({ name: row.name, type: row.type || row.entity_type });
  const ids = p.ids || {};
  const keys = Object.keys(ids).sort();
  return {
    id: row.id,
    name: row.name,
    type: String(row.type || row.entity_type || '').toLowerCase() || null,
    degree: Number(row.degree) || 0,
    ids,
    hasId: keys.length > 0,
    idSig: keys.length ? keys.map((k) => `${k}:${ids[k]}`).join('|') : null,
    bareKey: p.nameKey || null,
    personId: isPersonId(ids),
    // Does the ID SCHEME itself tell us what kind of thing this is? lda_client and FEC-committee ids mean
    // an organisation; bioguide/ocd-person mean a person. A bare QID means nothing on its own.
    identifiesKind: isPersonId(ids) || !!ids.lda || (!!ids.fec && /^C/i.test(String(ids.fec))),
  };
}

// population: [{ id, name, entity_type|type, degree }] → { merges, review, stats }
//
// merges: [{ from, into, reason, tier }]  — `from` is absorbed into `into`; the id-bearing row wins,
//                                            because it is the one that can be verified against a register.
// review: [{ rows, reason }]              — surfaced for a human, never applied.
function planMerges(population = []) {
  const rows = (Array.isArray(population) ? population : []).map(describe).filter((r) => r.id != null && r.bareKey);

  const merges = [];
  const review = [];

  // ── Tier-1: the SAME strong id under more than one row. Deterministic — same id, same real thing.
  // Order-independent: the survivor is the highest-degree row, ties broken by lowest id, so the plan does
  // not depend on the order the population arrived in.
  const byId = new Map();
  for (const r of rows) {
    if (!r.idSig) continue;
    if (!byId.has(r.idSig)) byId.set(r.idSig, []);
    byId.get(r.idSig).push(r);
  }
  const absorbed = new Set();
  for (const [sig, group] of byId) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (b.degree - a.degree) || (a.id - b.id));
    const into = sorted[0];
    for (const r of sorted.slice(1)) {
      merges.push({ from: r.id, into: into.id, fromName: r.name, intoName: into.name, tier: 'strong-id', reason: `shared ${sig}` });
      absorbed.add(r.id);
    }
  }

  // ── Tier-2: a bare name and its id-bearing twin. Gated, see the header.
  const byBare = new Map();
  for (const r of rows) {
    if (absorbed.has(r.id)) continue;
    const k = r.bareKey;
    if (!byBare.has(k)) byBare.set(k, []);
    byBare.get(k).push(r);
  }
  for (const [bare, group] of byBare) {
    if (group.length < 2) continue;
    const tagged = group.filter((r) => r.hasId);
    const plain = group.filter((r) => !r.hasId);
    if (!tagged.length || !plain.length) continue;          // nothing to bind together

    if (tagged.length > 1) { review.push({ rows: group, reason: `${tagged.length} id-bearing twins — bare "${bare}" is ambiguous (anti-fan hold)` }); continue; }
    const into = tagged[0];

    for (const r of plain) {
      if (r.type && into.type && r.type !== into.type) { review.push({ rows: [r, into], reason: `type differs (${r.type} vs ${into.type}) — T3 adjudicates` }); continue; }
      if (into.personId) { review.push({ rows: [r, into], reason: `person id (${into.idSig}) — a bare personal name is the attractor case` }); continue; }
      // Degree is reported before the kind gate: an attractor node needs a SPLIT, and that is a more
      // serious finding than "we could not establish what kind of thing this is".
      if (r.degree > ATTRACTOR_DEGREE) { review.push({ rows: [r, into], reason: `bare node degree ${r.degree} > ${ATTRACTOR_DEGREE} — likely absorbed several referents; needs a SPLIT, not a merge` }); continue; }
      // An id that does not itself say what kind of thing this is (a bare QID) needs positive evidence.
      if (!into.identifiesKind && !looksInstitutional(into.name)) {
        review.push({ rows: [r, into], reason: `${into.idSig} does not say what kind of thing this is, and the name carries no institutional marker — unresolved, held` });
        continue;
      }
      merges.push({ from: r.id, into: into.id, fromName: r.name, intoName: into.name, tier: 'bare-into-id', reason: `bare name binds to ${into.idSig}` });
    }
  }

  return {
    merges,
    review,
    stats: { population: rows.length, withId: rows.filter((r) => r.hasId).length, merges: merges.length, review: review.length },
  };
}

module.exports = { describe, planMerges, isPersonId, looksInstitutional, ATTRACTOR_DEGREE, PERSON_ID_SYSTEMS };
