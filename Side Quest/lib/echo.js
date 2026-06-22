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
function parseStreamableBody(contentType, text) {
  if (/text\/event-stream/i.test(contentType || '')) {
    let last = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m && m[1]) { try { last = JSON.parse(m[1]); } catch { /* partial/non-JSON data line */ } }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// Streamable-HTTP transport. Carries the bearer token + MCP session id; accepts both JSON and
// SSE responses. `fetchImpl` is injectable for tests.
function httpTransport({ url, token = null, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null) } = {}) {
  if (!url) throw new Error('echo httpTransport: url required');
  if (!fetchImpl) throw new Error('echo httpTransport: no fetch available');
  let sessionId = null;
  return {
    kind: 'http',
    async send(message) {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message) });
      const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (res.status === 202 || res.status === 204) return null;   // notification/ack, no body
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`echo http ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
      }
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      return parseStreamableBody(ct, await res.text());
    },
    get sessionId() { return sessionId; }
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
    const resp = await this.transport.send({ jsonrpc: '2.0', id, method, params });
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

module.exports = { EchoClient, httpTransport, parseStreamableBody, fromEnv, PROTOCOL_VERSION };
