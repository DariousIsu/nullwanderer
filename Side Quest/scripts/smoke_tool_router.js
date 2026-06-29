/* Smoke: lib/tool_router — the cloud tool-router (P3) picks web / echo / none. Deterministic:
 * cloud `ask` injected, no network. Guards: question gate, surface routing, fail-safe defaults.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_tool_router.js
 */
const tr = require('../lib/tool_router');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- looksLikeLookup gate (avoids cloud calls on chatter) ---
  ok(tr.looksLikeLookup('what is the price of oil') === true, 'question → looks like lookup');
  ok(tr.looksLikeLookup('can you find our latest polling data') === true, 'request → looks like lookup');
  ok(tr.looksLikeLookup('lol that is hilarious') === false, 'chatter → not a lookup');
  ok(tr.looksLikeLookup('hey') === false, 'too short → not a lookup');

  // --- web surface ---
  const webAsk = async ({ task, input }) => { ok(task === 'tool_route' && /price of oil/.test(input.user), 'planner gets the user message'); return { surface: 'web', arg: 'current price of oil', reason: 'live price' }; };
  const w = await tr.planTool({ userMessage: 'what is the price of oil right now', deps: { ask: webAsk } });
  ok(w.surface === 'web' && /oil/.test(w.arg), 'routes to web with a query');

  // --- echo surface (our private data) ---
  const echoAsk = async () => ({ surface: 'echo', arg: 'latest Rainey polling on permitting', reason: 'our vault' });
  const e = await tr.planTool({ userMessage: 'pull our latest polling on permitting reform', deps: { ask: echoAsk } });
  ok(e.surface === 'echo' && /polling/.test(e.arg), 'routes to echo for OUR data');

  // --- none (answerable from memory / chat) ---
  const noneAsk = async () => ({ surface: 'none', reason: 'memory' });
  ok((await tr.planTool({ userMessage: 'what did we decide earlier?', deps: { ask: noneAsk } })).surface === 'none', 'none when no external lookup needed');

  // --- non-question short-circuits WITHOUT a cloud call ---
  let called = false;
  const spyAsk = async () => { called = true; return { surface: 'web', arg: 'x' }; };
  const chat = await tr.planTool({ userMessage: 'that made me smile', deps: { ask: spyAsk } });
  ok(chat.surface === 'none' && called === false, 'chatter → none, NO cloud call spent');

  // --- fail-safe: malformed / null / missing arg → none ---
  ok((await tr.planTool({ userMessage: 'what is x', deps: { ask: async () => null } })).surface === 'none', 'cloud null → none');
  ok((await tr.planTool({ userMessage: 'what is x', deps: { ask: async () => ({ surface: 'web' }) } })).surface === 'none', 'web with no arg → none');
  ok((await tr.planTool({ userMessage: 'what is x', deps: { ask: async () => ({ surface: 'banana', arg: 'y' }) } })).surface === 'none', 'unknown surface → none');
  ok((await tr.planTool({ userMessage: 'what is x', deps: { ask: async () => { throw new Error('cloud down'); } } })).surface === 'none', 'cloud throws → none (fail-safe)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
