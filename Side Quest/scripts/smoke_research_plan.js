/* Smoke: lib/research_plan — the structured PLAN that becomes page 1 (Pillar 0). Proves the cloud
 * input/want packaging, the validator, the normalizer's gap-filling, the deterministic fallback, and the
 * page-1 renderer. Pure: no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_plan.js
 */
'use strict';
const rp = require('../lib/research_plan');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- planInput: compact, bounded, carries the knowns ---
const inp = rp.planInput({ goal: 'research right-wing think tanks', targets: ['Heritage Foundation', 'Cato Institute'], facet: 'policy VPs', deep: true, estimate: '~10 min' });
ok(inp.knownTargets.length === 2 && inp.knownTargets[0] === 'Heritage Foundation', 'planInput carries known targets');
ok(inp.deep === true && inp.facet === 'policy VPs' && inp.estimate === '~10 min', 'planInput carries deep/facet/estimate');
ok(Array.isArray(inp.databasesAvailable) && inp.databasesAvailable.length > 0, 'planInput defaults the available databases');

// --- planWant: a JSON contract naming all six fields ---
const want = rp.planWant();
ok(/objective/.test(want) && /approach/.test(want) && /targets/.test(want) && /databases/.test(want) && /facets/.test(want) && /estimate/.test(want), 'planWant names all six plan fields');
ok(/known→unknown/i.test(want), 'planWant tells the model to ground known→unknown');
// P3 (ADAPTIVE_RESEARCH_DESIGN): every plan contract demands at least one COMPUTED sub-question —
// "research that never computes is a summary, not an analysis."
ok(/QUANTITATIVE/.test(want) && /computed number or probability/i.test(want), 'planWant demands a quantitative sub-question');
ok(/QUANTITATIVE/.test(rp.planWant('topical')) && /QUANTITATIVE/.test(rp.planWant('forecast')) && /QUANTITATIVE/.test(rp.planWant('argument')), 'the quant clause rides the COMMON contract — every kind gets it');
// Requester ≠ subject (measured 2026-08-06: "financial forensic investigation for Lucas" was
// planned as an investigation OF Lucas — six passes on the wrong subject).
ok(/REQUESTER IS THE AUDIENCE, NEVER THE SUBJECT/.test(want) && /never means investigate that person/i.test(want), 'planWant forbids reading "for <name>" as "about <name>"');
ok(/REQUESTER IS THE AUDIENCE/.test(rp.planWant('topical')) && /REQUESTER IS THE AUDIENCE/.test(rp.planWant('forecast')), 'the requester-audience clause rides the COMMON contract too');

// --- P1 the living plan: revalidate contract + pure delta application ---
const rvIn = rp.revalidateInput({ plan: { objective: 'map the orgs', approach: 'depth-first', targets: ['A', 'B'], facets: ['f1'] }, synthesis: 'S'.repeat(9000), covered: ['A'], goal: 'the goal' });
ok(rvIn.plan.targets.length === 2 && rvIn.latestSynthesis.length === 6000 && rvIn.covered[0] === 'A', 'revalidateInput bounds and carries the state');
ok(/re-?validating/i.test(rp.revalidateWant()) && /tools_sufficient/.test(rp.revalidateWant()) && /conservative/i.test(rp.revalidateWant()), 'revalidateWant frames the scientific-method re-test, conservatively');
// Phantom-need discipline (measured live: "web browsing" filed as a tool_need by a revalidator
// that cannot see the toolkit — the program has web tools).
ok(/NEVER generic infrastructure/.test(rp.revalidateWant()) && /you simply cannot see the toolkit/.test(rp.revalidateWant()), 'tool_needs forbids blind generic-infrastructure filings');
ok(rp.revalidateValidator('{"correct":true,"complete":true,"tools_sufficient":true,"add_targets":[]}').valid === true, 'validator accepts a no-change verdict');
ok(rp.revalidateValidator('<think>hm {x} tricky</think>{"correct":false,"add_targets":["C"]}').valid === true, 'validator strips reasoning blocks before locating the JSON');
ok(rp.revalidateValidator('{"complete":true}').valid === false, 'a verdict without the boolean core is rejected');
const base = { objective: 'o', approach: 'old approach', targets: ['A', 'B'], facets: [] };
const d1 = rp.applyPlanDelta(base, { correct: true, complete: true, tools_sufficient: true, add_targets: [], drop_targets: [], approach_update: null });
ok(d1.changed === false && d1.plan.targets.length === 2, 'a no-change verdict changes nothing');
const d2 = rp.applyPlanDelta(base, { add_targets: ['C', 'a'], drop_targets: ['B'], approach_update: 'new tactics: follow the money through FEC and cross-tab the grants' });
ok(d2.changed === true && d2.plan.targets.includes('C') && !d2.plan.targets.includes('B'), 'delta adds/drops targets (case-insensitive dedupe)');
ok(d2.plan.targets.filter((t) => t.toLowerCase() === 'a').length === 1, 'an add that duplicates an existing target is not doubled');
ok(/new tactics/.test(d2.plan.approach) && d2.notes.some((n) => /tactics revised/.test(n)), 'an approach update replaces tactics and is named in the notes');
ok(base.targets.length === 2 && base.approach === 'old approach', 'applyPlanDelta never mutates its input');

