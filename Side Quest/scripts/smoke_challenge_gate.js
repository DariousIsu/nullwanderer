/* smoke_challenge_gate.js — stage 4.5 (2026-09-04): THE ADVERSARIAL STEP, from Alpha's validator.
 *
 * Every swarm plan that produces a deliverable ends in the challenger — a different model family —
 * which approves, requests a bounded re-run, or passes with caveats. Pure loop (produce/challenge
 * injected), the verdict parser on Alpha's schema, P11's confidence labels, and the finalize wiring.
 */
'use strict';
const fs = require('fs'), path = require('path');
const G = require('../lib/challenge_gate');
const law = require('../lib/tier_law');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── parseVerdict: Alpha's schema, tolerant of prose/fences, never blocks on a bad parse ──────────
let v = G.parseVerdict('{"verdict":"approved","score":0.92,"correction_notes":null}');
ok(v.verdict === 'approved' && v.score === 0.92 && v.correction_notes.length === 0 && v.parsed, 'a clean approved verdict parses');
v = G.parseVerdict('Here is my review.\n```json\n{"verdict":"revision_needed","score":0.55,"correction_notes":[{"area":"Financing","issue":"unsourced ARR claim","instruction":"cite or cut"}]}\n```\nDone.');
ok(v.verdict === 'revision_needed' && v.score === 0.55 && v.correction_notes.length === 1 && v.correction_notes[0].area === 'Financing', 'a revision verdict parses through prose + a markdown fence');
ok(G.parseVerdict('{"verdict":"reject","score":2}').verdict === 'revision_needed' && G.parseVerdict('{"verdict":"reject","score":2}').score === 1, 'reject → revision_needed; an out-of-range score clamps to [0,1]');
v = G.parseVerdict('the model rambled and never produced JSON');
ok(v.verdict === 'approved' && v.parsed === false && v.score === null && /auto-approved/.test(v.why), 'an unparseable reply AUTO-APPROVES (a broken challenger never wedges a deliverable)');
v = G.parseVerdict('{"verdict":"revision_needed","correction_notes":["fix the intro","add sources"]}');
ok(v.correction_notes.length === 2 && v.correction_notes[0].issue === 'fix the intro' && v.score === null, 'string correction notes and a missing score are tolerated');

// ── P11's confidence labels come from tier_law (one copy) ────────────────────────────────────────
ok(G.label(0.95) === 'verified' && G.label(0.8) === 'likely' && G.label(0.5) === 'uncertain' && G.label(null) === 'uncertain', 'the score labels are P11 levels (verified ≥0.9, likely ≥0.7, else uncertain)');
ok(G.label(0.9) === law.confidenceLabel(0.9), 'the labels are lib/tier_law.confidenceLabel, not a second copy');

// ── decide: approve / revise / pass_with_caveats, and auto-approve when no challenger ────────────
ok(G.decide({ verdict: 'approved', score: 0.9 }).action === 'approve', 'approved → approve');
ok(G.decide({ verdict: 'revision_needed', iteration: 1, maxIterations: 3 }).action === 'revise', 'revision with iterations left → revise');
ok(G.decide({ verdict: 'revision_needed', iteration: 3, maxIterations: 3 }).action === 'pass_with_caveats', 'revision on the last iteration → pass_with_caveats (Alpha: never block on the third)');
ok(G.decide({ verdict: 'revision_needed', challengerAvailable: false }).action === 'approve' && /auto-approved/.test(G.decide({ verdict: 'revision_needed', challengerAvailable: false }).why), 'no challenger available → auto-approve');

// ── corrections: the fold block for the producer's next pass ─────────────────────────────────────
const cb = G.corrections({ correction_notes: [{ area: 'Intro', issue: 'no hook', instruction: 'open on the number' }, { area: '', issue: 'stale date', instruction: '' }] });
ok(/1\. \[Intro\] no hook → open on the number/.test(cb) && /2\. stale date/.test(cb), 'corrections() renders a numbered fold block');
ok(G.corrections({ correction_notes: [] }) === '' && G.corrections(null) === '', 'no notes → empty fold');

