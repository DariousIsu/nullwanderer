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
  // <echo-recipe name="X" arg="Y"/> — the PREFERRED path: a named, pre-validated procedure.
  // Tolerant of self-closing or paired form, attrs in any order, and arg given as the body.
  scan(/<echo-recipe\s+([^>]*?)\/?>(?:([\s\S]*?)<\/echo-recipe>)?/g, m => {
    const attrs = m[1] || '';
    const name = (attrs.match(/name\s*=\s*"([^"]*)"/) || [])[1] || '';
    let arg = (attrs.match(/arg\s*=\s*"([^"]*)"/) || [])[1];
    const limit = (attrs.match(/limit\s*=\s*"?(\d+)"?/) || [])[1];
    const body = (m[2] || '').trim();
    if (arg == null && body) arg = body;
    return { kind: 'recipe', name: name.trim(), arg: arg != null ? String(arg).trim() : null, limit: limit ? Number(limit) : null };
  });
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
    .replace(/<echo-recipe\b[\s\S]*?(?:\/>|<\/echo-recipe>)/g, '')
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

// Turn list_recipes() JSON into a compact in-context menu: one terse line per recipe
// (name + arg hint + intent), capped so it stays ctx-cheap at num_ctx 8192.
function buildRecipeMenu(jsonText) {
  let d; try { d = JSON.parse(jsonText); } catch { return ''; }
  const list = d.recipes || [];
  if (!list.length) return '';
  const lines = list.map(r => `• ${r.name}${r.arg ? ` <${cap(String(r.arg), 22)}>` : ''} — ${cap(r.intent || '', 58)}`);
  let out = lines.join('\n');
  if (out.length > 2200) out = out.slice(0, 2200) + '\n…(more — <echo-do name="list_recipes">{}</echo-do>)';
  return out;
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
      let guide = '', atlas = '', recipes = '';
      try { guide = normalizeToolResult(await c.callTool('get_usage_guide', {})).text; } catch {}
      try { atlas = normalizeToolResult(await c.callTool('get_atlas', {})).text; } catch {}
      // Recipe Book menu — the validated, one-arg procedures she should reach for FIRST.
      try { recipes = buildRecipeMenu(normalizeToolResult(await c.callTool('list_recipes', {})).text); } catch {}
      this._suit = { guide: cap(guide, 1400), atlas: cap(atlas, 1200), recipes };
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
    const lines = [
      `ECHO SUIT — you are wearing Echo: ${this.toolCount} tools + a validated RECIPE BOOK. Reach for a recipe FIRST — they're pre-validated and take ONE plain arg, so they can't be fumbled. Drop to raw tools only when no recipe fits.`,
      `• <echo-recipe name="X" arg="Y"/> — run a named recipe from the menu below. ONE human arg (a name, a 2-letter state code, a keyword). THIS IS YOUR DEFAULT for our data.`,
      `• <echo-find>what you need</echo-find> — find a raw tool when no recipe fits.`,
      `• <echo-do name="tool">{json}</echo-do> — run any tool by name (describe_tool shows its schema).`,
      `• <echo-delegate name="agent">task</echo-delegate> — hand a heavy job to a background agent.`,
      `• <echo-propose kind="entity|relation|link">{json}</echo-propose> — curate into the graph (verification + Lucas gate).`,
      `• <echo-guide/> — pull the full contract + atlas when you need the map.`,
    ];
    if (this._suit.recipes) lines.push(`RECIPES (your menu — run any with <echo-recipe name="..." arg="..."/>):\n${this._suit.recipes}`);
    lines.push(`ECHO = OUR data (Rainey vault, the entity/relationship graph, contacts, bills, the LAMP network). <web-open> = the open internet. "Use the db / our records / find OUR papers / look up someone OURS (person/org/bill/LAMP)" → a recipe (or <echo-find>), NEVER the browser. (You once web-searched "LAMP" and got a Japanese band, and DuckDuckGo'd for Rainey papers that live in our own vault — wrong tool. search-vault is the recipe for that.)`);
    return lines.join('\n');
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
        if (!this.connected) await this.connect();
        if (!this.connected) return { ok: false, kind: 'guide', isError: true, text: `Echo not reachable: ${this.lastError || 'offline'}` };
        // Surface the full contract + atlas as the result (fed back via the tool-followup), so she
        // has the map THIS turn on demand — instead of it sitting in every prompt and blowing ctx.
        const s = this._suit || {};
        return { ok: true, kind: 'guide', text: `Echo contract + navigation atlas (${this.toolCount} tools):\n\n${s.guide || ''}\n\n${s.atlas || ''}` };
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
      if (tag.kind === 'recipe') {
        if (!tag.name) return { ok: false, kind: 'recipe', isError: true, text: `<echo-recipe> needs name="..." from your recipe menu — e.g. <echo-recipe name="search-vault" arg="weather modification"/>.` };
        const args = { name: tag.name };
        if (tag.arg) args.arg = tag.arg;
        if (tag.limit) args.limit = tag.limit;
        const r = normalizeToolResult(await c.callTool('run_recipe', args));
        // run_recipe reports recipe-level failure (bad name / missing arg) as {ok:false} in its
        // payload, which isn't an MCP transport error — detect it so she gets the correction.
        let recipeOk = r.ok;
        try { const p = JSON.parse(r.text); if (p && p.ok === false) recipeOk = false; } catch {}
        return { ok: recipeOk, kind: 'recipe', name: tag.name, isError: !recipeOk, text: r.text };
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

module.exports = { EchoSuit, createSuit, parseEchoTags, parseArgs, stripEchoTags, normalizeToolResult, resultText, filterToolMap, buildRecipeMenu };