// --- ⭐ REV→WALK SYNC (#3890 boot_p34): a plan rev that ADDS a target must extend the WALKABLE set
// (intended_targets) and block ALL-COVERED until the target is covered or explicitly dropped — run
// #3890's rev-2 district seat never entered the walk, and ALL-COVERED fired at the 3 originals.
{
  const research = require('../lib/research');
  const orig = ['Louisiana State Legislature', 'Louisiana State Senate', 'Louisiana House of Representatives'];
  const seat = 'Louisiana State Senate District 14 incumbent (name, party, contact info)';
  const s1 = rp.applyDeltaToIntended(orig, { add_targets: [seat], drop_targets: [] });
  ok(s1.changed === true && s1.intended.length === 4 && s1.intended.includes(seat), 'a rev add extends the walkable intended set');
  ok(orig.length === 3, 'applyDeltaToIntended never mutates its input');
  ok(research.allTargetsCovered({ intended: s1.intended, covered: orig }) === false, '⭐ ALL-COVERED blocked while the rev-added target is unstarted');
  ok(research.allTargetsCovered({ intended: s1.intended, covered: [...orig, seat] }) === true, '…and opens once the added target is covered');
  const s2 = rp.applyDeltaToIntended(s1.intended, { add_targets: [], drop_targets: [seat] });
  ok(s2.changed === true && !s2.intended.includes(seat) && research.allTargetsCovered({ intended: s2.intended, covered: orig }) === true, '…or once it is explicitly dropped');
  const s3 = rp.applyDeltaToIntended(orig, { add_targets: ['louisiana state senate'], drop_targets: [] });
  ok(s3.changed === false && s3.intended.length === 3, 'an add duplicating an existing intended target (case-insensitive) is a no-op');
}

// --- ⭐ THE COMPLETION-CREDIT GATE (boot_p216, five instances one afternoon): the revalidator
// re-added the org the run had JUST completed — NLIHC/Urban/NHC/FREOPP/HPN, each within a line of
// its completion. `covered` rode the verdict INPUT and the model ignored it (a prompt rule is a
// request, a gate is enforcement); the deterministic gate credits done work instead of re-adding.
{
  const covered = ['National Low Income Housing Coalition (NLIHC)', 'Urban Institute'];
  const plan = { objective: 'o', approach: 'a', targets: ['Cato Institute'], facets: [] };
  const g1 = rp.applyPlanDelta(plan, { add_targets: ['Urban Institute'] }, { covered });
  ok(g1.changed === false && !g1.plan.targets.some((t) => /urban institute/i.test(t)) && g1.credited.length === 1,
    '⭐ an exact re-add of a completed target is credited — no plan change, no rev, no steering note');
  const g2 = rp.applyPlanDelta(plan, { add_targets: ['National Low Income Housing Coalition (NLIHC) publications, methodology documents, advocacy impact data'] }, { covered });
  ok(g2.changed === false && g2.credited.length === 1,
    '⭐ the PHRASED re-add (rev 4\'s live shape: completed org + facet tail) is credited too');
  const g3 = rp.applyPlanDelta(plan, { add_targets: ['NLIHC funder information'] }, { covered });
  ok(g3.changed === false && g3.credited.length === 1,
    'an acronym-prefixed re-add ("NLIHC funder information") credits against "(NLIHC)" in the covered name');
  const g4 = rp.applyPlanDelta(plan, { add_targets: ['Mercatus Center'] }, { covered });
  ok(g4.changed === true && g4.plan.targets.includes('Mercatus Center') && g4.credited.length === 0,
    'a genuinely new org still enters the plan — the gate credits, it never blocks discovery');
  const g5 = rp.applyPlanDelta(plan, { add_targets: ['Urban Institute'], approach_update: 'new tactics: cross-tab the funder rolls against the grant databases' }, { covered });
  ok(g5.changed === true && g5.notes.length === 1 && /tactics revised/.test(g5.notes[0]),
    'a real tactics change beside a credited add still lands — as tactics only, never as "added target"');
  const g6 = rp.applyDeltaToIntended(['Cato Institute'], { add_targets: ['NLIHC publications and methodology'] }, { covered });
  ok(g6.changed === false && g6.intended.length === 1,
    '⭐ the walkable set refuses the phrased re-add too — a saturated org is never re-opened under a longer name');
}

