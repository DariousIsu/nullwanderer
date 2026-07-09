/*
 * Live renderer diagnosis over Chrome DevTools Protocol — attaches to the RUNNING app's webview and reads
 * ground truth (real canvas, real render loop), instead of guessing from the hidden-tab preview harness.
 *
 * Requires the app launched with remote debugging (main.js enables --remote-debugging-port=9222 in dev).
 *
 *   node scripts/kg_cdp_probe.js                 # list targets + run the default KG diagnostic
 *   node scripts/kg_cdp_probe.js --match kg      # pick target whose URL contains "kg"
 *   node scripts/kg_cdp_probe.js --eval "1+1"    # hot-evaluate any expression in the LIVE webview
 *
 * The default diagnostic answers the exact open questions: is the canvas sized? is anything painted? and —
 * crucially — is the render loop actually TICKING (does the far-field drift repaint pixels frame to frame)?
 */
'use strict';
const PORT = process.env.KG_DEBUG_PORT || 9222;
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const MATCH = argVal('--match', 'kg');
const EVAL = argVal('--eval', null);

// The default diagnostic: sized? painted? repainting (loop alive)? — sampled over ~380ms of real frames.
const DIAGNOSTIC = `(async () => {
  const c = document.querySelector('#graph canvas');
  if (!c) return { error: 'no #graph canvas', bodyHtml: document.body ? document.body.innerHTML.slice(0,200) : null };
  const ctx = c.getContext('2d');
  const snap = () => { const d = ctx.getImageData(0,0,c.width,c.height).data; let nb=0,h=0; for (let i=0;i<d.length;i+=4){ if(d[i]>18||d[i+1]>18||d[i+2]>18) nb++; h=(h*31 + d[i]+d[i+1]+d[i+2])>>>0; } return {nb,h}; };
  const a = c.width && c.height ? snap() : {nb:-1,h:0};
  let frames = 0;
  await new Promise(res => { const t0 = performance.now(); const step = () => { frames++; if (performance.now()-t0 < 380) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  const b = c.width && c.height ? snap() : {nb:-1,h:0};
  return {
    canvas: { w: c.width, h: c.height, clientW: c.clientWidth, clientH: c.clientHeight },
    graphElSize: (()=>{ const g=document.getElementById('graph'); return g?{w:g.clientWidth,h:g.clientHeight}:null; })(),
    nonBlackPx: a.nb,
    rafFramesIn380ms: frames,          // >0 means requestAnimationFrame is running (tab visible)
    canvasRepainting: a.h !== b.h,     // pixels changed frame-to-frame → force-graph loop is actively drawing
    overlayText: (document.getElementById('overlay')||{}).textContent || null,
  };
})()`;

async function main() {
  const res = await fetch(`http://localhost:${PORT}/json`).catch(e => { throw new Error(`cannot reach CDP on :${PORT} — is the app running with remote debugging? (${e.message})`); });
  const targets = await res.json();
  console.log('TARGETS:');
  for (const t of targets) console.log(`  [${t.type}] ${(t.url || '').slice(0, 90)}`);
  const tgt = targets.find(t => (t.url || '').toLowerCase().includes(MATCH.toLowerCase()) && t.webSocketDebuggerUrl);
  if (!tgt) { console.error(`\nno debuggable target with url containing "${MATCH}"`); process.exit(2); }
  console.log(`\nATTACHING → ${tgt.url}\n`);

  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('CDP websocket error (origin blocked? set --remote-allow-origins=*)'))); });

  await send('Runtime.enable');
  const expr = EVAL || DIAGNOSTIC;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(r.exceptionDetails, null, 2));
  else console.log((EVAL ? 'RESULT: ' : 'DIAGNOSTIC:\n') + JSON.stringify(r.result && r.result.value, null, 2));
  ws.close();
}
main().then(() => process.exit(0)).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
