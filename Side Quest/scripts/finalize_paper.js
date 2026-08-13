/**
 * Drive the FINALIZE conductor (lib/paper_finalize) on a topic — the program producing a finished
 * document: ONE file, frozen outline, inline [n] citations, full source list. This script is the
 * same call the artifact router will make; running it IS the program doing its job.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\finalize_paper.js "applied digital" "goal text"
 */
const topic = process.argv[2] || 'applied digital';
const goal = process.argv[3] || `A complete, sourced research paper on ${topic}.`;
const pf = require('../lib/paper_finalize');
const ollama = require('../lib/ollama');
const config = require('../lib/config');

(async () => {
  try { require('../lib/db').init(); } catch {}   // doc_store.land needs the store open
  const model = process.env.ZOE_PAPER_MODEL || config.deepReasonerModel();
  console.log(`[finalize] topic="${topic}" model=${model}`);
  const write = async (prompt) => ollama.complete({
    model,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.4, num_predict: 900 },
    lane: 'directed',           // Lucas-demanded work — the honest tier
    think: false,               // reasoning models: content, never salvaged chain-of-thought
    timeoutMs: 240000,
  });
  const t0 = Date.now();
  const r = await pf.finalize({ topic, goal, write });
  if (!r.ok) { console.error(`[finalize] FAILED: ${r.reason}`); process.exit(1); }
  console.log(`[finalize] DONE in ${Math.round((Date.now() - t0) / 1000)}s — ${r.sections} sections, ${r.sourceCount} sources, ${r.fragments} fragments folded`);
  console.log(`[finalize] THE document: ${r.path}`);
  process.exit(0);
})().catch((e) => { console.error('[finalize] crashed:', e.message); process.exit(1); });