// --- planValidator: accepts a real plan, rejects junk/empty ---
ok(rp.planValidator('{"objective":"x","approach":"y","targets":["A"]}').valid === true, 'validator accepts a real plan object');
ok(rp.planValidator('no json here').valid === false, 'validator rejects non-JSON');
ok(rp.planValidator('{}').valid === false, 'validator rejects an empty object');

// --- normalizePlan: fills gaps from what we know ---
const np = rp.normalizePlan({ objective: 'Profile the think tanks.' }, { goal: 'g', targets: ['Heritage Foundation'], facet: 'policy VPs', deep: false, estimate: '~6 min' });
ok(np.objective === 'Profile the think tanks.', 'normalize keeps a provided objective');
ok(np.targets.length === 1 && np.targets[0] === 'Heritage Foundation', 'normalize backfills targets from knownTargets');
ok(np.databases.length > 0, 'normalize backfills databases from the canonical list');
ok(np.facets.length === 1 && /policy VPs/.test(np.facets[0]), 'normalize backfills facets from the facet');
ok(np.estimate === '~6 min', 'normalize backfills the estimate');

// discovery (no targets) → a sane placeholder, not empty
const nd = rp.normalizePlan({}, { goal: 'find right-wing energy orgs', deep: true });
ok(nd.targets.length === 1 && /identified during discovery/i.test(nd.targets[0]), 'no targets → "to be identified during discovery"');
ok(nd.facets.length >= 3, 'no facet → a default facet checklist');
ok(/parallel|structured/i.test(nd.approach), 'deep run → approach mentions the parallel/structured pass');

// --- RESEARCH KIND (entity | topical | forecast): facets + framing follow the kind, not always contacts ---
const ent = rp.normalizePlan({}, { goal: 'profile energy orgs', kind: 'entity' });
ok(ent.kind === 'entity' && ent.facets.some(f => /contact/i.test(f)), 'entity → contact facet present (the Puller path)');
const top = rp.normalizePlan({}, { goal: 'brief me on the Strait of Hormuz', kind: 'topical' });
ok(top.kind === 'topical' && !top.facets.some(f => /contact|email|phone/i.test(f)), 'topical → NO contact/email/phone facets');
ok(top.facets.some(f => /development|driver|timeline|implication/i.test(f)), 'topical → subject facets (developments/drivers/timeline)');
ok(/identified during discovery/i.test(top.targets[0]) === false, 'topical → targets are NOT "entities to discover"');
const fc = rp.normalizePlan({}, { goal: 'who wins the House', kind: 'forecast' });
ok(fc.kind === 'forecast' && fc.facets.some(f => /probabilit|estimate|base rate|driver/i.test(f)), 'forecast → forecast facets (probability/base rate/drivers)');
ok(!fc.facets.some(f => /contact|email|phone/i.test(f)), 'forecast → NO contact facets');
ok(/probability|forecast|calibrated/i.test(rp.normalizePlan({}, { kind: 'forecast' }).objective), 'forecast default objective is a prediction, not a dossier');
ok(/briefing/i.test(rp.normalizePlan({}, { kind: 'topical' }).objective), 'topical default objective is a briefing');
// planWant branches by kind
ok(/do NOT gather personal contact/i.test(rp.planWant('topical')), 'planWant(topical) forbids contact-gathering');
ok(/PROBABILITY with a range/i.test(rp.planWant('forecast')), 'planWant(forecast) demands a probability + range');
ok(/organizations\/people to profile/i.test(rp.planWant('entity')), 'planWant(entity) keeps org/people profiling');
// unknown kind → entity default (backward-compatible)
ok(rp.normalizePlan({}, { goal: 'x' }).kind === 'entity', 'no kind → entity (prior behavior)');

