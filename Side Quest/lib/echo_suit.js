/**
 * lib/echo_suit.js — Component 2 of the Echo integration: the tool-dispatch bridge ("the suit").
 *
 * Zoe wears Echo as a capability suit. She does NOT hold all 518 tools — she navigates them
 * through Echo's own small-model-validated ATLAS (get_usage_guide / get_atlas / get_tool_map /
 * describe_tool), reaching the whole surface on demand via a handful of tags:
 *   <echo-guide/>                          reload the contract + map
 *   <echo-find>what you need</echo-find>   discover the right tool (filters the tool map)
 *   <echo-do name="tool">{json}</echo-do>  invoke ANY Echo tool by name
 *   <echo-delegate name="agent">task</echo-delegate>  hand a heavy job to a background agent
 *   <echo-propose kind="entity|relation|link">{json}</echo-propose>  curate into the KG
 *
 * INERT: this module is NOT imported by any live loop yet. Wiring it into main.js + her
 * dispatcher needs a reboot (gated on Lucas). Built to be smoke-tested offline with a mock
 * client (no real Echo) and then against the live stdio connection.
 *
 * Design + decisions: Side Quest/docs/ECHO_INTEGRATION_MAP.md (locked 2026-06-22).
 */
const echo = require('./echo');

const cap = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

// ---------- pure helpers (unit-tested in isolation) ----------

// Flatten an MCP tool result's content array to text.
function resultText(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw.content)) return raw.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('').trim();
  if (typeof raw.text === 'string') return raw.text;
  return '';
}

// FastMCP/pydantic surface tool-level errors two ways: an explicit isError flag, OR a normal
// result whose CONTENT is a validation message (observed live: "2 validation errors for
// call[quick_lookup]\nname\n Missing required argument"). Detect both so the bridge can feed the
// error back to her for self-correction instead of treating a bad call as success.
const VALIDATION_RE = /\b\d+\s+validation errors?\s+for\b|missing_argument|Missing required argument|field required|Input should be|Field required/i;
function normalizeToolResult(raw) {
  const text = resultText(raw);
  const isError = !!(raw && raw.isError) || VALIDATION_RE.test(text);
  return { ok: !isError, isError, text };
}

// Parse her output for echo-suit tags, preserving document order (dispatch order can matter).
function parseEchoTags(text) {
  if (!text) return [];
  const found = [];
  const scan = (re, make) => { let m; while ((m = re.exec(text)) !== null) found.push({ index: m.index, tag: make(m) }); };
  scan(/<echo-guide\s*\/>|<echo-guide>\s*<\/echo-guide>/g, () => ({ kind: 'guide' }));
  scan(/<echo-find>([\s\S]*?)<\/echo-find>/g, m => ({ kind: 'find', query: m[1].trim() }));
  scan(/<echo-do\s+name="([^"]+)"\s*>([\s\S]*?)<\/echo-do>/g, m => { const a = parseArgs(m[2]); return { kind: 'do', name: m[1].trim(), args: a.args, parseError: a.parseError }; });
  scan(/<echo-delegate(?:\s+name="([^"]*)")?\s*>([\s\S]*?)<\/echo-delegate>/g, m => ({ kind: 'delegate', agent: (m[1] || '').trim() || null, task: m[2].trim() }));
  scan(/<echo-propose\s+kind="([^"]+)"\s*>([\s\S]*?)<\/echo-propose>/g, m => { const a = parseArgs(m[2]); return { kind: 'propose', proposeKind: m[1].trim(), payload: a.args, parseError: a.parseError }; });
  return found.sort((a, b) => a.index - b.index).map(x => x.tag);
}
function parseArgs(body) {
  const t = (body || '').trim();
  if (!t) return { args: {} };
  try { return { args: JSON.parse(t) }; } catch (e) { return { args: {}, parseError: e.message }; }
}

