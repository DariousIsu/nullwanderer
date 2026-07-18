/* Smoke: lib/beats — autonomic worklist substrate (Slice 1). Pure, offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_beats.js
 */
'use strict';
const beats = require('../lib/beats');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- enumeration: FL has exactly 67 counties, no dups ---
const t = beats.countyCommissionTargets('FL');
ok(t.length === 67, `FL enumerates 67 county targets (got ${t.length})`);
ok(new Set(t).size === 67, 'no duplicate targets');
ok(t.every(x => /^Board of County Commissioners of .+ County, Florida$/.test(x)), 'every target is a well-formed governing-body name');
ok(t.includes('Board of County Commissioners of Miami-Dade County, Florida'), 'includes Miami-Dade (hyphenated)');
ok(t.includes('Board of County Commissioners of St. Johns County, Florida'), 'includes St. Johns (period)');
ok(beats.countyCommissionTargets('fl').length === 67, 'case-insensitive state code');
ok(beats.countyCommissionTargets('ZZ').length === 0, 'unknown state → empty worklist');

// --- beat descriptor ---
const b = beats.countyCommissionBeat('FL');
ok(b.id === 'county-commissions-fl', 'beat id');
ok(b.parentBeat === 'elected-officials', 'rolls up under elected-officials');
ok(b.kind === 'entity', 'entity kind');
ok(b.universeSize() === 67, 'universe size 67');
ok(/67 counties/.test(b.goal) && /corroborate/i.test(b.goal), 'goal states the universe + corroboration discipline');
ok(b.enumerate().length === 67, 'enumerate() returns the worklist');

// --- coverage: fuzzy-match covered names to worklist targets ---
const c0 = beats.coverageOf(t, []);
ok(c0.done === 0 && c0.total === 67 && c0.pct === 0, 'empty covered → 0/67 (0%)');
const c1 = beats.coverageOf(t, ['Alachua County Commission', 'Board of County Commissioners of Lee County, Florida', 'Miami-Dade County']);
ok(c1.done === 3, `fuzzy coverage counts 3 (Alachua/Lee/Miami-Dade), got ${c1.done}`);
ok(c1.remaining.length === 64, 'remaining = 64');
const cAll = beats.coverageOf(t, t);
ok(cAll.done === 67 && cAll.pct === 100, 'all covered → 67/67 (100%)');
ok(!beats.coverageOf(t, ['Broward']).remaining.some(r => /Broward/.test(r)), 'a covered county drops out of remaining');

// --- Slice 2: all-states enumeration via the bundled Census gazetteer ---
const states = beats.listCountyStates();
ok(states.length >= 51, `enumerates 50 states + DC + territories (got ${states.length})`);
ok(!states.includes('CT') && !states.includes('RI'), 'CT & RI absent (no county government)');
ok(beats.countyCommissionTargets('TX').length === 254, `TX = 254 counties (got ${beats.countyCommissionTargets('TX').length})`);
ok(beats.countyCommissionTargets('NY').length === 62, `NY = 62 counties incl. NYC boroughs (got ${beats.countyCommissionTargets('NY').length})`);
ok(beats.countyCommissionTargets('CA').length === 58, `CA = 58 counties incl. San Francisco (got ${beats.countyCommissionTargets('CA').length})`);

// per-state governing-body phrasing: Louisiana parishes, Alaska boroughs
const la = beats.countyCommissionTargets('LA');
ok(la.length === 64 && la.every(x => /Parish Council of .+ Parish, Louisiana$/.test(x)), `LA = 64 Parish Councils (got ${la.length})`);
const ak = beats.countyCommissionTargets('AK');
ok(ak.some(x => /Borough Assembly of .+ Borough, Alaska$/.test(x)), 'AK uses Borough Assembly phrasing');

// per-state beat descriptor generalizes off FL
const btx = beats.countyCommissionBeat('TX');
ok(btx.id === 'county-commissions-tx' && btx.stateCode === 'TX' && btx.universeSize() === 254, 'TX beat descriptor');
const bla = beats.countyCommissionBeat('LA');
ok(/64 parishes/.test(bla.goal), `LA goal names parishes (${bla.goal.slice(0, 60)}…)`);

// sub-beats: one county-commission beat per county-governing state
const subs = beats.countyCommissionSubBeats();
ok(subs.length === states.length && subs.every(s => s.parentBeat === 'elected-officials'), `${subs.length} county sub-beats under elected-officials`);

// parent-beat registry (the four hardwired mandates)
ok(beats.PARENT_BEATS.length === 4, 'four parent beats');
ok(beats.PARENT_BEATS.find(b => b.id === 'elected-officials').kind === 'completeness', 'elected-officials is a completeness beat');
ok(beats.PARENT_BEATS.filter(b => b.kind === 'topic').map(b => b.id).sort().join(',') === 'ai,datacenters,power-infrastructure', 'AI/power/datacenters are topic beats');

// coverage generalizes: TX all-covered = 100%
const tx = beats.countyCommissionTargets('TX');
ok(beats.coverageOf(tx, tx).pct === 100, 'TX full coverage → 100%');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
