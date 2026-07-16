/* Smoke: lib/entity_fuse — Step 4, CANONICALIZE + FUSE. Heavy coverage: canonical-form priority
 * (strong-id ≫ degree ≫ length), relation-splinter collapse while KEEPING novel predicates, and the
 * knowledge-fusion confidence + DERIVED_FROM guard (donated facts never count as independent sources).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_entity_fuse.js
 */
'use strict';
const F = require('../lib/entity_fuse');
const CM = require('../lib/confidence_model');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- (a) canonicalForm -----------------------------------------------------------------------------
const cf1 = F.canonicalForm([{ name: 'CITY OF SACRAMENTO', degree: 40 }, { name: 'City of Sacramento [wd:Q123]', degree: 1 }, { name: 'City of Sacramento, CA', degree: 3 }]);
ok(cf1.canonicalName === 'City of Sacramento [wd:Q123]', 'canonicalForm: a strong-id-tagged form wins even at lower degree');
ok(cf1.aliases.length === 2, 'canonicalForm: the other forms become aliases');
const cf2 = F.canonicalForm([{ name: 'Jane Roe', degree: 2 }, { name: 'Jane Roe', degree: 50 }]);
ok(cf2.canonical.degree === 50, 'canonicalForm: no tags → higher degree wins (more established)');
const cf3 = F.canonicalForm([{ name: 'J. Roe', degree: 5 }, { name: 'Jane Elizabeth Roe', degree: 5 }]);
ok(cf3.canonicalName === 'Jane Elizabeth Roe', 'canonicalForm: equal degree → the fuller/longer surface name wins');
ok(F.canonicalForm([]).canonical === null && F.canonicalForm([{}]).canonical === null, 'canonicalForm: empty / nameless → null');

// --- (b) canonicalRelation -------------------------------------------------------------------------
ok(F.canonicalRelation('MARRIED_TO') === 'SPOUSE', 'relation: MARRIED_TO → SPOUSE');
ok(F.canonicalRelation('birthplace') === 'BORN_IN' && F.canonicalRelation('Place of Birth') === 'BORN_IN', 'relation: birthplace / place of birth → BORN_IN (case + spaces normalized)');
ok(F.canonicalRelation('alma mater') === 'EDUCATED_AT' && F.canonicalRelation('ALUMNUS') === 'EDUCATED_AT', 'relation: alma mater / alumnus → EDUCATED_AT');
ok(F.canonicalRelation('has-ceo') === 'CEO', 'relation: has-ceo → CEO (hyphen normalized)');
ok(F.canonicalRelation('member') === 'MEMBER_OF' && F.canonicalRelation('PRECEDED_BY') === 'SUCCEEDS', 'relation: member → MEMBER_OF; preceded_by → SUCCEEDS');
ok(F.canonicalRelation('HALF_BROTHER_KILLED_BY_ANDREW_WARD') === 'HALF_BROTHER_KILLED_BY_ANDREW_WARD', 'relation: a NOVEL predicate is KEPT verbatim (let it in, mark, churn)');
ok(F.canonicalRelation('') === null && F.canonicalRelation(null) === null, 'relation: empty/null → null');

// --- (c) fuseProvenance ----------------------------------------------------------------------------
const gov2 = F.fuseProvenance([{ url: 'https://a.gov/x' }, { url: 'https://b.gov/y' }]);
ok(gov2.grade === 'A' && gov2.independentSources === 2, 'fuse: two authoritative .gov sources → grade A, 2 independent');
ok(Math.abs(gov2.confidence - CM.calibratedConfidence({ grade: 'A', corroboration: 2 })) < 1e-9, 'fuse: confidence = calibrated(A, 2)');

const oneB = F.fuseProvenance([{ url: 'https://localnews.example/s', grade: 'B' }]);
ok(oneB.grade === 'B' && Math.abs(oneB.confidence - CM.calibratedConfidence({ grade: 'B', corroboration: 1 })) < 1e-9, 'fuse: single grade-B source → calibrated(B, 1) = 0.88');

const mirror = F.fuseProvenance([{ url: 'https://en.wikipedia.org/wiki/X', grade: 'B' }, { url: 'https://www.wikiwand.com/en/X', grade: 'B' }]);
ok(mirror.independentSources === 1, 'fuse: a Wikipedia mirror collapses to ONE independent source (no self-echo)');

const junk = F.fuseProvenance([{ url: 'https://fandom.com/x', grade: 'B' }, { url: 'https://real.gov/y' }]);
ok(junk.independentSources === 1 && junk.grade === 'A', 'fuse: a junk source is excluded from the independent count; the .gov still lifts grade to A');

// THE DERIVED_FROM guard
const derivedOnly = F.fuseProvenance([{ url: 'https://neighbor', derived: true }, { url: 'https://neighbor2', derived: true }]);
ok(derivedOnly.grade === 'D' && derivedOnly.independentSources === 0 && derivedOnly.derivedExcluded === 2, 'guard: a DERIVED-only fact → grade D, 0 independent (donation is never "well-sourced")');
ok(Math.abs(derivedOnly.confidence - CM.calibratedConfidence({ grade: 'D', corroboration: 1 })) < 1e-9, 'guard: derived-only confidence = calibrated(D,1) = 0.52, not inflated');
const mixed = F.fuseProvenance([{ url: 'https://real.gov/x' }, { url: 'https://donated', derived: true }]);
ok(mixed.independentSources === 1 && mixed.derivedExcluded === 1, 'guard: a donated fact alongside a real one does NOT raise the independent count');

ok(F.fuseProvenance([]).grade === 'D', 'fuse: no sources → grade D (unbacked)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
