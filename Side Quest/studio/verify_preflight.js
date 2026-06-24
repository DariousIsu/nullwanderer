/*
 * Editor Studio — verification harness PREFLIGHT GATE (verify_preflight).
 *
 * Pipeline (EDITOR_TAB_SPEC, FROZEN): … → match → THIS → classify → contract. This is the
 * token-safety wall: "check the deterministic's homework before the bulk order." It guards the
 * frontier classify (the only paid step) against garbage-in — botched extraction, a fetched
 * login/404 page, a claim matched to an irrelevant passage — burning a whole batch.
 *
 *   Layer 0 — code guards (FREE): partition matched units into DECIDED (verified / unsupported /
 *     contradicted / inaccessible — settled deterministically, never sent to a model) vs RESIDUE
 *     (needs_model: the gray/weak band). Extraction-sanity flags ride along.
 *   Layer 1 — homework-check (ONE cheap-tier call): sample the residue; ask a cheap model
 *     "is each {claim, matched-passage} coherent + on-topic? yes/no". Deterministic gate on the
 *     pass-rate: ≥ threshold → RELEASE the bulk; < threshold → ABORT and surface why.
 *   Layer 2 — bulk classify (frontier, batched): only the vetted residue (downstream; step 5/6).
 *
 * The cheap model is CAGED behind an injected leaf, opts.homeworkCheck(samples) →
 * [{uid, ok:boolean, reason?}] (schema-validated here; a mock in the smoke, a cheap local/Ollama
 * call in production). If no checker is injected, the gate is reported ungated (production always
 * injects). A checker that returns no usable verdicts FAILS the gate (never spend frontier on a
 * broken homework-check). buildHomeworkPrompt() gives step-6 the one standardized prompt shape.
 *
 * Output: { proceed, reason, decided, residue, layer0, sample }.
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyPreflight = api;
})(this, function () {
  'use strict';

  const DEFAULT_SAMPLE = 5;        // canary sample size drawn from the residue
  const DEFAULT_THRESHOLD = 0.6;   // ≥ this fraction of sampled {claim,passage} coherent ⇒ release

  // Join verify_extract units with their verify_match results into preflight candidates carrying
  // everything the homework-check needs: { uid, band, needs_model, claim, passage, source_url }.
  function buildCandidates(units, matchResults) {
    const mById = {};
    for (const m of (matchResults || [])) if (m && m.uid != null) mById[m.uid] = m;
    return (units || []).map(u => {
      const m = mById[u.uid] || {};
      const rubric = m.rubric || {};
      return {
        uid: u.uid,
        band: m.band || 'unsupported',
        needs_model: !!m.needs_model,
        claim: u.quote || u.text || '',
        passage: rubric.best_passage || '',
        source_url: rubric.source_url || u.url || null,
        match_score: m.match_score != null ? m.match_score : null,
      };
    });
  }

  // Deterministic evenly-spread sample of the residue (representative, not just the head).
  function sampleResidue(residue, n) {
    if (residue.length <= n) return residue.slice();
    const step = residue.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(residue[Math.floor(i * step)]);
    return out;
  }

  // The one standardized homework-check prompt (used by step-6's real cheap-model call).
  function buildHomeworkPrompt(samples) {
    const items = samples.map((s, i) =>
      `${i + 1}. CLAIM: ${s.claim}\n   PASSAGE: ${(s.passage || '(no passage matched)').slice(0, 400)}`).join('\n');
    return [
      'You are a pre-flight coherence checker, NOT a verifier. For each item decide only whether the',
      'PASSAGE is a coherent, on-topic candidate to verify the CLAIM against — i.e. real prose about',
      'the same subject (NOT a login page, paywall notice, 404, navigation boilerplate, or text about',
      'something unrelated). Answer per item with yes or no.',
      '',
      items,
      '',
      'Return one line per item as: <number>: yes|no - <short reason>',
    ].join('\n');
  }

  function validVerdict(v) {
    return v && typeof v === 'object' && typeof v.uid === 'string' && typeof v.ok === 'boolean';
  }

  /**
   * Run the preflight gate over a candidate list (from buildCandidates).
   * @param {Array} candidates  [{ uid, band, needs_model, claim, passage, source_url, ... }]
   * @param {object} [opts]  { homeworkCheck, sampleSize, threshold, maxResidueFraction }
   * @returns {Promise<{proceed, reason, decided, residue, layer0, sample}>}
   */
  async function preflight(candidates, opts = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const sampleSize = opts.sampleSize != null ? opts.sampleSize : DEFAULT_SAMPLE;
    const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;

    // --- Layer 0: partition (free) ---
    const decided = list.filter(c => !c.needs_model);
    const residue = list.filter(c => c.needs_model);
    const total = list.length;
    const residueFraction = total ? residue.length / total : 0;
    // Extraction sanity: if essentially nothing settled deterministically, the upstream (extract/
    // resolve/match) is suspect — flagged for the operator, but Layer 1 makes the spend decision.
    const sanity = {
      total, decidedCount: decided.length, residueCount: residue.length,
      residueFraction: Math.round(residueFraction * 1000) / 1000,
      allResidue: total > 3 && decided.length === 0,
    };
    const layer0 = { decided: decided.length, residue: residue.length, sanity };

    // Nothing to escalate → trivially proceed (the frontier is never even reached).
    if (residue.length === 0) {
      return { proceed: true, reason: 'no-residue', decided, residue, layer0, sample: { size: 0, checked: 0, passed: 0, passRate: 1, threshold, gated: false, verdicts: [] } };
    }

    // --- Layer 1: homework-check (one cheap call) ---
    const samples = sampleResidue(residue, sampleSize);
    if (typeof opts.homeworkCheck !== 'function') {
      // Ungated: production always injects the checker; without it we proceed but flag it.
      return { proceed: true, reason: 'ungated (no homeworkCheck injected)', decided, residue, layer0,
        sample: { size: samples.length, checked: 0, passed: 0, passRate: null, threshold, gated: false, verdicts: [] } };
    }

    let raw = [];
    try { raw = await opts.homeworkCheck(samples, buildHomeworkPrompt(samples)); } catch (e) {
      return { proceed: false, reason: `homework-check threw: ${e.message}`, decided, residue, layer0,
        sample: { size: samples.length, checked: 0, passed: 0, passRate: 0, threshold, gated: true, verdicts: [] } };
    }
    const verdicts = (Array.isArray(raw) ? raw : []).filter(validVerdict);

    // A broken/empty gate must NOT release the batch (fail-safe: protect the frontier spend).
    if (verdicts.length === 0) {
      return { proceed: false, reason: 'homework-check returned no usable verdicts', decided, residue, layer0,
        sample: { size: samples.length, checked: 0, passed: 0, passRate: 0, threshold, gated: true, verdicts: [] } };
    }

    const passed = verdicts.filter(v => v.ok).length;
    const passRate = passed / verdicts.length;
    const proceed = passRate >= threshold;
    const failReasons = verdicts.filter(v => !v.ok).map(v => v.reason).filter(Boolean);
    const reason = proceed
      ? `homework-check passed (${passed}/${verdicts.length} ≥ ${threshold})`
      : `homework-check failed (${passed}/${verdicts.length} < ${threshold})${failReasons.length ? ' — ' + failReasons.slice(0, 3).join('; ') : ''}`;

    return {
      proceed, reason, decided,
      residue: proceed ? residue : [],           // residue released only when the gate clears
      heldResidue: proceed ? [] : residue,        // otherwise held back (operator fixes upstream)
      layer0,
      sample: { size: samples.length, checked: verdicts.length, passed, passRate: Math.round(passRate * 1000) / 1000, threshold, gated: true, verdicts },
    };
  }

  return { preflight, buildCandidates, sampleResidue, buildHomeworkPrompt, validVerdict, DEFAULT_SAMPLE, DEFAULT_THRESHOLD };
});
