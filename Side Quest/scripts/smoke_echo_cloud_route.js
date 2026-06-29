/* Smoke: lib/echo_suit cloud routing — the cloud Reasoner picks the recipe/tool + writes args,
 * we execute it; the conversational front never authors echo-do JSON. Deterministic: mock Echo
 * client (callTool) + injected cloud `ask`. No network/db/model.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_echo_cloud_route.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_echoroute_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const { EchoSuit, echoCloudRouteEnabled } = require('../lib/echo_suit');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// Mock Echo MCP client — returns MCP-shaped { content:[{text}] } per tool.
function mockClient() {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      const J = (o) => ({ content: [{ text: JSON.stringify(o) }] });
      if (name === 'list_recipes') return J({ recipes: [{ name: 'lamp-count', intent: 'count LAMP network members', arg_required: false }] });
      if (name === 'get_tool_map') return J({ by_intent: { search: [{ name: 'search_knowledge', description: 'search the knowledge base / vault' }] } });
      if (name === 'describe_tool') return J({ name: args.name, parameters: { query: { type: 'string', required: true } } });
      if (name === 'run_recipe') return J({ ok: true, result: '42 LAMP members' });
      if (name === 'search_knowledge') return { content: [{ text: 'found 3 vault results about X' }] };
      return { content: [{ text: '' }] };
    }
  };
}

(async () => {
  // --- RECIPE route: pick recipe → run_recipe → result ---
  let suit = new EchoSuit({ client: mockClient() }); suit.connected = true;
  const askRecipe = async ({ task }) => task === 'echo_pick' ? { type: 'recipe', name: 'lamp-count', arg: null, reason: 'count recipe' } : null;
  const r1 = await suit.routeNeed('how many LAMP members are there', { ask: askRecipe });
  ok(r1.routed === true && /42 LAMP members/.test(r1.text), 'recipe routed → executed (result returned)');
  ok(/recipe lamp-count/.test(r1.chose), 'recipe choice labeled');
  ok(suit.client().calls.some(c => c.name === 'run_recipe' && c.args.name === 'lamp-count'), 'run_recipe called with the chosen recipe');

  // --- TOOL route: pick tool → describe_tool → args → execute ---
  suit = new EchoSuit({ client: mockClient() }); suit.connected = true;
  const askTool = async ({ task, input }) => {
    if (task === 'echo_pick') return { type: 'tool', name: 'search_knowledge', reason: 'kb search' };
    if (task === 'echo_args') return { query: input.need };
    return null;
  };
  const r2 = await suit.routeNeed('search the vault for X', { ask: askTool });
  ok(r2.routed === true && /found 3 vault results/.test(r2.text), 'tool routed → pick→schema→args→execute');
  ok(/tool search_knowledge/.test(r2.chose), 'tool choice labeled');
  const tcalls = suit.client().calls.map(c => c.name);
  ok(tcalls.includes('describe_tool') && tcalls.includes('search_knowledge'), 'fetched schema THEN executed the tool');
  const exec = suit.client().calls.find(c => c.name === 'search_knowledge');
  ok(exec && exec.args && /X/.test(exec.args.query), 'cloud-written args passed to the tool');

  // --- NONE: nothing fits → plain message, no execution ---
  suit = new EchoSuit({ client: mockClient() }); suit.connected = true;
  const r3 = await suit.routeNeed('the meaning of life', { ask: async () => ({ type: 'none', reason: 'no tool fits' }) });
  ok(r3.routed === true && r3.ok === false && /nothing fit/i.test(r3.text), 'none → no-fit message, no tool run');
  ok(!suit.client().calls.some(c => c.name === 'run_recipe' || c.name === 'search_knowledge'), 'none → nothing executed');

  // --- fail-safe: no cloud ask available → routed:false (caller falls back to catalog list) ---
  suit = new EchoSuit({ client: mockClient() }); suit.connected = true;
  const r4 = await suit.routeNeed('x', { ask: async () => null });   // ask returns null pick
  ok(r4.routed === true && r4.ok === false, 'cloud pick null → graceful no-fit (no crash)');

  // --- enable flag: meta echo.cloudRoute=off → disabled ---
  D.setMeta('echo.cloudRoute', 'off');
  ok(echoCloudRouteEnabled() === false, 'echo.cloudRoute=off → routing disabled (falls back to manual list)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
