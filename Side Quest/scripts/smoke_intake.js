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

  // ─── Slice 2a: the DECOMPOSITION parse contract ───────────────────────────
  // routeDecomposition (pure)
  const rdEmpty = intake.routeDecomposition(null);
  ok(rdEmpty.ok === false && rdEmpty.intent === 'chat' && rdEmpty.objects.length === 0, 'routeDecomposition(null) → inert chat plan (fail-safe, no action)');
  ok(intake.routeDecomposition({ intent: 'frobnicate' }).intent === 'answer', 'unknown intent → answer (respond, never fire heavy machinery)');
  const rdObj = intake.routeDecomposition({ intent: 'research', objects: [{ mention: 'Sen. Curtis', type: 'person', op: 'resolve', salient: true }, { mention: '', type: 'person' }, { mention: 'the webinar', type: 'bogus' }] });
  ok(rdObj.objects.length === 2, 'objects: empty-mention dropped');
  ok(rdObj.objects[0].type === 'person' && rdObj.objects[0].salient === true, 'object keeps valid type + salient');
  ok(rdObj.objects[1].type === null && rdObj.objects[1].op === 'resolve', 'unknown type → null; op defaults to resolve');
  const rdRel = intake.routeDecomposition({ intent: 'schedule', relations: [{ source: 'the meeting', type: 'about', target: 'the webinar' }, { source: 'a', type: '', target: 'b' }] });
  ok(rdRel.relations.length === 1 && rdRel.relations[0].type === 'about', 'relations: require source+type+target (incomplete dropped)');
  const rdCon = intake.routeDecomposition({ intent: 'schedule', constraints: [{ kind: 'temporal', value: 'tomorrow', binds: 'the meeting' }, { kind: 'bogus', value: 'x' }, { value: '' }] });
  ok(rdCon.constraints.length === 2 && rdCon.constraints[0].kind === 'temporal' && rdCon.constraints[1].kind === 'other', 'constraints: value required, unknown kind → other');
  ok(intake.routeDecomposition({ intent: 'x', clarify: ['a', 'b', 'c', 'd'] }).clarify.length === 3, 'clarify capped at 3 (bias-to-clarify raises intake\'s 2)');
  ok(intake.routeDecomposition({ intent: 'research', deliverable: 'prep sheet' }).deliverable === 'prep sheet' && intake.routeDecomposition({ intent: 'chat' }).deliverable === null, 'deliverable carried / null');

  // The reference meeting utterance — three-bucket sort (mock cloud returns the parse)
  const meetingParse = {
    intent: 'research', deliverable: 'prep sheet',
    objects: [
      { mention: 'Sen. Curtis', type: 'person', op: 'resolve', salient: true },
      { mention: "Sen. Curtis' team", type: 'organization', op: 'resolve', salient: true },
      { mention: 'the meeting tomorrow', type: 'event', op: 'resolve', salient: true },
      { mention: 'the upcoming webinar', type: 'event', op: 'resolve', salient: true },
    ],
    relations: [{ source: 'the meeting tomorrow', type: 'about', target: 'the upcoming webinar' }],
    constraints: [{ kind: 'temporal', value: 'tomorrow', binds: 'the meeting tomorrow' }, { kind: 'speaker', value: 'we', binds: null }],
    clarify: [],
  };
  let capd = null;
  const mp = await intake.decompose('Hey Zoe, we have a meeting with Sen. Curtis\' team tomorrow about the upcoming webinar, can you get a prep sheet together on what we\'re talking about and the people in the meeting?', { deps: { ask: async (a) => { capd = a; return meetingParse; } } });
  ok(capd && capd.task === 'decompose', 'decompose calls the cloud with task=decompose');
  const plan = intake.routeDecomposition(mp);
  ok(plan.intent === 'research' && plan.deliverable === 'prep sheet', 'meeting utterance → research intent + prep-sheet deliverable');
  ok(plan.objects.length === 4 && intake.salientTargets(plan).length === 4, 'four salient objects to resolve (Curtis, his team, the meeting, the webinar)');
  ok(plan.constraints.find(c => c.kind === 'temporal' && c.binds === 'the meeting tomorrow'), '"tomorrow" is a temporal constraint binding the meeting (not a lookup)');
  ok(plan.constraints.find(c => c.kind === 'speaker'), '"we" sorted as a speaker constraint, not an object');
  ok(plan.relations[0].type === 'about', 'relation: meeting ABOUT webinar');

  // salientTargets filter (only salient + resolve)
  ok(intake.salientTargets({ objects: [{ mention: 'A', salient: true, op: 'resolve' }, { mention: 'B', salient: false, op: 'resolve' }, { mention: 'C', salient: true, op: 'create' }] }).length === 1, 'salientTargets: only salient + resolve');

  // decompose: short-circuit + fail-safe
  let dcalled = false;
  const dshort = await intake.decompose('hi', { deps: { ask: async () => { dcalled = true; return null; } } });
  ok(dcalled === false && dshort.intent === 'chat', 'decompose: <6 chars short-circuits to inert chat (no cloud call)');
  ok((await intake.decompose('who is the senator from utah', { deps: { ask: async () => null } })) === null, 'decompose: cloud down → null (caller falls back)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
