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

// Filter list_recipes() JSON to recipes matching a query, so <echo-find> surfaces RECIPES (the
// preferred, pre-validated path) — not just raw tools. The LAMP miss: she find-searched for a tool,
// but the answer was the `lamp-count` recipe, invisible to the raw tool map.
function filterRecipes(jsonText, query, limit = 8) {
  let d; try { d = JSON.parse(jsonText); } catch { return ''; }
  const list = d.recipes || [];
  if (!list.length) return '';
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let hits = list;
  if (terms.length) hits = list.filter(r => { const hay = (r.name + ' ' + (r.intent || '') + ' ' + (r.domain || '')).toLowerCase(); return terms.some(w => hay.includes(w)); });
  if (!hits.length) return '';
  const lines = hits.slice(0, limit).map(r => `• ${r.name}${r.arg_required ? ` <${cap(String(r.arg || 'arg'), 22)}>` : ' (no arg)'} — ${cap(r.intent || '', 80)}`);
  return `RECIPES matching "${query}" — PREFER these, run with <echo-recipe name="NAME" arg="..."/>:\n` + lines.join('\n');
}

// Is Echo cloud-routing on? On by default WHEN a cloud tier is configured; db meta echo.cloudRoute
// = 'off' disables it (→ fall back to the catalog-list behavior so the front can pick manually).
function echoCloudRouteEnabled() {
  try {
    const db = require('./db');
    if ((db.getMeta('echo.cloudRoute') || '').trim() === 'off') return false;
    const models = require('./models');
    return !!(models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  } catch { return false; }
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
      `• <echo-find>what you need</echo-find> — just say what you need in plain words; the right recipe/tool is CHOSEN and RUN for you automatically, and the result comes back. This is the easy path — you don't have to know tool names or write arguments.`,
      `• <echo-do name="tool">{json}</echo-do> — run a specific tool by name yourself (only when you already know exactly which one).`,
      `• <echo-delegate name="agent">task</echo-delegate> — hand a heavy job to a background agent.`,
      `• <echo-propose kind="entity|relation|link">{json}</echo-propose> — curate into the graph (verification + Lucas gate).`,
      `• <echo-guide/> — pull the full contract + atlas when you need the map.`,
    ];
    if (this._suit.recipes) lines.push(`RECIPES (your menu — run any with <echo-recipe name="..." arg="..."/>):\n${this._suit.recipes}`);
    lines.push(`ECHO = OUR data (Rainey vault, the entity/relationship graph, contacts, bills, the LAMP network). <web-open> = the open internet. "Use the db / our records / find OUR papers / look up someone OURS (person/org/bill/LAMP)" → a recipe (or <echo-find>), NEVER the browser. (You once web-searched "LAMP" and got a Japanese band, and DuckDuckGo'd for Rainey papers that live in our own vault — wrong tool. search-vault is the recipe for that.)`);
    // R1: bind OUR-data questions to recipes + a no-give-up rule (the LAMP-count failure: she
    // find-searched a tool, missed the lamp-count recipe, gave up, and drifted to another topic).
    lines.push(`A COUNT or LIST of OUR data ("how many LAMP members", "list the committee", "who is OURS") almost ALWAYS has a recipe — check your menu or <echo-find> it (it lists recipes first). If a lookup misses, do NOT give up or drift to another topic: try a broader recipe, or <echo-do name="db_query">, or tell Lucas you couldn't find it — and FINISH his question before anything else.`);
    return lines.join('\n');
  }

  // Execute one parsed tag → a normalized { ok, kind, isError?, text } the caller surfaces back
  // to her (errors included, so she can self-correct args / pick another tool).
  // opts.autonomous=true → the unattended research loop: only READ tools/recipes run; WRITE/HEAVY/
  // LOCKED are blocked with a message (she can READ from Echo unattended, but not mutate it or spawn
  // agents). Interactive turns (default) allow read+write+heavy; LOCKED (email-send/image-gen) never.
  async dispatch(tag, opts = {}) {
    if (!tag || !tag.kind) return { ok: false, text: 'no tag' };
    // TIER GATE — block a mutating/heavy/locked call before it reaches Echo.
    try {
      const tier = require('./echo_tier');
      let toolName = null;
      if (tag.kind === 'do') toolName = tag.name;
      else if (tag.kind === 'propose') toolName = 'propose_' + tag.proposeKind;
      else if (tag.kind === 'delegate') toolName = 'spawn_agent_async';
      // find / guide / recipe = navigation / read / curated procedure → not gated here.
      if (toolName) {
        const pol = tier.policyFor(toolName, { autonomous: !!opts.autonomous });
        if (!pol.allow) {
          console.log(`[echo] tier-gate BLOCKED ${toolName} (${pol.tier}, autonomous=${!!opts.autonomous})`);
          return { ok: false, kind: tag.kind, isError: true, blocked: true, tier: pol.tier, text: `Echo tool "${toolName}" is a ${pol.tier} action — ${pol.reason}. ${opts.autonomous ? 'On the autonomous loop you may READ from Echo but not write to it or spawn agents — surface this to Lucas instead of doing it unattended.' : 'This one stays off by design.'}` };
        }
      }
    } catch (e) { console.error('[echo] tier-gate check failed (allowing):', e.message); }
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
        // CLOUD ROUTING (Front/Cortex): when cloud routing is on, the cloud Reasoner picks the
        // recipe/tool + writes args + we execute it here — the conversational front never authors
        // echo-do JSON. Falls back to returning the catalog LIST (below) if cloud is unavailable.
        if (echoCloudRouteEnabled()) {
          try {
            const routed = await this.routeNeed(tag.query, { autonomous: !!opts.autonomous });
            if (routed && routed.routed) { if (routed.chose) console.log(`[echo] cloud-routed "${tag.query}" → ${routed.chose}`); return routed; }
          } catch (e) { console.error('[echo] cloud route failed, falling back to catalog list:', e.message); }
        }
        // recipe-aware: surface matching RECIPES first (the preferred, pre-validated path), THEN raw
        // tools. Without this, a find for "LAMP members count" missed the lamp-count recipe entirely.
        let recipes = '';
        try { recipes = filterRecipes(normalizeToolResult(await c.callTool('list_recipes', {})).text, tag.query); } catch {}
        const r = normalizeToolResult(await c.callTool('get_tool_map', { grouping: 'intent' }));
        const tools = r.isError ? '' : filterToolMap(r.text, tag.query);
        if (!recipes && !tools) return { ok: false, kind: 'find', isError: !!r.isError, text: r.isError ? r.text : `No recipe or tool matched "${tag.query}". Try different words, or scan your recipe menu.` };
        return { ok: true, kind: 'find', text: [recipes, tools].filter(Boolean).join('\n\n') };
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

  // CLOUD-ROUTE an Echo NEED end-to-end: the cloud Reasoner PICKS the recipe/tool from the
  // catalog and WRITES the args (matching the tool schema), then we execute it here. This moves
  // Echo tool-calling off the conversational front (which shouldn't author echo-do JSON) and onto
  // the cloud. Returns the executed result ({...,routed:true,chose}); fail-safe — any miss/empty
  // returns a plain message the front can voice (never throws). `ask` injectable for tests.
  async routeNeed(query, { ask = null, autonomous = false } = {}) {
    const cloudAsk = ask || (() => { try { return require('./cloud_logic').ask; } catch { return null; } })();
    if (!cloudAsk) return { ok: false, kind: 'find', isError: true, routed: false, text: 'cloud router unavailable' };
    if (!this.connected) { await this.connect(); if (!this.connected) return { ok: false, kind: 'find', isError: true, routed: true, text: `Echo isn't connected right now (${this.lastError || 'offline'}). Tell Lucas you couldn't reach it.` }; }
    const c = this.client();
    // 1) Catalog filtered to the need (recipes preferred, then raw tools).
    let recipes = '', tools = '';
    try { recipes = filterRecipes(normalizeToolResult(await c.callTool('list_recipes', {})).text, query, 10); } catch {}
    try { const r = normalizeToolResult(await c.callTool('get_tool_map', { grouping: 'intent' })); tools = r.isError ? '' : filterToolMap(r.text, query, 20); } catch {}
    if (!recipes && !tools) return { ok: false, kind: 'find', isError: true, routed: true, text: `No Echo recipe or tool matched "${query}".` };
    // 2) PASS 1 — the Reasoner picks the single best recipe/tool.
    const pick = await cloudAsk({
      task: 'echo_pick', v: 1,
      input: { need: query, recipes, tools },
      want: 'Pick the SINGLE best way to satisfy the need from the catalog. Prefer a recipe. Output ONLY JSON: {"type":"recipe"|"tool"|"none","name":"exact name from the catalog","arg":"the one plain arg, only for a recipe","reason":"short"}. Use "none" only if nothing fits.',
      validate: (raw) => { const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return { valid: false, error: 'no json' }; try { const o = JSON.parse(m[0]); return o && o.type ? { valid: true, value: o } : { valid: false, error: 'no type' }; } catch (e) { return { valid: false, error: e.message }; } }
    });
    if (!pick || pick.type === 'none' || !pick.name) {
      return { ok: false, kind: 'find', isError: false, routed: true, text: `I looked for an Echo tool for "${query}" but nothing fit${pick && pick.reason ? ` (${pick.reason})` : ''}. Tell Lucas, or this may be an open-web question.` };
    }
    // 3a) Recipe → run directly (one plain arg). Recipes are curated read/compile procedures → allowed
    // even on the autonomous loop.
    if (pick.type === 'recipe') {
      const res = await this.dispatch({ kind: 'recipe', name: pick.name, arg: pick.arg || null }, { autonomous });
      return { ...res, kind: 'find', routed: true, chose: `recipe ${pick.name}` };
    }
    // 3b) Tool → TIER GATE first (the auto loop reads but never writes/spawns via a cloud-picked tool),
    // then fetch its schema + PASS 2 to write args.
    try {
      const tier = require('./echo_tier');
      const pol = tier.policyFor(pick.name, { autonomous });
      if (!pol.allow) {
        console.log(`[echo] routeNeed tier-gate BLOCKED ${pick.name} (${pol.tier}, autonomous=${autonomous})`);
        return { ok: false, kind: 'find', isError: true, blocked: true, routed: true, text: `The best Echo match for "${query}" is "${pick.name}", a ${pol.tier} action — ${pol.reason}. ${autonomous ? 'On the autonomous loop you may READ from Echo but not write/spawn — note it for Lucas instead of doing it unattended.' : 'That one is off by design.'}` };
      }
    } catch (e) { console.error('[echo] routeNeed tier-gate failed (allowing):', e.message); }
    let schema = '';
    try { schema = normalizeToolResult(await c.callTool('describe_tool', { name: pick.name })).text; } catch {}
    const argObj = await cloudAsk({
      task: 'echo_args', v: 1,
      input: { need: query, tool: pick.name, schema: cap(schema, 1800) },
      want: `Write the JSON arguments object for the tool "${pick.name}" to satisfy the need, matching its schema. Output ONLY a JSON object (e.g. {"query":"..."}). Use {} if it takes no args.`,
      validate: (raw) => { const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return { valid: false, error: 'no json' }; try { return { valid: true, value: JSON.parse(m[0]) }; } catch (e) { return { valid: false, error: e.message }; } }
    });
    const args = (argObj && typeof argObj === 'object') ? argObj : {};
    const res = await this.dispatch({ kind: 'do', name: pick.name, args }, { autonomous });
    return { ...res, kind: 'find', routed: true, chose: `tool ${pick.name}` };
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

// ---------- session singleton (the LIVE wiring) ----------
// main.js already creates + connects ONE EchoSuit at boot (engine adopt/spawn + status light +
// 60s reattach). It registers that SAME instance here via setLiveSuit, so automatic recall reuses
// the live connection instead of opening a competing one. All fail-safe: never throws.
let _live = null;
function setLiveSuit(suit) { _live = suit; }
function liveReady() { return !!_live && _live.connected; }
function liveStatus() { return _live ? _live.status() : { connected: false }; }

// READ recall for active database integration: "what does the master DB know about X?" via
// search_knowledge (FTS corpora), normalized to {source:'echo:<corpus>', content, rank}. Fail-safe [].
async function recallKnowledge(query, { topK = 6 } = {}) {
  if (!liveReady()) return [];
  try {
    const r = await _live.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: String(query || ''), top_k: topK } });
    if (!r || !r.ok) return [];
    let data; try { data = JSON.parse(r.text); } catch { return []; }
    const rows = Array.isArray(data && data.result) ? data.result : (Array.isArray(data) ? data : []);
    return rows.map(h => ({
      source: 'echo:' + (h.source || 'kb'),
      content: String(h.snippet || h.text || h.content || '').replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim(),
      rank: h.rank
    })).filter(h => h.content.length > 1);
  } catch { return []; }
}