// ── runGate: the loop ────────────────────────────────────────────────────────────────────────────
(async () => {
  // approve on the first pass
  let produces = 0, challenges = 0;
  let r = await G.runGate({ task: 't', produce: async () => { produces++; return { output: `draft ${produces}`, sections: [1, 2] }; }, challenge: async () => { challenges++; return '{"verdict":"approved","score":0.95}'; } });
  ok(r.outcome === 'approved' && produces === 1 && challenges === 1 && r.iterations === 1 && r.output === 'draft 1', 'a clean first pass approves after one produce + one challenge');

  // revise once, then approve — the corrections reach the producer
  produces = 0; challenges = 0; let sawCorrections = null;
  r = await G.runGate({ task: 't', produce: async (corr) => { produces++; if (produces === 2) sawCorrections = corr; return { output: `draft ${produces}`, sections: [1, 2] }; },
    challenge: async () => { challenges++; return challenges === 1 ? '{"verdict":"revision_needed","score":0.5,"correction_notes":[{"area":"X","issue":"y","instruction":"z"}]}' : '{"verdict":"approved","score":0.9}'; } });
  ok(r.outcome === 'approved' && produces === 2 && r.iterations === 2 && r.output === 'draft 2', 'a revision re-runs the producer, then the second verdict approves');
  ok(sawCorrections && /\[X\] y → z/.test(sawCorrections), 'the corrections are folded into the producer\'s re-run');

  // revision every time → pass_with_caveats at the cap, keeping the last draft
  produces = 0;
  r = await G.runGate({ task: 't', maxIterations: 3, produce: async () => { produces++; return { output: `draft ${produces}`, sections: [1, 2] }; }, challenge: async () => '{"verdict":"revision_needed","score":0.4,"correction_notes":[{"issue":"still wrong"}]}' });
  ok(r.outcome === 'passed_with_caveats' && produces === 3 && r.iterations === 3 && r.output === 'draft 3', 'endless revision passes with caveats at the cap, keeping the last draft');

  // no challenger / challenger silent → no_challenger, keep the first draft
  r = await G.runGate({ task: 't', produce: async () => ({ output: 'draft', sections: [1, 2] }), challenge: null });
  ok(r.outcome === 'no_challenger' && r.iterations === 1, 'no challenger → the first draft stands (auto-approve by absence)');
  r = await G.runGate({ task: 't', produce: async () => ({ output: 'draft', sections: [1, 2] }), challenge: async () => null });
  ok(r.outcome === 'no_challenger', 'a challenger that does not answer → auto-approve, never a hang');
  r = await G.runGate({ task: 't', produce: async () => ({ output: 'draft', sections: [1, 2] }), challenge: async () => { throw new Error('engine down'); } });
  ok(r.outcome === 'no_challenger', 'a challenger that throws → auto-approve (a broken challenger never blocks)');

  // ── paper_finalize wiring: challenge absent = today's behavior; present = the gate runs ────────
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_challengegate_'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'CoreWeave raised $1.1B in 2023 [1]. The company runs GPU clusters. https://example.com/a');
  fs.writeFileSync(path.join(dir, 'b.md'), 'Nvidia backs the buildout with chips and a stake. https://example.com/b');
  const pf = require('../lib/paper_finalize');
  const write = async (prompt) => `This section covers the ground in ${/SECTION: "([^"]+)"/.exec(prompt)[1]}. CoreWeave raised money [1] and Nvidia backs it [2]. ${/CORRECTIONS/.test(prompt) ? 'Revised per the reviewer: dates added.' : ''} It is long enough to pass the eighty character floor easily and then some.`;
  // absent → no gate, behaves as before
  let f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'] });
  ok(f.ok && f.gate == null && f.sections === 2, 'finalize without a challenge dep behaves as before (no gate field)');
  // present, approves → gate.outcome approved
  let chN = 0;
  f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'], challenge: async () => { chN++; return '{"verdict":"approved","score":0.88}'; } });
  ok(f.ok && f.gate && f.gate.outcome === 'approved' && f.gate.label === 'likely' && chN === 1, 'finalize with a challenge dep runs the gate and reports the outcome + label');
  // present, revises once then approves → the corrected draft lands
  chN = 0;
  f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'], challenge: async () => { chN++; return chN === 1 ? '{"verdict":"revision_needed","score":0.5,"correction_notes":[{"area":"dates","issue":"no years","instruction":"add them"}]}' : '{"verdict":"approved","score":0.9}'; } });
  const landed = fs.readFileSync(f.path, 'utf8');
  ok(f.ok && f.gate.outcome === 'approved' && f.gate.iterations === 2 && /Revised per the reviewer/.test(landed), 'a revision re-writes the sections with the corrections and lands the revised paper');

  fs.rmSync(dir, { recursive: true, force: true });

  // ── wiring pins: the finalize verb dispatches the challenger role and records the run ───────────
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/swarm\.challenge_deliverables/.test(main) && /require\('\.\/lib\/role_registry'\)\.byName\('challenger'\)/.test(main), 'the finalize verb gates the challenger on a kill switch and the role being registered');
  ok(/name: 'challenger', prompt, lane: 'directed'/.test(main) && /spendTier: 'directed'/.test(main), "the challenger is dispatched (blocking) on the deliverable's directed lane");
  ok(/frozenOutline: _contract && _contract\.outline, challenge \}\)/.test(main) && /L\.start\(\{ role: 'challenger', executor: 'echo'/.test(main) && /echo_run_id: echoRunId/.test(main), 'the challenge is passed into finalize and each challenge is recorded in the run ledger, keyed on the engine run id');
  ok(/passed_with_caveats[\s\S]{0,200}landed with caveats/.test(main), 'a paper that passed with caveats says so in the announce (never claims a clean bill the challenger withheld)');
  const pfSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'paper_finalize.js'), 'utf8');
  ok(/require\('\.\/challenge_gate'\)/.test(pfSrc) && /cg\.runGate\(\{ task: goal \|\| topic, produce, challenge, maxIterations \}\)/.test(pfSrc), 'finalize runs the assembled deliverable through challenge_gate.runGate');

  // ── one shape, both sides: the gate's parser and the challenger manifest's emitted schema agree ──
  const ECHO = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  const manifestPath = path.join(ECHO, 'data', 'agents', 'challenger.toml');
  if (fs.existsSync(manifestPath)) {
    const man = fs.readFileSync(manifestPath, 'utf8');
    ok(/"verdict": "approved" \| "revision_needed", "score": 0\.0-1\.0, "correction_notes"/.test(man) && /max_iterations = 3/.test(man), 'the challenger manifest emits the verdict/score/correction_notes schema the gate parses, capped at 3 (no cross-repo drift)');
    // the exact JSON the manifest instructs parses to an approved verdict
    ok(G.parseVerdict('{"verdict": "approved", "score": 0.9, "correction_notes": null}').verdict === 'approved', 'the gate parses the manifest\'s own example shape');
  } else console.log('  (engine tree not readable here — manifest cross-repo pin skipped)');

  console.log(`\nsmoke_challenge_gate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
