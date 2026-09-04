/* smoke_citation_gate.js — stage 4.5 (2026-09-04): THE CITATION GATE, from Alpha.
 *
 * Between the collectors and the writer: every inline [n] must be supported by source [n]. Three
 * attempts, pass-with-caveats, held sources first. Pure gate (extract/parseCheck/decide/runGate),
 * the deterministic dangling check, the verifier prompt, and the finalize wiring (composed with the
 * challenger: citation gate inner, challenger outer).
 */
'use strict';
const fs = require('fs'), path = require('path');
const C = require('../lib/citation_gate');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const sources = [{ n: 1, url: 'https://a', title: 'A' }, { n: 2, url: 'https://b', title: 'B' }, { n: 3, url: 'https://c', title: 'C' }];

// ── extractCitations: the inline [n] claims and their mapped source ──────────────────────────────
const doc = 'CoreWeave raised $1.1B in 2023 [1]. Nvidia holds a stake [2]. An uncited sentence. A claim citing a missing source [9]. Two cites here [1][3].';
let cs = C.extractCitations(doc, sources);
ok(cs.length === 5, `extracts one entry per (claim, index) — got ${cs.length}`);
ok(cs.find((c) => c.index === 1 && /CoreWeave/.test(c.claim)).source.url === 'https://a', 'a citation maps to its source in the list');
ok(cs.find((c) => c.index === 9).source === null, 'a citation with no matching source has a null source (dangling)');
ok(C.danglingCitations(cs).length === 1 && C.danglingCitations(cs)[0].index === 9, 'danglingCitations catches exactly the [9]');
ok(C.extractCitations('no citations here at all', sources).length === 0, 'text with no [n] yields nothing');

// ── parseCheck: Alpha's CitationGateResult, tolerant, auto-pass on garbage ───────────────────────
let v = C.parseCheck('{"verdict":"pass","citation_count":5,"failed_count":0}');
ok(v.verdict === 'pass' && v.citation_count === 5 && v.failed_count === 0 && v.parsed, 'a pass verdict parses');
v = C.parseCheck('```json\n{"verdict":"fail","citation_count":5,"failed_count":2,"corrections":{"2":{"issue":"source is about chips not the stake","suggested_fix":"cite [3] or cut"}}}\n```');
ok(v.verdict === 'fail' && v.failed_count === 2 && v.corrections['2'].issue === 'source is about chips not the stake', 'a fail verdict with corrections parses through a fence');
ok(C.parseCheck('{"verdict":"pass_with_caveats","caveats":["[1] is a press release"]}').verdict === 'pass_with_caveats', 'pass_with_caveats parses');
ok(C.parseCheck('the verifier rambled, no json').verdict === 'pass' && !C.parseCheck('x').parsed, 'an unparseable verifier reply AUTO-PASSES (a broken verifier never blocks)');

// ── decide: pass / recheck / pass_with_caveats, auto-pass with no checker ────────────────────────
ok(C.decide({ verdict: 'pass' }).action === 'pass', 'pass → pass');
ok(C.decide({ verdict: 'fail', attempt: 1, maxAttempts: 3 }).action === 'recheck', 'fail with attempts left → recheck');
ok(C.decide({ verdict: 'fail', attempt: 3, maxAttempts: 3 }).action === 'pass_with_caveats', 'fail on the last attempt → pass_with_caveats (Alpha: never block on the third)');
ok(C.decide({ verdict: 'fail', checkerAvailable: false }).action === 'pass', 'no verifier → auto-pass');

// ── corrections: dangling + model corrections fold ──────────────────────────────────────────────
const cb = C.corrections({ corrections: { 2: { issue: 'chips not the stake', suggested_fix: 'cite [3]' } } }, C.danglingCitations(cs));
ok(/citation \[9\] points at no source/.test(cb) && /citation \[2\]: chips not the stake → cite \[3\]/.test(cb), 'corrections() folds the dangling AND the model corrections');

// ── buildCheckPrompt: held sources first ─────────────────────────────────────────────────────────
const held = { 1: 'CoreWeave announced a $1.1B raise in 2023.', 2: 'Nvidia supplies chips.' };
const prompt = C.buildCheckPrompt(C.extractCitations(doc, sources).filter((c) => c.source), (n) => held[n] || null);
ok(/read this FIRST/.test(prompt) && /CoreWeave announced a \$1\.1B/.test(prompt) && /CLAIMS citing \[1\]/.test(prompt) && /Respond ONLY with valid JSON/.test(prompt), 'the verifier prompt puts the held source content first, then the claims, then the schema');

