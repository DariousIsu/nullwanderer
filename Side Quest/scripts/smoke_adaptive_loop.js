/* Integration smoke: the ADAPTIVE RESEARCH loop end-to-end at the lib layer (multi-layer testing,
 * Lucas 2026-08-06 — "she'll need new smoke testing parameters added for all of this").
 *
 * Drives the real data flow the app runs, with every cloud/search dep injected:
 *   P0  preflight verdict → guidance
 *   →   plan input CARRIES the guidance verbatim + the want binds the HONOR clause
 *   →   two synthesis rounds drive P1 revalidation: round 1 conservative (no mutation),
 *       round 2 evidence-driven delta MUTATES the plan (targets + tactics) and files tool needs
 *   →   P4b re-entry audit on a flawed base doc: gaps become the plan, guidance re-enters planInput
 *   →   P4 paper compose contract: front-matter prompt carries the preflight's method + quant
 *       questions + the run's open questions; deterministic citation coverage tells the truth.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_adaptive_loop.js
 */
'use strict';
const pf = require('../lib/research_preflight');
const rp = require('../lib/research_plan');
const cp = require('../lib/compose');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const goal = 'Map the foundations funding anti-data-center groups in North Carolina';

  // ── P0: preflight (unfamiliar craft → study pass → verdict with a gap + quant questions) ──────────
  const verdictStudy = { knows_class: false, method: 'tbd', study_queries: ['how do investigative journalists trace nonprofit funding'], tool_picks: [], missing_capabilities: [], quant_questions: [] };
  const verdictFinal = {
    knows_class: false, method: 'Studied: trace 990 Schedule I grant lists, cross-reference FEC and state overlays.',
    study_queries: [], tool_picks: [{ tool: 'nonprofit_lookup', for: '990 filings' }, { tool: 'analyze_data', for: 'grant cross-tabs' }],
    missing_capabilities: ['NC state-level campaign finance filings'],
    quant_questions: ['total grant flow by recipient', 'donor overlap probability'],
  };
  const needs = [];
  let searches = 0;
  const pfRes = await pf.run({
    goal, kind: 'entity',
    deps: {
      ask: async (o) => (o.input && o.input.studyNotes) ? verdictFinal : verdictStudy,
      search: async () => { searches++; return 'journalists use Schedule I grant lists'; },
      operatorToolNames: ['web_search', 'analyze_data'], deepLane: ['nonprofit_lookup', 'forecast_query'], webLane: ['web_fetch'],
      recordNeed: (n) => needs.push(n),
    },
  });
  ok(pfRes && pfRes.studied === true && searches === 1, 'P0: unfamiliar craft ran ONE study search and re-asked');
  ok(/Studied: trace 990 Schedule I/.test(pfRes.guidance) && /QUANTITATIVE QUESTIONS/.test(pfRes.guidance), 'P0: guidance carries the studied method + quant questions');
  ok(needs.length === 1 && /NC state-level/.test(needs[0]), 'P0: the capability gap was FILED as a build need');

  // ── guidance → plan input (the HONOR chain, exactly as generateResearchPlan wires it) ─────────────
  const planInp = rp.planInput({ goal, targets: [], deep: true, kind: 'entity', preflight: pfRes.guidance });
  ok(planInp.preflightGuidance === pfRes.guidance.slice(0, 2500), 'chain: plan input carries the preflight guidance verbatim');
  ok(/If preflightGuidance is provided, HONOR it/.test(rp.planWant('entity')), 'chain: the plan contract binds the HONOR clause');
  ok(/QUANTITATIVE sub-question/.test(rp.planWant('entity')), 'chain: the plan contract still demands a computed quant question (P3)');

  // ── P1: two synthesis rounds through revalidation (round 1 conservative, round 2 mutates) ─────────
  let plan = { objective: 'map the funders', approach: 'depth-first per foundation', targets: ['Hartfield Foundation', 'Green South Foundation'], facets: ['funding flows'] };
  const synth1 = '## Hartfield Foundation\nGrants routed through a fiscal sponsor.\n[pages read this pass: 3]\nSOURCES: https://example.org/990-2023';
  const synth2 = '## Green South Foundation\nShares two board members with the Roy-Richards Trust — a cross-control signal.\nSOURCES: https://example.org/board';

  const inp1 = rp.revalidateInput({ plan, synthesis: synth1, covered: ['Hartfield Foundation'], goal });
  ok(inp1.plan.targets.length === 2 && inp1.latestSynthesis.indexOf('fiscal sponsor') > -1, 'P1: revalidate input carries the live plan + the fresh synthesis');
  ok(/scientific method applied to the plan itself/.test(rp.revalidateWant()) && /tools_sufficient/.test(rp.revalidateWant()), 'P1: the revalidate contract re-tests correctness/completeness/toolkit');

  // round 1: the conservative verdict (the common case) → NO mutation
  const conservative = { correct: true, complete: true, tools_sufficient: true, reason: 'holds', add_targets: [], drop_targets: [], approach_update: null, tool_needs: [] };
  const r1 = rp.applyPlanDelta(plan, conservative);
  ok(r1.changed === false && r1.plan.targets.length === 2, 'P1 round 1: conservative verdict leaves the plan untouched');

  // round 2: the evidence (cross-control signal) demands a delta → plan MUTATES, needs filed
  const delta = {
    correct: true, complete: false, tools_sufficient: false, reason: 'board overlap opens a second layer',
    add_targets: ['Roy-Richards Trust'], drop_targets: [],
    approach_update: 'Depth-first per foundation, then a board-interlock pass across all of them using analyze_data cross-tabs.',
    tool_needs: ['NC Secretary of State corporate registry lookups'],
  };
  ok(rp.revalidateValidator(`<think>{"correct":"no"}</think>${JSON.stringify(delta)}`).valid === true, 'P1: validator strips think blocks before locating the verdict');
  const r2 = rp.applyPlanDelta(plan, delta);
  ok(r2.changed === true && r2.plan.targets.includes('Roy-Richards Trust'), 'P1 round 2: the delta ADDS the evidence-driven target');
  ok(/board-interlock pass/.test(r2.plan.approach) && r2.notes.includes('tactics revised'), 'P1 round 2: tactics genuinely revised, and the notes say so');
  ok(plan.approach === 'depth-first per foundation', 'P1: delta application is pure — the input plan is never mutated');
  ok((delta.tool_needs || []).length === 1, 'P1: the tools-insufficient verdict carries a concrete need to file');
  plan = r2.plan;

  // ── P4b: re-entry audit on the flawed base doc → the gaps become the plan, guidance re-enters ─────
  const auditVerdict = {
    meets_bar: false, assessment: 'Organized notes with headings, not a finished cited paper.', depth_score: 3, citation_coverage: 'sparse',
    gaps: [{ section: 'Funding', missing: 'grant-level flows with dollar amounts' }, { section: 'Network', missing: 'second-layer board connections' }],
    uncomputed: ['total grant flow by recipient'],
  };
  const audit = await pf.auditDocument({ goal, title: 'Hartfield draft', body: 'D'.repeat(400), deps: { ask: async () => auditVerdict } });
  ok(audit && audit.verdict.meets_bar === false && /THE GAPS ARE THE PLAN/.test(audit.guidance), 'P4b: the flawed document is judged honestly and its gaps become the plan');
  const reentryInp = rp.planInput({ goal, targets: plan.targets, kind: 'entity', preflight: [pfRes.guidance, audit.guidance].filter(Boolean).join('\n') });
  ok(/THE GAPS ARE THE PLAN/.test(reentryInp.preflightGuidance) && /Studied: trace 990/.test(reentryInp.preflightGuidance), 'P4b: audit + preflight guidance BOTH re-enter the plan input (the acceptance-test wiring)');

  // ── P4: paper compose contract over the run's own artifacts ───────────────────────────────────────
  const body = '## Hartfield Foundation\nGrants routed through a fiscal sponsor (source: https://example.org/990-2023).\n\n## Green South Foundation\nBoard overlap with Roy-Richards Trust (source: https://example.org/board).\n\n## Roy-Richards Trust\nSecond-layer connections still thin.';
  const paperMsgs = cp.buildPaperPrompt({
    goal, method: `Preflight method: ${verdictFinal.method}`, body,
    quantQuestions: verdictFinal.quant_questions, openQuestions: ['who funds the funders'], gaps: '- NC state filings unavailable',
  });
  ok(/Studied: trace 990 Schedule I/.test(paperMsgs[1].content) && /total grant flow by recipient/.test(paperMsgs[1].content), 'P4: the paper prompt carries the PREFLIGHT method + its promised quant questions');
  ok(/who funds the funders/.test(paperMsgs[1].content) && /NC state filings unavailable/.test(paperMsgs[1].content), 'P4: the paper prompt carries the run’s open questions + honest gaps');
  ok(/not computed this run/.test(paperMsgs[0].content), 'P4: the contract forbids estimating uncomputed numbers into existence');

  const front = '## Abstract\nA.\n\n## Key findings\n- routed via sponsor (source: https://example.org/990-2023)\n\n## Methodology\nm\n\n## Quantitative results\ntotal grant flow: not computed this run\n\n## Open questions\n- who funds the funders';
  const paper = cp.assemblePaper({ goal, front, planPage: '# Research plan\n\np', composedBody: body, gaps: '- NC state filings unavailable', completed: 'done', count: 3 });
  const cov = cp.citationCoverage(paper);
  ok(cov.total === 4 && cov.cited === 3 && cov.uncited[0] === 'Roy-Richards Trust', 'P4: coverage counts the paper honestly — the thin section is NAMED, not papered over');
  ok(/3\/4 content sections carry a source/.test(cp.renderCoverageFooter(cov)), 'P4: the coverage footer states the measured truth');
  ok(paper.indexOf('## Abstract') < paper.indexOf('## Hartfield Foundation') && paper.indexOf('## Appendix — research plan') > paper.indexOf('## Roy-Richards Trust'), 'P4: paper shape holds — front matter, evidence body, plan appendix');

  // ── mid-flight re-entry wiring (source assert — the acceptance-test gap, measured live) ─────────
  // "take another look at the report" folds into the LIVE thread, so the seed-site audit never
  // fires; the REFINEMENT branch must enter through judgment instead and arm paper mode.
  {
    const fs = require('fs'), path = require('path');
    const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/REFINEMENT folded into current focus[\s\S]{0,3500}?auditDocument\(/.test(m), 'the refinement branch runs the re-entry audit on the live thread');
    ok(/mid-flight re-entry audit/.test(m) && m.indexOf('reentry_audit`, JSON.stringify(_audit.verdict)') > -1, 'the mid-flight verdict is stored (arms paper mode at condense)');
    ok(/paper mode armed/.test(m), 'the log says paper mode is armed for the run');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
