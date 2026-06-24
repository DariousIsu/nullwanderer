/*
 * Editor Studio — verification harness STAGE 5: classify (verify_classify) — THE ONLY MODEL TOUCH.
 *
 * Pipeline (EDITOR_TAB_SPEC, FROZEN): … → match → preflight → THIS → contract. Everything upstream
 * is deterministic; this is the single caged leaf where model cognition is allowed, and only on the
 * vetted residue the preflight gate released. Input AND output are schema-validated — the model is
 * a COMPONENT inside the rails, never the orchestrator.
 *
 *   classify({claim, passage}) -> { status_code ∈ {V,VC,VP,QO,QP,A,M,NK}, note }
 *
 * TIERED model (model-selector primitive): a local 24B call first; escalate to the cloud frontier
 * only when the local call is LOW-CONFIDENCE or returns schema-invalid output. Both tiers are
 * INJECTED (opts.model / opts.frontier — async ({claim,passage}) -> {status_code, note, confidence?}).
 * With NEITHER injected, a deterministic STUB stands in (lexical-overlap placeholder) so the entire
 * harness runs end-to-end OFFLINE before a single cloud token is spent — exactly the build-order
 * requirement for this step.
 *
 * STRICT I/O: invalid model output never silently becomes a guess — validateOutput maps known
 * synonyms, else flags valid:false and falls to a conservative NK with the violation recorded
 * (the contract's strict gate, studio/checks_contract.js, then surfaces it to the operator).
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const VM = (typeof require !== 'undefined') ? require('./verify_match')
    : (typeof window !== 'undefined' ? window.VerifyMatch : null);
  const api = factory(VM);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyClassify = api;
})(this, function (VM) {
  'use strict';

  // The frozen per-claim status-code enum (mirrors checks_contract STATUS_CODE + the Rainey TOMLs).
  const STATUS_CODES = Object.freeze(['V', 'VC', 'VP', 'QO', 'QP', 'A', 'M', 'NK']);
  const CODE_SET = new Set(STATUS_CODES);
  const MIN_CONFIDENCE = 0.65;   // local-tier confidence below this ⇒ escalate to frontier

  // Map a free-form model status string onto the enum (strict: returns null if unmappable).
  function parseStatusCode(s) {
    const up = String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '_');
    if (CODE_SET.has(up)) return up;
    const t = up.toLowerCase();
    if (/^veri/.test(t)) return /paraphrase/.test(t) ? 'VP' : (/caveat/.test(t) ? 'VC' : 'V');
    if (/paraphrase/.test(t)) return /quote/.test(t) ? 'QP' : 'VP';
    if (/omission/.test(t)) return 'QO';
    if (/attribution/.test(t)) return 'A';
    if (/mismatch|contradict/.test(t)) return 'M';
    if (/not[_\s-]?in|unknown|no[_\s-]?(?:kdb|source)/.test(t)) return 'NK';
    return null;
  }

  // ---- schema validation (input + output) ------------------------------------------------------
  function validateInput(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'input must be an object' };
    if (typeof input.claim !== 'string' || !input.claim.trim()) return { ok: false, error: 'claim must be a non-empty string' };
    if (input.passage != null && typeof input.passage !== 'string') return { ok: false, error: 'passage must be a string' };
    return { ok: true };
  }
  function validateOutput(out) {
    if (!out || typeof out !== 'object') return { ok: false, error: 'output must be an object' };
    const code = parseStatusCode(out.status_code != null ? out.status_code : out.code);
    if (!code) return { ok: false, error: `status_code "${out.status_code}" not in enum` };
    const note = typeof out.note === 'string' ? out.note : (typeof out.finding === 'string' ? out.finding : '');
    return { ok: true, status_code: code, note };
  }

  // ---- deterministic stub (no model) -----------------------------------------------------------
  // Honest placeholder: pure lexical-overlap → a code, so the pipeline yields varied, reproducible
  // output offline. Clearly marked tier:'stub' / low confidence so production tiering would escalate.
  function stubClassify(input) {
    const overlap = VM ? VM.contentOverlap(input.claim, input.passage || '') : 0;
    const code = overlap >= 0.7 ? 'VP' : (overlap >= 0.4 ? 'QP' : 'NK');
    return { status_code: code, note: `stub: content-overlap=${Math.round(overlap * 100) / 100}`, confidence: 0.3 };
  }

  /**
   * Classify one residue item. Caged: validated input → tiered model (or stub) → validated output.
   * @param {{claim:string, passage?:string}} input
   * @param {object} [opts] { model, frontier, minConfidence }
   * @returns {Promise<{status_code, note, tier, confidence, valid}>}
   */
  async function classify(input, opts = {}) {
    const vi = validateInput(input);
    if (!vi.ok) throw new Error(`classify: invalid input — ${vi.error}`);
    const minConf = opts.minConfidence != null ? opts.minConfidence : MIN_CONFIDENCE;

    // No model injected → deterministic stub (offline end-to-end).
    if (typeof opts.model !== 'function' && typeof opts.frontier !== 'function') {
      const s = stubClassify(input);
      return { status_code: s.status_code, note: s.note, tier: 'stub', confidence: s.confidence, valid: true };
    }

    // Tier 1 — local model.
    if (typeof opts.model === 'function') {
      let raw; try { raw = await opts.model(input); } catch (e) { raw = null; }
      const vo = validateOutput(raw);
      const conf = raw && typeof raw.confidence === 'number' ? raw.confidence : (vo.ok ? 1 : 0);
      if (vo.ok && conf >= minConf) return { status_code: vo.status_code, note: vo.note, tier: 'local', confidence: conf, valid: true };
      // low-confidence OR invalid local output → escalate if a frontier is available
      if (typeof opts.frontier !== 'function') {
        if (vo.ok) return { status_code: vo.status_code, note: vo.note, tier: 'local', confidence: conf, valid: true };
        return { status_code: 'NK', note: `local output invalid: ${vo.error}`, tier: 'local', confidence: 0, valid: false };
      }
    }

    // Tier 2 — cloud frontier (escalation, or sole tier if only frontier injected).
    let fr; try { fr = await opts.frontier(input); } catch (e) { fr = null; }
    const vof = validateOutput(fr);
    if (vof.ok) {
      const conf = fr && typeof fr.confidence === 'number' ? fr.confidence : 1;
      return { status_code: vof.status_code, note: vof.note, tier: 'frontier', confidence: conf, valid: true };
    }
    return { status_code: 'NK', note: `frontier output invalid: ${vof.error}`, tier: 'frontier', confidence: 0, valid: false };
  }

  /**
   * Classify the vetted residue. items: [{uid, claim, passage, ...}]. Sequential = deterministic.
   * Returns [{uid, status_code, note, tier, confidence, valid}].
   */
  async function classifyAll(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    for (const it of list) {
      const r = await classify({ claim: it.claim, passage: it.passage }, opts);
      out.push(Object.assign({ uid: it.uid }, r));
    }
    return out;
  }

  return { classify, classifyAll, stubClassify, validateInput, validateOutput, parseStatusCode, STATUS_CODES, MIN_CONFIDENCE };
});