// ── runGate: the loop ────────────────────────────────────────────────────────────────────────────
(async () => {
  // clean pass on attempt 1
  let produces = 0, checks = 0;
  let r = await C.runGate({ produce: async () => { produces++; return { output: 'Claim [1].', sources }; }, check: async () => { checks++; return '{"verdict":"pass","citation_count":1,"failed_count":0}'; } });
  ok(r.outcome === 'passed' && produces === 1 && checks === 1 && r.attempts === 1, 'a clean pass settles on attempt 1');

  // fail once (model), then pass — corrections reach the producer
  produces = 0; let sawCorr = null;
  r = await C.runGate({ produce: async (corr) => { produces++; if (produces === 2) sawCorr = corr; return { output: 'Claim [1].', sources }; },
    check: async () => (produces === 1 ? '{"verdict":"fail","failed_count":1,"corrections":{"1":{"issue":"unsupported","suggested_fix":"cite the right source"}}}' : '{"verdict":"pass","failed_count":0}') });
  ok(r.outcome === 'passed' && produces === 2 && /citation \[1\]: unsupported/.test(sawCorr || ''), 'a fail re-runs the producer with the corrections, then passes');

  // dangling citation forces a fail even when the model says pass (deterministic hard rule)
  produces = 0;
  r = await C.runGate({ produce: async () => { produces++; return { output: 'A claim citing nothing real [9].', sources }; }, check: async () => '{"verdict":"pass"}', maxAttempts: 2 });
  ok(r.outcome === 'passed_with_caveats' && produces === 2 && r.caveats.some((c) => /\[9\]/.test(c)), 'a dangling [9] fails deterministically even though the model said pass, then passes with caveats at the cap');

  // endless model fail → pass_with_caveats at the cap
  produces = 0;
  r = await C.runGate({ produce: async () => { produces++; return { output: 'Claim [1].', sources }; }, check: async () => '{"verdict":"fail","failed_count":1}', maxAttempts: 3 });
  ok(r.outcome === 'passed_with_caveats' && produces === 3 && r.attempts === 3, 'endless failure passes with caveats at the cap');

  // no checker, no dangling → no_checker; a silent/throwing checker → no_checker (auto-pass, never hang)
  r = await C.runGate({ produce: async () => ({ output: 'Claim [1].', sources }), check: null });
  ok(r.outcome === 'no_checker', 'no checker and no dangling → auto-pass');
  r = await C.runGate({ produce: async () => ({ output: 'Claim [1].', sources }), check: async () => { throw new Error('down'); } });
  ok(r.outcome === 'no_checker', 'a checker that throws → auto-pass, never a hang');
  // but a dangling citation still fails deterministically with no model checker
  r = await C.runGate({ produce: async () => ({ output: 'A claim [9].', sources }), check: async () => null, maxAttempts: 2 });
  ok(r.outcome === 'passed_with_caveats' && r.caveats.some((c) => /\[9\]/.test(c)), 'a dangling citation fails even with no working model checker (deterministic)');

  // ── finalize wiring: citation gate composes with the challenger (inner/outer) ──────────────────
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_citgate_'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'CoreWeave raised $1.1B in 2023. https://example.com/a');
  fs.writeFileSync(path.join(dir, 'b.md'), 'Nvidia backs the buildout. https://example.com/b');
  const pf = require('../lib/paper_finalize');
  const write = async (prompt) => `Section on ${/SECTION: "([^"]+)"/.exec(prompt)[1]}: CoreWeave raised money [1] and Nvidia backs it [2]. ${/citation check found/i.test(prompt) ? 'Citations corrected.' : ''} This is comfortably over the eighty character floor for a section body.`;
  // verifier absent → today's behavior (no citationGate field)
  let f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'] });
  ok(f.ok && f.citationGate == null, 'finalize without a verifier behaves as before (no citationGate field)');
  // verifier present, passes → citationGate.outcome passed
  let vn = 0;
  f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'], verifyCitations: async () => { vn++; return '{"verdict":"pass","failed_count":0}'; } });
  ok(f.ok && f.citationGate && f.citationGate.outcome === 'passed' && vn >= 1, 'finalize with a verifier runs the citation gate and reports the outcome');
  // composed with the challenger: both gates run, both reported
  vn = 0; let chn = 0;
  f = await pf.finalize({ topic: 'coreweave', goal: 'a paper', write, dir, outDir: dir, land: false, frozenOutline: ['Overview', 'Backers'],
    verifyCitations: async () => { vn++; return '{"verdict":"pass"}'; }, challenge: async () => { chn++; return '{"verdict":"approved","score":0.9}'; } });
  ok(f.ok && f.citationGate.outcome === 'passed' && f.gate.outcome === 'approved' && vn >= 1 && chn >= 1, 'the citation gate (inner) and the challenger (outer) both run and both report');

  fs.rmSync(dir, { recursive: true, force: true });

  // ── wiring pins ─────────────────────────────────────────────────────────────────────────────────
  const pfSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'paper_finalize.js'), 'utf8');
  ok(/require\('\.\/citation_gate'\)/.test(pfSrc) && /the CITATION GATE wraps the/.test(pfSrc) && /_heldForSource/.test(pfSrc), 'finalize composes the citation gate inside the challenger, reading held sources first');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/citation-verifier|rainey-citation-verifier/.test(main) && /verifyCitations \}\)/.test(main) && /buildCheckPrompt/.test(pfSrc), 'the finalize verb dispatches the citation-verifier role and finalize hands it the held-sources-first prompt');
  ok(/citation gate: \$\{r\.citationGate\.outcome\}/.test(main), 'the citation gate outcome is logged');

  console.log(`\nsmoke_citation_gate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
