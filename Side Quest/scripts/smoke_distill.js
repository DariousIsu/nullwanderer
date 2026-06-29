/* Smoke: lib/distill (context distillation) + config.frontModel (front/voice model role).
 * Deterministic: cloud `ask` injected, temp DB for meta. No network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_distill.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_distill_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const distill = require('../lib/distill');
const config = require('../lib/config');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// Genuinely heavy now (> the raised 3500c auto threshold): full knowledge block + several long
// thoughts/past-turns, the kind of firehose distillation is actually meant to compress.
const heavy = {
  knowledge: 'X'.repeat(2500),
  monologue: Array.from({ length: 4 }, (_, i) => ({ content: `thought ${i}: ` + 'y'.repeat(240) })),
  pastTurns: Array.from({ length: 4 }, (_, i) => ({ content: `past turn ${i}: ` + 'z'.repeat(240) })),
  threads: [{ content: 'research 6G privacy' }],
  commitments: [{ content: 'I prefer concise answers' }]
};
const light = { knowledge: 'short note', monologue: [] };

(async () => {
  // --- _packContext assembles the bulky blocks ---
  const packed = distill._packContext(heavy);
  ok(/MEMORY \/ KNOWLEDGE/.test(packed) && /RELEVANT PAST TURNS/.test(packed) && /past turn/.test(packed), '_packContext folds the blocks in');

  // --- shouldDistill gate (auto / off / always) ---
  D.setMeta('distill.mode', 'auto');
  ok(distill.shouldDistill(heavy) === true, 'auto: heavy context → distill');
  ok(distill.shouldDistill(light) === false, 'auto: light context → skip');
  D.setMeta('distill.mode', 'off');
  ok(distill.shouldDistill(heavy) === false, 'off: never distill');
  D.setMeta('distill.mode', 'always');
  ok(distill.shouldDistill(heavy) === true && distill.shouldDistill({ knowledge: 'note '.repeat(60) }) === true, 'always: distill any non-trivial context (>200c)');
  ok(distill.shouldDistill({ knowledge: 'tiny' }) === false, 'always: still skips near-empty context');
  D.setMeta('distill.mode', 'auto');

  // --- distill: injected ask returns a brief ---
  let sawInput = null;
  const askBrief = async (opts) => { sawInput = opts.input; return '• User asks about Bayesian priors\n• You hold: prefer concise answers\n• Tone: curious'; };
  const brief = await distill.distill({ userMessage: 'explain Bayesian priors simply', blocks: heavy, deps: { ask: askBrief } });
  ok(typeof brief === 'string' && /Bayesian priors/.test(brief), 'distill returns the brief');
  ok(sawInput && /past turn|thought/.test(sawInput.context) && /explain Bayesian/.test(sawInput.user), 'distill packs user + context into the cloud input');

  // --- distill validator strips code fences ---
  const fenced = await distill.distill({ userMessage: 'hi there friend', blocks: heavy, deps: { ask: async () => '```\n• a clean brief line\n```' } });
  ok(fenced === '```\n• a clean brief line\n```' || /a clean brief line/.test(fenced), 'distill returns brief (fence handling in validator)');

  // --- CONTRACT: through the REAL cloud_logic.ask with only deps.complete (which must return
  // {text, model}). Guards the live bug where _distillComplete returned a raw string → ask read
  // result.text → undefined → empty brief. ---
  const briefContract = await distill.distill({
    userMessage: 'remind me about my kids',
    blocks: heavy,
    deps: { complete: async () => ({ text: '• Kids: Alice (cheer), Raegan (film)\n• Ask: reminder\n• Tone: warm', model: 'test' }) }
  });
  ok(typeof briefContract === 'string' && /Alice \(cheer\)/.test(briefContract), 'distill via real ask + deps.complete({text}) → brief (the {text} contract)');
  const briefBadShape = await distill.distill({
    userMessage: 'x'.repeat(20), blocks: heavy,
    deps: { complete: async () => 'a raw string, not {text}' }   // wrong shape → ask sees no text → null
  });
  ok(briefBadShape === null, 'deps.complete returning a raw string (wrong shape) → null (fail-safe)');

  // --- fail-safe: cloud null → null (caller keeps full context) ---
  ok((await distill.distill({ userMessage: 'hello', blocks: heavy, deps: { ask: async () => null } })) === null, 'cloud null → distill null (fail-safe)');
  ok((await distill.distill({ userMessage: '', blocks: heavy, deps: { ask: async () => 'x' } })) === null, 'empty user message → null');

  // --- FRONT MODEL role (config.frontModel) ---
  process.env.ZOE_FRONT_MODEL = 'dans-personality-engine:24b';
  ok(config.frontModel() === 'dans-personality-engine:24b', 'frontModel uses ZOE_FRONT_MODEL when set');
  delete process.env.ZOE_FRONT_MODEL;
  ok(config.frontModel() === config.model(), 'frontModel falls back to model() when unset');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
