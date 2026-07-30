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
ok(t.every(x => /^the governing body of .+ County, Florida$/.test(x)), 'every target names the JURISDICTION and describes its body functionally');
ok(t.includes('the governing body of Miami-Dade County, Florida'), 'includes Miami-Dade (hyphenated)');
ok(t.includes('the governing body of St. Johns County, Florida'), 'includes St. Johns (period)');
ok(beats.countyCommissionTargets('fl').length === 67, 'case-insensitive state code');
ok(beats.countyCommissionTargets('ZZ').length === 0, 'unknown state → empty worklist');

// --- beat descriptor ---
const b = beats.countyCommissionBeat('FL');
ok(b.id === 'county-commissions-fl', 'beat id');
ok(b.parentBeat === 'elected-officials', 'rolls up under elected-officials');
ok(b.kind === 'entity', 'entity kind');
ok(b.universeSize() === 67, 'universe size 67');
ok(/67 counties/.test(b.goal) && /cross-check|corroborat/i.test(b.goal), 'goal states the universe + corroboration discipline');
ok(b.enumerate().length === 67, 'enumerate() returns the worklist');

// --- VALIDATION shape (leash slice B — Lucas 2026-07-29): the idle sweep VALIDATES rosters, it does
// not grind per-person dossiers. That is what walked every county in the country and owned the browser.
ok(b.depth === 'validate', 'beat is validate-depth (roster validation, not a dossier grind)');
ok(Array.isArray(b.facets) && b.facets.length <= 5, `validation facet plan is SHORT (${(b.facets || []).length} facets — 2-3 passes per body, then move on)`);
ok(b.facets.some(f => /current roster/i.test(f)), 'validation confirms the current roster by name and office');
ok(b.facets.some(f => /corroborat/i.test(f)), 'validation cross-checks once against an independent source');
ok(b.facets.some(f => /changes/i.test(f)), 'validation flags vacancies/appointments/elections');
ok(!b.facets.some(f => /A-grade/i.test(f)), 'CRITICAL: no per-person A-grade contact hunt in the idle sweep');
ok(/never a per-person contact hunt/i.test(b.goal), 'the goal targets the OFFICE door, not the people');
ok(/VALIDATE/i.test(b.goal) && /not a dossier/i.test(b.goal), 'goal states the validation-not-dossier contract');
// DETECTOR FIT (boot118: climbing false absences — CT 1 → RI 3 unfound): every validation facet
// must be CREDITABLE by the coverage detector from realistic result prose, or correct work gets
// logged as absence. This binds beats' facet text to canvas_emit.coveredFacets THROUGH the seam.
{
  const ce = require('../studio/canvas_emit');
  const prose = `## City of Example\nThe current roster: Mayor Jane Doe and every officeholder named below with office and seat — `
    + `council members A. Smith (Seat 1), B. Jones (Seat 2). Corroborated against an independent source (AL.com coverage of the `
    + `swearing-in). Changes: no vacancies; two appointments in March; upcoming elections November 2026. Official contact point: `
    + `office address 710 20th St N, phone (205) 254-2000, website example.gov.`;
  const credited = ce.coveredFacets(prose, beats.VALIDATION_FACETS);
  ok(credited.length === beats.VALIDATION_FACETS.length,
    `CRITICAL: realistic validation prose credits ALL ${beats.VALIDATION_FACETS.length} facets (got ${credited.length} — an uncreditable facet manufactures false absences)`);
}

// --- coverage: fuzzy-match covered names to worklist targets ---
const c0 = beats.coverageOf(t, []);
ok(c0.done === 0 && c0.total === 67 && c0.pct === 0, 'empty covered → 0/67 (0%)');
const c1 = beats.coverageOf(t, ['Alachua County Commission', 'Board of County Commissioners of Lee County, Florida', 'Miami-Dade County']);
ok(c1.done === 3, `fuzzy coverage counts 3 (Alachua/Lee/Miami-Dade), got ${c1.done}`);
ok(c1.remaining.length === 64, 'remaining = 64');
// MIGRATION GUARD: `covered` holds thousands of entries written under the OLD title-asserting scheme.
// Coverage keys on the PLACE, so those must still count — otherwise correcting the target strings would
// silently discard real completed research and re-run it.
const cLegacy = beats.coverageOf(beats.countyCommissionTargets('LA'), [
  'Parish Council of Acadia Parish, Louisiana',   // the old synthesised form
  'Acadia Parish Police Jury',                    // the real body, as research found it
  'Caddo Parish Commission',
  'East Baton Rouge Parish Metropolitan Council',
]);
ok(cLegacy.done === 3, `CRITICAL: legacy + real-name covered entries still match (Acadia counted once), got ${cLegacy.done}`);
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

