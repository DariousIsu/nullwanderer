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

// --- RUN SHAPE (systemic reframe): shape + anchor carried; action agrees with shape ---
const prof = intake.route({ isProject: true, shape: 'profile', target: 'Emergence Water' });
ok(prof.shape === 'profile' && prof.action === 'discover', 'shape=profile → carried, action=discover (a profile is a discover-action run, bounded downstream)');
const comp = intake.route({ isProject: true, shape: 'comparables', anchor: 'Emergence Water', target: 'companies similar to Emergence Water' });
ok(comp.shape === 'comparables' && comp.anchor === 'Emergence Water', 'shape=comparables → carries the reference anchor');
ok(intake.route({ isProject: true, shape: 'enrich', mode: 'discover' }).action === 'enrich', 'shape=enrich forces action=enrich even if mode says discover');
ok(intake.route({ isProject: true, shape: 'bogus' }).shape === null, 'invalid shape dropped → null (main falls back to the regex)');
ok(intake.route({ isProject: true, mode: 'discover' }).shape === null, 'no shape field → null (cloud-down fallback path)');

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

  // ─── Slice 2b: resolve-before-decompose (resolvePlan) ─────────────────────
  const rpPlan = { intent: 'research', objects: [
    { mention: 'Sen. Curtis', type: 'person', op: 'resolve', salient: true },
    { mention: 'the webinar', type: 'event', op: 'resolve', salient: true },
    { mention: 'background', type: null, op: 'resolve', salient: false },
  ], clarify: [] };
  const rf = async (mention) => mention === 'Sen. Curtis' ? { status: 'resolved', mention, object: { degree: 320 } } : { status: 'nil', mention, reason: 'no-match' };
  const rp = await intake.resolvePlan(rpPlan, { resolveFn: rf });
  ok(rp.resolved.length === 2, 'resolvePlan: resolves only the salient targets (non-salient skipped)');
  ok(rp.resolved[0].resolution.status === 'resolved' && rp.resolved[0].resolution.object.degree === 320, 'resolved salient object carries its Echo object');
  ok(rp.needsClarification === true && rp.clarifications.some(q => /the webinar/.test(q)), 'nil salient target → a "which" clarify question (bias-to-clarify)');
  const rpAmb = await intake.resolvePlan({ objects: [{ mention: 'John Curtis', type: 'person', op: 'resolve', salient: true }] }, { resolveFn: async (m) => ({ status: 'ambiguous', mention: m, candidates: ['John Curtis (US)', 'John Curtis Marion'] }) });
  ok(rpAmb.needsClarification && /Which "John Curtis"/.test(rpAmb.clarifications[0]) && /John Curtis Marion/.test(rpAmb.clarifications[0]), 'ambiguous target → "which one?" listing the candidates');
  const rpClean = await intake.resolvePlan({ objects: [{ mention: 'A', type: 'person', op: 'resolve', salient: true }], clarify: [] }, { resolveFn: async (m) => ({ status: 'resolved', mention: m, object: { degree: 9 } }) });
  ok(rpClean.needsClarification === false && rpClean.clarifications.length === 0, 'all salient resolved → no clarification needed');
  const rpMerge = await intake.resolvePlan({ objects: [{ mention: 'B', type: 'person', op: 'resolve', salient: true }], clarify: ['pre-existing q'] }, { resolveFn: async (m) => ({ status: 'nil', mention: m }) });
  ok(rpMerge.clarifications.includes('pre-existing q') && rpMerge.clarifications.length <= 3, 'resolvePlan merges the parse clarify with its own, capped at 3');

  // buildAssignmentSeed: resolved plan → run seed (targets + objects + clarify) — the main.js activation
  const seed = intake.buildAssignmentSeed({
    resolved: [
      { mention: 'Sen. Curtis', resolution: { status: 'resolved', object: { name: 'John Curtis (US)', degree: 320 } } },
      { mention: 'the webinar', resolution: { status: 'nil' } },
    ],
    clarifications: ["I don't have a clear match for \"the webinar\" — can you point me to who or what you mean?"],
  });
  ok(seed.targets.length === 1 && seed.targets[0] === 'John Curtis (US)', 'buildAssignmentSeed: resolved entity → canonical name as a known target');
  ok(seed.objects.length === 1 && seed.objects[0].degree === 320, 'buildAssignmentSeed: carries the resolved object (prior knowledge)');
  ok(seed.clarify.length === 1 && /the webinar/.test(seed.clarify[0]), 'buildAssignmentSeed: carries the bias-to-clarify question');
  ok(seed.intendedTargets.length === 2 && seed.intendedTargets.includes('John Curtis (US)') && seed.intendedTargets.includes('the webinar') && seed.bounded === true, 'buildAssignmentSeed: intendedTargets = all salient named entities (resolved name or mention); bounded=true → run confined + terminates');
  ok(intake.buildAssignmentSeed({ resolved: [], clarifications: [] }).bounded === false, 'buildAssignmentSeed: no salient entities → bounded=false (open discovery)');
  const seed0 = intake.buildAssignmentSeed(null);
  ok(seed0.targets.length === 0 && seed0.objects.length === 0 && seed0.clarify.length === 0, 'buildAssignmentSeed(null) → empty seed (fail-safe)');
  ok(intake.buildAssignmentSeed({ resolved: [{ mention: 'A', resolution: { status: 'resolved', object: { name: 'X' } } }, { mention: 'B', resolution: { status: 'resolved', object: { name: 'X' } } }] }).targets.length === 1, 'buildAssignmentSeed: duplicate target names deduped');

  // decompose: short-circuit + fail-safe
  let dcalled = false;
  const dshort = await intake.decompose('hi', { deps: { ask: async () => { dcalled = true; return null; } } });
  ok(dcalled === false && dshort.intent === 'chat', 'decompose: <6 chars short-circuits to inert chat (no cloud call)');
  ok((await intake.decompose('who is the senator from utah', { deps: { ask: async () => null } })) === null, 'decompose: cloud down → null (caller falls back)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