// Remove all echo-suit tags from a block of her output, so they don't persist in stored turns
// (mirrors every other tool lib's stripTags). Idempotent; null-safe.
function stripEchoTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/<echo-guide\s*\/>/g, '')
    .replace(/<echo-guide>\s*<\/echo-guide>/g, '')
    .replace(/<echo-find>[\s\S]*?<\/echo-find>/g, '')
    .replace(/<echo-do\b[\s\S]*?<\/echo-do>/g, '')
    .replace(/<echo-delegate\b[\s\S]*?<\/echo-delegate>/g, '')
    .replace(/<echo-propose\b[\s\S]*?<\/echo-propose>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Turn get_tool_map(intent) JSON into a SMALL, query-relevant list — the small-model navigation
// aid (518 raw entries would blow her context). Filters by query terms over name+description.
function filterToolMap(jsonText, query, limit = 15) {
  let data; try { data = JSON.parse(jsonText); } catch { return cap(jsonText, 1200); }
  const buckets = data.by_intent || {};
  const all = [];
  for (const [intent, list] of Object.entries(buckets)) for (const t of (list || [])) all.push({ intent, name: t.name, desc: t.description || '' });
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let hits = all;
  if (terms.length) hits = all.filter(t => { const hay = (t.name + ' ' + t.desc).toLowerCase(); return terms.some(w => hay.includes(w)); });
  if (!hits.length) {
    const overview = Object.entries(buckets).map(([i, l]) => `${i} (${(l || []).length})`).join(', ');
    return `No tool matched "${query}". Intent buckets: ${overview}. Try different words, or <echo-do name="get_tool_map">{"grouping":"flat"}</echo-do> to see them all.`;
  }
  const lines = hits.slice(0, limit).map(t => `• ${t.name} [${t.intent}] — ${cap(t.desc, 90)}`);
  const more = hits.length > limit ? `\n(+${hits.length - limit} more — narrow your terms, then <echo-do name="describe_tool">{"name":"…"}</echo-do> to inspect one)` : '';
  return `Tools matching "${query}":\n` + lines.join('\n') + more;
}

// ---------- the suit (stateful connection wrapper) ----------

class EchoSuit {
  constructor({ client = null, spawnFn = null, now = () => Date.now() } = {}) {
    this._client = client;       // injectable for tests
    this._spawnFn = spawnFn;     // injectable spawner (else echo.spawnEcho)
    this._now = now;
    this.connected = false;
    this.toolCount = 0;
    this.serverInfo = null;
    this.lastError = null;
    this.bootMs = null;
    this._suit = null;           // cached { guide, atlas }
  }

  client() {
    if (!this._client) this._client = this._spawnFn ? this._spawnFn() : echo.spawnEcho();
    return this._client;
  }

  // Spawn/connect, initialize, list tools, and pin the contract + atlas. Idempotent: re-running
  // refreshes the cached map (what <echo-guide/> does). Never throws — returns {ok,...}.
  async connect() {
    const t0 = this._now();
    try {
      const c = this.client();
      const init = await c.initialize();
      this.serverInfo = (init && init.serverInfo) || c.serverInfo || null;
      const tools = await c.listTools();
      this.toolCount = Array.isArray(tools) ? tools.length : 0;
      let guide = '', atlas = '';
      try { guide = normalizeToolResult(await c.callTool('get_usage_guide', {})).text; } catch {}
      try { atlas = normalizeToolResult(await c.callTool('get_atlas', {})).text; } catch {}
      this._suit = { guide: cap(guide, 1400), atlas: cap(atlas, 1200) };
      this.connected = true; this.lastError = null; this.bootMs = this._now() - t0;
      return { ok: true, tools: this.toolCount, bootMs: this.bootMs, server: this.serverInfo };
    } catch (e) {
      this.connected = false; this.lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  status() { return { connected: this.connected, tools: this.toolCount, server: this.serverInfo, bootMs: this.bootMs, lastError: this.lastError }; }

  // The always-on context block pinned into her prompt when the suit is on — the contract + map
  // + the tag grammar, so the navigation surface is in front of her (Echo's "load this first").
  suitContextBlock() {
    if (!this.connected || !this._suit) return null;
    return [
      `ECHO SUIT — you are wearing Echo, your capability suit: ${this.toolCount} tools over a live connection (search, the knowledge graph, deliverable renderers, a background agent workforce). You don't hold them all — you navigate them with these tags:`,
      `• <echo-find>what you need</echo-find> — find the right tool by description.`,
      `• <echo-do name="tool_name">{json args}</echo-do> — run any Echo tool by name (use <echo-find> first if unsure of the name or args; <echo-do name="describe_tool">{"name":"X"}</echo-do> shows a tool's schema + examples).`,
      `• <echo-delegate name="agent">the task</echo-delegate> — hand a heavy/multi-step job to a background agent; it reports back later, you don't wait.`,
      `• <echo-propose kind="entity|relation|link">{json}</echo-propose> — propose into the shared knowledge graph. You curate by relevance; verification + Lucas are the commit gate, so propose freely.`,
      `• <echo-guide/> — reload this contract + map.`,
      ``,
      `ECHO'S CONTRACT (its own usage guide):`,
      this._suit.guide,
      ``,
      `ECHO'S ATLAS (navigation map):`,
      this._suit.atlas,
    ].join('\n');
  }

  // Execute one parsed tag → a normalized { ok, kind, isError?, text } the caller surfaces back
  // to her (errors included, so she can self-correct args / pick another tool).
  async dispatch(tag) {
    if (!tag || !tag.kind) return { ok: false, text: 'no tag' };
    // Self-heal: if she reaches for the suit before the warm-connect finished (or after Echo
    // dropped), try to connect now. guide connects on its own below.
    if (!this.connected && tag.kind !== 'guide') {
      await this.connect();
      if (!this.connected) return { ok: false, kind: tag.kind, isError: true, text: `The Echo suit isn't connected right now (${this.lastError || 'still starting up'}). I can't reach those tools this moment — say so plainly and try again shortly.` };
    }
    try {
      const c = this.client();
      if (tag.kind === 'guide') {
        const r = await this.connect();
        return { ok: r.ok, kind: 'guide', text: r.ok ? `Reloaded the Echo contract + atlas (${this.toolCount} tools).` : `Echo not reachable: ${r.error}` };
      }
      if (tag.kind === 'find') {
        const r = normalizeToolResult(await c.callTool('get_tool_map', { grouping: 'intent' }));
        if (r.isError) return { ok: false, kind: 'find', isError: true, text: r.text };
        return { ok: true, kind: 'find', text: filterToolMap(r.text, tag.query) };
      }
      if (tag.kind === 'do') {
        if (tag.parseError) return { ok: false, kind: 'do', isError: true, text: `Your <echo-do name="${tag.name}"> args weren't valid JSON (${tag.parseError}). Re-emit with valid JSON args.` };
        const r = normalizeToolResult(await c.callTool(tag.name, tag.args || {}));
        return { ok: r.ok, kind: 'do', name: tag.name, isError: r.isError, text: r.text };
      }
      if (tag.kind === 'delegate') {
        const args = { prompt: tag.task };
        if (tag.agent) args.name = tag.agent;
        const r = normalizeToolResult(await c.callTool('spawn_agent_async', args));
        return { ok: r.ok, kind: 'delegate', isError: r.isError, text: r.text };
      }
      if (tag.kind === 'propose') {
        if (tag.parseError) return { ok: false, kind: 'propose', isError: true, text: `Your <echo-propose> payload wasn't valid JSON (${tag.parseError}). Re-emit with valid JSON.` };
        const r = normalizeToolResult(await c.callTool('propose_' + tag.proposeKind, tag.payload || {}));
        return { ok: r.ok, kind: 'propose', isError: r.isError, text: r.text };
      }
      return { ok: false, text: `unknown tag kind ${tag.kind}` };
    } catch (e) {
      // A throw here is a transport/protocol failure (Echo dropped, server restarted) — mark
      // disconnected so the next use / the boot poller re-attaches rather than assuming it's live.
      this.connected = false;
      return { ok: false, kind: tag.kind, isError: true, text: `Echo call failed: ${e.message}` };
    }
  }

  // Parse + dispatch every echo tag in a block of her output, in order.
  async dispatchAll(text) {
    const out = [];
    for (const tag of parseEchoTags(text)) out.push(await this.dispatch(tag));
    return out;
  }

  async close() {
    try { const c = this._client; if (c && c.transport && typeof c.transport.close === 'function') c.transport.close(); } catch {}
    this.connected = false;
  }
}

function createSuit(opts) { return new EchoSuit(opts); }

module.exports = { EchoSuit, createSuit, parseEchoTags, parseArgs, stripEchoTags, normalizeToolResult, resultText, filterToolMap };
