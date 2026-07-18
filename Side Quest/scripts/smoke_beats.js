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

// --- deep-DOSSIER depth: every board gets a complete dossier, not a shallow roster ---
ok(b.depth === 'dossier', 'beat is dossier-depth (deep-dive every board, do not waste a search)');
ok(Array.isArray(b.facets) && b.facets.length >= 6, `dossier facet plan is comprehensive (${(b.facets || []).length} facets)`);
ok(b.facets.some(f => /contact/i.test(f) && /A-grade/i.test(f)), 'dossier pursues A-grade contact info');
ok(b.facets.some(f => /minutes|agenda|meeting/i.test(f)), 'dossier pursues meetings / minutes / agendas');
ok(b.facets.some(f => /biograph/i.test(f)), 'dossier pursues member biographies');
ok(b.facets.some(f => /charter|statute|bylaw/i.test(f)), 'dossier pursues the governing charter / statute');

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

// --- MUNICIPAL tier (elected-officials granularity) ---
const mStates = beats.listPlaceStates();
ok(mStates.length >= 50, `municipal tier enumerates 50 states (got ${mStates.length})`);
const flCities = beats.municipalTargets('FL');
ok(flCities.length > 100, `FL enumerates its incorporated municipalities (got ${flCities.length})`);
ok(flCities.every(x => / of .+, Florida$/.test(x)), 'every municipal target is "<body> of <place>, Florida"');
ok(flCities.some(x => /City Council of Miami,/.test(x)), 'FL includes City Council of Miami');
ok(flCities.some(x => /Town Council of .+, Florida/.test(x)), 'FL uses Town Council phrasing for towns');
const mBeat = beats.municipalBeat('TX');
ok(mBeat.id === 'municipalities-tx' && mBeat.parentBeat === 'elected-officials' && mBeat.depth === 'dossier', 'TX municipal beat descriptor (dossier depth, elected-officials parent)');
ok(mBeat.universeSize() > 1000, `TX has >1000 municipalities (got ${mBeat.universeSize()})`);
ok(mBeat.facets.some(f => /mayor/i.test(f)) && mBeat.facets.some(f => /charter|ordinance/i.test(f)) && mBeat.facets.some(f => /A-grade/i.test(f)), 'municipal dossier covers mayor/council + charter + A-grade contacts');
// display name strips the Census type word; coverage still matches
ok(beats.placeDisplayName('Birmingham city') === 'Birmingham' && beats.placeDisplayName('Autaugaville town') === 'Autaugaville', 'placeDisplayName strips the Census type suffix');
ok(beats.coverageOf(flCities.slice(0, 10), flCities.slice(0, 10)).pct === 100, 'municipal coverage matches (first 10 → 100%)');
// the combined elected-officials decomposition = county tier + municipal tier
const all = beats.electedOfficialsSubBeats();
ok(all.length === beats.countyCommissionSubBeats().length + beats.municipalSubBeats().length, 'electedOfficialsSubBeats = county + municipal tiers');
ok(all.some(b => b.id.startsWith('county-commissions-')) && all.some(b => b.id.startsWith('municipalities-')), 'combined roster carries both tiers');
// county dossier now also pursues the OTHER county-elected offices (sheriff, clerk, assessor, DA, judges)
ok(beats.countyCommissionBeat('FL').facets.some(f => /sheriff/i.test(f) && /clerk/i.test(f)), 'county dossier now pursues sheriff/clerk/assessor/DA/judges (all county-elected offices)');

// --- Slice 2d: news-anchored maintenance matcher ---
const news = [
  { title: 'Orange County commissioner resigns amid probe', summary: 'The board will hold a special election.' },
  { title: 'Miami-Dade County commissioner sworn in after appointment', summary: '' },
  { title: 'Fresh orange juice prices climb in Florida groceries', summary: 'citrus growers report a strong season' },
  { title: 'Leon County libraries extend weekend hours', summary: 'no personnel changes' },
];
const matched = beats.matchNewsToTargets('FL', news);
ok(matched.some(t => /Orange County/.test(t)), 'news: Orange County commissioner resignation → flagged');
ok(matched.some(t => /Miami-Dade County/.test(t)), 'news: Miami-Dade appointment → flagged');
ok(!matched.some(t => /Leon County/.test(t)), 'news: Leon libraries (no change cue) → NOT flagged');
ok(!matched.some(t => /Citrus County/.test(t)), 'news: "orange juice / citrus growers" (no noun+cue) → NOT flagged (no false positive)');
ok(beats.matchNewsToTargets('FL', []).length === 0, 'no headlines → no matches');
ok(beats.matchNewsToTargets('ZZ', news).length === 0, 'unknown state → no matches');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
