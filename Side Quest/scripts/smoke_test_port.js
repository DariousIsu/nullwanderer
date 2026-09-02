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

// A fake pipeline with the REAL callback shape: emits tokens, STORES the say as a turns row (the
// real pipeline does — `says` reads the rows back), logs a detached "door" line after the turn
// resolves (the async-door pattern the settle window exists for), completes.
let smokeSid = null;
async function fakeRunChatTurn(text, _atts, io) {
  io.emit('routed: ');
  io.emit(text.toUpperCase());
  db.insertTurn({ sessionId: smokeSid, speaker: 'ai_said', content: `routed: ${text.toUpperCase()}` });
  console.log('[fake-door] landed after turn');
  io.onComplete({ said: true });
  return { ok: true, say: '' };
}

(async () => {
  smokeSid = db.startSession();
  TP.start({ runChatTurn: fakeRunChatTurn, port: PORT });
  await new Promise((r) => setTimeout(r, 300));

  const st = await get('/status');
  ok('status answers', st.code === 200 && st.body.ok && st.body.inFlight === false);

  // ── THE ONE PACING LAW's read door (unification stage 4): GET /quota?lane=… is the gate's verdict, read-only ──
  const q0 = await get('/quota?lane=research');
  ok('/quota answers with the lane echoed and fails open when no pool is configured', q0.code === 200 && q0.body.ok && q0.body.lane === 'research' && q0.body.allow === true && q0.body.known === false && /no quota configured/.test(q0.body.reason), JSON.stringify(q0.body));
  const nowMs = Date.now();
  db.setMeta('quota.limit_compute', '1000000'); db.setMeta('quota.mark_pct', '0.95'); db.setMeta('quota.mark_at', String(nowMs)); db.setMeta('quota.reset_at', String(nowMs + 48 * 3600e3));
  const qi = await get('/quota?lane=idle');
  ok('/quota applies the real law: idle is STOPPED at 95% used (the floor)', qi.code === 200 && qi.body.allow === false && qi.body.known === true && Math.abs(qi.body.usedPct - 0.95) < 1e-6 && /stops at 85% of the pool/.test(qi.body.reason), JSON.stringify(qi.body));
  const qc = await get('/quota?lane=interactive');
  ok('/quota: interactive is never throttled', qc.body.allow === true && /never throttled/.test(qc.body.reason));
  ok('/quota is READ-ONLY: no closure stamp was written by the peek', !db.getMeta('quota.closed_since.idle'));
  const qd = await get('/quota');
  ok('/quota defaults to the research lane', qd.body.lane === 'research');
  db.setMeta('quota.limit_compute', ''); db.setMeta('quota.mark_pct', ''); db.setMeta('quota.mark_at', ''); db.setMeta('quota.reset_at', '');

  const r1 = await post({ text: 'convert the doc', settleMs: 1200, maxMs: 15000 });
  ok('turn runs and reply is captured', r1.code === 200 && r1.body.ok && /CONVERT THE DOC/.test(r1.body.say));
  // `say` concatenates every stream (it can double-count); `says` = the stored rows, the truth.
  ok('says carries the STORED say rows — one clean row per say', Array.isArray(r1.body.says) && r1.body.says.length === 1
    && r1.body.says[0].content === 'routed: CONVERT THE DOC' && r1.body.says[0].unprompted === false && r1.body.says[0].ts >= 0);
  // the gap instruments: stamped log lines + the user-felt edges (TTFT, say-complete)
  ok('logLines carry the +ms stage stamp', r1.body.logLines.some((l) => /^\+\d+ms .*fake-door/.test(l)));
  ok('firstEmitMs and sayDoneMs ride the response', typeof r1.body.firstEmitMs === 'number' && typeof r1.body.sayDoneMs === 'number' && r1.body.firstEmitMs <= r1.body.sayDoneMs);
  ok('console lines during the window are captured', r1.body.logLines.some((l) => /fake-door/.test(l)));
  ok('turn settles when the console goes quiet', r1.body.settled === true);
  ok('completion info rides along', r1.body.complete && r1.body.complete.said === true);

  ok('empty text is refused', (await post({ text: '  ' })).code === 400);

  // ⭐ CSRF / drive-by guard (audit S3): a browser cross-origin POST and a no-cors simple-request
  // (text/plain) are both refused before any door runs; curl-shaped JSON (the `post` helper) passes.
  const postRaw = (headers, bodyStr) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/turn', method: 'POST', headers: { 'Content-Length': Buffer.byteLength(bodyStr), ...headers } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return {}; } })() })); });
    req.on('error', reject); req.write(bodyStr); req.end();
  });
  ok('a cross-origin POST (Origin header) is refused 403', (await postRaw({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }, '{"text":"x"}')).code === 403);
  ok('a no-cors simple request (text/plain) is refused 415', (await postRaw({ 'Content-Type': 'text/plain' }, '{"text":"x"}')).code === 415);
  ok('a Sec-Fetch-Site:cross-site POST is refused', (await postRaw({ 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, '{"text":"x"}')).code === 403);

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
