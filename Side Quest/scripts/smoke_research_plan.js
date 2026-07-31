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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
