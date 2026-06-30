/* Smoke: lib/echo_tier (capability tiering + curated read menu) and the echo_suit tier GATE.
 * Guarantees: the autonomous loop may READ from Echo but cannot write to it, spawn agents, or touch a
 * locked tool — while interactive turns keep full access (locked excepted). Pure + a mock Echo client,
 * no live Echo. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_echo_tier.js
 */
'use strict';
const tier = require('../lib/echo_tier');
const suitLib = require('../lib/echo_suit');
const operator = require('../lib/operator');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- classifyTool: the four tiers ---
ok(tier.classifyTool('search_entities') === 'read', 'search_entities → read');
ok(tier.classifyTool('propublica_nonprofit_search') === 'read', 'propublica_nonprofit_search → read');
ok(tier.classifyTool('usaspending_search') === 'read', 'usaspending_search → read');
ok(tier.classifyTool('kg_neighborhood') === 'read', 'kg_neighborhood → read');
ok(tier.classifyTool('get_document') === 'read', 'get_document → read');
ok(tier.classifyTool('db_query') === 'write', 'db_query → write (unknown-shaped ⇒ safe default, not auto-readable)');
ok(tier.classifyTool('propose_entity') === 'write', 'propose_entity → write');
ok(tier.classifyTool('ingest_file') === 'write', 'ingest_file → write');
ok(tier.classifyTool('save_document') === 'write', 'save_document → write');
ok(tier.classifyTool('update_contact') === 'write', 'update_contact → write');
ok(tier.classifyTool('hub_create') === 'write', 'hub_create → write');
ok(tier.classifyTool('os_click') === 'write', 'os_click (desktop control) → write');
ok(tier.classifyTool('spawn_agent_async') === 'heavy', 'spawn_agent_async → heavy');
ok(tier.classifyTool('team_spawn') === 'heavy', 'team_spawn → heavy');
ok(tier.classifyTool('delegate_to_fact_checker') === 'heavy', 'delegate_to_* → heavy');
ok(tier.classifyTool('send_email') === 'locked', 'send_email → locked');
ok(tier.classifyTool('generate_image') === 'locked', 'generate_image → locked');
ok(tier.classifyTool('totally_new_tool_2027') === 'write', 'UNKNOWN tool → write (safe default: blocked on auto)');
ok(tier.classifyTool('') === 'locked', 'empty name → locked (fail-safe)');

// --- allowedOnAuto: read-only allowlist ---
ok(tier.allowedOnAuto('search_bills') === true, 'allowedOnAuto: read tool true');
ok(tier.allowedOnAuto('ingest_file') === false, 'allowedOnAuto: write tool false');
ok(tier.allowedOnAuto('spawn_agent_async') === false, 'allowedOnAuto: heavy tool false');

// --- policyFor: auto vs interactive ---
ok(tier.policyFor('search_entities', { autonomous: true }).allow === true, 'auto + read → allow');
ok(tier.policyFor('propose_entity', { autonomous: true }).allow === false, 'auto + write → block');
ok(tier.policyFor('spawn_agent_async', { autonomous: true }).allow === false, 'auto + heavy → block');
ok(tier.policyFor('propose_entity', { autonomous: false }).allow === true, 'interactive + write → allow (Echo gates proposals itself)');
ok(tier.policyFor('spawn_agent_async', { autonomous: false }).allow === true, 'interactive + heavy → allow (Lucas present)');
ok(tier.policyFor('send_email', { autonomous: false }).allow === false, 'interactive + locked → STILL block');

// --- the curated read menu surfaces in the operator's TOOL_SPEC ---
const spec = operator.TOOL_SPEC;
ok(/nonprofit_lookup/.test(spec), 'operator menu includes nonprofit_lookup');
ok(/kg_search/.test(spec) && /gov_funding/.test(spec) && /bill_lookup/.test(spec), 'operator menu includes kg_search/gov_funding/bill_lookup');
ok(/ECHO DATA TOOLS/.test(spec), 'operator menu has the ECHO DATA TOOLS section header');
ok(tier.READ_TOOLS.every(t => tier.classifyTool(t.tool) === 'read'), 'every curated tool classifies as read (none can be blocked on auto)');
ok(typeof tier.readToolByOp('fec_lookup') === 'object' && tier.readToolByOp('fec_lookup').tool === 'fec_committee_search', 'readToolByOp resolves op → real tool');

