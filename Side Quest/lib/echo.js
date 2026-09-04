/**
 * lib/echo.js — Zoe's MCP client to the Echo "suit" (the keyhole, Zoe's side).
 *
 * Echo is a FastMCP server exposing ~400 tools (data/KG + the agent workforce). It speaks
 * MCP JSON-RPC over either stdio (its default — an Electron frontend spawns it) or Streamable
 * HTTP (--transport http, token-auth'd). The PROTOCOL is identical across transports, so this
 * client is transport-agnostic: a small JSON-RPC core (initialize → tools/list → tools/call)
 * over an injectable `transport`. An HTTP transport is included; a stdio (child-process)
 * transport can drop in later without touching the core.
 *
 * STATUS: inert. Not wired into any live loop yet — this is the connection seam only, so it
 * can be built + smoke-tested (mock transport, offline) without a running Echo and without
 * rebooting her. Live wiring (tool dispatch, frontier routing, the subconscious tick) lands
 * after the transport + Echo-side decisions are made. See docs/ECHO_INTEGRATION_MAP.md.
 */
'use strict';

const PROTOCOL_VERSION = '2025-06-18';   // MCP protocol revision this client negotiates

// Pull the JSON-RPC payload out of a Streamable-HTTP response body, which may be a bare JSON
// object or an SSE stream ("event: message\ndata: {…}"). Returns the last data object seen.
//
// ⚠ `[\s\S]*`, NOT `.*` (2026-07-20). In JS regex `.` excludes U+2028/U+2029 — they count as line
// terminators — but String.split(/\r?\n/) does NOT split on them. So ONE raw U+2029 anywhere in a
// tool's payload (e.g. an RSS body reprinting a PARAGRAPH SEPARATOR) made `^data:\s?(.*)$` fail to
// match the whole line, this return null, and the caller throw "echo: empty response to tools/call"
// — on a perfectly good HTTP 200. That was the Monitors "⚠ fetch failed" panel: one poisoned feed
// killed its entire fetch_feeds_batch. MEASURED on chicago.suntimes.com: 526KB body, 2× U+2029.
function parseStreamableBody(contentType, text) {
  if (/text\/event-stream/i.test(contentType || '')) {
    let last = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^data:\s?([\s\S]*)$/);
      if (m && m[1]) { try { last = JSON.parse(m[1]); } catch { /* partial/non-JSON data line */ } }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// A NETWORK-LEVEL failure (socket died before a response existed) vs everything else. Only these
// are safe+useful to retry once on a fresh connection: an AbortError is the hang guard's verdict
// (retrying doubles the wedge), and an HTTP-status error means Echo answered — the transport's
// job is done. undici surfaces the keep-alive race as TypeError "fetch failed" with the real
// code on `cause`; the message alternation covers runtimes that throw the code directly.
function isNetFail(e) {
  if (!e || e.name === 'AbortError') return false;
  const s = `${e.message || ''} ${(e.cause && (e.cause.code || e.cause.message)) || ''}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed/i.test(s);
}

// Streamable-HTTP transport. Carries the bearer token + MCP session id; accepts both JSON and
// SSE responses. `fetchImpl` is injectable for tests.
function httpTransport({ url, token = null, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
                         requestTimeoutMs = Number(process.env.ECHO_HTTP_TIMEOUT_MS) || 180000 } = {}) {
  if (!url) throw new Error('echo httpTransport: url required');
  if (!fetchImpl) throw new Error('echo httpTransport: no fetch available');
  let sessionId = null;
  return {
    kind: 'http',
    async send(message) {
      // An `initialize` STARTS a session — it must never carry a previous one. Without this reset a
      // stale latched id (Echo restarted / session GC'd) poisons every reconnect: initialize + old
      // Mcp-Session-Id → 404 "Session not found", and the 60s attach heartbeat can retry forever
      // without ever landing (live failure, boot97 2026-07-29).
      if (message && message.method === 'initialize') sessionId = null;
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      // M2.5 HANG GUARD: this send had NO timeout — a dead/hung Echo left `await fetch` pending forever,
      // wedging the caller (the attach heartbeat could retry-loop without ever landing; a tool dispatch would
      // hang the turn). Bound it with an AbortController. GENEROUS default (180s, ECHO_HTTP_TIMEOUT_MS-overridable)
      // so legitimately long tool calls still complete — this guards a true connection hang, not a tight SLA.
      // THE TIMER COVERS THE BODY TOO (cut 18, 2026-09-03): the guard used to be cleared the moment the
      // response HEADERS arrived, and the body read below (`res.text()` — a streamable-HTTP tool result
      // arrives as an SSE body that stays open until the tool returns) had no timeout at all. A tool the
      // engine never finished hung the caller forever — the editor round-trip smoke sat 5 minutes past
      // its cap with ECHO_HTTP_TIMEOUT_MS=20000 in force. The controller now lives until the body is
      // consumed; `done()` releases it.
      const _fetchOnce = async () => {
        const _ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const _to = _ctrl ? setTimeout(() => { try { _ctrl.abort(); } catch {} }, requestTimeoutMs) : null;
        const done = () => { if (_to) clearTimeout(_to); };
        try {
          const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), signal: _ctrl ? _ctrl.signal : undefined });
          return { res: r, done };
        } catch (e) { done(); throw e; }
      };
      // M2.5 KEEP-ALIVE RACE (transport hardening): after an idle gap (a main-thread stall, a long
      // tool run) the fetch pool reuses a socket Echo's uvicorn already closed (~5s keep-alive) —
      // the request dies at write time with a bare "fetch failed" though Echo is healthy (measured
      // 1-7×/boot as "[route-obs] … Echo call failed: fetch failed"). The connection died, the
      // request was not processed; ONE immediate retry rides a fresh socket. Never retried on
      // abort (that's the hang guard's verdict — a second 180s wait would double the wedge) and
      // never more than once (a hard-down Echo must fail fast into the reconnect path).
      let got;
      try {
        got = await _fetchOnce();
      } catch (e) {
        if (!isNetFail(e)) throw e;
        try { console.log(`[echo] transport: dead keep-alive socket (${e && e.message}) — one retry on a fresh connection`); } catch {}
        got = await _fetchOnce();
      }
      const res = got.res;
      try {
        const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;
        if (res.status === 202 || res.status === 204) return null;   // notification/ack, no body
        if (!res.ok) {
          // 404 = the server no longer knows this session (restart / GC) — drop the latch so the
          // next handshake starts clean instead of re-presenting the dead id.
          if (res.status === 404) sessionId = null;
          const errText = await res.text().catch(() => '');
          throw new Error(`echo http ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
        }
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        let text;
        try { text = await res.text(); }
        catch (e) {
          if (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)))) throw new Error(`echo http timeout: no complete reply within ${requestTimeoutMs}ms (${message && message.method}${message && message.params && message.params.name ? ' ' + message.params.name : ''})`);
          throw e;
        }
        return parseStreamableBody(ct, text);
      } finally { got.done(); }
    },
    get sessionId() { return sessionId; }
  };
}

