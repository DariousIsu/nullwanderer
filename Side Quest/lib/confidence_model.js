'use strict';
/**
 * lib/confidence_model.js — C3 of the confidence engine (see
 * docs/AUTONOMOUS_SELF_CURATING_DB_ARCHITECTURE.md §Step-2).
 *
 * Replaces the fixed per-grade cap (A=1.0 … E=0.30, corroboration-BLIND) with a
 * CALIBRATED probability that RISES with INDEPENDENT corroboration (from
 * lib/corroboration). The fixed cap was backwards for a KG: for a send-safety
 * model "corroboration never exceeds the cap"; for a knowledge graph
 * corroboration is exactly what SHOULD raise belief (Knowledge Vault /
 * truth-discovery). Confidence = P(the fact is true).
 *
 * Form: a grade-anchored single-source prior, then each additional INDEPENDENT
 * source removes a fixed fraction (1-κ) of the remaining doubt — a bounded,
 * monotone "noisy-OR" of independent confirmations that starts at the prior and
 * asymptotes to (near) certainty. Deterministic + pure; scored by the forecast
 * Brier/ECE harness (lib/calibration) against the fixed-0.8 baseline.
 */

// Single-source reliability P(true | one source of this grade). Calibrated to
// the verified-fact holdout in smoke_confidence_model (grade-B single source ≈
// 0.88, not the old hard 0.95 cap).
const GRADE_PRIOR = { A: 0.97, B: 0.88, C: 0.72, D: 0.52, E: 0.33 };
const DEFAULT_PRIOR = GRADE_PRIOR.C;

// Residual-doubt retained per ADDITIONAL independent source. 0.5 → each
// independent corroboration halves the remaining doubt.
const KAPPA = 0.5;

const CONF_FLOOR = 0.02, CONF_CEIL = 0.995;

function _clamp(x) { return Math.max(CONF_FLOOR, Math.min(CONF_CEIL, x)); }

function gradePrior(grade) {
  const g = String(grade == null ? '' : grade).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(GRADE_PRIOR, g) ? GRADE_PRIOR[g] : DEFAULT_PRIOR;
}

/**
 * Calibrated confidence for a fact.
 *   grade         source quality of the strongest source (A–E)
 *   corroboration count of INDEPENDENT sources (from corroboration.corroborationCount); min 1
 * Returns P(true) in [0.02, 0.995], monotonically increasing in corroboration.
 */
function calibratedConfidence({ grade = 'C', corroboration = 1 } = {}) {
  const n = Math.max(1, Math.floor(Number(corroboration) || 1));
  const p1 = gradePrior(grade);
  const doubt = (1 - p1) * Math.pow(KAPPA, n - 1);   // residual doubt after n independent sources
  return _clamp(1 - doubt);
}

// Derive an A–E letter from a calibrated probability (for display / gate bands).
// Thresholds chosen so the letter round-trips a single-source prior back to its grade.
function gradeFromConfidence(p) {
  const x = Number(p);
  if (!(x >= 0)) return 'E';
  if (x >= 0.95) return 'A';
  if (x >= 0.85) return 'B';
  if (x >= 0.68) return 'C';
  if (x >= 0.45) return 'D';
  return 'E';
}

module.exports = {
  GRADE_PRIOR, KAPPA, CONF_FLOOR, CONF_CEIL,
  gradePrior, calibratedConfidence, gradeFromConfidence,
};