// --- the GATE in echo_suit.dispatch, with a mock connected suit ---
const calls = [];
const mkResult = (txt) => ({ content: [{ text: txt }] });
const mockClient = {
  initialize: async () => ({ serverInfo: { name: 'mock' } }),
  listTools: async () => [{ name: 'x' }],
  callTool: async (name, args) => {
    calls.push(name);
    if (name === 'get_tool_map') return mkResult(JSON.stringify({ by_intent: { ingest: [{ name: 'ingest_file', description: 'ingest a file' }], search: [{ name: 'search_entities', description: 'search the graph' }] } }));
    if (name === 'list_recipes') return mkResult(JSON.stringify({ recipes: [] }));
    if (name === 'describe_tool') return mkResult(JSON.stringify({ schema: {} }));
    return mkResult(`ran ${name}`);
  }
};
async function run() {
  const suit = suitLib.createSuit({ client: mockClient });
  suit.connected = true; suit._suit = { guide: '', atlas: '', recipes: '' };

  // AUTONOMOUS: read allowed, write/propose/delegate blocked
  calls.length = 0;
  let r = await suit.dispatch({ kind: 'do', name: 'search_entities', args: { query: 'x' } }, { autonomous: true });
  ok(r.ok && calls.includes('search_entities'), 'auto dispatch: READ tool runs (reaches Echo)');
  calls.length = 0;
  r = await suit.dispatch({ kind: 'do', name: 'ingest_file', args: {} }, { autonomous: true });
  ok(r.blocked && r.isError && !calls.includes('ingest_file'), 'auto dispatch: WRITE tool BLOCKED (never reaches Echo)');
  r = await suit.dispatch({ kind: 'propose', proposeKind: 'entity', payload: {} }, { autonomous: true });
  ok(r.blocked === true, 'auto dispatch: propose BLOCKED');
  r = await suit.dispatch({ kind: 'delegate', task: 'do a big thing' }, { autonomous: true });
  ok(r.blocked === true, 'auto dispatch: delegate (heavy) BLOCKED');
  calls.length = 0;
  r = await suit.dispatch({ kind: 'recipe', name: 'search-vault', arg: 'x' }, { autonomous: true });
  ok(calls.includes('run_recipe') && !r.blocked, 'auto dispatch: recipe ALLOWED (curated read/compile)');

  // INTERACTIVE: write allowed, locked still blocked
  calls.length = 0;
  r = await suit.dispatch({ kind: 'do', name: 'ingest_file', args: {} }, {});
  ok(calls.includes('ingest_file') && !r.blocked, 'interactive dispatch: WRITE tool ALLOWED (Lucas present)');
  calls.length = 0;
  r = await suit.dispatch({ kind: 'do', name: 'send_email', args: {} }, {});
  ok(r.blocked === true && !calls.includes('send_email'), 'interactive dispatch: LOCKED tool STILL blocked');

  // routeNeed gate: a cloud pick of a WRITE tool is blocked on auto, allowed interactively
  const askPick = async ({ task }) => {
    if (task === 'echo_pick') return { type: 'tool', name: 'ingest_file', reason: 'mock' };
    if (task === 'echo_args') return { path: 'x' };
    return {};
  };
  calls.length = 0;
  r = await suit.routeNeed('ingest this file', { ask: askPick, autonomous: true });
  ok(r.blocked === true && !calls.includes('ingest_file'), 'auto routeNeed: cloud-picked WRITE tool BLOCKED before execution');
  calls.length = 0;
  r = await suit.routeNeed('ingest this file', { ask: askPick, autonomous: false });
  ok(calls.includes('ingest_file'), 'interactive routeNeed: WRITE tool runs (Lucas present)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
