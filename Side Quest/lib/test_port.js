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
 *   → { ok, say, says, complete, error, logLines, canvasWrites, tookMs, settled }
 *     Resolution: the turn resolves AND the console stays quiet for settleMs (detached doors
 *     announce themselves in the log; silence = the pathway finished), or maxMs hard-caps a
 *     stuck pathway (settled:false says so honestly).
 *     `say` is the RAW emit capture — the main stream AND every followup stream concatenated with
 *     no boundary, so two clean says can read as one self-repeating one (the P2/P3 "duplicated
 *     count sentence" was THIS, not her voice). `says` is the stored ai_said rows for the turn's
 *     window — the DB row is the truth; checkers assert on `says`.
 * GET /status → { ok, inFlight, lastUserTurnAgoMs, port }
 */
'use strict';

const http = require('http');

const ACTIVE_WINDOW_MS = 120000;   // a real user turn this recent → his session owns the pipeline
const DEFAULT_SETTLE_MS = 8000;
const DEFAULT_MAX_MS = 240000;     // canvas edit runs are minutes — a pathway test must outlast one
// RUN-4 COLLISION (2026-08-20, turns 12874-12884): the guard counted the port's OWN injected turns
// as "the user", so it could not tell Lucas from the harness — and an UNANSWERED real turn older
// than ACTIVE_WINDOW_MS did not block at all. Lucas's live clarification (12878) sat unanswered at
// 126s while the next test turn fired 3s before her reply landed; his conversation and the suite
// cross-threaded in one session. Cure: the port remembers the ts-windows of turns IT injected;
// a REAL (non-injected) user turn owns the pipeline for REAL_USER_WINDOW_MS, and an UNANSWERED
// real turn blocks up to UNANSWERED_BLOCK_CAP_MS regardless of age.
const REAL_USER_WINDOW_MS = 10 * 60 * 1000;
const UNANSWERED_BLOCK_CAP_MS = 30 * 60 * 1000;

let _server = null;
let _inFlight = false;
const _injectedWindows = [];   // ts ranges of port-injected user turns (ring 60; in-memory — post-reboot the guard errs toward blocking, never toward colliding)
function _noteInjectionWindow(a, b) { _injectedWindows.push({ a: a - 1000, b: b + 1000 }); if (_injectedWindows.length > 60) _injectedWindows.shift(); }

function _lastUserTurnAgoMs() {
  try {
    const db = require('./db');
    const row = db.getDb().prepare(`SELECT MAX(ts) t FROM turns WHERE speaker = 'user'`).get();
    return row && row.t ? Date.now() - row.t : null;
  } catch { return null; }
}

// PURE: the newest user-turn row whose ts falls outside every injected window = the real user.
function realTurnFrom(rows, windows) {
  for (const r of rows || []) { if (!(windows || []).some((w) => r.ts >= w.a && r.ts <= w.b)) return r; }
  return null;
}
// PURE: does a real-user state own the pipeline right now?
function blockVerdict({ agoMs, unanswered }, now = Date.now()) {   // eslint-disable-line no-unused-vars
  if (agoMs == null) return { block: false };
  if (agoMs < REAL_USER_WINDOW_MS) return { block: true, why: `real user turn ${Math.round(agoMs / 1000)}s ago` };
  if (unanswered && agoMs < UNANSWERED_BLOCK_CAP_MS) return { block: true, why: `real user turn ${Math.round(agoMs / 1000)}s ago is still UNANSWERED` };
  return { block: false };
}
function _realUserState(now = Date.now()) {
  try {
    const db = require('./db');
    const rows = db.getDb().prepare(`SELECT id, session_id, ts FROM turns WHERE speaker = 'user' ORDER BY ts DESC LIMIT 40`).all();
    const r = realTurnFrom(rows, _injectedWindows);
    if (!r) return { agoMs: null, unanswered: false };
    let unanswered = false;
    try {
      const n = db.getDb().prepare(`SELECT COUNT(*) n FROM turns WHERE speaker = 'ai_said' AND session_id = ? AND ts > ?`).get(r.session_id, r.ts);
      unanswered = !n || n.n === 0;
    } catch {}
    return { agoMs: now - r.ts, unanswered };
  } catch { return { agoMs: null, unanswered: false }; }
}

// The stored say rows for the injection window — THE TRUTH (08-22, the P3 finding: the port's one
// emit accumulator concatenates every stream, so the capture double-counts what the DB stores as
// separate clean rows). One row per say, in order, with its unprompted flag.
function _saysSince(sinceTs) {
  try {
    const db = require('./db');
    return db.getDb().prepare(`SELECT id, ts, content, unprompted FROM turns WHERE speaker = 'ai_said' AND ts >= ? ORDER BY ts`)
      .all(sinceTs).map((r) => ({ id: r.id, ts: r.ts, content: String(r.content || '').slice(0, 20000), unprompted: !!r.unprompted }));
  } catch { return []; }
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
    ok: !error, say: say.slice(0, 20000), says: _saysSince(started), complete, error,
    logLines, canvasWrites: _canvasWritesSince(started),
    tookMs: Date.now() - started, settled,
  };
}