// --- fallbackPlan: a complete plan with the cloud absent ---
const fb = rp.fallbackPlan({ goal: 'research X', targets: ['Org A', 'Org B'], facet: 'contacts' });
ok(fb.objective && fb.approach && fb.targets.length === 2 && fb.databases.length > 0, 'fallback is a complete plan');

// --- renderPlanPage: clean page-1 markdown with every block ---
const page = rp.renderPlanPage(fb);
ok(/^# Research plan/m.test(page), 'page 1 starts with "# Research plan"');
ok(/\*\*Objective\*\*/.test(page) && /\*\*Approach\*\*/.test(page) && /\*\*Targets\*\* \(2\)/.test(page), 'page 1 has Objective/Approach/Targets(count)');
ok(/Databases & sources checked first/.test(page) && /known→unknown/.test(page), 'page 1 names the databases (known→unknown)');
ok(/Estimated time to a complete deliverable/.test(page), 'page 1 states the time estimate');
ok(/- Org A/.test(page) && /- Org B/.test(page), 'page 1 lists the targets');

// renderPlanPage tolerates a raw/partial plan (no throw, still renders)
ok(/# Research plan/.test(rp.renderPlanPage({ objective: 'just an objective' })), 'renderPlanPage tolerates a partial plan');

// --- ⭐ ARGUMENT kind (S0, methodology parity) -------------------------------------------------
// The other three kinds organise a run around a SUBJECT. This one organises it around a claim to be
// defended and the reader who will attack it — the primitive that "counter-evidence", "vulnerability"
// and the tier rule are all undefined without.
{
  const aw = rp.planWant('argument');
  ok(/thesis/.test(aw) && /hostile_reader/.test(aw) && /vulnerabilities/.test(aw), 'planWant(argument) asks for thesis + hostile reader + vulnerabilities');
  ok(/ONE PER VULNERABILITY/.test(aw), 'planWant(argument) makes each facet a dossier answering one vulnerability');
  ok(/EVEN IF IT FLATTERS THE THESIS/.test(aw), 'planWant(argument) demands claims that fail scrutiny be named even when flattering');
  ok(!/thesis/.test(rp.planWant('entity')) && !/thesis/.test(rp.planWant('topical')), 'the other kinds are untouched — no thesis requested');

  // facets ARE the vulnerabilities: research driven by where the case is weakest
  const ap = rp.normalizePlan({
    objective: 'Defend the buildout claim.',
    thesis: 'The grid was underbuilt for a decade before data centers arrived.',
    hostile_reader: 'A utility regulator who believes data centers caused the price spike.',
    vulnerabilities: ['The PJM capacity number the opposition will cite', 'The reverse-causation siting claim'],
  }, { kind: 'argument', goal: 'g' });
  ok(ap.kind === 'argument', 'normalize keeps the argument kind');
  ok(ap.facets.length === 2 && /PJM capacity/.test(ap.facets[0]), '⭐ facets are DERIVED from the vulnerabilities, one dossier each');
  ok(ap.thesis && ap.hostile_reader, 'the thesis and the hostile reader survive normalization');
  ok(/verify the facts BEFORE drafting/i.test(ap.approach), 'the default approach is facts-before-prose');

  // an argument plan with no vulnerabilities still gets defensible defaults
  const bare = rp.normalizePlan({}, { kind: 'argument', goal: 'g' });
  ok(bare.facets.length > 0 && /falsif/i.test(bare.facets[0]), 'a bare argument plan defaults to argument-shaped facets, not org profiling');
  ok(!/Direct contacts/.test(bare.facets.join(' ')), 'an argument run never defaults to contact gathering');

  // page 1 states the case before any finding
  const apage = rp.renderPlanPage(ap);
  ok(/\*\*Thesis\*\*/.test(apage) && /\*\*Hostile reader\*\*/.test(apage), 'page 1 states the thesis and names the adversary');
  ok(/Vulnerabilities this research must answer\*\* \(2\)/.test(apage), 'page 1 lists the vulnerabilities with a count');
  ok(/Dossiers — one per vulnerability/.test(apage), 'page 1 labels the facets as dossiers, not "gathered on each target"');

  // ⚠ REGRESSION (2026-07-31): normalizePlan read `kind` from the CONTEXT only, and renderPlanPage
  // calls normalizePlan(plan, {}) to tolerate a partial plan — so every rendered plan collapsed back
  // to 'entity'. A topical plan had been rendering under "Gathered on each target" since kinds were
  // added, and an argument plan would have dropped its thesis on the way to page 1.
  ok(/Aspects covered/.test(rp.renderPlanPage(rp.normalizePlan({}, { kind: 'topical', goal: 'g' }))),
    '⭐ renderPlanPage honours the plan\'s OWN kind (topical renders as "Aspects covered")');
  ok(/Forecast components/.test(rp.renderPlanPage(rp.normalizePlan({}, { kind: 'forecast', goal: 'g' }))),
    '…and a forecast plan renders as "Forecast components"');
  ok(/Gathered on each target/.test(rp.renderPlanPage(rp.normalizePlan({}, { kind: 'entity', goal: 'g' }))),
    '…and entity still renders as before');

  // an entity/topical plan carries no argument block (the section is argument-only)
  ok(!/\*\*Thesis\*\*/.test(rp.renderPlanPage(fb)), 'a non-argument plan shows no thesis block');

  // planInput only ships the argument fields when they exist (small payload otherwise)
  ok(rp.planInput({ goal: 'g' }).thesis === undefined, 'planInput omits thesis when there is none');
  ok(rp.planInput({ goal: 'g', thesis: 'T', hostileReader: 'H' }).hostileReader === 'H', 'planInput carries a thesis + hostile reader when set');
}

// ── D1 COMPLETION + THE NO-INVENTED-SPECIFICS GATE (08-29, trace#104841: a goal-only input drew
// "15% market share by year three" / "the next five years" — every number confabulated) ──────────
{
  const ctx = { goal: 'gather enough data to run forecasting scenarios for Lucas', askContext: 'Lucas: find the most up to date polling numbers for the St. Petersburg FL mayoral race and the Florida gubernatorial race\nZoe: hitting the web now' };
  ok(rp.planInput(ctx).askContext.includes('St. Petersburg'), 'planInput carries the askContext (the conversation that created the goal)');
  ok(rp.planInput({ goal: 'g' }).askContext === undefined, 'no askContext → the field is omitted (payload stays small)');
  ok(/askContext is provided, it is THE ACTUAL CONVERSATION/.test(rp.planWant()) && /NEVER introduce metrics, percentages, dollar figures/.test(rp.planWant()), 'planWant carries the grounding rail on the COMMON contract');
  const confab = JSON.stringify({ objective: "Collect data on Lucas to compute the baseline projected annual revenue growth rate for the next five years and the probability that Lucas's market share will exceed 15% by the end of year three.", approach: 'a', targets: ['t'] });
  const vd = rp.planValidatorFor(ctx)(confab);
  ok(vd.valid === false && /invents specifics/.test(vd.error) && /15\s*%|15%/.test(vd.error), '⭐ the confabulated contract (trace#104841 shape) is REJECTED — the repair retry gets the named inventions');
  const grounded = JSON.stringify({ objective: 'Gather current polling for the St. Petersburg FL mayoral race and the Florida gubernatorial race, then build scenario forecasts for both.', approach: 'a', targets: ['t'] });
  ok(rp.planValidatorFor(ctx)(grounded).valid === true, 'a grounded objective passes the gate untouched');
  const withAskedNumber = JSON.stringify({ objective: 'Compute win probabilities using the last five years of Florida election results.', approach: 'a', targets: ['t'] });
  ok(rp.planValidatorFor({ ...ctx, askContext: ctx.askContext + '\nLucas: use the last five years of results' })(withAskedNumber).valid === true, 'a specific the ASK contains is never flagged');
  ok(rp._inventedSpecifics('growth of 12% within two quarters', { goal: 'plain goal' }).length === 2, '_inventedSpecifics catches percents and word-number horizons');
  ok(rp.planValidatorFor({})('not json at all').valid === false, 'the factory still fails cleanly on unparseable raw');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
