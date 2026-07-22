/*
 * Screenshot the RUNNING app's KG webview over CDP — the visual half of kg_cdp_probe.js.
 *
 * The 3D surface lives in a <webview>, which the Browser pane cannot reach and which only becomes a
 * debuggable target while the KG surface is the active one. Buffer attributes prove the encoding is
 * correct; they do not prove it LOOKS like anything. This closes that gap.
 *
 *   node scripts/kg_cdp_shot.js out.png              # capture the KG webview
 *   node scripts/kg_cdp_shot.js out.png --match kg3d # pick a different target
 */
'use strict';
const fs = require('fs');
const PORT = process.env.KG_DEBUG_PORT || 9222;
const args = process.argv.slice(2);
const OUT = args.find(a => !a.startsWith('--')) || 'kg_shot.png';
const mi = args.indexOf('--match');
const MATCH = mi >= 0 && args[mi + 1] ? args[mi + 1] : 'kg3d';

async function main() {
  const res = await fetch(`http://localhost:${PORT}/json`).catch(e => { throw new Error(`cannot reach CDP on :${PORT} (${e.message})`); });
  const tgt = (await res.json()).find(t => (t.url || '').toLowerCase().includes(MATCH.toLowerCase()) && t.webSocketDebuggerUrl);
  if (!tgt) { console.error(`no debuggable target matching "${MATCH}" — is the KG surface open?`); process.exit(2); }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('CDP websocket error'))); });
  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB) from ${tgt.url}`);
  ws.close();
}
main().then(() => process.exit(0)).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
