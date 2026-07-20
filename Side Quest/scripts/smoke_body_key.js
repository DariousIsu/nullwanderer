/* smoke_body_key.js — stable body identity across renames.
 *
 * The load-bearing tests are the SEPARATIONS. Merging two distinct bodies into one key would silently
 * fuse their recorded gaps and seat counts, which is far worse than failing to match a rename.
 */
'use strict';
const bk = require('../lib/body_key');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── THE RENAME IT EXISTS FOR ───────────────────────────────────────────────────────────────────
ok(bk.sameBody('Parish Council of Acadia Parish, Louisiana',
  'the governing body of Acadia Parish, Louisiana') === true,
  'THE CASE: legacy synthesised title and the new functional target are the same body');
ok(bk.sameBody('Board of County Commissioners of Lee County, Florida',
  'the governing body of Lee County, Florida') === true, 'legacy county form matches');
ok(bk.sameBody('City Council of Miami, Florida',
  'the municipal governing body of Miami, Florida') === true, 'legacy municipal form matches');
ok(bk.sameBody('Board of Education of Alabaster City School District, Alabama',
  'the school board of Alabaster City School District, Alabama') === true, 'legacy school form matches');
ok(bk.sameBody('Township Board of Trustees of Acme, Michigan',
  'the township governing body of Acme, Michigan') === true, 'legacy township form matches');
ok(bk.sameBody('Town Board / Select Board of Abington, Massachusetts',
  'the town governing body of Abington, Massachusetts') === true,
  'even the slash-hedged legacy default resolves');

// ── CRITICAL SEPARATIONS: distinct bodies must never share a key ───────────────────────────────
ok(bk.sameBody('Oregon House of Representatives', 'Pennsylvania House of Representatives') === false,
  'CRITICAL: two states\' Houses stay distinct — this is exactly what targetPlaceKey got wrong');
ok(bk.sameBody('Vermont State Senate', 'Vermont House of Representatives') === false,
  'CRITICAL: two chambers of the SAME state stay distinct');
ok(bk.sameBody('the governing body of Acadia Parish, Louisiana',
  'the governing body of Allen Parish, Louisiana') === false, 'different parishes stay distinct');
ok(bk.sameBody('the governing body of Orange County, Florida',
  'the governing body of Orange County, California') === false,
  'CRITICAL: same county name, different state — the state token must survive');
ok(bk.sameBody('the municipal governing body of Miami, Florida',
  'the governing body of Miami-Dade County, Florida') === false,
  'CRITICAL: a city and the county around it are different bodies');

// ── an unrecognised name keeps its own identity (the safe failure) ─────────────────────────────
ok(bk.normalizeBody('Louisiana Parish Attorneys Association') === 'louisiana parish attorneys association',
  'a name we did not construct passes through, never merged into something else');
ok(bk.sameBody('Some Body We Never Named', 'Some Other Body') === false, 'unknown names stay separate');

// ── cosmetic normalisation ─────────────────────────────────────────────────────────────────────
ok(bk.sameBody('the governing body of St. Johns County, Florida',
  'the governing body of St Johns County, Florida') === true, 'punctuation differences collapse');
ok(bk.sameBody('THE GOVERNING BODY OF Acadia Parish, Louisiana',
  'the governing body of acadia parish, louisiana') === true, 'case-insensitive');
ok(bk.sameBody('the governing body of  Acadia  Parish,  Louisiana',
  'the governing body of Acadia Parish, Louisiana') === true, 'whitespace collapses');

// ── degenerate input is fail-soft ──────────────────────────────────────────────────────────────
ok(bk.normalizeBody('') === '' && bk.normalizeBody(null) === '' && bk.normalizeBody(undefined) === '',
  'empty/null/undefined → empty string, never throws');
ok(bk.sameBody('', '') === false, 'CRITICAL: two empty names are NOT the same body');
ok(bk.sameBody(null, 'anything') === false, 'null never matches');
// A bare prefix with nothing after it must not become a universal match-all key.
ok(bk.sameBody('the governing body of ', 'the school board of ') === false,
  'CRITICAL: prefix-only strings do not collapse into one shared empty key');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