function start({ runChatTurn, antifabCorrect = null, bookPromises = null, port = parseInt(process.env.ZOE_TEST_PORT, 10) || 8767 } = {}) {
  if (_server) return _server;
  if (typeof runChatTurn !== 'function') throw new Error('test_port needs runChatTurn');
  _server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && req.url === '/status') {
        const real = _realUserState();
        return send(200, { ok: true, inFlight: _inFlight, lastUserTurnAgoMs: _lastUserTurnAgoMs(),
          lastRealUserTurnAgoMs: real.agoMs, realUnanswered: real.unanswered, port });
      }
      // DEBUG: run the REAL wired anti-fabrication / Spine-2 gate on a SUPPLIED reply — deterministic proof
      // that the gate transforms a bad reply in the live process (no model needed). {say, evidence, turnStartTs}.
      // turnStartTs default = now (so lastGatherTs is stale → "no gather this turn", exercises absence);
      // pass turnStartTs:0 to make a historical gather count (exercises the gathered-confab fact gate).
      if (req.method === 'POST' && req.url === '/antifab') {
        if (typeof antifabCorrect !== 'function') return send(501, { ok: false, error: 'antifabCorrect not wired' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const { say, evidence, turnStartTs } = JSON.parse(body || '{}');
            if (!say || !String(say).trim()) return send(400, { ok: false, error: 'say required' });
            const ts = (turnStartTs === undefined || turnStartTs === null) ? Date.now() : turnStartTs;
            const corrected = antifabCorrect(String(say), ts, String(evidence || ''));
            return send(200, { ok: true, original: String(say), corrected, changed: corrected !== String(say) });
          } catch (e) { return send(500, { ok: false, error: e.message }); }
        });
        return;
      }
      // DEBUG: run the REAL async verify chain (groundFacts → verifyFact → the live search_lane instrument)
      // on a supplied reply — deterministic proof that an ungrounded current-event fact reaches the bounded
      // verify AND that the real SERP instrument returns a usable verdict (the smokes only inject a mock
      // search). {say, evidence} → {violation, query, verdict, matched, total}. Uses the real browser search,
      // so it is SLOW (~10-20s). Read-only: judges, never posts to chat.
      if (req.method === 'POST' && req.url === '/verify') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
          try {
            const { say, evidence } = JSON.parse(body || '{}');
            if (!say || !String(say).trim()) return send(400, { ok: false, error: 'say required' });
            const gf = require('./metacognition').groundFacts(String(say), { evidence: String(evidence || '') });
            if (gf.ok || !gf.violations.length) return send(200, { ok: true, violation: false, note: 'no ungrounded current-event fact' });
            const top = gf.violations[0];
            const vc = require('./verify_claim');
            // also run the raw SERP directly so we can see whether the instrument returns anything
            let serpCount = null, serpSample = null;
            try { const q = vc.buildFactQuery(top.claim, top.novelTerms || []); const raw = await require('./search_lane').search(q); serpCount = ((raw && raw.results) || []).length; serpSample = (raw && raw.results && raw.results[0]) ? `${raw.results[0].title} :: ${raw.results[0].snippet}`.slice(0, 160) : null; } catch (e) { serpCount = `ERR:${e.message}`; }
            const res = await vc.verifyFact(top.claim, top.novelTerms || [], { search: (q) => require('./search_lane').search(q), timeoutMs: 20000 });
            return send(200, { ok: true, violation: true, novelTerms: top.novelTerms, query: res.query, verdict: res.verdict, matched: res.matched, total: res.total, reason: res.reason, serpCount, serpSample });
          } catch (e) { return send(500, { ok: false, error: e.message }); }
        });
        return;
      }
      // DEBUG: run the REAL delivery-binding on a supplied reply — detect the promise + book the unkept one,
      // then return the current open promise queue. Deterministic proof of book+queue (no model). {say}.
      if (req.method === 'POST' && req.url === '/promise') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const { say, clear } = JSON.parse(body || '{}');
            // {clear:true} → complete any open promise booked by THIS test port (sessionId 'test-port'), so a
            // deterministic /promise test never leaves rows that would later surface to the user.
            if (clear) {
              const rq = require('./recheck_queue');
              const rows = rq.openByKind({ kind: 'promise', limit: 100, now: Date.now() + 3600000 })
                .filter((r) => (r.detail || {}).sessionId === 'test-port');
              for (const r of rows) rq.complete(r.id, { outcome: 'test-port cleanup' });
              return send(200, { ok: true, cleared: rows.length });
            }
            if (!say || !String(say).trim()) return send(400, { ok: false, error: 'say required' });
            const detected = require('./delivery').detectPromise(String(say));
            if (typeof bookPromises === 'function') bookPromises(String(say), { sessionId: 'test-port', turnStartTs: Date.now() });
            // reveal grace-window promises too (now far in the future) so a just-booked row is visible
            const open = require('./recheck_queue').openByKind({ kind: 'promise', limit: 20, now: Date.now() + 3600000 });
            return send(200, { ok: true, detected, openPromises: open.map((r) => ({ id: r.id, subject: r.subject, deliverable: (r.detail || {}).deliverable })) });
          } catch (e) { return send(500, { ok: false, error: e.message }); }
        });
        return;
      }
      // DEBUG / interim trigger: the Spine-3 leaf-fill. {state, limit?, action:'enqueue'|'coverage'} →
      // enqueue a state's localities as local-roster research tasks (the metabolism then drains them), or
      // report honest coverage (filled/denominator). Deterministic; the research itself runs in the metabolism.
      if (req.method === 'POST' && req.url === '/local-roster') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const { state, limit, action } = JSON.parse(body || '{}');
            if (!state || !String(state).trim()) return send(400, { ok: false, error: 'state required (e.g. "LA")' });
            const lr = require('./local_roster');
            if (action === 'coverage') return send(200, { ok: true, ...lr.coverage(String(state)) });
            if (action === 'clear') {
              // complete any open local-roster task from the fill producer — so a test enqueue never leaves
              // tasks grinding the metabolism (committing a whole state to research is Lucas's call, not a test's).
              const rq = require('./recheck_queue');
              const rows = rq.openByKind({ kind: 'local-roster', limit: 5000, now: Date.now() + 3600000 })
                .filter((r) => r.born_from === 'local-roster-fill');
              for (const r of rows) rq.complete(r.id, { outcome: 'test-port cleanup' });
              return send(200, { ok: true, cleared: rows.length });
            }
            return send(200, { ok: true, ...lr.enqueueState(String(state), { limit: limit || null }) });
          } catch (e) { return send(500, { ok: false, error: e.message }); }
        });
        return;
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
            // RUN-4 COLLISION guard: a REAL (non-injected) user turn owns the pipeline far longer
            // than the self-pacing window, and an unanswered one blocks regardless of age (capped).
            const real = _realUserState();
            const rv = blockVerdict(real);
            if (rv.block) {
              return send(409, { ok: false, error: `Lucas is live (${rv.why}) — his conversation owns the pipeline; retry when idle` });
            }
            _inFlight = true;
            const _injectStart = Date.now();
            try {
              const out = await _runInjectedTurn(runChatTurn, {
                text, settleMs: Math.max(1000, settleMs || DEFAULT_SETTLE_MS), maxMs: Math.max(10000, maxMs || DEFAULT_MAX_MS),
              });
              send(200, out);
            } finally { _inFlight = false; _noteInjectionWindow(_injectStart, Date.now()); }
          } catch (e) { _inFlight = false; send(500, { ok: false, error: e.message }); }
        });
        return;
      }
      send(404, { ok: false, error: 'POST /turn, /antifab, /verify, /promise, /local-roster, or GET /status' });
    } catch (e) { send(500, { ok: false, error: e.message }); }
  });
  _server.listen(port, '127.0.0.1', () => console.log(`[test-port] inside access port on 127.0.0.1:${port} (POST /turn drives the REAL pipeline)`));
  _server.on('error', (e) => console.error('[test-port] server error:', e.message));
  return _server;
}

function stop() { try { if (_server) _server.close(); } catch {} _server = null; }

module.exports = { start, stop, _runInjectedTurn, realTurnFrom, blockVerdict, ACTIVE_WINDOW_MS, DEFAULT_SETTLE_MS, DEFAULT_MAX_MS, REAL_USER_WINDOW_MS, UNANSWERED_BLOCK_CAP_MS };