// stdio transport — Zoe OWNS the suit's process: she spawns `python -m echo.mcp_server`
// (Echo's default stdio mode) and frames MCP JSON-RPC as newline-delimited messages over
// the child's stdin/stdout (the MCP stdio contract). No port, no token. `spawnFn` is
// injectable so the framing can be smoke-tested without launching real Echo.
function stdioTransport({
  python = process.env.ECHO_PYTHON || 'python',
  cwd = process.env.ECHO_CWD || null,
  moduleName = 'echo.mcp_server',
  extraArgs = [],
  env = null,
  spawnFn = null,
  requestTimeoutMs = 30000,
} = {}) {
  let proc = null;
  let started = false;
  let buf = '';
  const pending = new Map();
  let nextId = 0;

  function handleLine(line) {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }   // skip Echo's stdout log noise
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); p.resolve(msg);
    }
    // server-initiated notifications/requests are ignored for now (no sampling/roots needed yet)
  }

  function rejectAll(err) { for (const [, p] of pending) p.reject(err); pending.clear(); }

  function start() {
    if (started) return;
    const _spawn = spawnFn || require('child_process').spawn;
    proc = _spawn(python, ['-m', moduleName, ...extraArgs], {
      // Zoe's model pins are stripped here — Echo reads the same variable names for its own agent
      // fleet, and forwarding them collapses its three slots onto one model (lib/child_env.js).
      cwd: cwd || undefined, env: require('./child_env').forEcho(env || process.env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    started = true;
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handleLine(line); }
    });
    if (proc.stderr) proc.stderr.on('data', () => { /* Echo logs to stderr; swallow */ });
    proc.on('exit', (code) => { started = false; proc = null; rejectAll(new Error(`echo stdio exited (code ${code})`)); });
    proc.on('error', (e) => { started = false; rejectAll(e); });
  }

  return {
    kind: 'stdio',
    start,
    async send(message) {
      if (!started) start();
      proc.stdin.write(JSON.stringify(message) + '\n');
      if (message.id == null) return null;   // notification — no response expected
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => { if (pending.has(message.id)) { pending.delete(message.id); reject(new Error(`echo stdio timeout (id ${message.id})`)); } }, requestTimeoutMs);
        pending.set(message.id, { resolve: (m) => { clearTimeout(to); resolve(m); }, reject: (e) => { clearTimeout(to); reject(e); } });
      });
    },
    close() { if (proc) { try { proc.kill(); } catch { /* already dead */ } proc = null; started = false; } },
  };
}

