/*
 * lib/test_port.js — THE INSIDE ACCESS PORT (2026-08-08, Lucas: "these are all becoming like
 * pulling really annoying weeds… can you create an access port for your model and run full
 * pathway tests that way?").
 *
 * Why: every pathway defect so far (payload ruin, block stacking, anaphora gap) was found ONE
 * live message at a time — Lucas sends, the log is read after the fact, one weed gets pulled,
 * the next is invisible until the next live message. The smokes prove pure parts; nothing could
 * drive the RUNNING program end to end. This port closes that gap: POST a message and it runs
 * through the exact real pipeline — runChatTurn is the single shared entry the renderer's own
 * IPC wrapper calls — while the port captures the complete observable outcome: her reply, every
 * console line during the turn AND the detached door work that follows it (canvas doors fire
 * after the turn resolves), and the canvas blocks that changed. A test turn IS a real turn on
 * purpose (real turns table, real canvas, real quota) — a parallel "test mode" pipeline would
 * reintroduce the two-truths disease; what is tested is what runs.
 *
 * Safety shape:
 *   - Binds 127.0.0.1 ONLY. No auth token because nothing but this machine can reach it.
 *   - One injected turn at a time, and REFUSED while Lucas is live: a real user turn within
 *     ACTIVE_WINDOW_MS means his session owns the shared turn state (_chatTurnGen, paused loops)
 *     — interleaving a test turn under him is exactly the cross-turn bleed the gen counter exists
 *     to prevent.
 *   - Console capture is process-global while a test turn is in flight (concurrency is refused,
 *     so everything captured belongs to the window) and always passes through to the real log.
 *
 * POST /turn {"text": "...", "settleMs"?: 8000, "maxMs"?: 240000}
 *   → { ok, say, complete, error, logLines, canvasWrites, tookMs, settled }
 *     Resolution: the turn resolves AND the console stays quiet for settleMs (detached doors
 *     announce themselves in the log; silence = the pathway finished), or maxMs hard-caps a
 *     stuck pathway (settled:false says so honestly).
 * GET /status → { ok, inFlight, lastUserTurnAgoMs, port }
 */
'use strict';

const http = require('http');

const ACTIVE_WINDOW_MS = 120000;   // a real user turn this recent → his session owns the pipeline
const DEFAULT_SETTLE_MS = 8000;
const DEFAULT_MAX_MS = 240000;     // canvas edit runs are minutes — a pathway test must outlast one

let _server = null;
let _inFlight = false;

function _lastUserTurnAgoMs() {
  try {
    const db = require('./db');
    const row = db.getDb().prepare(`SELECT MAX(ts) t FROM turns WHERE speaker = 'user'`).get();
    return row && row.t ? Date.now() - row.t : null;
  } catch { return null; }
}

// Canvas blocks touched since `sinceTs` — the doors' observable landings, read from the mirror.
function _canvasWritesSince(sinceTs) {
  try {
    const store = require('./canvas_docs');
    return store._db().prepare(
      `SELECT tab_key, block_id, block_type, position, length(data) bytes, updated_at FROM blocks WHERE updated_at >= ? ORDER BY updated_at`
    ).all(sinceTs);
  } catch { return []; }
}

