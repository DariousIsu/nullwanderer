/**
 * Hard smoke — Echo MCP client (Zoe's side of the keyhole). Offline: a MOCK transport stands
 * in for Echo, so the protocol logic (initialize handshake, tools/list, tools/call, errors)
 * and the Streamable-HTTP framing (bearer auth, session header, JSON + SSE bodies) are
 * verified without a running Echo and without touching her live process.
 */
const echo = require('../lib/echo');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// A scripted MCP server: records what the client sends, returns canned JSON-RPC results.
function mockTransport() {
  const sent = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: echo.PROTOCOL_VERSION, serverInfo: { name: 'nx-echo', version: '1.0.0' }, capabilities: { tools: {} } } };
      if (msg.method === 'notifications/initialized') return null;   // notification: no response
      if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search_knowledge' }, { name: 'spawn_agent' }, { name: 'kg_query_local' }] } };
      if (msg.method === 'tools/call') {
        if (msg.params.name === 'boom') return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'tool failed' } };
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ran ${msg.params.name}(${JSON.stringify(msg.params.arguments)})` }] } };
      }
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
    }
  };
}

(async () => {
  console.log('Hard smoke — Echo MCP client\n');

  console.log('protocol core (handshake → list → call):');
  const t = mockTransport();
  const client = new echo.EchoClient({ transport: t });
  const init = await client.initialize();
  ok('initialize returns serverInfo', init && init.serverInfo && init.serverInfo.name === 'nx-echo');
  ok('sent an initialize request (jsonrpc 2.0, has id)', t.sent[0].method === 'initialize' && t.sent[0].jsonrpc === '2.0' && typeof t.sent[0].id === 'number');
  ok('sent the initialized notification (no id)', t.sent[1].method === 'notifications/initialized' && !('id' in t.sent[1]));
  ok('negotiated the protocol version', t.sent[0].params.protocolVersion === echo.PROTOCOL_VERSION);

  const tools = await client.listTools();
  ok('listTools returns the suit surface', tools.length === 3 && tools.some(x => x.name === 'spawn_agent'));
  const again = await client.listTools();
  ok('tools are cached (no second tools/list request)', again === tools && t.sent.filter(m => m.method === 'tools/list').length === 1);

  const r = await client.callTool('search_knowledge', { q: 'AI bills' });
  ok('callTool returns content', r && r.content && /ran search_knowledge/.test(r.content[0].text));
  ok('callTool passed arguments through', /AI bills/.test(r.content[0].text));

  let threw = false;
  try { await client.callTool('boom'); } catch (e) { threw = /tool failed/.test(e.message); }
  ok('a JSON-RPC error becomes a thrown Error', threw);

  console.log('\nStreamable-HTTP transport framing (injected fetch):');
  // Capture the request the transport builds, and feed back an SSE-framed result.
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    const body = 'event: message\n' + 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n\n';
    return {
      ok: true, status: 200,
      headers: { get: (k) => ({ 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-123' })[String(k).toLowerCase()] || null },
      text: async () => body
    };
  };
  const http = echo.httpTransport({ url: 'http://127.0.0.1:9000/mcp/', token: 'secret-tok', fetchImpl: fakeFetch });
  const out = await http.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
  ok('parses an SSE-framed JSON-RPC result', out && out.result && out.result.ok === true);
  ok('sends bearer auth header', captured.opts.headers['Authorization'] === 'Bearer secret-tok');
  ok('sends MCP Accept header (json + sse)', /application\/json/.test(captured.opts.headers['Accept']) && /text\/event-stream/.test(captured.opts.headers['Accept']));
  ok('captures + echoes the session id', http.sessionId === 'sess-123');

  console.log('\nparseStreamableBody handles both shapes:');
  ok('bare JSON body', echo.parseStreamableBody('application/json', '{"jsonrpc":"2.0","id":2,"result":{"x":1}}').result.x === 1);
  ok('SSE body (last data line)', echo.parseStreamableBody('text/event-stream', 'data: {"result":{"x":1}}\ndata: {"result":{"x":2}}\n').result.x === 2);

  // REGRESSION (2026-07-20): U+2028/U+2029 are line terminators to a JS regex `.` but NOT to
  // String.split(/\r?\n/), so `^data:\s?(.*)$` silently failed to match any line containing one —
  // parse → null → "echo: empty response to tools/call" on an HTTP 200. One RSS item carrying a raw
  // PARAGRAPH SEPARATOR killed a whole fetch_feeds_batch (the Monitors "⚠ fetch failed" panel).
  for (const [label, ch] of [['U+2028 (line separator)', '\u2028'], ['U+2029 (paragraph separator)', '\u2029']]) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { text: `before${ch}after` } });
    const parsed = echo.parseStreamableBody('text/event-stream', `event: message\ndata: ${payload}\n\n`);
    ok(`SSE body survives a raw ${label}`, !!parsed && parsed.result && parsed.result.text === `before${ch}after`);
  }
  {
    // …and it must still work when the terminator sits inside a large single-line payload (the live shape).
    const big = 'x'.repeat(50000) + '\u2029' + 'y'.repeat(50000);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 4, result: { text: big } });
    const parsed = echo.parseStreamableBody('text/event-stream', `event: message\ndata: ${payload}\n\n`);
    ok('SSE body survives U+2029 inside a 100KB single line', !!parsed && parsed.result && parsed.result.text === big);
  }

  console.log('\nstdio transport (Zoe spawns Echo) — fake child process, no real Echo:');
  const { EventEmitter } = require('events');
  function makeFakeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.writes = [];
    proc.stdin = { write: (s) => { proc.writes.push(s); if (proc._onWrite) proc._onWrite(s); } };
    proc.kill = () => { proc.emit('exit', 0); };
    return proc;
  }
  // scripted child: auto-answers each written request line (like Echo would)
  let scripted;
  const spawnFn = () => {
    scripted = makeFakeProc();
    scripted._onWrite = (s) => {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id == null) continue;   // notification — no response
        let result, error;
        if (m.method === 'initialize') result = { serverInfo: { name: 'nx-echo' } };
        else if (m.method === 'tools/list') result = { tools: [{ name: 'search_knowledge' }, { name: 'spawn_agent' }] };
        else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'stdio ok' }] };
        else error = { code: -32601, message: 'nope' };
        const resp = JSON.stringify(error ? { jsonrpc: '2.0', id: m.id, error } : { jsonrpc: '2.0', id: m.id, result }) + '\n';
        setImmediate(() => scripted.stdout.emit('data', Buffer.from(resp)));
      }
    };
    return scripted;
  };
  const sc = new echo.EchoClient({ transport: echo.stdioTransport({ spawnFn }) });
  const sinit = await sc.initialize();
  ok('stdio: initialize handshake over the child', sinit.serverInfo.name === 'nx-echo');
  ok('stdio: writes newline-delimited JSON to stdin', scripted.writes[0].endsWith('\n') && JSON.parse(scripted.writes[0].trim()).method === 'initialize');
  ok('stdio: tools/list over the child', (await sc.listTools()).some(x => x.name === 'spawn_agent'));
  ok('stdio: tools/call over the child', /stdio ok/.test((await sc.callTool('search_knowledge', { q: 'x' })).content[0].text));

  console.log('\nstdio framing (buffering, id correlation, notifications, timeout):');
  const proc2 = makeFakeProc();
  const tr = echo.stdioTransport({ spawnFn: () => proc2, requestTimeoutMs: 200 });
  const n = await tr.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('notification (no id) returns null immediately', n === null);
  const p1 = tr.send({ jsonrpc: '2.0', id: 1, method: 'a' });
  const p2 = tr.send({ jsonrpc: '2.0', id: 2, method: 'b' });
  proc2.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"v":2}}\n{"jsonrpc":"2.0","id":1,"resu'));   // out-of-order + split line
  proc2.stdout.emit('data', Buffer.from('lt":{"v":1}}\n'));
  const [r1, r2] = await Promise.all([p1, p2]);
  ok('id correlation + line split across chunks', r1.result.v === 1 && r2.result.v === 2);
  let timedOut = false;
  try { await tr.send({ jsonrpc: '2.0', id: 99, method: 'hang' }); } catch (e) { timedOut = /timeout/.test(e.message); }
  ok('unanswered request times out (does not hang)', timedOut);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
