'use strict';
/* smoke_test_port.js — the INSIDE ACCESS PORT (lib/test_port.js). Hermetic temp sq.db + a fake
 * runChatTurn: what must hold offline is the contract — the port drives the callback shape the
 * real runChatTurn takes, captures say + console lines + settle, and REFUSES to run under a live
 * user session. Run: node scripts/smoke_test_port.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testport-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
process.env.CANVAS_DOCS_DB_PATH = ':memory:';
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const TP = require(path.join(__dirname, '..', 'lib', 'test_port'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

const PORT = 18767;
const post = (bodyObj) => new Promise((resolve, reject) => {
  const body = JSON.stringify(bodyObj);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/turn', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(d) })); });
  req.on('error', reject); req.write(body); req.end();
});
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(d) })); }).on('error', reject);
});

// A fake pipeline with the REAL callback shape: emits tokens, logs a detached "door" line after
// the turn resolves (the async-door pattern the settle window exists for), completes.
async function fakeRunChatTurn(text, _atts, io) {
  io.emit('routed: ');
  io.emit(text.toUpperCase());
  console.log('[fake-door] landed after turn');
  io.onComplete({ said: true });
  return { ok: true, say: '' };
}

(async () => {
  TP.start({ runChatTurn: fakeRunChatTurn, port: PORT });
  await new Promise((r) => setTimeout(r, 300));

  const st = await get('/status');
  ok('status answers', st.code === 200 && st.body.ok && st.body.inFlight === false);

  const r1 = await post({ text: 'convert the doc', settleMs: 1200, maxMs: 15000 });
  ok('turn runs and reply is captured', r1.code === 200 && r1.body.ok && /CONVERT THE DOC/.test(r1.body.say));
  ok('console lines during the window are captured', r1.body.logLines.some((l) => /fake-door/.test(l)));
  ok('turn settles when the console goes quiet', r1.body.settled === true);
  ok('completion info rides along', r1.body.complete && r1.body.complete.said === true);

  ok('empty text is refused', (await post({ text: '  ' })).code === 400);

  // The Lucas-live guard: a fresh REAL user turn → the pipeline is his; the port refuses.
  const sid = db.startSession();
  db.insertTurn({ sessionId: sid, speaker: 'user', content: 'a real live message' });
  const r2 = await post({ text: 'test while live' });
  ok('refuses while a user session is live', r2.code === 409 && /Lucas is live/.test(r2.body.error));

  TP.stop();
  console.log(`smoke_test_port: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e.message); process.exit(1); });
