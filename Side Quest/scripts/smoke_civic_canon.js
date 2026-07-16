/* Smoke: lib/civic_canon — the curated canonical registry for hub civic bodies.
 * Verifies the fix for the demonstrated miss (re-ingesting "United States Senate" must route to the ONE
 * canonical U.S. Senate, not re-mint), AND the precision guards (ambiguous bare forms + persons never route).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_civic_canon.js
 */
'use strict';
const C = require('../lib/civic_canon');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- normalizeCivic: abbreviation folding -----------------------------------------------------------
ok(C.normalizeCivic('U.S. Senate') === 'united states senate', 'normalize: "U.S. Senate" → "united states senate"');
ok(C.normalizeCivic('US Senate') === 'united states senate', 'normalize: "US Senate" → "united states senate"');
ok(C.normalizeCivic('United States Senate') === 'united states senate', 'normalize: full form is stable');
ok(C.normalizeCivic('U.S.A.') === 'united states', 'normalize: "U.S.A." → "united states"');
ok(C.normalizeCivic('U.S. House of Representatives [wd:Q11701]') === 'united states house of representatives', 'normalize: strips [id] tag');
ok(C.normalizeCivic('United States Senate (US)') === 'united states senate', 'normalize: strips (jurisdiction)');
ok(C.normalizeCivic('Dept. of State') === 'department of state', 'normalize: dept → department');
// abbreviation must not corrupt an unrelated token that merely starts with u/s
ok(C.normalizeCivic('Universal Studios') === 'universal studios', 'normalize: does NOT touch "Universal Studios"');
ok(C.normalizeCivic('Usher') === 'usher', 'normalize: single token "Usher" untouched (not "us"+"her")');

// --- resolveCanon: the hub bodies route to ONE canonical entry ---------------------------------------
const sen = C.resolveCanon('United States Senate');
ok(sen && sen.wikidata === 'Q66096' && sen.canonical === 'United States Senate', 'resolve: "United States Senate" → Senate entry (Q66096)');
ok(C.resolveCanon('U.S. Senate') === sen, 'resolve: "U.S. Senate" → SAME Senate entry (dedup target)');
ok(C.resolveCanon('US Senate') === sen, 'resolve: "US Senate" → SAME Senate entry');

const hou = C.resolveCanon('United States House of Representatives');
ok(hou && hou.wikidata === 'Q11701', 'resolve: House → House entry (Q11701)');
ok(C.resolveCanon('U.S. House of Representatives') === hou, 'resolve: "U.S. House of Representatives" → SAME House entry');
ok(C.resolveCanon('US House of Representatives') === hou, 'resolve: "US House of Representatives" → SAME House entry');

const con = C.resolveCanon('United States Congress');
ok(con && con.wikidata === 'Q11268', 'resolve: Congress → Congress entry (Q11268)');
ok(C.resolveCanon('U.S. Congress') === con, 'resolve: "U.S. Congress" → SAME Congress entry');

// entries are distinct (no cross-collision)
ok(sen !== hou && hou !== con && sen !== con, 'resolve: the three federal bodies are distinct entries');

// --- PRECISION GUARDS: what must NOT route -----------------------------------------------------------
ok(C.resolveCanon('Senate') === null, 'guard: bare "Senate" does NOT route (could be a STATE senate)');
ok(C.resolveCanon('Congress') === null, 'guard: bare "Congress" does NOT route (Indian National Congress, etc.)');
ok(C.resolveCanon('House of Representatives') === null, 'guard: bare "House of Representatives" does NOT route (a state house)');
ok(C.resolveCanon('Virginia Senate') === null, 'guard: "Virginia Senate" does NOT route to the US Senate');
ok(C.resolveCanon('United States Senate', 'person') === null, 'guard: a PERSON-typed mention never canon-routes');
ok(C.resolveCanon('U.S. Senate', 'organization') === sen, 'guard: organization-typed hub still routes (types blur)');
ok(C.resolveCanon('U.S. Senate', 'bill') === null, 'guard: an incompatible type (bill) does NOT route');
ok(C.resolveCanon('') === null && C.resolveCanon(null) === null, 'guard: empty / null → null (no throw)');
ok(C.resolveCanon('Some Random Company LLC') === null, 'guard: an off-registry org → null (default behavior preserved)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
