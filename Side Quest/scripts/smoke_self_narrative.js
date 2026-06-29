/* Smoke: lib/self_narrative — unified self-narrative (self-awareness Layer 4).
 * Deterministic: model (genFn), store (setFn), and clock (nowTs/getFn) all injected. No model/db.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_narrative.js
 */
const sn = require('../lib/self_narrative');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- compose: builds a prompt from her fragments, stores narrative + timestamp ---
  const store = {};
  const setFn = (k, v) => { store[k] = v; };
  let seenPrompt = '';
  const genFn = async (prompt) => { seenPrompt = prompt; return 'I am Zoe — curious, honest, and steady. I love deep ocean blue and I care about getting facts right. Lately I learned to say when I do not know instead of guessing.'; };
  const selfRows = [{ category: 'preference', content: 'My favorite color is deep ocean blue.' }, { category: 'value', content: 'I value getting facts right.' }];
  const devRows = [{ content: '2026-06-28 — I now admit when I do not know instead of guessing.' }];
  const text = await sn.compose({ genFn, selfRows, devRows, setFn, nowTs: 5000, name: 'Zoe' });

  ok(/favorite color is deep ocean blue/.test(seenPrompt), 'compose feeds self-fragments into the prompt');
  ok(/I now admit when I do not know/.test(seenPrompt), 'compose feeds recent dev changes into the prompt');
  ok(text && /I am Zoe/.test(text), 'compose returns the narrative');
  ok(store[sn.NARR_KEY] === text && store[sn.NARR_AT_KEY] === '5000', 'stores narrative + timestamp');

  // --- compose rejects an empty / too-short model result ---
  const empty = await sn.compose({ genFn: async () => '   ', selfRows, devRows, setFn: () => { throw new Error('should not store'); }, nowTs: 1 });
  ok(empty === null, 'empty model output → no narrative, no store');

  // --- current / composedAt / isStale via injected getter ---
  const getFn = (k) => ({ [sn.NARR_KEY]: 'I am Zoe.', [sn.NARR_AT_KEY]: '1000' }[k]);
  ok(sn.current({ getFn }) === 'I am Zoe.', 'current() reads stored narrative');
  ok(sn.composedAt({ getFn }) === 1000, 'composedAt() reads timestamp');
  ok(sn.isStale({ getFn, nowTs: 1000 + sn.DEFAULT_TTL_MS + 1 }) === true, 'older than TTL → stale');
  ok(sn.isStale({ getFn, nowTs: 1000 + 1000 }) === false, 'within TTL → fresh');
  ok(sn.isStale({ getFn: () => null, nowTs: 9999 }) === true, 'never composed → stale');

  // --- maybeRefresh: composes only when stale ---
  let composed = 0;
  const composeFn = async () => { composed++; return 'fresh narrative'; };
  await sn.maybeRefresh({ getFn, nowTs: 1000 + 1000, composeFn });          // fresh → skip
  ok(composed === 0, 'maybeRefresh skips when fresh');
  await sn.maybeRefresh({ getFn, nowTs: 1000 + sn.DEFAULT_TTL_MS + 1, composeFn }); // stale → compose
  ok(composed === 1, 'maybeRefresh composes when stale');

  // --- buildBlock: identity-anchor framing; null on empty ---
  const block = sn.buildBlock('I am Zoe — curious and honest.', 'Lucas');
  ok(/WHO YOU ARE, IN YOUR OWN WORDS/.test(block) && /persists across every reset/i.test(block), 'block frames a continuous, persistent self');
  ok(/I am Zoe — curious and honest\./.test(block), 'block contains the narrative');
  ok(sn.buildBlock('', 'Lucas') === null, 'empty narrative → null block');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
