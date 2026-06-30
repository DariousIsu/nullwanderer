/* Smoke: lib/intake — the systemic project-recognition gate that replaces the brittle isDirectedTask
 * regex. Proves: route() turns a cloud decision into a concrete run action; classify() calls the cloud
 * contract and falls back to null (→ regex) when the cloud is down; short/non-project turns short-circuit.
 * Pure + a mock cloud. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_intake.js
 */
'use strict';
const intake = require('../lib/intake');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- route(): decision → action (pure) ---
ok(intake.route(null).action === 'none', 'null decision → none (fail-safe)');
ok(intake.route({ isProject: false }).action === 'none', 'not a project → none');
const enr = intake.route({ isProject: true, mode: 'enrich', target: 'the 5 think tanks', facet: 'points of contact for upper leadership', priority: 'red', deep: true, subset: 'the 5 most complete', budget: { kind: 'none' }, clarify: ['which titles count as upper leadership?'] });
ok(enr.action === 'enrich' && enr.deep === true && enr.priority === 'red', 'enrich decision → enrich action, deep + red carried');
ok(enr.subset === 'the 5 most complete' && enr.clarify.length === 1, 'subset + clarify carried');
ok(intake.route({ isProject: true, mode: 'discover', target: 'X', facet: 'Y' }).action === 'discover', 'discover decision → discover action');
ok(intake.route({ isProject: true }).action === 'discover', 'project with no mode → defaults to discover');
ok(intake.route({ isProject: true, priority: 'purple' }).priority === null, 'invalid priority dropped');
ok(intake.route({ isProject: true, clarify: ['a', 'b', 'c', 'd'] }).clarify.length === 2, 'clarify capped at 2');
ok(intake.route({ isProject: true, budget: { kind: 'deadline', value: 'the 1030 meeting' } }).budget.kind === 'deadline', 'budget carried when set');

// --- subsetTopN ---
ok(intake.subsetTopN('the 5 most complete') === 5, '"the 5 most complete" → 5');
ok(intake.subsetTopN('top three') === 3, '"top three" → 3');
ok(intake.subsetTopN('the most complete five') === 5, '"most complete five" → 5');
ok(intake.subsetTopN('the think tanks') === null, 'no superlative → null (enrich ALL)');
ok(intake.subsetTopN('') === null, 'empty → null');

(async () => {
  // --- classify(): the cloud seam ---
  let captured = null;
  const capAsk = async (args) => { captured = args; return { isProject: true, mode: 'enrich', facet: 'contacts', deep: true, priority: 'red' }; };
  const d = await intake.classify('spin up a red tagged project on generating as many contacts as possible for those 5, deep', { deps: { ask: capAsk } });
  ok(captured && captured.task === 'work_intake', 'classify calls the cloud with task=work_intake');
  ok(/isProject/.test(captured.want) && /enrich/.test(captured.want) && /red/.test(captured.want), 'the contract spec names isProject/enrich/red-tag');
  ok(d && d.isProject === true && intake.route(d).action === 'enrich', "Lucas's exact red-tag phrasing → enrich project (the live miss, now caught)");

  // --- fail-safe: cloud down → null (caller falls back to the regex) ---
  ok((await intake.classify('go do the thing', { deps: { ask: async () => null } })) === null, 'cloud down → null (regex fallback engages)');

  // --- short / trivial turns short-circuit (no cloud call) ---
  let called = false;
  await intake.classify('hi', { deps: { ask: async () => { called = true; return null; } } });
  ok(called === false && true, 'a 2-char turn short-circuits before the cloud call');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
