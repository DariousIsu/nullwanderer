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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
