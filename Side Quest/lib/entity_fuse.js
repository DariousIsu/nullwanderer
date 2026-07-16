'use strict';
/**
 * lib/entity_fuse.js — Step 4 of the node-resolution-&-fusion gate: CANONICALIZE + FUSE
 * (docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md §3/§4; CESI-style canonicalization + Knowledge-Vault fusion).
 *
 * When Steps 1-3 decide a MATCH, this stage:
 *   (a) canonicalForm — picks the SURVIVING form of a merge cluster (the others alias in via SAME_AS):
 *       a strong-id-tagged form wins, then the higher-degree/fuller name.
 *   (b) canonicalRelation — collapses freeform / LLM-extracted predicate splinters onto the core vocab
 *       (SPOUSE/MARRIED_TO, BORN_IN/BIRTHPLACE, …) — the 246-singleton fix — while KEEPING a genuinely novel
 *       predicate ("let it in, mark, churn").
 *   (c) fuseProvenance — fuses multi-source facts into ONE calibrated, well-provenanced confidence. The
 *       DERIVED_FROM guard (Knowledge-Vault / the node-enrichment track): a donated/neighbor-diffused fact
 *       is EXCLUDED from the independent-source count, so donation can never inflate a node into looking
 *       "well-sourced". Independence is mirror-collapsed (corroboration) and source-authority raises grade.
 *
 * PURE — composes confidence_model + corroboration + curation_gate; no I/O → exhaustively offline-testable.
 */
const confModel = require('./confidence_model');
const corroboration = require('./corroboration');
const { isAuthoritativeSource, isJunkSource } = require('./curation_gate');

// --- (a) canonical FORM selection ------------------------------------------------------------------
function _hasStrongIdTag(name) {
  return /\[(?:wd:Q\d+|Q\d+|(?:FEC:)?C\d{7,}|M\d{6}|lda_client:\d+|ocd-)/i.test(String(name || ''));
}
// canonicalForm(records) → { canonical, canonicalName, aliases }. Priority: a strong-id tag (authoritative
// anchor) ≫ higher degree (more established) ≫ longer/fuller surface name. Deterministic.
function canonicalForm(records = []) {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && r.name);
  if (!recs.length) return { canonical: null, canonicalName: null, aliases: [] };
  const score = (r) => (_hasStrongIdTag(r.name) ? 1e12 : 0) + (Number(r.degree) || 0) * 1000 + String(r.name).length;
  const sorted = recs.slice().sort((a, b) => score(b) - score(a));
  return { canonical: sorted[0], canonicalName: sorted[0].name, aliases: sorted.slice(1) };
}

// --- (b) canonical RELATION predicate --------------------------------------------------------------
// Same-DIRECTION synonyms only (inverse predicates like CHILD_OF are deliberately NOT collapsed here — that
// needs endpoint-swapping the caller owns). Extends doc_decompose's REL_VOCAB with the observed splinters.
const REL_SYNONYM = {
  MARRIED_TO: 'SPOUSE', WIFE_OF: 'SPOUSE', HUSBAND_OF: 'SPOUSE', WED_TO: 'SPOUSE',
  HAS_CEO: 'CEO', CEO_OF: 'CEO', CHIEF_EXECUTIVE_OFFICER: 'CEO',
  FOUNDED_BY: 'FOUNDER', FOUNDER_OF: 'FOUNDER', CO_FOUNDER: 'FOUNDER', COFOUNDER: 'FOUNDER',
  BIRTHPLACE: 'BORN_IN', BIRTH_PLACE: 'BORN_IN', PLACE_OF_BIRTH: 'BORN_IN', BORN_AT: 'BORN_IN',
  DIED_AT: 'DIED_IN', PLACE_OF_DEATH: 'DIED_IN', DEATH_PLACE: 'DIED_IN',
  EMPLOYED_BY: 'WORKS_FOR', EMPLOYEE_OF: 'WORKS_FOR', WORKS_AT: 'WORKS_FOR',
  MEMBER: 'MEMBER_OF', MEMBER_OF_ORG: 'MEMBER_OF',
  FATHER_OF: 'PARENT_OF', MOTHER_OF: 'PARENT_OF',
  LOCATION: 'LOCATED_IN', LOCATED_AT: 'LOCATED_IN', BASED_IN: 'LOCATED_IN', HEADQUARTERED_IN: 'LOCATED_IN',
  ALMA_MATER: 'EDUCATED_AT', ALUMNUS: 'EDUCATED_AT', ALUMNA: 'EDUCATED_AT', ATTENDED: 'EDUCATED_AT', STUDIED_AT: 'EDUCATED_AT',
  PRECEDED_BY: 'SUCCEEDS', PREDECESSOR: 'SUCCEEDS', SUCCEEDED_BY: 'PRECEDES', SUCCESSOR: 'PRECEDES',
};
function canonicalRelation(pred) {
  const norm = String(pred == null ? '' : pred).trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z_]/g, '').replace(/^_+|_+$/g, '');
  if (!norm) return null;
  return REL_SYNONYM[norm] || norm;   // known splinter → core; else keep the novel predicate (churn later)
}

// --- (c) provenance FUSION -------------------------------------------------------------------------
const _GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, E: 4 };
function _strongestGrade(grades) {
  let best = null;
  for (const g of grades) { const u = String(g || '').trim().toUpperCase(); if (u in _GRADE_RANK && (best === null || _GRADE_RANK[u] < _GRADE_RANK[best])) best = u; }
  return best;
}
// fuseProvenance(sources, opts) → { confidence, grade, independentSources, derivedExcluded }.
//   sources: [{ url?, grade?, derived? }]  — `derived:true` = donated/neighbor-diffused (DERIVED_FROM guard)
// Independence = mirror-collapsed count of NON-derived, non-junk source urls. A source on a registration-
// restricted authority (.gov/.mil) lifts grade to A. DERIVED-ONLY facts are capped at grade D — a donated
// fact is never, by itself, "well-sourced".
function fuseProvenance(sources = [], { extraIndependent = 0 } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean);
  const nonDerived = list.filter((s) => !s.derived);
  const independentUrls = nonDerived.filter((s) => s.url && !isJunkSource(s.url)).map((s) => s.url);
  const independent = (independentUrls.length ? corroboration.corroborationCount(independentUrls) : 0) + (Number(extraIndependent) || 0);

  let grade;
  if (!nonDerived.length) grade = 'D';   // derived-only → never counts as well-sourced
  else {
    const grades = nonDerived.map((s) => (s.url && isAuthoritativeSource(s.url)) ? 'A' : (s.grade || null)).filter(Boolean);
    grade = _strongestGrade(grades) || 'C';
  }
  const confidence = confModel.calibratedConfidence({ grade, corroboration: Math.max(1, independent) });
  return { confidence, grade, independentSources: independent, derivedExcluded: list.length - nonDerived.length };
}

module.exports = { canonicalForm, canonicalRelation, fuseProvenance, REL_SYNONYM };
