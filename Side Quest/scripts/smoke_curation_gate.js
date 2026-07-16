/* Smoke: lib/curation_gate — the shared CITATION GATE (curation substrate Slice 0). Fully offline/pure.
 * Exhaustively covers claim-grading, the A/B/C/D ladder thresholds, both gates (existence + fact), the
 * missing-anchor existence path, and the edge cases (bad ref, no url, out-of-range, inferred, null).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_curation_gate.js
 */
const G = require('../lib/curation_gate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const SRC = [
  { title: 'A', text: 'James Inhofe chaired the Environment and Public Works Committee.', url: 'https://ex.com/1' },
  { title: 'B', text: 'Inhofe attended the University of Tulsa.', url: 'https://ex.com/2' },
  { title: 'C', text: 'no url here', link: 'https://ex.com/3' },   // uses `link` alias
  { title: 'D', text: 'a source with no url or link at all' }       // ungradeable → no backing
];

// --- gradeForClaim: ref → grade + url ---
ok(G.gradeForClaim('S1', SRC).grade === 'B' && G.gradeForClaim('S1', SRC).url === 'https://ex.com/1', 'gradeForClaim: "S1" → B + its url (directly stated in a named source)');
ok(G.gradeForClaim('s2', SRC).grade === 'B', 'gradeForClaim: case-insensitive "s2" → B');
ok(G.gradeForClaim('S3', SRC).grade === 'B' && G.gradeForClaim('S3', SRC).url === 'https://ex.com/3', 'gradeForClaim: honors the `link` alias for url');
ok(G.gradeForClaim('S4', SRC).grade === 'D', 'gradeForClaim: a ref to a source with NO url → D (unbacked)');
ok(G.gradeForClaim('S9', SRC).grade === 'D', 'gradeForClaim: out-of-range ref → D');
ok(G.gradeForClaim('inferred', SRC).grade === 'D', 'gradeForClaim: "inferred" → D');
ok(G.gradeForClaim(null, SRC).grade === 'D', 'gradeForClaim: null ref → D');
ok(G.gradeForClaim('the second one', SRC).grade === 'D', 'gradeForClaim: prose ref → D (must be S#)');

// --- meets: ladder ordering (A strongest) ---
ok(G.meets('A', 'B') && G.meets('B', 'B'), 'meets: A and B both clear the B floor');
ok(!G.meets('C', 'B') && !G.meets('D', 'B'), 'meets: C and D do NOT clear the B floor');
ok(G.meets('C', 'C') && !G.meets('D', 'C'), 'meets: C clears C floor, D does not');
ok(!G.meets('bogus', 'C'), 'meets: an unknown grade never clears a floor');

// --- FACT gate (floor B): cited stated-in-source promotes, inference holds ---
const fCited = G.gateFact('S1', SRC);
ok(fCited.promote === true && fCited.grade === 'B' && fCited.url === 'https://ex.com/1' && fCited.confidence === 0.95, 'gateFact: a source-cited edge PROMOTES (B, 95%, url attached)');
ok(G.gateFact('inferred', SRC).promote === false, 'gateFact: an inferred edge is HELD (not promoted)');
ok(G.gateFact('S4', SRC).promote === false, 'gateFact: a ref with no backing url is HELD');

// --- AUTHORITY tier (2026-07-15, official-document weight): a registration-restricted gov TLD grades A so
// a single authoritative source (a lone official's own .gov page) auto-promotes, without a 2nd source. ---
const GOV = [{ title: 'g', text: 'Sheriff roster', url: 'https://sos.la.gov/officials' }];
ok(G.gradeForClaim('S1', GOV).grade === 'A', 'authority: a .gov single source → grade A (gradeForClaim)');
ok(G.gradeForClaims('S1', GOV).grade === 'A', 'authority: a .gov single source → grade A (gradeForClaims)');
ok(G.gateFact('S1', GOV).promote === true && G.gateFact('S1', GOV).grade === 'A', 'authority: a .gov-cited edge PROMOTES at grade A (single-source)');
ok(G.isAuthoritativeSource('https://x.mil') === true, 'authority: .mil is authoritative');
// SPOOF GUARDS — these must STAY B (never A), or auto-promote becomes spoofable via open registrations:
ok(G.gradeForClaim('S1', [{ url: 'https://govtech.com/x' }]).grade === 'B', 'spoof: govtech.com → B (not A)');
ok(G.gradeForClaim('S1', [{ url: 'https://randomco.us/x' }]).grade === 'B', 'spoof: bare .us → B (not A)');
ok(G.isAuthoritativeSource('https://x.gov.evil.com') === false, 'spoof: x.gov.evil.com (masquerade) is NOT authoritative');
ok(G.isAuthoritativeSource('https://notgov.com') === false, 'spoof: notgov.com is NOT authoritative');

// --- EXISTENCE gate (floor C): cited mints, inference does not ---
ok(G.gateExistence('S1', SRC).mint === true, 'gateExistence: a source-cited entity MINTS (B ≥ C)');
ok(G.gateExistence('inferred', SRC).mint === false, 'gateExistence: a pure inference NEVER mints (D < C)');

// --- missing-anchor existence: real sources → mint, none → hold ---
ok(G.gateAnchorExistence(SRC).mint === true && G.gateAnchorExistence(SRC).grade === 'C', 'gateAnchorExistence: real web sources → C, mint');
ok(G.gateAnchorExistence([]).mint === false && G.gateAnchorExistence([]).grade === 'D', 'gateAnchorExistence: no sources → D, hold (no hallucinated object)');
ok(G.gateAnchorExistence([{ title: 'x', text: 'y' }]).mint === false, 'gateAnchorExistence: sources without urls → hold');

// --- locked thresholds ---
ok(G.FACT_FLOOR === 'B' && G.EXISTENCE_FLOOR === 'C', 'thresholds: FACT_FLOOR=B, EXISTENCE_FLOOR=C (locked)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