// OBJECT recall — the Echo-search-FIRST move (object-memory architecture, Slice 1). Resolve a name
// to its canonical Echo entity and pull the WHOLE object in one cheap call, instead of re-deriving
// what we already hold. quick_lookup is the resolver: it returns the RICH record's full dossier
// (facts + bio + committees + role + degree), not a naive name match — the Curtis proof: get_entity
// exact-matched a degree-1 stub, quick_lookup resolved the degree-320 Senator with his whole bio.
// kg_neighborhood adds bounded background concepts (fail-soft — the Wikipedia sidecar is often
// unanchored → empty). Fully defensive; any miss → null. `dispatch` injectable for offline tests.
const OBJ_RICH_DEGREE = 8;   // a base resolution below this is "thin" → sweep types for a richer record
async function recallObject(name, { maxNeighbors = 8, preferType = null, dispatch = null } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  if (!d) return null;
  const n = String(name || '').trim();
  if (!n) return null;
  // RESOLUTION. quick_lookup ranks by FTS text match, NOT degree — so a bare "John Curtis" resolves
  // to a degree-1 bill titled "…John Curtis…" over the degree-320 Senator. Fix (generic, not per-case):
  // if the caller knows the type, trust it (one call). Otherwise do a DEGREE-AWARE resolve — base
  // lookup, and only if it's thin, sweep the dossier-bearing types and KEEP THE RICHEST record.
  let best = await _lookupObject(d, n, preferType);
  if (!preferType && (!best || best.degree < OBJ_RICH_DEGREE)) {
    for (const t of ['person', 'organization']) {
      const alt = await _lookupObject(d, n, t);
      if (alt && (!best || alt.degree > best.degree)) best = alt;
    }
  }
  if (!best) return null;
  // SAME-ENTITY CANONICALIZATION (duplicate-QID fix) — quick_lookup's FTS pick can return a THIN duplicate
  // over the canonical rich record (Donald Trump's degree-3 "mayor" twin vs his degree-13 "President"
  // record — same wikidata QID, never merged; the type-sweep above is BLIND to this since both are
  // 'person'). If the resolved record is thin but carries a QID, pull the RICHEST record sharing that QID
  // (exact identity — QID covers 100% of the duplicate groups here vs SAME_AS's ~75%). Only runs on a
  // thin base result, so clean hits pay nothing.
  if (best.degree < OBJ_RICH_DEGREE && best.wikidata_qid) {
    try { const richer = await _richestByQid(d, best.wikidata_qid, best); if (richer) best = richer; } catch {}
  }
  // bounded neighborhood — degree-capped background (open decision #2: can't pull all 320 edges).
  if (maxNeighbors > 0 && best.id) {
    try {
      const kr = await d({ kind: 'do', name: 'kg_neighborhood', args: { entity_id: best.id, top_k: maxNeighbors } });
      if (kr && kr.ok) { let kd; try { kd = JSON.parse(kr.text); } catch {} if (kd) best.neighbors = normalizeNeighbors(kd); }
    } catch {}
  }
  return best;
}
// One quick_lookup → normalized object (or null). Fail-soft on transport/JSON errors.
async function _lookupObject(d, name, preferType) {
  let r; try { r = await d({ kind: 'do', name: 'quick_lookup', args: preferType ? { name, prefer_type: preferType } : { name } }); } catch { return null; }
  if (!r || !r.ok) return null;
  let data; try { data = JSON.parse(r.text); } catch { return null; }
  return normalizeObject(data && (data.result || data));
}

