/* Smoke: lib/research_preflight — P0 of ADAPTIVE_RESEARCH_DESIGN (the universal step-0).
 * Deterministic: ask/search/recordNeed all injected. Guards: the contract's fields, the verdict
 * validator, the study loop (only when queries are asked for), gap filing, guidance rendering,
 * and fail-open on every failure shape.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_preflight.js
 */
'use strict';
const pf = require('../lib/research_preflight');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- inventory + input + want ---
  const inv = pf.inventoryText({ operatorToolNames: ['web_search', 'analyze_data'], deepLane: ['nonprofit_lookup', 'forecast_query'], webLane: ['web_fetch'], skills: ['puller-verification'] });
  ok(/OPERATOR TOOLS: web_search, analyze_data/.test(inv) && /RESEARCH DEEP LANE: nonprofit_lookup/.test(inv), 'inventory lists the real tool names by group');
  ok(/PROVEN SKILLS: puller-verification/.test(inv) && /500\+ structured tools/.test(inv), 'inventory carries skills + the echo escape hatch');
  const inp = pf.preflightInput({ goal: 'map the foundations', kind: 'entity', inventory: inv });
  ok(inp.goal === 'map the foundations' && inp.toolInventory.includes('nonprofit_lookup') && !('studyNotes' in inp), 'input carries goal+inventory, omits empty study');
  const want = pf.preflightWant();
  ok(/knows_class/.test(want) && /tool_picks/.test(want) && /missing_capabilities/.test(want) && /quant_questions/.test(want), 'want names the full contract');
  ok(/do not study for the sake of it/.test(want) && /at least one quantitative pick/i.test(want), 'want binds study-restraint + the quant pick');

  // --- validator ---
  ok(pf.preflightValidator('{"knows_class":true,"tool_picks":[]}').valid === true, 'validator accepts a minimal verdict');
  ok(pf.preflightValidator('<think>{junk}</think>{"knows_class":false,"tool_picks":[{"tool":"x","for":"y"}]}').valid === true, 'validator strips think blocks first');
  ok(pf.preflightValidator('{"tool_picks":[]}').valid === false && pf.preflightValidator('prose').valid === false, 'a non-verdict is rejected');

  // --- run: BANKED craft → one ask, no study, banked method rides the input ---
  // (Craft memory, Lucas 2026-08-06: a model asked to self-assess always claims competence, so
  // "knows_class" alone no longer skips school — only a FRESH banked study note does.)
  const verdictKnown = { knows_class: true, method: 'follow the money through 990s', study_queries: [], tool_picks: [{ tool: 'nonprofit_lookup', for: '990 filings' }, { tool: 'analyze_data', for: 'grant cross-tabs' }], missing_capabilities: [], quant_questions: ['total grant flow by recipient'] };
  let asks = 0, searches = 0, needs = [];
  let seenInput = null;
  let r = await pf.run({ goal: 'g', kind: 'entity', deps: {
    ask: async (o) => { asks++; seenInput = o.input; return verdictKnown; },
    search: async () => { searches++; return 'notes'; },
    recordNeed: (n) => needs.push(n),
    craftGet: () => ({ method: 'banked: trace 990 Schedule I first', ts: Date.now() }),
  } });
  ok(asks === 1 && searches === 0 && r.studied === false, 'FRESH banked craft → one ask, no study pass');
  ok(seenInput && /banked: trace 990 Schedule I/.test(seenInput.knownCraft || ''), 'the banked craft note rides the ask input (learning is APPLIED, not re-derived)');
  ok(/applying an earlier study pass/.test(r.guidance), 'guidance says the method comes from an earlier study');
  ok(/TOOLKIT CHOSEN: nonprofit_lookup \(990 filings\); analyze_data/.test(r.guidance), 'guidance records method + toolkit');
  ok(/QUANTITATIVE QUESTIONS THIS RUN MUST COMPUTE: total grant flow/.test(r.guidance) && !/CAPABILITY GAPS/.test(r.guidance), 'guidance carries quant questions, omits empty gaps');

  // --- run: NO banked craft → study is FORCED even when the model claims competence ---
  asks = 0; searches = 0;
  let bankedPut = null, seenQuery = null;
  r = await pf.run({ goal: 'g', kind: 'entity', deps: {
    ask: async () => { asks++; return verdictKnown; },   // claims knows_class:true, no study queries
    search: async (q) => { searches++; seenQuery = q; return 'craft notes from the web'; },
    craftPut: (k, m) => { bankedPut = { k, m }; },
  } });
  ok(asks === 2 && searches === 1 && r.studied === true, 'no banked craft → study FORCED despite claimed competence (structural, not self-assessed)');
  ok(/investigative research methodology best practices/.test(seenQuery || ''), 'the forced query studies the CRAFT, not the subject');
  ok(bankedPut && bankedPut.k === 'entity' && /follow the money/.test(bankedPut.m), 'the studied method is BANKED for the class — later runs start from it');
  // a STALE banked note behaves like no note (restudy after the TTL)
  asks = 0; searches = 0;
  r = await pf.run({ goal: 'g', kind: 'entity', deps: {
    ask: async () => { asks++; return verdictKnown; },
    search: async () => { searches++; return 'notes'; },
    craftGet: () => ({ method: 'old', ts: Date.now() - pf.CRAFT_TTL_MS - 1000 }),
  } });
  ok(searches === 1 && r.studied === true, 'a stale banked note (past the TTL) triggers a restudy');
  // no search dep → forced study structurally impossible, run still completes (the beat lane shape)
  asks = 0;
  r = await pf.run({ goal: 'g', kind: 'entity', deps: { ask: async () => { asks++; return verdictKnown; } } });
  ok(asks === 1 && r && r.studied === false, 'no search dep (bg lane) → no forced study, preflight still completes');

  // --- run: unfamiliar craft → study pass → re-ask; gaps filed + rendered ---
  const verdictStudy1 = { knows_class: false, method: 'tbd', study_queries: ['how do investigative journalists trace nonprofit funding'], tool_picks: [], missing_capabilities: [], quant_questions: [] };
  const verdictStudy2 = { knows_class: false, method: 'studied: use 990 Schedule I + FEC overlays', study_queries: [], tool_picks: [{ tool: 'fec_lookup', for: 'PAC ties' }], missing_capabilities: ['NC state-level campaign finance filings'], quant_questions: ['donor overlap probability'] };
  asks = 0; searches = 0; needs = [];
  r = await pf.run({ goal: 'g', kind: 'entity', deps: {
    ask: async (o) => { asks++; return (o.input && o.input.studyNotes) ? verdictStudy2 : verdictStudy1; },
    search: async () => { searches++; return 'journalists use Schedule I grant lists and cross-reference FEC'; },
    recordNeed: (n) => needs.push(n),
  } });
  ok(asks === 2 && searches === 1 && r.studied === true, 'unfamiliar craft → study search → re-ask with notes');
  ok(/informed by a study pass/.test(r.guidance) && /studied: use 990 Schedule I/.test(r.guidance), 'the studied method wins the guidance');
  ok(needs.length === 1 && /NC state-level/.test(needs[0]), 'a missing capability is FILED as a build need');
  ok(/KNOWN CAPABILITY GAPS/.test(r.guidance) && /never pretend coverage/.test(r.guidance), 'the gap is carried honestly in the guidance');

  // --- fail-open shapes ---
  ok(await pf.run({ goal: 'g', deps: { ask: async () => null } }) === null, 'a null verdict → null (plan proceeds as before)');
  ok(await pf.run({ goal: 'g', deps: { ask: async () => { throw new Error('cloud down'); } } }) === null, 'an ask throw → null, never a throw upward');
  ok(await pf.run({ goal: '', deps: { ask: async () => verdictKnown } }) === null, 'no goal → null');
  // a dry study search must not sink the verdict
  asks = 0;
  r = await pf.run({ goal: 'g', deps: { ask: async () => { asks++; return verdictStudy1; }, search: async () => { throw new Error('search down'); } } });
  ok(r && r.studied === false && asks === 1, 'a failed study search falls back to the un-studied verdict');

  // --- P4b RE-ENTRY AUDIT: judgment before accretion ---
  ok(/meets_bar/.test(pf.auditWant()) && /Judge it honestly/.test(pf.auditWant()) && /uncomputed/.test(pf.auditWant()), 'audit want demands honest judgment + the uncomputed list');
  ok(pf.auditValidator('{"meets_bar":false,"gaps":[]}').valid === true && pf.auditValidator('{"gaps":[]}').valid === false, 'audit validator requires the boolean verdict');
  const flawed = { meets_bar: false, assessment: 'Organized notes, not a finished paper.', depth_score: 3, citation_coverage: 'sparse', gaps: [{ section: 'Funding', missing: 'grant-level flows with amounts' }, { section: 'Network', missing: 'second-layer connections' }], uncomputed: ['total grants by recipient'] };
  const g = pf.renderAuditGuidance(flawed);
  ok(/depth 3\/10, citations sparse/.test(g) && /Organized notes/.test(g), 'audit guidance states the blunt verdict');
  ok(/THE GAPS ARE THE PLAN/.test(g) && /Funding — grant-level flows/.test(g) && /NEVER COMPUTED/.test(g), 'the gaps and uncomputed questions become the work');
  ok(/REVISES this same document/.test(g) && /never restate/.test(g), 'guidance binds revision-in-place, not restating');
  ok(pf.renderAuditGuidance({ meets_bar: true, gaps: [] }) === '', 'a document that meets the bar produces no gap plan');
  let auditAsks = 0;
  let ar = await pf.auditDocument({ goal: 'g', title: 't', body: 'B'.repeat(300), deps: { ask: async () => { auditAsks++; return flawed; } } });
  ok(auditAsks === 1 && ar && ar.verdict.meets_bar === false && /GAPS ARE THE PLAN/.test(ar.guidance), 'auditDocument returns verdict + guidance');
  ok(await pf.auditDocument({ goal: 'g', title: 't', body: '  ', deps: { ask: async () => flawed } }) === null, 'no document body → null (nothing to audit)');
  ok(await pf.auditDocument({ goal: 'g', title: 't', body: 'B'.repeat(300), deps: { ask: async () => { throw new Error('down'); } } }) === null, 'audit ask failure → null, fail-open');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