// THE REGRESSION GUARD. Target strings end up in `covered`, in the coverage report, and in what she says
// to Lucas — so a synthesised title is not an internal convention, it is a factual claim about how a
// jurisdiction is governed. It was wrong at scale: all 64 Louisiana parishes were enumerated as "Parish
// Council of X", when most are run by a POLICE JURY. Never assert a body's title we have not researched.
const la = beats.countyCommissionTargets('LA');
ok(la.length === 64, `LA enumerates 64 parishes (got ${la.length})`);
ok(la.every(x => /^the governing body of .+ Parish, Louisiana$/.test(x)), 'LA targets name the parish, not an assumed body title');
for (const banned of [/Parish Council of/i, /Police Jury/i, /Board of County Commissioners/i, /Commissioners Court/i, /County Board/i, /Borough Assembly/i]) {
  ok(!la.some(x => banned.test(x)), `CRITICAL: no LA target asserts the title ${banned} — that is for research to discover`);
}
const ak = beats.countyCommissionTargets('AK');
ok(ak.some(x => /^the governing body of .+ Borough, Alaska$/.test(x)), 'AK boroughs described functionally too');
// Incorporated municipalities keep a municipal qualifier — that distinguishes the TIER (city vs county
// government), which we do know from the gazetteer, without naming the body.
ok(beats.bodyLabel('Anchorage municipality') === 'the municipal governing body', 'municipal tier is still distinguished');
ok(beats.bodyLabel('Acadia Parish') === 'the governing body', 'county-equivalent tier asserts nothing further');

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
// Miami belongs to the CAPITAL/MAJOR-CITIES rung now — the municipal tail excludes the ladder head.
ok(!flCities.some(x => /^the municipal governing body of Miami, Florida$/.test(x)), 'Miami is NOT in the municipal tail (claimed by the capital-cities rung)');
ok(beats.capitalCityTargets('FL').some(x => /^the municipal governing body of Miami, Florida$/.test(x)), 'Miami IS in the FL capital/major-cities rung');
// Municipal titles vary as much as county ones (City Council / Board of Aldermen / Common Council /
// City Commission, and New England towns run Select Boards) — describe the tier, never the title.
ok(!flCities.some(x => /City Council|Town Council|Board of Aldermen|Village Board/i.test(x)),
  'CRITICAL: no municipal target asserts a body title');
const mBeat = beats.municipalBeat('TX');
ok(mBeat.id === 'municipalities-tx' && mBeat.parentBeat === 'elected-officials' && mBeat.depth === 'validate', 'TX municipal beat descriptor (validate depth, elected-officials parent)');
ok(mBeat.universeSize() > 1000, `TX has >1000 municipalities (got ${mBeat.universeSize()})`);
ok(mBeat.ladderRung === 4 && /mayor/i.test(mBeat.goal), 'municipal tail is ladder rung 4, goal covers mayor + council');
// display name strips the Census type word; coverage still matches
ok(beats.placeDisplayName('Birmingham city') === 'Birmingham' && beats.placeDisplayName('Autaugaville town') === 'Autaugaville', 'placeDisplayName strips the Census type suffix');
ok(beats.coverageOf(flCities.slice(0, 10), flCities.slice(0, 10)).pct === 100, 'municipal coverage matches (first 10 → 100%)');
// the combined elected-officials decomposition = county tier + municipal tier
const all = beats.electedOfficialsSubBeats();
ok(all.some(b => b.id.startsWith('county-commissions-')) && all.some(b => b.id.startsWith('municipalities-')), 'combined roster carries county + municipal tiers');
// validation still reaches the OTHER county-elected offices (sheriff, clerk, assessor, DA) — via the goal
ok(/sheriff/i.test(beats.countyCommissionBeat('FL').goal) && /clerk/i.test(beats.countyCommissionBeat('FL').goal), 'county validation still names sheriff/clerk/assessor/DA (in the goal, where instruction lives)');

