'use strict';
/**
 * lib/puller_corrections.js — F4 correction loop: run the contextual identity-dedup SWEEP (lib/identity_dedup)
 * over the LIVE Puller target population and act on the result. This is the retrospective arm of the Tracy
 * fix — F1 guards the front door at mint time; this walks the back catalog for fragments already minted.
 *
 * DEGREE for a Puller target = its observation count (a fragment with a couple of stray observations is safe
 * to fold into its canonical; an attractor carrying dozens of observations that span multiple real people is
 * NOT — that gets flagged for an operator split, never blind-merged). TITLE comes from the person's role
 * belief so a descriptor ("the finance lady") can bind by role, not just first name.
 *
 * Policy (the ADDITIVE-gate pivot): a high-confidence, low-degree, role-narrowed merge AUTO-APPLIES (the
 * machine is better than the human at this scale) and is logged reversibly; everything softer is SURFACED as
 * a proposal/flag for the operator window. Nothing here is destructive — mergeTarget tombstones (reversible),
 * and the operator can unmerge any correction. Human = watcher + label-supplier, not a blocking gate.
 */

const pdb = require('./puller_db');
const dedup = require('./identity_dedup');

// Auto-apply only a role-narrowed match at/above this confidence AND at/below this observation degree.
const AUTO_CONFIDENCE = 0.8;
const AUTO_MAX_DEGREE = 3;

// Build the dedup population from live targets: id, name, person/org type, role→title, degree=obs count.
function buildPopulation(db = pdb, { limit = 100000 } = {}) {
  const targets = db.listTargets({ limit });
  return targets.map((t) => {
    const role = db.getBelief(t.id, 'role');
    const degree = db.listObservations(t.id).length;
    return { id: t.id, name: t.name, type: t.kind === 'org' ? 'organization' : 'person',
             title: role && role.value ? role.value : (t.function || t.notes || null), degree };
  });
}

/**
 * runSweep(opts) → { proposals, autoApplied, attractorFlags, scanned, candidates }
 *   opts.apply (default false): actually auto-apply the confident low-degree merges. When false, EVERYTHING
 *     comes back as a proposal (dry run — the safe default for a first look / the observability window).
 *   opts.autoConfidence / opts.autoMaxDegree: tune the auto-apply gate.
 */
function runSweep(opts = {}) {
  const db = opts.db || pdb;
  const apply = !!opts.apply;
  const autoConfidence = opts.autoConfidence == null ? AUTO_CONFIDENCE : opts.autoConfidence;
  const autoMaxDegree = opts.autoMaxDegree == null ? AUTO_MAX_DEGREE : opts.autoMaxDegree;

  const population = buildPopulation(db, opts);
  const { merges, attractorFlags, scanned, candidates } = dedup.sweep(population, opts);

  const proposals = [], autoApplied = [];
  for (const m of merges) {
    const eligible = apply && m.via === 'first-name+role' && m.confidence >= autoConfidence && m.degree <= autoMaxDegree;
    if (eligible) {
      try {
        const res = db.mergeTarget(m.fromId, m.intoId, { actor: 'auto-sweep', confidence: m.confidence,
          reason: m.reason });
        autoApplied.push({ ...m, correctionId: res.correctionId, movedObs: res.movedObs });
      } catch (e) { proposals.push({ ...m, error: e.message }); }
    } else {
      proposals.push(m);   // surfaced for operator review (the Puller window)
    }
  }
  return { proposals, autoApplied, attractorFlags, scanned, candidates };
}

module.exports = { runSweep, buildPopulation, AUTO_CONFIDENCE, AUTO_MAX_DEGREE };
