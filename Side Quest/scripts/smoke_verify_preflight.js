/**
 * Offline smoke for the verification harness PREFLIGHT GATE (studio/verify_preflight.js):
 * matched units → release|abort the frontier batch. No cloud — a MOCK homework-check stands in
 * for the cheap-tier model call, so the gate logic is fully testable offline.
 *
 * Run: node scripts/smoke_verify_preflight.js
 */
const PF = require('../studio/verify_preflight');
const { preflight, buildCandidates, sampleResidue, buildHomeworkPrompt, validVerdict } = PF;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// A candidate factory.
const cand = (uid, needs_model, band, extra = {}) => Object.assign({ uid, needs_model, band, claim: `claim ${uid}`, passage: `passage for ${uid}`, source_url: `https://s/${uid}` }, extra);

(async () => {
  // ---- buildCandidates joins units + match results by uid ------------------------------------
  {
    const units = [{ uid: 'a0.s0', text: 'the claim text', url: 'https://x/y' }];
    const matches = [{ uid: 'a0.s0', band: 'gray', needs_model: true, match_score: 0.7, rubric: { best_passage: 'the matched passage', source_url: 'https://x/y' } }];
    const c = buildCandidates(units, matches);
    ok('buildCandidates carries claim + passage + band', c[0].claim === 'the claim text' && c[0].passage === 'the matched passage' && c[0].band === 'gray' && c[0].needs_model === true);
  }
  ok('validVerdict shape gate', validVerdict({ uid: 'x', ok: true }) && !validVerdict({ uid: 'x' }) && !validVerdict({ ok: true }));
  ok('sampleResidue spreads (not just head)', (() => {
    const r = Array.from({ length: 10 }, (_, i) => ({ uid: 'u' + i }));
    const s = sampleResidue(r, 5);
    return s.length === 5 && s[0].uid === 'u0' && s[4].uid === 'u8';
  })());
  ok('buildHomeworkPrompt is one standardized prompt', /coherence checker/i.test(buildHomeworkPrompt([{ claim: 'c', passage: 'p' }])));

  // ---- Layer 0: no residue → trivially proceed, model never reached --------------------------
  {
    let called = 0;
    const cands = [cand('v0', false, 'verified'), cand('u0', false, 'unsupported'), cand('c0', false, 'contradicted')];
    const r = await preflight(cands, { homeworkCheck: async () => { called++; return []; } });
    ok('all-decided → proceed, reason no-residue', r.proceed === true && r.reason === 'no-residue');
    ok('no-residue → homework-check NOT called', called === 0);
    ok('decided carried through, residue empty', r.decided.length === 3 && r.residue.length === 0);
  }

  // ---- Layer 1 PASS: coherent residue → release the bulk -------------------------------------
  {
    const cands = [cand('v0', false, 'verified'), cand('g0', true, 'gray'), cand('g1', true, 'gray'), cand('g2', true, 'gray')];
    const hw = async (samples) => samples.map(s => ({ uid: s.uid, ok: true, reason: 'on-topic' }));
    const r = await preflight(cands, { homeworkCheck: hw, threshold: 0.6 });
    ok('coherent residue → proceed', r.proceed === true && /passed/.test(r.reason));
    ok('residue released for classify (3)', r.residue.length === 3);
    ok('sample marked gated + passRate 1', r.sample.gated === true && r.sample.passRate === 1);
    ok('layer0 partition correct', r.layer0.decided === 1 && r.layer0.residue === 3);
  }

  // ---- Layer 1 FAIL: mostly garbage passages → ABORT, surface why ----------------------------
  {
    const cands = Array.from({ length: 6 }, (_, i) => cand('g' + i, true, 'gray'));
    // 4 of the sampled 5 are login/404 pages → 1/5 coherent → below threshold.
    const hw = async (samples) => samples.map((s, i) => i === 0
      ? { uid: s.uid, ok: true, reason: 'on-topic' }
      : { uid: s.uid, ok: false, reason: 'login page' });
    const r = await preflight(cands, { homeworkCheck: hw, threshold: 0.6, sampleSize: 5 });
    ok('garbage residue → ABORT (proceed false)', r.proceed === false);
    ok('abort reason surfaces the failure cause', /failed/.test(r.reason) && /login page/.test(r.reason), r.reason);
    ok('residue HELD back (not released)', r.residue.length === 0 && r.heldResidue.length === 6);
    ok('frontier protected: passRate below threshold', r.sample.passRate < 0.6);
  }

  // ---- fail-safe: broken gate (no usable verdicts) → do NOT release ---------------------------
  {
    const cands = [cand('g0', true, 'gray'), cand('g1', true, 'gray')];
    const r = await preflight(cands, { homeworkCheck: async () => [{ garbage: 1 }, null, 'nope'] });
    ok('unusable verdicts → proceed false (fail-safe)', r.proceed === false && /no usable verdicts/.test(r.reason));
  }
  {
    const cands = [cand('g0', true, 'gray')];
    const r = await preflight(cands, { homeworkCheck: async () => { throw new Error('model down'); } });
    ok('homework-check throw → proceed false + reason', r.proceed === false && /threw/.test(r.reason));
  }

  // ---- ungated: no checker injected → proceed but flagged ungated -----------------------------
  {
    const cands = [cand('g0', true, 'gray')];
    const r = await preflight(cands);
    ok('no checker → proceed ungated + flagged', r.proceed === true && /ungated/.test(r.reason) && r.sample.gated === false);
  }

  // ---- extraction-sanity flag: everything gray, nothing decided ------------------------------
  {
    const cands = Array.from({ length: 5 }, (_, i) => cand('g' + i, true, 'gray'));
    const r = await preflight(cands, { homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: true })) });
    ok('allResidue sanity flag set', r.layer0.sanity.allResidue === true && r.layer0.sanity.residueFraction === 1);
  }

  // ---- threshold boundary: exactly at threshold passes ----------------------------------------
  {
    const cands = Array.from({ length: 4 }, (_, i) => cand('g' + i, true, 'gray'));
    const hw = async (samples) => samples.map((s, i) => ({ uid: s.uid, ok: i < 2 }));  // 2/4 = 0.5
    const r = await preflight(cands, { homeworkCheck: hw, threshold: 0.5 });
    ok('passRate == threshold → proceed', r.proceed === true && r.sample.passRate === 0.5);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
