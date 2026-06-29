/* Smoke: lib/vision — two-way image capability. Deterministic: cloud call (completeFn), generator
 * (genFn), and save (saveFn) all injected; no network/db/fs.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_vision.js
 */
const v = require('../lib/vision');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- data-url stripping ---
  ok(v._stripDataUrl('data:image/png;base64,AAAB') === 'AAAB', 'strips data-url prefix');
  ok(v._stripDataUrl('AAAB') === 'AAAB', 'raw base64 left intact');

  // --- describe: builds an Ollama image request (images field) with the right model + source ---
  let req = null;
  const completeFn = async (opts) => { req = opts; return 'A golden retriever sitting on a porch.'; };
  const src = { tier: 'cloud', base: 'https://ollama.com', token: 'KEY' };
  const r = await v.describe({ imageBase64: 'data:image/png;base64,ABC', model: 'qwen2.5vl', source: src, completeFn });
  ok(r.ok && /golden retriever/.test(r.text), 'describe returns the vision text');
  ok(req.model === 'qwen2.5vl' && req.base === 'https://ollama.com', 'uses the given model + source base');
  ok(req.headers && /Bearer KEY/.test(req.headers.Authorization), 'sends the bearer token for cloud');
  ok(Array.isArray(req.messages[0].images) && req.messages[0].images[0] === 'ABC', 'passes raw base64 in the images field');

  // --- describe: failure modes are fail-safe ---
  ok((await v.describe({ imageBase64: '', source: src, completeFn })).ok === false, 'no image → ok:false');
  const blank = await v.describe({ imageBase64: 'ABC', source: src, completeFn: async () => '' });
  ok(blank.ok === false && /returned nothing/.test(blank.reason), 'empty model output → ok:false with reason');
  const thrown = await v.describe({ imageBase64: 'ABC', source: src, completeFn: async () => { throw new Error('boom'); } });
  ok(thrown.ok === false && /vision call failed/.test(thrown.reason), 'thrown error → caught, ok:false');

  // --- source selection: local is always present; cloud only with a key ---
  ok(v._pickSource('local') && v._pickSource('local').tier === 'local', "tier 'local' → local source");

  // --- gen tag parsing ---
  ok(JSON.stringify(v.parseGenTags('hi <image-gen>a red barn at dusk</image-gen> bye')) === JSON.stringify(['a red barn at dusk']), 'parses <image-gen>');
  ok(v.parseGenTags('<draw>a cat</draw><imagine>a dog</imagine>').length === 2, 'parses <draw> + <imagine>');
  ok(v.stripGenTags('keep <draw>x</draw> this') === 'keep this', 'strips gen tags from display text');

  // --- generate: KILL-SWITCH off by default ---
  const off = await v.generate({ prompt: 'a red barn' });   // no genFn, no env → disabled
  ok(off.ok === false && off.disabled === true && /OFF by design/i.test(off.reason), 'generation OFF by default (kill-switch)');
  ok((await v.generate({ prompt: '' })).reason === 'empty prompt', 'empty prompt → reason');

  // --- generate: works when a provider (genFn) + save are supplied ---
  let savedB64 = null;
  const genFn = async (p) => { ok(/barn/.test(p), 'generator receives the prompt'); return 'IMGBASE64'; };
  const saveFn = async (b64) => { savedB64 = b64; return '/data/zoe_workspace/images/gen_1.png'; };
  const gen = await v.generate({ prompt: 'a red barn at dusk', genFn, saveFn });
  ok(gen.ok && gen.path === '/data/zoe_workspace/images/gen_1.png' && savedB64 === 'IMGBASE64', 'generate → saves + returns path');
  const genThrow = await v.generate({ prompt: 'x', genFn: async () => { throw new Error('provider down'); } });
  ok(genThrow.ok === false && /image generation failed/.test(genThrow.reason), 'provider error → ok:false');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