class EchoClient {
  constructor({ transport, clientName = 'zoe', clientVersion = '1.0.0' } = {}) {
    if (!transport || typeof transport.send !== 'function') throw new Error('EchoClient: a transport with send() is required');
    this.transport = transport;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this._id = 0;
    this.ready = false;
    this.serverInfo = null;
    this._toolCache = null;
  }

  async _request(method, params = {}) {
    const id = ++this._id;
    let resp;
    try {
      resp = await this.transport.send({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      // A dead session must also un-latch the CLIENT: `ready` stays true after a mid-session 404,
      // so without this every later call would skip the handshake and die the same way.
      if (/echo http 404\b/.test(String(e && e.message))) this.ready = false;
      throw e;
    }
    if (!resp) throw new Error(`echo: empty response to ${method}`);
    if (resp.error) throw new Error(`echo ${method} error ${resp.error.code}: ${resp.error.message}`);
    return resp.result;
  }

  _notify(method, params = {}) {
    return this.transport.send({ jsonrpc: '2.0', method, params });
  }

  // MCP handshake: initialize, then the initialized notification. Idempotent-ish.
  async initialize() {
    const result = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion }
    });
    await this._notify('notifications/initialized');
    this.serverInfo = result && result.serverInfo ? result.serverInfo : null;
    this.ready = true;
    return result;
  }

  // List Echo's tools (the suit's capability surface). Cached after first call.
  async listTools({ refresh = false } = {}) {
    if (!this.ready) await this.initialize();
    if (this._toolCache && !refresh) return this._toolCache;
    const result = await this._request('tools/list', {});
    this._toolCache = (result && result.tools) || [];
    return this._toolCache;
  }

  // Call one Echo tool. Returns the MCP tool result ({ content: [...], isError? }).
  async callTool(name, args = {}) {
    if (!this.ready) await this.initialize();
    return this._request('tools/call', { name, arguments: args || {} });
  }
}

// Construct from env/config. Defaults to a locally-running Echo HTTP server; token from the
// same env var Echo's auth reads (NX_ECHO_SHARED_TOKEN), so no new secret surface.
function fromEnv(overrides = {}) {
  const url = overrides.url || process.env.ECHO_MCP_URL || 'http://127.0.0.1:9000/mcp/';
  const token = overrides.token || process.env.NX_ECHO_SHARED_TOKEN || process.env.NX_ECHO_ADMIN_TOKEN || null;
  return new EchoClient({ transport: httpTransport({ url, token }), ...overrides });
}

// The chosen path: Zoe spawns Echo over stdio (she owns the suit's process). cwd/python come
// from env (ECHO_CWD = the nx-echo repo root, ECHO_PYTHON = its interpreter). Caller calls
// .initialize() to start the handshake (which lazily spawns the child).
function spawnEcho(overrides = {}) {
  const transport = stdioTransport({
    python: overrides.python || process.env.ECHO_PYTHON || 'python',
    cwd: overrides.cwd || process.env.ECHO_CWD || null,
    moduleName: overrides.moduleName || 'echo.mcp_server',
    extraArgs: overrides.extraArgs || [],
    env: overrides.env || null,
    spawnFn: overrides.spawnFn || null,
  });
  return new EchoClient({ transport, clientName: overrides.clientName || 'zoe', clientVersion: overrides.clientVersion || '1.0.0' });
}

// Unwrap an MCP tool result ({ content: [{type:'text', text:'<json>'}], isError? }) to the tool's
// domain payload object. MCP encodes the real return value as JSON text inside content[]; callers
// that want the structured object (not the envelope) route through this. Already-structured input
// is returned as-is; unparseable text comes back as { text } so callers can still inspect it.
function toolJson(raw) {
  if (raw == null) return raw;
  // FastMCP populates `structuredContent` with the canonical structured object — list returns are
  // wrapped under {result:[…]}, dict returns pass through ({query,results}/{ok,rows}/…). This is the
  // shape callers ground against, so prefer it. `content[].text` is the human-text rendering (a
  // BARE list for list-returning tools), used only as a fallback when structuredContent is absent.
  if (raw.structuredContent != null) return raw.structuredContent;
  if (Array.isArray(raw.content)) {
    const text = raw.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('').trim();
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return raw;
}

module.exports = { EchoClient, httpTransport, stdioTransport, parseStreamableBody, isNetFail, fromEnv, spawnEcho, toolJson, PROTOCOL_VERSION };
