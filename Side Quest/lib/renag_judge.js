'use strict';
/**
 * renag_judge.js — bounded model classifier for the FALSE-INCOMPLETENESS self-nag (FEC loop, 2026-08-16 audit).
 *
 * The question: when an idle rail is about to say, unprompted, "I never finished / still owe you X", has X
 * ALREADY been fully delivered to the user? A lexical predecessor could not answer it — "I pulled figures but
 * didn't get you a clean comparison" (a FALSE re-nag of a delivered head-to-head) is lexically identical to
 * "I gave you Scott's but still owe Moody's" (a GENUINE partial). The only difference is whether the claimed-
 * missing thing is actually present in a prior delivery, which is a reading-comprehension judgment. So, per the
 * detectors-vs-comprehension cure shape, this is a bounded model call GATED by two cheap pure predicates in
 * delivery.js (isOwedClaim + resultBearingDeliveries) so it fires only when there's genuinely something to
 * check. Mirrors lib/importance.js: tiny prompt, num_predict small, temperature 0, its own cloud model.
 *
 * FAIL-OPEN: any error, empty, or ambiguous reply → false (SURFACE). The adversarial pass (wf_38a9dc28) made
 * the asymmetry explicit — suppressing a genuine partial or a correction (leaving Lucas holding wrong data) is
 * far worse than letting one nag through, so uncertainty must resolve to surface, never to suppress.
 *
 * Run: node scripts/smoke_renag_judge.js (injected classify — no network); live model proof in the drill log.
 */
const { streamChat } = require('./ollama');
const config = require('./config');

const MODEL = config.importanceModel();

// DONE = the deliveries already contain it → it's a false re-nag → suppress (true).
// OPEN = genuinely still owed (a part, a correction, a new metric) → surface (false). Ambiguous → surface.
function parseVerdict(raw) {
  const s = String(raw || '').toLowerCase();
  if (/\bopen\b/.test(s)) return false;   // check OPEN first — a model that echoes "DONE or OPEN" must not read as DONE
  if (/\bdone\b/.test(s)) return true;
  return false;                            // empty / neither → fail-open to surface
}

/**
 * isRedundantRenag(say, deliveries, opts?) → Promise<boolean>
 *   say         — the composed unprompted utterance
 *   deliveries  — array of recent delivered-reply strings (from delivery.resultBearingDeliveries)
 *   opts.classify(say, deliveries[]) — optional SYNC/async override for deterministic tests; bypasses the model
 * true  = the say falsely re-nags work the deliveries already contain → the caller SUPPRESSES it.
 * false = genuinely remaining work, OR nothing to check, OR any failure → the caller lets it surface.
 */
async function isRedundantRenag(say, deliveries, { classify = null, model = MODEL } = {}) {
  const s = String(say == null ? '' : say).trim();
  const dl = (Array.isArray(deliveries) ? deliveries : []).filter(Boolean).map((d) => String(d));
  if (!s || !dl.length) return false;      // nothing delivered to contradict it → surface (honest "not yet")
  if (typeof classify === 'function') { try { return (await classify(s, dl)) === true; } catch { return false; } }

  const block = dl.slice(0, 3).map((d, i) => `--- actually delivered #${i + 1} ---\n${d.slice(0, 600)}`).join('\n\n');
  const messages = [{
    role: 'user',
    content:
`An AI assistant on an idle timer keeps fretting that it "never finished" or "still owes" things. It is often WRONG — it re-nags work it ALREADY delivered — but not always. Decide by checking the SPECIFIC things it names against what it ACTUALLY delivered.

The assistant is about to say, unprompted:
"${s.slice(0, 500)}"

What it ACTUALLY delivered to this same user recently (the ground truth):
${block}

Check each specific thing the assistant names as missing — a person or entity, a named figure, a named metric (e.g. "cash-on-hand", "burn rate"), a comparison, a section:
- Reply OPEN if ANY specific named thing is genuinely absent from the deliveries above, or it names a correction that would replace wrong/outdated delivered data. Genuinely-missing work must reach the user.
- Reply DONE only if everything it names is ALREADY in the deliveries — the same people, the same numbers, the same comparison — OR it only gestures vaguely ("those numbers", "a clean comparison", "the head-to-head", "that breakdown") at material that is already there. In that case its "I never… / didn't get you a clean… / totals shifted" wording is just a false worry, not evidence.
Account for aliases and abbreviations (e.g. "DMP" = "Debbie Mucarsel-Powell"; "the Democrat" may name a delivered candidate).

Reply with ONLY one word: DONE or OPEN.`
  }];

  let raw = '';
  try {
    await streamChat({
      model,
      messages,
      options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 6 },
      think: false,
      onToken: (tk) => { raw += tk; },
    });
  } catch (e) {
    console.error('[renag_judge] classify call failed:', e.message);
    return false;   // fail-open → surface
  }
  return parseVerdict(raw);
}

module.exports = { isRedundantRenag, parseVerdict, MODEL };