async function _runInjectedTurn(runChatTurn, { text, settleMs, maxMs }) {
  const started = Date.now();
  const logLines = [];
  let lastLineTs = Date.now();
  const origLog = console.log, origErr = console.error;
  const tap = (orig, tag) => (...args) => {
    try {
      logLines.push(`${tag}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.slice(0, 500));
      lastLineTs = Date.now();
    } catch {}
    return orig(...args);
  };
  console.log = tap(origLog, '');
  console.error = tap(origErr, 'ERR ');

  let say = '', complete = null, error = null, turnDone = false;
  try {
    const r = await runChatTurn(String(text), [], {
      emit: (t) => { say += t; },
      onComplete: (info) => { complete = info || {}; },
      onError: (e) => { error = typeof e === 'string' ? e : (e && e.message) || String(e); },
      busy: () => {},
    });
    turnDone = true;
    if (r && typeof r.say === 'string' && !say) say = r.say;
  } catch (e) { error = e.message; }

  // The doors run detached AFTER the turn resolves — hold until the console goes quiet (or cap).
  // v1.1 (08-08): a ROUTED door queues behind cloud-slot contention and can start MINUTES after
  // the reply — twice the port settled on quiet console while the edit still ran. When the router
  // dispatched a door, quiet is not enough: hold until that door's OUTCOME line appears (or cap,
  // reported honestly via settled:false).
  // A door owns the tail of the turn if EITHER the artifact router dispatched one OR the LEGACY
  // canvas-cmd net began an in-place edit/order (2026-08-09: "add contacts into the doc" routed to
  // status and the legacy net applied the edit — the port settled on quiet console mid-edit because
  // it only watched for artifact-router doors, capturing "applying in place" but not the outcome).
  const routedDoor = () => logLines.some((l) => /\[artifact-router\] intent=(?!none)|\[canvas-cmd\] (?:edit order on the working doc|classifier read the intent)/.test(l));
  const doorOutcome = () => logLines.some((l) => /\[canvas-cmd\] (?:edit applied|edit NOT applied|edit output REJECTED|order executed)|\[pull-up\] |\[report-cmd\] |canvas (?:edit|create|report|pull-up)? ?failed/.test(l));
  let settled = false;
  while (Date.now() - started < maxMs) {
    if (turnDone && Date.now() - lastLineTs >= settleMs && (!routedDoor() || doorOutcome())) { settled = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log = origLog;
  console.error = origErr;
  return {
    ok: !error, say: say.slice(0, 20000), complete, error,
    logLines, canvasWrites: _canvasWritesSince(started),
    tookMs: Date.now() - started, settled,
  };
}

function start({ runChatTurn, port = parseInt(process.env.ZOE_TEST_PORT, 10) || 8767 } = {}) {
  if (_server) return _server;
  if (typeof runChatTurn !== 'function') throw new Error('test_port needs runChatTurn');
  _server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && req.url === '/status') {
        return send(200, { ok: true, inFlight: _inFlight, lastUserTurnAgoMs: _lastUserTurnAgoMs(), port });
      }
      if (req.method === 'POST' && req.url === '/turn') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
          try {
            const { text, settleMs, maxMs } = JSON.parse(body || '{}');
            if (!text || !String(text).trim()) return send(400, { ok: false, error: 'text required' });
            if (_inFlight) return send(409, { ok: false, error: 'a test turn is already in flight' });
            const ago = _lastUserTurnAgoMs();
            if (ago != null && ago < ACTIVE_WINDOW_MS) {
              return send(409, { ok: false, error: `Lucas is live (user turn ${Math.round(ago / 1000)}s ago) — his session owns the pipeline; retry when idle` });
            }
            _inFlight = true;
            try {
              const out = await _runInjectedTurn(runChatTurn, {
                text, settleMs: Math.max(1000, settleMs || DEFAULT_SETTLE_MS), maxMs: Math.max(10000, maxMs || DEFAULT_MAX_MS),
              });
              send(200, out);
            } finally { _inFlight = false; }
          } catch (e) { _inFlight = false; send(500, { ok: false, error: e.message }); }
        });
        return;
      }
      send(404, { ok: false, error: 'POST /turn or GET /status' });
    } catch (e) { send(500, { ok: false, error: e.message }); }
  });
  _server.listen(port, '127.0.0.1', () => console.log(`[test-port] inside access port on 127.0.0.1:${port} (POST /turn drives the REAL pipeline)`));
  _server.on('error', (e) => console.error('[test-port] server error:', e.message));
  return _server;
}

function stop() { try { if (_server) _server.close(); } catch {} _server = null; }

module.exports = { start, stop, _runInjectedTurn, ACTIVE_WINDOW_MS, DEFAULT_SETTLE_MS, DEFAULT_MAX_MS };