// --- CAPITAL + MAJOR CITIES rung (the ladder head) + the STATE LADDER structure ---
{
  const cc = beats.capitalCityBeat('LA');
  ok(cc.id === 'capital-cities-la' && cc.depth === 'validate' && cc.ladderRung === 2, 'LA capital-cities beat: validate depth, ladder rung 2');
  const t0 = cc.enumerate()[0] || '';
  ok(/Baton Rouge/.test(t0), `the CAPITAL leads the rung (got "${t0.slice(0, 60)}")`);
  ok(cc.enumerate().some(x => /New Orleans/.test(x)) && cc.enumerate().some(x => /Shreveport/.test(x)), 'major cities ride behind the capital');
  // CONSOLIDATED GOVERNMENTS (the 2026-07-29 gazetteer fix): Nashville, Louisville, Indianapolis,
  // Baton Rouge, Augusta were absent from the ENTIRE municipal map — Census types their one real
  // government CONSOLIDATED "(balance)" / FUNCSTAT B and the generator dropped both.
  ok(beats.ladderHeadNames('TN').some(n => /Nashville-Davidson/.test(n)), 'CRITICAL: Nashville-Davidson metropolitan government resolves (was missing from the map)');
  ok(beats.ladderHeadNames('KY').some(n => /Louisville\/Jefferson/.test(n)), 'CRITICAL: Louisville/Jefferson County metro government resolves');
  ok(beats.ladderHeadNames('IN').some(n => /Indianapolis/.test(n)), 'CRITICAL: Indianapolis resolves');
  ok(beats.ladderHeadNames('LA').some(n => /Baton Rouge/.test(n)), 'CRITICAL: Baton Rouge (FUNCSTAT B) resolves');
  ok(beats.placeDisplayName('Indianapolis city (balance)') === 'Indianapolis', 'placeDisplayName strips "(balance)" + the type word');
  // matchPlace never lets a short name absorb a longer one
  ok(beats.matchPlace('SC', 'Charleston') === 'Charleston city', 'matchPlace: "Charleston" → Charleston city, never North Charleston');
  ok(beats.matchPlace('FL', 'Nowhere Ville') === null, 'matchPlace: unknown city → null (drops out, never invented)');
  // DISJOINT worklists: a head city never appears in the municipal tail (no double coverage)
  const heads = new Set(beats.ladderHeadNames('TX').map(n => beats.placeDisplayName(n).toLowerCase()));
  ok(heads.size >= 5 && !beats.municipalTargets('TX').some(t => heads.has(beats.targetPlaceKey(t))), 'CRITICAL: capital/major-city rung and municipal tail are DISJOINT');
  // the ladder rungs are declared tier-wide
  ok(beats.stateLegBeat('TX').ladderRung === 1 && beats.countyCommissionBeat('TX').ladderRung === 3
    && beats.subdivisionBeat('MI').ladderRung === 5 && beats.schoolBoardBeat('TX').ladderRung === 6, 'ladder rungs: leg=1 capital=2 county=3 municipal=4 township=5 school=6');
  ok(!beats.federalBeat().ladderRung, 'federal carries NO rung (global head, never gated behind a state)');
  ok(beats.beatLabel(cc) === 'Louisiana capital and major cities', 'capital beat label is speakable');
}

