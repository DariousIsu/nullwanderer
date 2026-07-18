/* Minimal node-inspector eval: run a JS expression in the LIVE main process (--inspect=9229).
 * Usage: node scripts/cdp_eval.js "global.__autonomicSeedBeat('FL')"
 * Reuses the app's bundled `ws`. Awaits promises, returns the value by JSON.
 */
'use strict';
const WebSocket = require('../node_modules/ws');
const expr = process.argv[2] || '1+1';
const PORT = process.env.INSPECT_PORT || '9229';

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find(t => t.webSocketDebuggerUrl) || list[0];
  if (!target) { console.error('no inspector target'); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  ws.on('open', async () => {
    await send('Runtime.enable');
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (r.result && r.result.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails));
    console.log('RESULT:', JSON.stringify((r.result && r.result.result && r.result.result.value) ?? r.result, null, 1));
    ws.close(); process.exit(0);
  });
  ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(3); });
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
