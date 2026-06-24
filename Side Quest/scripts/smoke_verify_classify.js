/**
 * Offline smoke for the verification harness STAGE 5 (studio/verify_classify.js) — the caged model
 * leaf — plus the STRICT validation gate added to studio/checks_contract.js. No cloud: the stub
 * and injected mock "models" stand in.
 *
 * Run: node scripts/smoke_verify_classify.js
 */
const VC = require('../studio/verify_classify');
const contract = require('../studio/checks_contract');
const { classify, classifyAll, validateInput, validateOutput, parseStatusCode, STATUS_CODES } = VC;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  // ---- schema + enum mapping -----------------------------------------------------------------
  ok('parseStatusCode passes enum through', parseStatusCode('VP') === 'VP' && parseStatusCode(' m ') === 'M');
  ok('parseStatusCode maps synonyms', parseStatusCode('verified') === 'V' && parseStatusCode('mismatch') === 'M' && parseStatusCode('not in kdb') === 'NK');
  ok('parseStatusCode rejects junk', parseStatusCode('banana') === null);
  ok('validateInput requires non-empty claim', !validateInput({ claim: '' }).ok && validateInput({ claim: 'x', passage: 'y' }).ok);
  ok('validateOutput maps + rejects', validateOutput({ status_code: 'verified', note: 'n' }).status_code === 'V' && !validateOutput({ status_code: 'zzz' }).ok);
  ok('invalid input throws', await (async () => { try { await classify({ claim: '' }); return false; } catch { return true; } })());

  // ---- STUB: deterministic, runs with no model -----------------------------------------------
  {
    const hi = await classify({ claim: 'the panel rejected the amendment', passage: 'records show the panel rejected the amendment on a vote' });
    ok('stub high-overlap → VP, tier stub', hi.status_code === 'VP' && hi.tier === 'stub' && hi.valid === true, JSON.stringify(hi));
    const lo = await classify({ claim: 'unrelated zeppelin marmalade', passage: 'a passage about municipal water board staffing' });
    ok('stub low-overlap → NK', lo.status_code === 'NK' && lo.tier === 'stub');
    const a = await classify({ claim: 'x y z', passage: 'p' }), b = await classify({ claim: 'x y z', passage: 'p' });
    ok('stub is deterministic', JSON.stringify(a) === JSON.stringify(b));
  }

  // ---- TIER 1 local model accepted when confident --------------------------------------------
  {
    const model = async () => ({ status_code: 'V', note: 'confirmed', confidence: 0.95 });
    const r = await classify({ claim: 'c', passage: 'p' }, { model });
    ok('confident local → tier local, V', r.tier === 'local' && r.status_code === 'V' && r.valid);
  }

  // ---- TIER 2 escalation: low-confidence local → frontier ------------------------------------
  {
    let usedFrontier = false;
    const model = async () => ({ status_code: 'QP', note: 'unsure', confidence: 0.3 });
    const frontier = async () => { usedFrontier = true; return { status_code: 'VP', note: 'frontier call', confidence: 0.9 }; };
    const r = await classify({ claim: 'c', passage: 'p' }, { model, frontier, minConfidence: 0.65 });
    ok('low-confidence local escalates to frontier', usedFrontier && r.tier === 'frontier' && r.status_code === 'VP');
  }

  // ---- strict I/O: invalid local output, no frontier → conservative NK, valid:false ----------
  {
    const model = async () => ({ status_code: 'WAT', note: 'garbage' });
    const r = await classify({ claim: 'c', passage: 'p' }, { model });
    ok('invalid local output (no frontier) → NK valid:false', r.status_code === 'NK' && r.valid === false && /invalid/.test(r.note));
  }
  // invalid local → frontier also invalid → NK valid:false
  {
    const model = async () => ({ status_code: 'nope' });
    const frontier = async () => ({ status_code: 'also-bad' });
    const r = await classify({ claim: 'c', passage: 'p' }, { model, frontier });
    ok('invalid both tiers → NK valid:false (frontier)', r.status_code === 'NK' && r.valid === false && r.tier === 'frontier');
  }
  // model throws → handled (escalates / falls back), never crashes
  {
    const r = await classify({ claim: 'c', passage: 'p' }, { model: async () => { throw new Error('boom'); } });
    ok('local throw → graceful NK valid:false', r.valid === false && r.status_code === 'NK');
  }

  // ---- classifyAll over residue --------------------------------------------------------------
  {
    const items = [
      { uid: 'g0', claim: 'panel rejected the amendment', passage: 'the panel rejected the amendment today' },
      { uid: 'g1', claim: 'totally distinct topic words', passage: 'a wholly different subject entirely here' },
    ];
    const rs = await classifyAll(items);
    ok('classifyAll preserves uid + order', rs.length === 2 && rs[0].uid === 'g0' && rs[1].uid === 'g1');
    ok('classifyAll every result has a valid enum code', rs.every(r => STATUS_CODES.includes(r.status_code)));
  }

  // ---- STRICT GATE in checks_contract --------------------------------------------------------
  {
    // tolerant (default): an item with no status + no score is GUESSED (score fallback → unverified)
    const tol = contract.mapCheckResult({ claims: [{ claim_text: 'no status here', finding: 'f' }] });
    ok('tolerant default still maps (no invalid)', tol.summary.invalid === 0 && tol.findings[0].status !== 'INVALID');

    // strict: same item → flagged INVALID (schema violation), not guessed
    const strict = contract.mapCheckResult({ claims: [{ claim_text: 'no status here', finding: 'f' }] }, { strict: true });
    ok('strict flags signal-less item INVALID', strict.summary.invalid === 1 && strict.findings[0].status === 'INVALID' && strict.findings[0].verdict === 'bad');

    // strict still honors a real code + a real score
    const mixed = contract.mapCheckResult({ claims: [
      { claim_text: 'good code', status_code: 'V' },
      { claim_text: 'scored', match_score: 0.93 },
      { claim_text: 'junk', status: 'qwerty' },
    ] }, { strict: true });
    ok('strict passes valid code + valid score, flags only the junk', mixed.summary.invalid === 1 &&
      mixed.findings[0].status === 'V' && mixed.findings[1].verdict === 'ok' && mixed.findings[2].status === 'INVALID', JSON.stringify(mixed.summary));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