// Among all records sharing this wikidata QID (i.e. the SAME real-world entity), pull the RICHEST one's
// full object — the duplicate-resolution fix. db_query gives id/name/degree in one exact call; we then
// quick_lookup the winner by name for its full dossier. Returns null (keep the base) if there's no
// strictly-richer sibling or the pull doesn't beat what we already had. Fail-soft on any transport error.
async function _richestByQid(d, qid, best) {
  if (!qid) return null;
  let r;
  try { r = await d({ kind: 'do', name: 'db_query', args: { sql: 'SELECT id, name, degree FROM entities WHERE wikidata_qid = ? AND id != ? ORDER BY degree DESC LIMIT 1', params: [qid, best.id || 0] } }); }
  catch { return null; }
  if (!r || !r.ok) return null;
  let rows; try { const j = JSON.parse(r.text); rows = (j && j.rows) || j; } catch { return null; }
  const top = Array.isArray(rows) ? rows[0] : null;
  if (!top || (Number(top.degree) || 0) <= (best.degree || 0)) return null;   // no strictly-richer twin
  const obj = await _lookupObject(d, top.name, best.type);                     // pull the winner's full dossier
  return (obj && (obj.degree || 0) > (best.degree || 0)) ? obj : null;
}

// Pure: quick_lookup's `.result` → a flat, render-ready object. facts already carry the attributes
// ("Curtis — title: U.S. Senator"); committee names are usually "(unnamed)" so the role is what
// matters (dedup them). Keeps the raw bio for structured access.
function normalizeObject(res) {
  if (!res || typeof res !== 'object') return null;
  const ent = res.entity || {};
  if (!ent.id && !ent.name) return null;
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const facts = (Array.isArray(res.facts) ? res.facts : []).map(f => clean(f && f.text)).filter(Boolean);
  const seen = new Set(); const committees = [];
  for (const c of (Array.isArray(res.committees) ? res.committees : [])) {
    const nm = c && c.name && c.name !== '(unnamed)' ? clean(c.name) : '';
    const role = clean(c && c.role);
    const s = nm ? `${nm}${role ? ` (${role})` : ''}` : role;
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); committees.push(s); }
  }
  return {
    id: ent.id || null, name: clean(ent.name), type: ent.entity_type || null, subtype: ent.entity_subtype || null,
    degree: Number(ent.degree) || 0, role: clean(res.role) || null, citation: clean(res.citation) || null,
    wikidata_qid: clean(ent.wikidata_qid) || null,   // canonical identity — drives duplicate-QID resolution
    facts, committees, bio: (res.bio && typeof res.bio === 'object') ? res.bio : null, neighbors: []
  };
}

