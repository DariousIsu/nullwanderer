'use strict';
/**
 * lib/identity_dedup.js — F4: the CONTEXTUAL identity-dedup SWEEP (PURE detector + proposal builder).
 *
 * F1 (lib/identity_gate) stops NEW attractors at mint time. But fragments minted BEFORE F1 — the original
 * "Tracy the finance lady" node that already ate every bare "Tracy" — still sit in the store. This sweep is
 * the retrospective arm: it scans the existing population, applies the SAME F1 identity logic, and proposes
 * reversible fixes. It never mutates — it emits proposals the operator/auto-loop apply through a logged,
 * reversible merge (proposal-first, the charter invariant).
 *
 * Two outcomes, split on DEGREE (the attractor tell):
 *   merges         — a WEAK node (bare first name / descriptor) with a UNIQUE strong same-first-name
 *                    canonical AND a LOW degree → almost certainly one person fragmented in two. Propose
 *                    merge weak→canonical (rewire edges, tombstone the weak node), reversible.
 *   attractorFlags — a weak node with the same unique canonical but a HIGH degree, OR an AMBIGUOUS match →
 *                    it likely absorbed MANY distinct people's mentions (the real Tracy bug). Blind-merging
 *                    would fuse strangers, so this is FLAGGED for an operator SPLIT (management-by-exception),
 *                    never auto-merged.
 *
 * The detector is store-agnostic: it takes a plain entity population and returns plans. Applying a merge
 * against a specific store (Puller targets, Echo entities) is the caller's job — identity_dedup only decides
 * WHAT should merge, using the same primitives that guard the front door so the two can never disagree.
 */

const gate = require('./identity_gate');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// A weak node is a merge/attractor CANDIDATE. Strong (full name / strong-id) and non-person nodes are the
// canonicals weak nodes bind TO — never themselves candidates for absorption here.
function isCandidate(ent) {
  const s = gate.referenceStrength(ent && ent.name, ent && ent.type);
  return gate.isWeak(s);
}

// Build the {name,title,roles,dept,type} context view the F1 contextualMatch expects from a population row.
function _ctx(ent) {
  return { name: ent.name, title: ent.title, roles: ent.roles, dept: ent.dept || ent.department,
           function: ent.function, type: ent.type, provisional: ent.provisional, confirmed: ent.confirmed };
}

// Confidence a weak→canonical merge is the SAME person. Role-narrowed match beats bare first-name; a very
// low degree (barely-connected fragment) is safer than a busy one. Bounded [0.55, 0.9] — never 1.0 (a name
// coincidence is always possible → operator can still reject; this is a proposal, not a promotion).
function _mergeConfidence(via, degree) {
  let c = via === 'first-name+role' ? 0.82 : 0.66;
  if (degree <= 1) c += 0.06;
  else if (degree <= 3) c += 0.03;
  return Math.max(0.55, Math.min(0.9, c));
}

/**
 * sweep(entities, opts) → { merges, attractorFlags, scanned, candidates }
 *   entities: [{ id, name, type?, title?/roles?/dept?, degree?, provisional?, confirmed? }]
 *   opts.maxMergeDegree (default 8): a weak node above this is treated as a suspected attractor (flag,
 *     don't merge) even with a unique canonical — its edges probably span multiple real people.
 *   opts.minCanonicalDegree (default 0): ignore canonicals with fewer edges than this (avoid binding to
 *     an equally-thin node); default 0 = no floor.
 */
function sweep(entities, opts = {}) {
  const list = (Array.isArray(entities) ? entities : []).filter((e) => e && e.name);
  const maxMergeDegree = opts.maxMergeDegree == null ? 8 : opts.maxMergeDegree;
  const minCanonicalDegree = opts.minCanonicalDegree || 0;
  const byId = new Map(list.map((e) => [e.id, e]));
  const merges = [], attractorFlags = [];
  let candidates = 0;

  for (const w of list) {
    if (!isCandidate(w)) continue;
    candidates++;
    const degree = Number(w.degree) || 0;
    // context = the rest of the population (contextualMatch's own attractor-guard drops weak/provisional
    // context rows, so a weak node can only bind to a CONFIRMED strong canonical — never another fragment).
    const context = list.filter((e) => e.id !== w.id).map(_ctx);
    const cm = gate.contextualMatch(w.name, context);

    if (cm.match) {
      // resolve the matched canonical row (unique by construction) and honor the degree floor
      const canonical = list.find((e) => e.id !== w.id && norm(e.name) === norm(cm.match));
      if (!canonical || (Number(canonical.degree) || 0) < minCanonicalDegree) continue;
      const via = cm.via || 'first-name';
      if (degree > maxMergeDegree) {
        attractorFlags.push({ id: w.id, name: w.name, degree, kind: 'suspected-attractor',
          canonicalHint: canonical.name, canonicalId: canonical.id,
          reason: `weak node degree ${degree} > ${maxMergeDegree}; a unique canonical exists but the edges likely span multiple people — operator SPLIT, not merge` });
      } else {
        merges.push({ fromId: w.id, fromName: w.name, intoId: canonical.id, intoName: canonical.name,
          via, degree, confidence: _mergeConfidence(via, degree),
          reason: `weak ref "${w.name}" (deg ${degree}) uniquely matches canonical "${canonical.name}" via ${via}` });
      }
    } else if (cm.ambiguous) {
      attractorFlags.push({ id: w.id, name: w.name, degree, kind: 'ambiguous',
        candidates: cm.candidates || [],
        reason: `weak ref "${w.name}" matches ${(cm.candidates || []).length} same-first-name canonicals — operator must disambiguate` });
    }
    // no match + not ambiguous → a genuinely-unknown weak node; leave it (F3 research / future context).
  }
  return { merges, attractorFlags, scanned: list.length, candidates };
}

// Plan the concrete operations a single merge implies, store-agnostically: rewire the weak node's edges to
// the canonical, carry its evidence over, tombstone the weak node. The caller executes these against its
// store (Puller targets → move observations/beliefs; Echo → merge_entities) and logs them for revert.
function planMerge(m) {
  if (!m || m.fromId == null || m.intoId == null) return null;
  return {
    fromId: m.fromId, intoId: m.intoId,
    ops: ['rewire-edges', 'carry-evidence', 'tombstone-source'],
    reversible: true,
    note: `merge ${m.fromName || m.fromId} → ${m.intoName || m.intoId} (${m.reason || ''})`,
  };
}

module.exports = { sweep, planMerge, isCandidate, _mergeConfidence };
