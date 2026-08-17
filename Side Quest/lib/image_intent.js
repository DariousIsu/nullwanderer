'use strict';
/**
 * lib/image_intent.js — recover a PROMISED-but-undrawn image (2026-08-17 live audit).
 *
 * On an INDIRECT image request ("I can't picture my patio with a koi pond…") she recognises the opening and
 * COMMITS — "I'll render an image of your patio… give me a moment" — writes the whole image prompt as PROSE,
 * but emits no <draw> tag, so nothing generates. The anti-fab gate (metacognition.verifyArtifactClaims)
 * deliberately SKIPS future-tense sentences ("only completed claims are falsifiable"), so this dangling
 * commitment is completely unguarded: she promises an image and none appears — which reads to Lucas as
 * "she forgot she can make images", and is worse than a plain miss because she promised.
 *
 * This detects that unfired commitment and returns the prompt she meant to draw, so the harness can dispatch
 * the <draw> she intended (the image then lands "in a moment", fulfilling her own words). Per the detectors-
 * vs-comprehension cure: a cheap regex PREFILTER (a false nominate costs one classifier call) gates a bounded
 * model that EXTRACTS the prompt or answers NONE. FAILS CLOSED — any error/ambiguity → null (no dispatch),
 * because generating a spurious image she didn't intend is worse than missing one recovery. Mirrors
 * lib/renag_judge: tiny prompt, temperature 0, its own cloud model, injectable classify for offline tests.
 */
const { streamChat } = require('./ollama');
const config = require('./config');

const _DRAW_VERB = "render|draw|generate|create|make|paint|sketch|whip up|cook up|mock up|conjure|put together";
const _IMG_NOUN = "image|picture|pic|portrait|illustration|drawing|render|rendering|photo|artwork|sketch|scene|visual|mockup|concept art|wallpaper";
const _COMMIT = "i'?ll|i will|i'?m going to|i am going to|going to|gonna|let me|give me a (?:moment|sec|second|minute)|one (?:sec|moment)|hang on|coming (?:right )?up|on it";

// Three shapes of an UNFIRED commitment: commit→verb→noun; verb→noun→"for you/right now"; commit→verb→"it/that".
// Broad on purpose — the classifier is the real gate; the regex only avoids paying it on ordinary chat.
const _INTENT_RE = new RegExp(
  `\\b(?:${_COMMIT})\\b[^.!?\\n]{0,60}\\b(?:${_DRAW_VERB})\\b[^.!?\\n]{0,40}\\b(?:${_IMG_NOUN})\\b`
  + `|\\b(?:${_DRAW_VERB})\\b[^.!?\\n]{0,40}\\b(?:${_IMG_NOUN})\\b[^.!?\\n]{0,40}\\b(?:for you|for ya|right now|now|real quick)\\b`
  + `|\\b(?:${_COMMIT})\\b[^.!?\\n]{0,40}\\b(?:${_DRAW_VERB})\\b[^.!?\\n]{0,20}\\b(?:it|that|this|them|one)\\b`,
  'i');

/** Cheap pure prefilter: does the reply read like a committed-but-unfired image? */
function looksLikeUnfiredImageIntent(say) { return _INTENT_RE.test(String(say || '')); }

const MODEL = config.importanceModel();

/**
 * recoverUnfiredPrompt(say, opts?) → Promise<string|null>
 *   say       — the composed reply text (no <draw> was emitted this turn)
 *   opts.classify(ask) — optional sync/async override returning the raw model text (deterministic tests)
 * Returns a single image-generation prompt to dispatch, or null when she did NOT actually commit to a NEW
 * image (a mere offer/question, a reference to an existing/external image) or on ANY failure (FAIL CLOSED).
 */
async function recoverUnfiredPrompt(say, { classify = null, model = MODEL } = {}) {
  const text = String(say == null ? '' : say).trim();
  if (!text || !looksLikeUnfiredImageIntent(text)) return null;

  const ask =
`An AI assistant just replied to a user and said it WOULD create/draw an image — but it did NOT actually generate one (no image was produced).

Its reply:
"""
${text.slice(0, 1500)}
"""

Decide:
- If it genuinely COMMITTED to making a NEW image right now (e.g. "I'll render an image of…", "let me draw that", "give me a moment"), output ONE vivid image-generation prompt on a single line — subject, setting, style, lighting — capturing the image it intended. Use the details it already described. No preamble, no quotes, just the prompt.
- If it did NOT actually commit to generating a NEW image — it only ASKED ("want me to draw it?"), merely OFFERED, declined, or referred to an EXISTING or external/online image — output exactly: NONE

Answer:`;

  let raw = '';
  try {
    if (typeof classify === 'function') { raw = String(await classify(ask) || ''); }
    else {
      await streamChat({
        model,
        messages: [{ role: 'user', content: ask }],
        options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 120 },
        think: false,
        onToken: (tk) => { raw += tk; },
      });
    }
  } catch (e) { try { console.error('[image_intent] classify failed:', e.message); } catch {} return null; }   // FAIL CLOSED

  const first = String(raw || '').split(/\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
  if (!first || /^none\b/i.test(first)) return null;
  const cleaned = first.replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/^prompt\s*[:\-]\s*/i, '').trim();
  return cleaned.length >= 8 ? cleaned.slice(0, 500) : null;   // too-short → treat as a non-answer (fail closed)
}

module.exports = { recoverUnfiredPrompt, looksLikeUnfiredImageIntent, _INTENT_RE, MODEL };