// RESOLVE a mention to a decision: resolved | ambiguous | nil (Slice 2b — resolve-before-decompose).
// Candidate scan via search_entities (cheap, one call), then: 0 candidates → nil; >1 DISTINCT same-type
// entity (names that aren't near-dupes of each other) → ambiguous (trip the NIL "which X?" branch —
// bias-toward-clarifying: we ASK rather than guess between different real entities); a single distinct
// entity (even across several duplicate records) → pull its object via recallObject. Fail-soft. Coherence
// note: preferType comes from the whole-utterance parse — that IS the primary coherence signal; full
// candidate-ranking against sibling mentions is a later refinement.
async function resolveMention(name, { preferType = null, dispatch = null } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const n = String(name || '').trim();
  if (!d) return { status: 'error', mention: n };
  if (!n) return { status: 'nil', mention: n, reason: 'empty' };
  // Strip honorifics before hitting Echo — "Sen. Curtis" as a raw FTS query matches nothing (no entity
  // name carries "sen"); the search must run on the actual name tokens.
  const q = _cleanMention(n);
  const cands = await _searchEntities(d, q, preferType);
  if (!cands.length) return { status: 'nil', mention: n, reason: 'no-match' };
  // NAME-GATE: search_entities also matches on SUMMARIES, so it drags in tangential people (a staffer
  // whose bio names the target). Keep only candidates whose NAME actually carries the query's core tokens.
  const gated = _nameGate(cands, _coreNameKey(q));
  const distinct = _distinctNames(gated);
  // >1 genuinely-different name (not dup records / initial variants) → ambiguous → ASK (bias-to-clarify).
  if (distinct.length > 1) return { status: 'ambiguous', mention: n, candidates: distinct.slice(0, 4).map(c => c.name) };
  const obj = await recallObject(q, { preferType, dispatch: d });
  if (!obj) return { status: 'nil', mention: n, reason: 'no-object' };
  // Resolve ONLY when a record genuinely DOMINATES (rich object). Several thin same-name records with no
  // clear winner = we can't safely pick → ask rather than popularity-guess (the overshadowing trap).
  const dominant = obj.degree >= 8 || (obj.facts || []).length >= 4 || (obj.committees || []).length >= 1;
  if (!dominant) return { status: 'ambiguous', mention: n, reason: 'low-confidence', candidates: distinct.map(c => c.name) };
  return { status: 'resolved', mention: n, object: obj };
}
async function _searchEntities(d, name, preferType) {
  const args = { query: name, top_k: 10 };
  if (preferType) args.entity_type = preferType;
  let r; try { r = await d({ kind: 'do', name: 'search_entities', args }); } catch { return []; }
  if (!r || !r.ok) return [];
  let data; try { data = JSON.parse(r.text); } catch { return []; }
  const rows = Array.isArray(data && data.result) ? data.result : (Array.isArray(data) ? data : []);
  return rows.map(e => ({ id: e.id, name: String(e.name || ''), entity_type: e.entity_type, rank: e.rank })).filter(e => e.name);
}
// Pure: collapse a candidate list to DISTINCT entities by a normalized core-name key — so the many
// duplicate records of one entity ("John Curtis (US)", "John Curtis (US-US)", "CURTIS, JOHN [S4UT00282]")
// count ONCE, while genuinely different names ("John Curtis Marion") count separately.
const _NAME_TITLES = new Set(['sen', 'senator', 'rep', 'representative', 'dr', 'mr', 'mrs', 'ms', 'hon', 'honorable', 'gov', 'governor', 'pres', 'president']);
function _coreNameKey(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');   // strip paren/bracket qualifiers + IDs
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  // drop id-like tokens (any digit), single letters (middle initials — "John R. Curtis" == "John Curtis"),
  // and honorifics ("Sen. Curtis" == "Curtis").
  const toks = s.split(/\s+/).filter(t => t && t.length > 1 && !/\d/.test(t) && !_NAME_TITLES.has(t));
  return toks.sort().join(' ').trim();
}
function _distinctNames(cands) {
  const seen = new Map();
  for (const c of cands) { const k = _coreNameKey(c.name) || String(c.name || '').toLowerCase(); if (!seen.has(k)) seen.set(k, c); }
  return [...seen.values()];
}
// Strip honorifics/titles from a mention so the search runs on real name tokens ("Sen. John Curtis" →
// "John Curtis"). Falls back to the original if stripping empties it.
function _cleanMention(name) {
  const toks = String(name || '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean).filter(t => !_NAME_TITLES.has(t.toLowerCase()));
  return toks.join(' ').trim() || String(name || '').trim();
}
// Keep only candidates whose NAME carries every core token of the query (drops summary-only FTS matches).
// Falls back to the raw list if the gate removes everything (never leave the caller empty-handed).
function _nameGate(cands, queryKey) {
  const q = String(queryKey || '').split(' ').filter(Boolean);
  if (!q.length) return cands;
  const named = cands.filter(c => { const ck = _coreNameKey(c.name).split(' '); return q.every(t => ck.includes(t)); });
  return named.length ? named : cands;
}

// Pure: kg_neighborhood's `.neighbors` → capped name strings (background concepts).
function normalizeNeighbors(kd) {
  const ns = Array.isArray(kd && kd.neighbors) ? kd.neighbors : [];
  const out = [];
  for (const n of ns) {
    const s = typeof n === 'string' ? n : (n && (n.name || n.title || n.target_name || n.label));
    const c = String(s || '').replace(/\s+/g, ' ').trim();
    if (c) out.push(c);
    if (out.length >= 12) break;
  }
  return out;
}

// test seam: inject a fake connected suit
function _setLiveForTest(suit) { _live = suit; }

// Generic dispatch to ANY Echo tool via the live suit — the graph-builder needs kg_neighborhood /
// propose_entity / propose_relation / web_search / the data tools, not just the wrapped recalls.
// Returns the raw normalized {ok,text,isError} (null when Echo isn't connected). Fail-soft.
async function dispatch(tag, opts) {
  if (!liveReady()) return null;
  try { return await _live.dispatch(tag, opts); } catch { return null; }
}
function liveDispatch() { return liveReady() ? (tag) => _live.dispatch(tag) : null; }

module.exports = {
  EchoSuit, createSuit, parseEchoTags, parseArgs, stripEchoTags, normalizeToolResult, resultText, filterToolMap, buildRecipeMenu, filterRecipes, echoCloudRouteEnabled,
  setLiveSuit, liveReady, liveStatus, recallKnowledge, recallObject, resolveMention, normalizeObject, normalizeNeighbors, dispatch, liveDispatch, _coreNameKey, _distinctNames, _nameGate, _cleanMention, _setLiveForTest
};
