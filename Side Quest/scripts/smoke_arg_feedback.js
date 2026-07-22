/* smoke_arg_feedback.js — an arg failure teaches the arg SHAPE, not just "try again".
 *
 * Live 2026-07-22, the Bloomberg Government brief. Four consecutive hops died on db_query:
 *
 *   hop 1  args were the literal "…"        → "Re-emit with valid JSON args."
 *   hop 2  same                              → same
 *   hop 3  same                              → same
 *   hop 4  {"name": "Bloomberg ..."}         → pydantic: sql Missing required argument
 *
 * The feedback said WHAT was wrong but never WHAT RIGHT LOOKS LIKE, so every retry was another
 * guess and the whole hop budget burned before the pydantic error finally named `sql` — on the
 * wind-down hop. The signature was in listTools() at attach time all along.
 *
 * THE CONTRACT: the suit indexes tool schemas at connect; an arg failure — invalid JSON OR an
 * Echo-side argument rejection — carries the tool's compact signature so the next hop can
 * correct in ONE step. A non-argument error (a real runtime failure) is NOT decorated: appending
 * a signature to "connection refused" would misdiagnose it as her mistake.
 */
'use strict';
const es = require('../lib/echo_suit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// A fake Echo client with the two live tools, schemas as MCP tools/list returns them.
function fakeClient({ callResult } = {}) {
  return {
    async initialize() { return { serverInfo: { name: 'fake-echo' } }; },
    async listTools() {
      return [
        { name: 'db_query', inputSchema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array' }, timeout_seconds: { type: 'integer' } }, required: ['sql'] } },
        { name: 'saga_canvas_add_block', inputSchema: { type: 'object', properties: { tab_key: { type: 'string' }, block_type: { type: 'string' }, data: { type: 'object', properties: { markdown: {}, level: {}, text: {} } } }, required: ['tab_key', 'block_type', 'data'] } },
      ];
    },
    async callTool(name, args) {
      if (name === 'get_usage_guide' || name === 'get_atlas' || name === 'list_recipes') return { content: [{ type: 'text', text: '' }] };
      return callResult || { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

async function main() {
  // ── the schema index and the compact signature ────────────────────────────────────────────────
  {
    const suit = new es.EchoSuit({ client: fakeClient() });
    await suit.connect();
    const shape = suit.argShape('db_query');
    ok(/db_query args: \{/.test(shape || ''), 'the suit can state a tool\'s signature from the attach-time index');
    ok(/"sql": string \(REQUIRED\)/.test(shape || ''), 'required params are marked — the thing four hops never learned');
    ok(/"params": array/.test(shape || '') && /"timeout_seconds": integer/.test(shape || ''), 'optional params carry their types');
    const blk = suit.argShape('saga_canvas_add_block');
    ok(/"data": object\{markdown,level,text\}/.test(blk || ''), 'an object param opens one level — that is where a block\'s shape lives');
    ok(suit.argShape('no_such_tool') === null, 'an unknown tool yields null, never a throw');
  }

  // ── ⭐ THE LIVE FAILURE, replayed: invalid-JSON args now teach the shape ──────────────────────
  {
    const suit = new es.EchoSuit({ client: fakeClient() });
    await suit.connect();
    // hop 1's tag: args were the literal ellipsis — parseError set at parse time
    const r = await suit.dispatch({ kind: 'do', name: 'db_query', parseError: 'Unexpected token …', args: null });
    ok(r.isError, 'invalid JSON still errors');
    ok(/weren't valid JSON/.test(r.text), 'and still says what was wrong');
    ok(/db_query args: \{ "sql": string \(REQUIRED\)/.test(r.text), '⭐ but now ALSO says what right looks like — the one-hop correction');
  }

  // ── ⭐ hop 4's failure: valid JSON, wrong keys — Echo's rejection gets the signature too ──────
  {
    const pydantic = { content: [{ type: 'text', text: '2 validation errors for call[db_query] sql Missing required argument [type=missing_argument, input_value={\'name\': \'Bloomberg\'}]' }], isError: true };
    const suit = new es.EchoSuit({ client: fakeClient({ callResult: pydantic }) });
    await suit.connect();
    const r = await suit.dispatch({ kind: 'do', name: 'db_query', args: { name: 'Bloomberg' } });
    ok(r.isError, 'the Echo-side rejection is still an error');
    ok(/Missing required argument/.test(r.text), 'the original rejection text survives');
    ok(/db_query args: \{ "sql": string \(REQUIRED\)/.test(r.text), '⭐ with the signature appended');
  }

  // ── SAFETY: a runtime failure is NOT dressed up as an arg mistake ─────────────────────────────
  {
    const runtime = { content: [{ type: 'text', text: 'database is locked' }], isError: true };
    const suit = new es.EchoSuit({ client: fakeClient({ callResult: runtime }) });
    await suit.connect();
    const r = await suit.dispatch({ kind: 'do', name: 'db_query', args: { sql: 'SELECT 1' } });
    ok(r.isError && !/db_query args:/.test(r.text),
      'SAFETY: "database is locked" gets no signature — appending one would misdiagnose a runtime failure as her mistake');
  }

  // ── a client that never connected (or an unknown tool) degrades to the old message ────────────
  {
    const suit = new es.EchoSuit({ client: fakeClient() });
    await suit.connect();
    const r = await suit.dispatch({ kind: 'do', name: 'no_such_tool', parseError: 'bad', args: null });
    ok(r.isError && /weren't valid JSON/.test(r.text) && !/no_such_tool args:/.test(r.text),
      'no schema on file → the plain message, unchanged');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