// --- FEDERAL tier (President/VP + full Congress) ---
const fed = beats.federalTargets();
ok(fed.includes('President of the United States') && fed.includes('Vice President of the United States'), 'federal includes President + VP');
ok(fed.filter(t => /United States Senator/.test(t)).length === 100, `100 US Senators (got ${fed.filter(t => /United States Senator/.test(t)).length})`);
ok(fed.filter(t => /Representative for .+Congressional District$/.test(t)).length === 435, `435 US Representatives (got ${fed.filter(t => /Representative for .+Congressional District$/.test(t)).length})`);
ok(fed.some(t => /At-Large Congressional District/.test(t)), 'single-district states use At-Large phrasing');
ok(fed.some(t => /California's 52nd Congressional District/.test(t)), 'ordinal district phrasing (California 52nd)');
ok(fed.some(t => /Delegate to the United States House.*District of Columbia|Resident Commissioner.*Puerto Rico/.test(t)), 'territorial delegates included');
const fb = beats.federalBeat();
ok(fb.id === 'federal-officials' && fb.parentBeat === 'elected-officials' && fb.depth === 'validate', 'federal beat descriptor (validate depth)');
ok(fb.universeSize() === 2 + 100 + 435 + 6, `federal universe = 543 (got ${fb.universeSize()})`);

// --- STATE LEGISLATURE tier ---
const legStates = beats.listLegislatureStates();
ok(legStates.length === 50, `50 states have a legislature beat (got ${legStates.length})`);
ok(beats.stateLegTargets('TX').join('|') === 'Texas State Senate|Texas House of Representatives', 'TX = Senate + House of Representatives');
ok(beats.stateLegTargets('CA').some(t => /California State Assembly/.test(t)), 'CA lower chamber = State Assembly');
ok(beats.stateLegTargets('VA').some(t => /House of Delegates/.test(t)), 'VA lower chamber = House of Delegates');
ok(beats.stateLegTargets('NE').length === 1 && /unicameral/i.test(beats.stateLegTargets('NE')[0]), 'NE is unicameral (single chamber target)');
const slb = beats.stateLegBeat('NY');
ok(slb.id === 'state-legislature-ny' && slb.depth === 'validate' && /COMPLETE membership/i.test(slb.goal), 'state-leg beat validates the complete roster (rung 1 — the ladder top)');

// --- TOWN / TOWNSHIP tier (New England towns + Midwest townships) ---
const subStates = beats.listSubdivisionStates();
ok(subStates.length === 20, `20 MCD-government states (got ${subStates.length})`);
ok(['CT', 'RI', 'MA', 'ME', 'NH', 'VT'].every(s => subStates.includes(s)), 'all six New England states present (the place-tier gap)');
const ctTowns = beats.subdivisionTargets('CT');
ok(ctTowns.length > 100, `CT enumerates its towns (got ${ctTowns.length}) — filled the place-tier gap`);
ok(ctTowns.every(t => / of .+, Connecticut$/.test(t)), 'every CT town target is "<body> of <town>, Connecticut"');
ok(beats.subdivisionTargets('MI').some(t => /^the township governing body of .+, Michigan$/.test(t)), 'MI townships named as jurisdictions');
// The old default here hedged with a slash — "Town Board / Select Board" — a worklist admitting it did
// not know the title and writing the guess into `covered` regardless.
ok(!beats.subdivisionTargets('CT').some(t => /Select Board|Board of Trustees|Town Board/i.test(t)),
  'CRITICAL: no township/town target asserts a body title, and none hedges with a slash');
ok(beats.subdivisionDisplayName('Bloomfield charter township') === 'Bloomfield' && beats.subdivisionDisplayName('Hartford town') === 'Hartford', 'subdivisionDisplayName strips town/charter-township suffixes');
const tb = beats.subdivisionBeat('MA');
ok(tb.id === 'townships-ma' && tb.depth === 'validate' && /town and township/i.test(tb.goal), 'MA township beat descriptor (validate depth)');
ok(!subStates.includes('CA') && !subStates.includes('TX'), 'non-MCD states (CA/TX) have no township tier');

// --- SCHOOL-BOARD tier ---
const schStates = beats.listSchoolStates();
ok(schStates.length >= 50, `school-board tier spans 50+ states (got ${schStates.length})`);
const caSchools = beats.schoolBoardTargets('CA');
ok(caSchools.length > 500, `CA enumerates its school districts (got ${caSchools.length})`);
ok(caSchools.every(t => /^the school board of .+, California$/.test(t)), 'school target = "the school board of <district>, California"');
// Districts variously have a Board of Education, Board of Trustees, or Board of Directors (PA) — "school
// board" is the generic function, not a claimed title.
ok(!caSchools.some(t => /Board of Education|Board of Trustees|Board of Directors/i.test(t)),
  'CRITICAL: no school target asserts a specific board title');
// coverage key lands on the DISTRICT (after the last " of "), not "Education"
ok(beats.targetPlaceKey('Board of Education of Los Angeles Unified School District, California').includes('los angeles'), 'school coverage key lands on the district name, not "education"');
const sbb = beats.schoolBoardBeat('TX');
ok(sbb.id === 'school-boards-tx' && sbb.depth === 'validate' && /superintendent/i.test(sbb.goal) && /elected vs appointed/i.test(sbb.goal), 'school-board beat validates members + elected-vs-appointed + superintendent');

// --- combined elected-officials roster now spans seven tiers, federal first ---
const roster = beats.electedOfficialsSubBeats();
ok(roster[0].id === 'federal-officials', 'federal beat is first (rotation priority)');
ok(['state-legislature-', 'capital-cities-', 'county-commissions-', 'municipalities-', 'townships-', 'school-boards-'].every(p => roster.some(b => b.id.startsWith(p))), 'roster spans all seven tiers (federal, state-leg, capital-cities, county, municipal, township, school)');
ok(roster.length === 1 + beats.stateLegSubBeats().length + beats.capitalCitySubBeats().length + beats.countyCommissionSubBeats().length + beats.municipalSubBeats().length + beats.subdivisionSubBeats().length + beats.schoolBoardSubBeats().length, 'roster = federal(1) + state-leg + capital + county + municipal + township + school tiers');

// --- TOPIC / CONCEPT beats (AI, power, datacenters) ---
const topics = beats.topicBeats();
ok(topics.length === 3 && topics.map(t => t.id).sort().join(',') === 'topic-ai,topic-datacenters,topic-power-infrastructure', 'three topic beats: ai, power, datacenters');
const ai = beats.topicBeat('ai');
ok(ai.lane === 'topic' && ai.kind === 'entity' && ai.depth === 'concept', 'topic beat: topic lane, deep-CONCEPT research path (facet-capped, not refusal — so it progresses through all sub-topics)');
ok(ai.enumerate().length >= 10 && ai.enumerate().some(t => /frontier AI labs/i.test(t)) && ai.enumerate().some(t => /compute and chips/i.test(t)), 'AI beat worklist covers labs + compute (concept development)');
ok(ai.facets.some(f => /debates/i.test(f)) && ai.facets.some(f => /ON THE HORIZON/i.test(f)), 'topic facets include debates + on-the-horizon (Lucas: ideas, debates, horizon)');
ok(ai.maintenanceMs === beats.TOPIC_MAINTENANCE_MS && ai.maintenanceMs < 7 * 86400000, 'topic beat carries the short (<7d) news-fast maintenance interval');
ok(beats.topicBeat('power-infrastructure').enumerate().some(t => /grid/i.test(t)) && beats.topicBeat('datacenters').enumerate().some(t => /hyperscale/i.test(t)), 'power beat covers the grid; datacenter beat covers hyperscalers');
ok(beats.topicBeat('nope') === null, 'unknown topic → null');

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

// --- findBeatsInText: which beat is a coverage question actually about? ---
// Live failure (2026-07-20): "How much have we covered on Louisiana Parishes?" was answered with the
// PORTFOLIO total (203 of 52,890) when the answer was 64 of 64. Being unresponsive, it lost the turn to
// CRM material that DID mention those parishes, and she replied about lobby clients instead.
{
  const all = beats.electedOfficialsSubBeats();
  const ids = (q) => beats.findBeatsInText(q, all).map((b) => b.id).sort();
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  ok(eq(ids('How much have we covered on Louisiana Parishes?'), ['county-commissions-la']),
    'THE LIVE CASE: "Louisiana Parishes" resolves to the LA county-equivalent beat');
  ok(eq(ids('how far along is the Michigan school board research'), ['school-boards-mi']), 'Michigan school boards');
  ok(eq(ids('what about Virginia legislature coverage'), ['state-legislature-va']), 'Virginia legislature');
  ok(ids('how much of Alaska boroughs have we done').includes('county-commissions-ak'), "Alaska's own noun (boroughs) works");

  // BOTH a state and a tier are required — either alone is too weak to answer confidently from.
  ok(ids('how much have we covered').length === 0, 'no jurisdiction named -> no match, caller falls back to portfolio');
  ok(ids('tell me about Louisiana').length === 0, 'CRITICAL: a state with no tier word must NOT match');
  ok(ids('how many parishes are there').length === 0, 'CRITICAL: a tier word with no state must NOT match');
  ok(ids('').length === 0 && beats.findBeatsInText(null, all).length === 0, 'empty/null -> no match, never throws');

  // Longest-name-first: "West Virginia" must not be read as "Virginia".
  const wv = ids('how much have we covered on West Virginia counties');
  ok(wv.includes('county-commissions-wv') && !wv.includes('county-commissions-va'),
    'CRITICAL: "West Virginia" does not match Virginia');

  // Labels are spoken aloud — an internal beat id in her mouth is jarring and uninformative.
  ok(beats.beatLabel(all.find((b) => b.id === 'county-commissions-la')) === 'Louisiana parishes', "label uses the state's own noun");
  ok(beats.beatLabel(all.find((b) => b.id === 'county-commissions-ak')) === 'Alaska boroughs', 'Alaska -> boroughs');
  ok(beats.beatLabel(all.find((b) => b.id === 'county-commissions-fl')) === 'Florida counties', 'Florida -> counties');
  ok(beats.beatLabel(null) === '', 'null beat -> empty label, never throws');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
