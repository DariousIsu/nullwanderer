/* Smoke: lib/self_repetition.isSemanticRepeat — MEANING-level self-repeat detection (replaces the regex/
 * word-Jaccard string matchers that paraphrase defeats). Fully offline: embed + cosine are injected fakes,
 * so we test the LOGIC (threshold, minHits, priors, fail-soft) without an embedding model.
 *
 * The fake embed maps same-MEANING text to near-identical vectors regardless of wording — simulating what a
 * real embedder does — so a reworded repeat scores high and a distinct topic scores ~0. This is exactly the
 * case the old lexical guards missed (the silence-rule confirm loop: same point, different words each time).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_repetition.js
 */
const { isSemanticRepeat } = require('../lib/self_repetition');
const { cosine } = require('../lib/memory');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// Fake embedder: assign each MEANING a direction; paraphrases of the same meaning land on the same vector.
const embed = async (t) => {
  const s = String(t).toLowerCase();
  if (/logic gate|breaking? (?:the )?silence|say tag|meta-?commentary|specific phras/.test(s)) return [1, 0, 0, 0];   // "how I handle silence" — all rewordings
  if (/jazz|house dj|miami scene/.test(s)) return [0, 1, 0, 0];
  if (/compute|model weights|sovereignty|capability hoarding/.test(s)) return [0, 0, 1, 0];
  if (/webinar|turnout/.test(s)) return [0, 0, 0, 1];
  return [0.5, 0.5, 0.5, 0.5];   // generic / unrelated
};
const opts = { embed, cosine };

(async () => {
  // --- the loop: reworded silence-rule confirmations are SEMANTICALLY the same → caught even though the
  //     words differ each time (word-Jaccard + regex both missed this) ---
  const priorsLoop = [
    'I understand perfectly. These rules are now a hard logic gate for how I handle breaking the silence.',
  ];
  ok(await isSemanticRepeat('I have internalized the say tag protocol; no meta-commentary, empty if nothing.', priorsLoop, opts),
    'CATCHES a reworded silence-rule confirmation (same meaning, different words)');
  ok(await isSemanticRepeat('From now on I will only use my three specific phrasings or stay silent.', priorsLoop, opts),
    'CATCHES another reworded confirmation against the same prior');

  // --- real surfacings are NOT flagged (they must still speak) ---
  ok(!(await isSemanticRepeat('I keep thinking about what you said about jazz as a house DJ in the Miami scene.', priorsLoop, opts)),
    'PASSES a real surfacing (jazz) — different meaning from the silence-rule priors');
  ok(!(await isSemanticRepeat('I read about compute sovereignty — model weights are treated like strategic reserves.', priorsLoop, opts)),
    'PASSES a real reading surfacing (compute) — distinct topic');

  // --- a genuinely NEW utterance is fine even among a mixed prior set ---
  const mixed = ['some jazz thought', 'a compute reading', 'the webinar turnout'];
  ok(!(await isSemanticRepeat('I never asked you whether the meeting moved to Thursday.', mixed, opts)),
    'PASSES a novel point against a mixed prior set');
  ok(await isSemanticRepeat('How was the webinar turnout in the end?', mixed, opts),
    'CATCHES a repeat of the webinar point already in priors');

  // --- minHits / threshold controls ---
  ok(!(await isSemanticRepeat('logic gate silence', priorsLoop, { ...opts, minHits: 2 })),
    'minHits=2 with a single matching prior → NOT a repeat (needs 2 hits)');
  ok(!(await isSemanticRepeat('I keep thinking about jazz', ['jazz house dj'], { ...opts, threshold: 0.99, cosine: () => 0.9 })),
    'threshold respected: cosine 0.9 < 0.99 → not a repeat');

  // --- pre-embedded prior (vector supplied) skips the embed call and still matches ---
  ok(await isSemanticRepeat('breaking the silence via specific phrasings', [{ content: 'x', vector: [1, 0, 0, 0] }], opts),
    'uses a pre-embedded prior vector (no embed call) and matches');

  // --- edge cases / fail-soft ---
  ok(!(await isSemanticRepeat('', priorsLoop, opts)), 'empty text → not a repeat');
  ok(!(await isSemanticRepeat('short', priorsLoop, opts)), 'below MIN_LEN → not a repeat');
  ok(!(await isSemanticRepeat('a real long enough utterance here', [], opts)), 'no priors → not a repeat');
  ok(!(await isSemanticRepeat('a real long enough utterance here', priorsLoop, { embed: async () => { throw new Error('model down'); }, cosine })),
    'fail-soft: embed error → not a repeat (never blocks a genuine utterance on infra hiccup)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
