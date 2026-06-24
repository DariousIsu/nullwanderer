/*
 * Editor Studio — verification harness MODEL I/O adapters (verify_model_io).
 *
 * The determinism law's teeth: force a real model's free-form reply into the harness's standardized
 * schema. Two adapters, both pure over an INJECTED `complete({model,messages,...}) -> text` (Ollama
 * in production, a mock in the smoke) — no HTTP, no DB here, so they're offline-testable:
 *
 *   makeHomeworkCheck → the preflight Layer-1 leaf: parses "N: yes|no - reason" lines back to
 *     per-uid verdicts. Unparsed lines are omitted (preflight's fail-safe refuses to release a
 *     batch on an empty/garbage reply).
 *   makeClassifier   → the classify leaf: standardized STATUS=<CODE> | NOTE=<…> prompt, parsed to
 *     one enum status_code + note. Clean parse ⇒ confidence 0.8 (local stands, no needless cloud
 *     escalation); unparseable ⇒ low confidence (verify_classify escalates / falls to NK).
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const VC = (typeof require !== 'undefined') ? require('./verify_classify')
    : (typeof window !== 'undefined' ? window.VerifyClassify : null);
  const api = factory(VC);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyModelIO = api;
})(this, function (VC) {
  'use strict';
  const parseStatusCode = VC.parseStatusCode;

  function makeHomeworkCheck({ complete, model, base, headers } = {}) {
    return async (samples, prompt) => {
      const text = await complete({ model, base, headers, messages: [{ role: 'user', content: prompt }] });
      const out = [];
      for (const line of String(text || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[:.\)]\s*(yes|no)\b\s*[-–—:]?\s*(.*)$/i);
        if (!m) continue;
        const idx = parseInt(m[1], 10) - 1;
        if (idx < 0 || idx >= samples.length) continue;
        out.push({ uid: samples[idx].uid, ok: /^yes$/i.test(m[2]), reason: (m[3] || '').trim() });
      }
      return out;
    };
  }

  const CLASSIFY_SYS = [
    'You are a citation-verification classifier. Decide how well the SOURCE PASSAGE supports the CLAIM.',
    'Respond with EXACTLY one line and nothing else:',
    'STATUS=<CODE> | NOTE=<one short sentence>',
    'CODE is one of: V (source clearly supports), VC (verified with caveat), VP (verified but paraphrased),',
    'QO (quote present, minor omission), QP (quote present, paraphrased), A (attribution issue),',
    'M (mismatch / source contradicts), NK (not supported / not in the passage).',
  ].join('\n');

  function makeClassifier({ complete, model, base, headers } = {}) {
    return async ({ claim, passage }) => {
      const user = `CLAIM: ${claim}\nPASSAGE: ${(passage || '(no passage matched)').slice(0, 1200)}`;
      const text = await complete({ model, base, headers, messages: [{ role: 'system', content: CLASSIFY_SYS }, { role: 'user', content: user }] });
      const codeM = String(text || '').match(/STATUS\s*=\s*([A-Za-z]+)/i);
      const noteM = String(text || '').match(/NOTE\s*=\s*(.+)$/im);
      let code = codeM ? parseStatusCode(codeM[1]) : null;
      if (!code) { const tok = String(text || '').match(/\b(VC|VP|QO|QP|NK|V|A|M)\b/); code = tok ? tok[1] : null; }
      if (!code) code = parseStatusCode(text);   // last resort: synonym scan (verified/mismatch/…)
      return { status_code: code || 'NK', note: (noteM ? noteM[1] : '').trim() || String(text || '').slice(0, 160), confidence: code ? 0.8 : 0.2 };
    };
  }

  return { makeHomeworkCheck, makeClassifier, CLASSIFY_SYS };
});
