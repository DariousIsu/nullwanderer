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
const kga = require('./kg_activity');   // kg:activity push bus — match.hit recognition arc (Slice 2b)

const cap = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));
// A tool call that failed on ARGS (not data) — worth one corrected retry in routeNeed.
const ARG_ERR_RE = /unexpected keyword|validation error|field required|missing .*argument|not a valid|invalid argument|no such (?:column|table)|required (?:property|argument)/i;

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
  // ROUTE OBSERVATION (memory path mapping, P0) — a thin recording wrapper around the real
  // dispatch. This is the ONE place every Echo call funnels through, which is why the log lives
  // here: an audit found five separate traversal mechanisms (relatedEntities, idle_anchors' own raw
  // 1+2-hop JOINs, kg_neighborhood, get_entity.relations, query_graph), and instrumenting any single
  // one of them would have captured about a third of the traffic. Wrapping (rather than editing the
  // body) also means the throw path gets recorded too — a transport failure is data.
  // Fail-soft and flag-gated (`route.obs` meta, default OFF): observation must never be able to
  // break a research call, so record() swallows everything.
  async dispatch(tag, opts = {}) {
    const _t0 = Date.now();
    let _res = null;
    try {
      _res = await this._maybeMemoized(tag, opts);
      return _res;
    } catch (e) {
      _res = { ok: false, isError: true, text: String((e && e.message) || e) };
      throw e;
    } finally {
      try {
        // `autonomous` falls back to the AMBIENT LANE (lib/lane.js) when the caller didn't pass one.
        // The operator's tools are invoked from a module-level map with no knowledge of their run,
        // so opts.autonomous was unset on ~98% of calls and the flag was very nearly a constant.
        //
        // ⚠️ LABELLING ONLY — deliberately NOT applied to the tier gate in _dispatchRaw, which reads
        // opts.autonomous to BLOCK writes on the unattended loop. Because the flag never propagated,
        // background research has in fact been writing freely (~5,900 proposals/day). Making the gate
        // ambient would start enforcing a rule that has never actually been in force and would stop
        // the autonomic ingest pipeline dead. That is a policy decision for Lucas, not a gap fix.
        require('./route_obs').record(tag, _res, {
          latencyMs: Date.now() - _t0,
          focusId: opts.focusId || null,
          autonomous: require('./lane').isAutonomous(opts.autonomous === undefined ? undefined : !!opts.autonomous),
        });
      } catch { /* never let observation break dispatch */ }
    }
  }

  // SHORT-TTL RESULT MEMO (flag `route.memo`, default OFF). Sits ABOVE coalescing because a memo
  // hit costs no call at all, where coalescing still waits on one in flight. The observation log
  // measured 56% of hashed calls as exact repeats — 2,892 min/day — WITH coalescing already on,
  // because those duplicates are sequential rather than concurrent. See lib/memo.js for the
  // safety rules (reads only, errors never stored, name-scoped invalidation, not persisted).
  //
  // A memo hit still records a route observation, with its true near-zero latency. That is
  // deliberate: the duplicate COUNT stays visible while its COST collapses, which is exactly the
  // shape the P2 utility gate needs to read.
  async _maybeMemoized(tag, opts) {
    let on = false;
    try { on = require('./db').getMeta('route.memo') === '1'; } catch { on = false; }
    if (!on || !tag) return this._maybeCoalesced(tag, opts);
    let mem, memo;
    try {
      mem = require('./memo');
      if (!this._memo) {
        const ro = require('./route_obs');
        // same hashing as the observation log and the coalescer, so measured duplicate rate and
        // achieved memo rate describe the same notion of "same question" and compare directly
        let ttl; try { ttl = Number(require('./db').getMeta('route.memo.ttl_ms')) || undefined; } catch {}
        this._memo = mem.createMemo({ hashFn: (a) => ro.argHash(a), ttlMs: ttl });
      }
      memo = this._memo;
    } catch { return this._maybeCoalesced(tag, opts); }

    // WRITES — run first, then drop whatever the write touched. Ordering matters: invalidating
    // before the call would leave a window where a concurrent read re-caches the pre-write answer.
    const writeName = tag.kind === 'do' ? tag.name
      : tag.kind === 'propose' ? 'propose_' + tag.proposeKind : null;
    if (writeName && mem.isInvalidatingWrite(writeName)) {
      const res = await this._maybeCoalesced(tag, opts);
      // a `do` tag carries its arguments on .args, but an <echo-propose> tag carries them on
      // .payload — reading only .args silently invalidated nothing for every proposal she makes
      // through the tag syntax, which is the exact path the staleness guard exists to cover.
      try { if (res && !res.isError && res.ok !== false) memo.invalidate(mem.writeArgsOf(tag)); } catch {}
      return res;
    }

    if (tag.kind !== 'do' || !mem.isMemoizable(tag.name)) return this._maybeCoalesced(tag, opts);
    const args = tag.args || {};
    const hit = memo.get(tag.name, args);
    // shallow copy so a caller that annotates the result can never write back into the cache
    if (hit) return { ...hit };
    const t0 = Date.now();
    const res = await this._maybeCoalesced(tag, opts);
    try { memo.put(tag.name, args, res, Date.now() - t0); } catch { /* caching must never break a call */ }
    return res;
  }

  // IN-FLIGHT COALESCING (flag `route.coalesce`, default OFF). The observation log measured 578
  // identical questions asked within 2s of each other costing 1,986s of engine time — 496 of them
  // interleaved with other calls and 259 within 100ms, which is research.workers=2 racing rather
  // than any retry loop. When two identical READS are in flight, they share one call. Reads only;
  // see lib/coalesce.js for why writes must never be collapsed.
  _maybeCoalesced(tag, opts) {
    let on = false;
    try { on = require('./db').getMeta('route.coalesce') === '1'; } catch { on = false; }
    if (!on || !tag || tag.kind !== 'do') return this._dispatchRaw(tag, opts);
    try {
      const coalesce = require('./coalesce');
      if (!coalesce.isCoalescable(tag.name)) return this._dispatchRaw(tag, opts);
      if (!this._coalescer) {
        const ro = require('./route_obs');
        // same hashing as the observation log, so the measured duplicate rate and the achieved
        // coalesce rate describe the same notion of "same question" and can be compared directly
        this._coalescer = coalesce.createCoalescer({ hashFn: (a) => ro.argHash(a) });
      }
      return this._coalescer.run(tag.name, tag.args || {}, () => this._dispatchRaw(tag, opts));
    } catch { return this._dispatchRaw(tag, opts); }   // any failure here → plain dispatch
  }

  async _dispatchRaw(tag, opts = {}) {
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
      want: 'Pick the SINGLE best way to satisfy the need from the catalog. Prefer a recipe. Output ONLY JSON: {"type":"recipe"|"tool"|"none","name":"exact name from the catalog","arg":"the one plain arg, only for a recipe","reason":"short"}. Use "none" when nothing GENUINELY fits — INCLUDING when the need is an open-web / general-knowledge / current-news question rather than OUR own private structured data (the caller falls back to web + vision for those). Do NOT force a CRM/list/summary tool onto a question it does not actually answer.',
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
    let args = (argObj && typeof argObj === 'object') ? argObj : {};
    let res = await this.dispatch({ kind: 'do', name: pick.name, args }, { autonomous });
    // ARG-VALIDATION RETRY — the cloud often writes args that violate the tool schema (a `query` key on a
    // tool that doesn't take one → pydantic "unexpected keyword argument"; a db_query on a hallucinated
    // table). Feed the error back ONCE and let it correct the args, then re-run — turning a hard miss into a
    // working lookup. Bounded to a single retry; fail-soft.
    if (res && ARG_ERR_RE.test(String(res.text || ''))) {
      try {
        const fixed = await cloudAsk({
          task: 'echo_args_fix', v: 1,
          input: { need: query, tool: pick.name, schema: cap(schema, 1800), bad_args: JSON.stringify(args).slice(0, 400), error: String(res.text || '').slice(0, 300) },
          want: `The previous arguments for "${pick.name}" FAILED with the error shown. Output a CORRECTED JSON arguments object matching the schema EXACTLY — use ONLY keys the schema defines, drop any it doesn't, and fix any bad value (e.g. a wrong table/column name). Output ONLY the JSON object.`,
          validate: (raw) => { const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return { valid: false, error: 'no json' }; try { return { valid: true, value: JSON.parse(m[0]) }; } catch (e) { return { valid: false, error: e.message }; } }
        });
        if (fixed && typeof fixed === 'object') { args = fixed; res = await this.dispatch({ kind: 'do', name: pick.name, args }, { autonomous }); }
      } catch {}
    }
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
// Neighbors come from OUR OWN relations table (see the maxNeighbors block below for why kg_neighborhood
// no longer feeds this). Fully defensive; any miss → null. `dispatch` injectable for offline tests.
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
  // SEARCH FALLBACK — quick_lookup resolves against the STORED name form, so a caller's name that matches
  // no stored form ("Lee Zeldin" vs stored "Lee M. Zeldin (US-US)" / "ZELDIN, LEE MICHAEL") dead-ends to
  // null even though the entity plainly exists (search_entities finds it). Recover it via the candidate
  // scan → pull the richest by its EXACT stored name. Only fires when quick_lookup left us empty/thin, so
  // rich direct hits pay nothing. The instance-blind-resolution fix (the null that made "what does Lee do?"
  // confabulate). Bias-to-clarify preserved: _resolveViaSearch declines when candidates are DIFFERENT people.
  if (!best || best.degree < OBJ_RICH_DEGREE) {
    try { const viaSearch = await _resolveViaSearch(d, n, preferType); if (viaSearch && (!best || (viaSearch.degree || 0) > (best.degree || 0))) best = viaSearch; } catch {}
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
  //
  // SOURCE CHANGED (2026-07-19) from kg_neighborhood to our own `relations` table. kg_neighborhood
  // reads the Wikipedia/CourtListener SIDECAR, which is a different id space from civic_graph and is
  // unanchored for essentially everything we hold: the route observation log measured 2,982 calls in
  // 24h returning EMPTY 91% of the time, and the P1 derivation found it as the tail of 7 of the 10
  // most futile chains in the system. It is not "often unanchored", it is structurally absent —
  // Michael J. Madigan, the highest-degree person in the entire graph (12,107 edges), returns
  // `{anchors:[],neighbors:[]}`. Three other call sites had already discovered this and routed around
  // it (cognition.js, resolution_live.js, and relatedEntities' own header); this closes the last one.
  //
  // relatedEntities walks the REAL edges for the same cost, so this is latency-neutral and turns an
  // empty field into a populated one — every consumer of `.neighbors` (active_recall's "related:"
  // line, cognition's neighbourNames, graph_walk) has been reading [] for these nodes.
  if (maxNeighbors > 0 && best.id) {
    try {
      const rel = await relatedEntities(best.id, { dispatch: d, limit: maxNeighbors });
      const names = [];
      for (const r of rel) { const n = String((r && r.name) || '').trim(); if (n && !names.includes(n)) names.push(n); }
      if (names.length) best.neighbors = names;
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
// SEARCH-based resolution — the fallback when quick_lookup can't match the caller's name form to a stored
// one. search_entities surfaces the entity's (often duplicate) records; name-gate drops summary-only FTS
// matches; then pull the RICHEST candidate's full object by its exact stored name (which quick_lookup DOES
// resolve). Bias-to-clarify: if the gated candidates are GENUINELY DIFFERENT people (>1 distinct core
// name), decline — don't popularity-guess; leave arbitration to the ambiguity/enrich path. Bounded to a
// few candidate pulls. Returns the richest object, or null. Fail-soft.
async function _resolveViaSearch(d, name, preferType) {
  const cands = await _searchEntities(d, name, preferType);
  if (!cands.length) return null;
  const gated = _nameGate(cands, _coreNameKey(name));
  const pool = gated.length ? gated : cands;
  if (!_sameEntity(pool)) return null;   // genuinely different same-named people → don't guess, leave to ask/enrich
  let best = null;
  for (const c of pool.slice(0, 4)) {
    if (!c || !c.name) continue;
    const obj = await _lookupObject(d, c.name, preferType || c.entity_type || null);
    if (obj && (!best || (obj.degree || 0) > (best.degree || 0))) best = obj;
  }
  return best;
}

// GRAPH TRAVERSAL via the `relations` table — kg_neighborhood returns EMPTY for these nodes, but the REAL
// edges live here (a person can have thousands). Walk an entity's edges to the connected objects, joining
// `entities` for names, and pull role/tenure out of relation_metadata. The model is office-centric: a
// person HELD_OFFICE → an OFFICE node with tenure_start/tenure_end (end=null ⇒ CURRENT). So this is what
// makes "his cabinet / their titles / X's current role" actually flow across the graph. Fail-soft → [].
const _SAFE_ID = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };
async function relatedEntities(entityId, { dispatch = null, limit = 30, relTypes = null } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const id = _SAFE_ID(entityId);
  if (!d || !id) return [];
  let typeFilter = '';
  if (relTypes && relTypes.length) { const safe = relTypes.map(t => String(t).replace(/[^A-Z_]/gi, '')).filter(Boolean); if (safe.length) typeFilter = ` AND r.relation_type IN (${safe.map(t => `'${t}'`).join(',')})`; }
  const sql = `SELECT r.relation_type rt, r.relation_metadata md, r.confidence conf, r.created_at cat, r.valid_from vf, r.valid_to vt, e.id id, e.name nm, e.entity_type et, e.entity_subtype est`
    + ` FROM relations r JOIN entities e ON e.id = (CASE WHEN r.source_id=${id} THEN r.target_id ELSE r.source_id END)`
    + ` WHERE (r.source_id=${id} OR r.target_id=${id}) AND r.deleted=0 AND r.tx_to IS NULL${typeFilter} ORDER BY r.confidence DESC LIMIT ${_SAFE_ID(limit) || 30}`;
  let rows = [];
  try { const r = await d({ kind: 'do', name: 'db_query', args: { sql } }); const j = JSON.parse(r.text); rows = (j && j.rows) || []; } catch {}
  return rows.map(x => {
    let md = {}; try { md = JSON.parse(x.md || '{}'); } catch {}
    const until = md.tenure_end || md.end_date || null;
    return {
      id: x.id, name: String(x.nm || ''), type: x.et || null, subtype: x.est || null,
      relation: x.rt || null, role: md.role_type || md.role || null,
      since: md.tenure_start || md.start_date || null, until, current: !until,
      // decay + termination inputs (confidence engine): the edge's own confidence + system-time age
      // basis (created_at, unix SECONDS) + world-time validity window. valid_to / tenure_end that has
      // passed is a PREDETERMINED TERMINATION (the nightly pass's business, not gradual decay).
      confidence: x.conf == null ? null : Number(x.conf),
      createdAt: x.cat == null ? null : Number(x.cat),
      validFrom: x.vf == null ? null : Number(x.vf),
      validTo: x.vt == null ? null : Number(x.vt),
    };
  }).filter(x => x.name);
}

// OFFICE-HOLDER resolution — "who is Trump's Secretary of State / the current EPA administrator" maps to the
// CURRENT holder of that office (the office-centric model). Resolve the office name → its OFFICE node →
// people who HELD_OFFICE it, current first. Returns [{ name, since, until, current }]. Fail-soft → [].
async function officeHolders(office, { dispatch = null, currentOnly = true, top = 3 } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const q = String(office || '').replace(/^.*\b(?:the\s+)?(secretary|administrator|director|chair|chancellor|minister|president|governor|mayor|justice|ambassador|attorney general|speaker)\b/i, '$1').trim() || String(office || '').trim();
  if (!d || !q) return [];
  const cands = await _searchEntities(d, q, null);
  // an OFFICE node's name IS the office title (e.g. "United States Secretary of State [wd:Q14213]")
  const office_ = cands.find(c => /office|position|Q\d/i.test(c.name) || _coreNameKey(c.name).includes(_coreNameKey(q).split(' ').pop()));
  const target = office_ || cands[0];
  if (!target || !target.id) return [];
  const holders = (await relatedEntities(target.id, { dispatch: d, relTypes: ['HELD_OFFICE'], limit: 20 }))
    .filter(h => !currentOnly || h.current)
    .sort((a, b) => String(b.since || '').localeCompare(String(a.since || '')));
  return holders.slice(0, top).map(h => ({ name: h.name, since: h.since, until: h.until, current: h.current, office: target.name }));
}
// Are these name-gated candidates all plausibly the SAME person? After the gate each core-name key already
// carries every query token, so the only divergence is EXTRA tokens (middle names / suffixes). Same person
// = the extras form a subset chain ("Lee Zeldin" ⊆ "Lee Michael Zeldin"); DIFFERENT people carry
// incompatible extras ("John Adam Smith" vs "John Robert Smith" — neither contains the other). Pure.
function _sameEntity(cands) {
  const keys = [...new Set((cands || []).map(c => _coreNameKey(c && c.name)).filter(Boolean))];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = keys[i].split(' '), b = keys[j].split(' ');
    if (!a.every(t => b.includes(t)) && !b.every(t => a.includes(t))) return false;   // incompatible → different people
  }
  return true;
}

// RELEVANCE GATE — is this resolved object a LEGITIMATE match for what was asked, or FTS junk? The diverse
// battery proved the resolver lights up off-topic records: a Florida bill (HB 4635) for "Cuban Missile
// Crisis", "HISPANIC HERITAGE FOUNDATION" (a lobby client) for "Heritage Foundation", "AH DEFENSE LLC" for
// "Secretary of Defense", "CALIFORNIA STATE SENATE" for "US Senate". Mostly MASKED (the cloud ignores junk
// grounding) but fragile + occasionally fatal (junk poisons the recovery topic). Gate by TYPE:
//   • bills / legislation / documents: their canonical name is a number/ID and they match on TITLE/summary,
//     so trust the resolve — "Inflation Reduction Act" → HR 5376 is CORRECT (a naive name-gate wrongly kills
//     it). This is the carve-out that makes the gate safe.
//   • person: the object may carry EXTRA name tokens (middle names) → mention ⊆ object (or ⊇) is fine
//     ("Lee Zeldin" resolving "Lee Michael Zeldin").
//   • org / place / everything else: require the SAME core name — drops the "Hispanic …" superset and the
//     "AH DEFENSE LLC …" / "CALIFORNIA STATE …" qualifier-junk that merely CONTAINS the query tokens.
// Rejecting junk → the object becomes ∅ → the cloud/wiki answers cleanly (and deterministically). Pure.
const _BILLISH_RE = /bill|legislation|resolution|statute|\blaw\b|document|ordinance|act\b/i;
// A BARE OFFICE/ROLE TITLE ("president", "the president", "the CEO", "governor", "attorney general") is NOT an
// entity reference — it's a CURRENT-OFFICE-HOLDER question, and it must NEVER resolve to a same-named junk
// PERSON record: "who's the president?" lit up "THE PRESIDENT" (a Wisconsin city councilmember) → a confidently
// wrong answer; "president now" lit up "PRESIDENT QUINCI" (a PR candidate). These slip `_coreNameKey` because
// it strips title words → an empty/degenerate key the name-gate then waves through. Detect the bare-title
// mention and REJECT the resolve → object ∅ → the turn drafts a NEED → the recovery ladder finds the CURRENT
// holder from a fresh source (proven reliable). A QUALIFIED office ("governor of Texas", "president of
// Microsoft") keeps a non-title token, so it is NOT caught — only the generic-title junk magnet is. Pure.
const _OFFICE_STOP = new Set(['the', 'a', 'an', 'current', 'currently', 'sitting', 'incumbent', 'present', 'new', 'us', 'u', 's', 'usa', 'american', 'united', 'states', 'state', 'of', 'our', 'my', 'your', 'who', 'is', 'now', 'today', 'this', 'that', 'country', 'nation']);
const _OFFICE_WORD = new Set(['president', 'vice', 'vp', 'potus', 'flotus', 'governor', 'gov', 'senator', 'sen', 'congressman', 'congresswoman', 'congressperson', 'representative', 'rep', 'mayor', 'secretary', 'attorney', 'general', 'prime', 'minister', 'premier', 'chancellor', 'chair', 'chairman', 'chairwoman', 'chairperson', 'ceo', 'cfo', 'cto', 'coo', 'director', 'administrator', 'pope', 'king', 'queen', 'monarch', 'emperor', 'ambassador', 'speaker', 'justice', 'commissioner', 'treasurer', 'comptroller', 'sheriff', 'taoiseach']);
function _isBareOfficeTitle(mention) {
  const toks = String(mention || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const content = toks.filter(t => !_OFFICE_STOP.has(t));
  if (!content.length) return false;                 // nothing but stopwords → let other logic handle it
  return content.every(t => _OFFICE_WORD.has(t));     // every meaningful token is an office word → bare title
}
function _relevanceGate(mention, obj) {
  if (!obj) return false;
  if (_isBareOfficeTitle(mention)) return false;      // office-title question → never a same-named person; route to recovery
  const typeStr = `${obj.type || ''}/${obj.subtype || ''}`;
  if (_BILLISH_RE.test(typeStr)) return true;                     // bill/doc: matches on title, not name → trust
  const mk = _coreNameKey(mention), ok = _coreNameKey(obj.name);
  if (!mk || !ok) return true;                                    // can't judge names → don't block
  const a = mk.split(' '), b = ok.split(' ');
  const mSubO = a.every(x => b.includes(x)), oSubM = b.every(x => a.includes(x));
  if (/person/i.test(String(obj.type || ''))) return mSubO || oSubM;   // people: allow middle-name variance
  return mSubO && oSubM;                                          // org/place/other: same core name required
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

// GRAPH WALK — follow a resolved object's EDGES to the connected OBJECTS and read each one's key fact
// (its title/role). This is the graph's whole point: Trump's object holds the edges to his cabinet; we
// FOLLOW them to each member's own object → "Marco Rubio — Secretary of State" (which lives in Rubio's
// facts, not Trump's). One cheap quick_lookup per neighbor (no sub-neighborhood). Returns
// [{name, title}], titles-first. Fail-soft → []. Lets a conversation flow across the graph instead of
// re-searching from scratch each turn.
async function expandNeighbors(namesOrObject, { dispatch = null, top = 8 } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const names = Array.isArray(namesOrObject)
    ? namesOrObject
    : (namesOrObject && Array.isArray(namesOrObject.neighbors) ? namesOrObject.neighbors : []);
  if (!d || !names.length) return [];
  const out = [];
  for (const nm of names.slice(0, top)) {
    let title = null;
    try {
      const o = await _lookupObject(d, String(nm), null);   // resolve the neighbor to ITS object (role only)
      if (o) {
        const tf = (o.facts || []).find(f => /—\s*title:/i.test(f));
        title = tf ? tf.replace(/.*—\s*title:\s*/i, '').trim()
              : (o.subtype && !/legacy|target|unknown/i.test(o.subtype) ? o.subtype.replace(/_/g, ' ') : null);
      }
    } catch {}
    if (title) out.push({ name: String(nm), title });   // only connections we actually hold a role for
  }
  return out;
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
// ── CONTEXT-AWARE DISAMBIGUATION (R2) ──────────────────────────────────────────────────────────────────
// When a mention resolves to >1 genuinely-different candidate, the co-occurring entities in the SAME
// document are a disambiguator: the right candidate's Echo signature (summary + neighbor names) overlaps
// the doc's OTHER entities more than the wrong one does. Score each candidate by that overlap; resolve to
// the winner ONLY if it STRICTLY dominates (bias-to-clarify preserved — a tie or all-zero stays ambiguous).
// Pure scoring (offline-testable); the per-candidate fetch is injected via `d`. Fail-soft.

// Overlap score: how many context entities (by core-name key) appear in the candidate's signature text.
function _contextScore(signature, contextKeys) {
  const sig = ' ' + String(signature || '').toLowerCase() + ' ';
  let score = 0;
  for (const key of (contextKeys || [])) {
    const toks = String(key || '').split(' ').filter(Boolean);
    if (toks.length && toks.every(t => sig.includes(t))) score++;
  }
  return score;
}
// Winner iff top score >= 1 AND STRICTLY beats the runner-up (never popularity-guess on a tie/zero).
function _pickByContext(scored) {
  const s = [...(scored || [])].sort((a, b) => b.score - a.score);
  if (s.length && s[0].score >= 1 && (s.length === 1 || s[0].score > s[1].score)) return s[0];
  return null;
}
// A candidate's signature = summary + subtype + neighbor/relation target names (via get_entity), lower-cased.
async function _entitySignature(d, name) {
  let r; try { r = await d({ kind: 'do', name: 'get_entity', args: { name } }); } catch { return ''; }
  if (!r || !r.ok) return '';
  let data; try { data = JSON.parse(r.text); } catch { return ''; }
  const e = (data && (data.result || data)) || {};
  const parts = [e.summary || '', e.entity_subtype || e.subtype || ''];
  const rels = Array.isArray(e.relations) ? e.relations : (Array.isArray(e.neighbors) ? e.neighbors : []);
  for (const rel of rels) parts.push((rel && (rel.target_name || rel.target || rel.name)) || '');
  const dossier = e.knowledge_dossier;
  if (dossier && Array.isArray(dossier.neighbors)) for (const nb of dossier.neighbors) parts.push((typeof nb === 'string' ? nb : (nb && nb.name)) || '');
  return parts.join(' ').toLowerCase();
}
// Pull each candidate's signature, score against the context, return a dominant winner candidate (or null).
// `selfKey` = the query's own core-name key, excluded (a candidate matching the query name is not a signal).
async function _disambiguateByContext(d, distinct, contextNames, selfKey) {
  const contextKeys = [...new Set((contextNames || []).map(_coreNameKey).filter(k => k && k.length > 1 && k !== selfKey))];
  if (!contextKeys.length) return null;
  const scored = [];
  for (const c of (distinct || []).slice(0, 4)) {
    const sig = await _entitySignature(d, c.name);
    scored.push({ cand: c, score: _contextScore(sig, contextKeys) });
  }
  const winner = _pickByContext(scored.map(s => ({ name: s.cand.name, score: s.score })));
  return winner ? ((scored.find(s => s.cand.name === winner.name) || {}).cand || null) : null;
}

// ── STRUCTURAL AFFILIATION RESOLUTION (R3) ─────────────────────────────────────────────────────────────
// A c4 arm + its c3 parent (or a subsidiary, a DBA) are LEGALLY DISTINCT entities but ONE org structurally.
// They must NOT be merged (the legal split matters for compliance) — instead they're kept as separate nodes
// LINKED by an arm→primary affiliation edge. A GENERIC mention ("Rainey Center") then resolves to the
// PRIMARY (the structural head), while an explicit arm mention still lands on the arm. This collapses an
// affiliation cluster the way _distinctNames collapses duplicate records — but across legal entities.
// Two directional conventions for a structural-hierarchy edge (both point across the SAME cluster):
//   ARM→PRIMARY  (source = arm, target = primary): subsidiary_of, affiliate_of, arm_of, division_of, …
//   PRIMARY→ARM  (source = primary, target = arm): parent_of  (Echo's whitelisted org-parent edge)
const _ARM_TO_PRIMARY_RE = /affiliate_of|arm_of|subsidiary_of|dba_of|division_of|chapter_of|c4_of|c3_of/i;
const _PRIMARY_TO_ARM_RE = /^parent_of$/i;

// A candidate's typed OUT relations (via get_entity): [{type, target, direction}].
async function _entityRelations(d, name) {
  let r; try { r = await d({ kind: 'do', name: 'get_entity', args: { name } }); } catch { return []; }
  if (!r || !r.ok) return [];
  let data; try { data = JSON.parse(r.text); } catch { return []; }
  const e = (data && (data.result || data)) || {};
  const rels = Array.isArray(e.relations) ? e.relations : [];
  return rels.map(x => ({
    type: String((x && (x.relation_type || x.type)) || '').toUpperCase(),
    target: String((x && (x.target_name || x.target || x.name)) || ''),
    direction: (x && x.direction) || 'out',
  }));
}
// Among the ORG candidates, find a clean single-head affiliation cluster (every non-primary org is an arm
// pointing to ONE primary). Returns the primary candidate, or null (no cluster / >1 head → stay ambiguous).
// Non-org candidates (same-named events, etc.) are ignored — the org cluster is the referent for a mention
// that names an organization.
async function _affiliatedPrimary(d, distinct) {
  const orgs = (distinct || []).filter(c => /organization/i.test(String(c.entity_type || c.type || ''))).slice(0, 4);
  if (orgs.length < 2) return null;
  const keyOf = c => _coreNameKey(c.name) || String(c.name || '').toLowerCase();
  const byKey = new Map(orgs.map(c => [keyOf(c), c]));
  const armToPrimary = new Map();
  for (const c of orgs) {
    const ck = keyOf(c);
    for (const rel of await _entityRelations(d, c.name)) {
      if (rel.direction === 'in') continue;                    // OUT edges only (avoid double-counting mirrors)
      const tk = _coreNameKey(rel.target);
      if (!byKey.has(tk) || tk === ck) continue;               // the other endpoint must also be a candidate org
      if (_ARM_TO_PRIMARY_RE.test(rel.type)) armToPrimary.set(ck, tk);       // c is the arm, target is primary
      else if (_PRIMARY_TO_ARM_RE.test(rel.type)) armToPrimary.set(tk, ck);  // target is the arm, c is primary
    }
  }
  if (!armToPrimary.size) return null;
  const primaries = new Set([...armToPrimary.values()]);
  if (primaries.size !== 1) return null;                        // >1 candidate head → don't guess
  const primaryKey = [...primaries][0];
  for (const c of orgs) { const k = keyOf(c); if (k === primaryKey) continue; if (armToPrimary.get(k) !== primaryKey) return null; }
  return byKey.get(primaryKey) || null;
}

// ── TYPO-TOLERANT CANDIDATE RECOVERY (R4) ──────────────────────────────────────────────────────────────
// Echo's search is exact-token FTS5 — an extraction typo ("Rainy Center" for "Rainey Center") matches
// NOTHING (validated: search_entities/quick_lookup/find_mentions all miss; no spellfix1 in the DB). So on
// an exact miss we recover candidates ourselves: a TIGHT db_query pool (AND-of-word-boundary-prefixes, one
// per significant query token) filtered by a token-level edit-distance gate. Validated on the real pool for
// "Rainy Center": {Joseph Rainey Center…, RAINEY CENTER FREEDOM PROJECT…} pass; RAINBOW ENERGY CENTER,
// RAINMAKER…, RAIN AND HAIL… are rejected (the "center" token + the 0.8 similarity floor exclude them).
// Damerau-Levenshtein (optimal string alignment): counts an adjacent TRANSPOSITION as ONE edit — the most
// common typo class ("Jerome"→"Jermoe", "Commerce"→"Commrece"). Plain Levenshtein scores those as 2, which
// sank them below the 0.8 similarity floor. Keeps two prior rows for the transposition check.
function _levenshtein(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let pp = null, prev = new Array(n + 1); for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1); cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + cost);
    }
    pp = prev; prev = cur;
  }
  return prev[n];
}
function _tokenSim(a, b) { const L = Math.max(String(a).length, String(b).length); return L ? 1 - _levenshtein(a, b) / L : 1; }
function _sigTokens(name, min = 4) { return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= min); }
// EVERY significant query token must have a candidate token within the similarity floor → a fuzzy match.
function _fuzzyNameMatch(query, candidateName, threshold = 0.8) {
  const qt = _sigTokens(query), ct = _sigTokens(candidateName);
  if (!qt.length || !ct.length) return false;
  return qt.every(q => ct.some(c => _tokenSim(q, c) >= threshold));
}
// Recover fuzzy candidates for a query that exact-missed. The fetch uses a 2-CHAR word-boundary prefix per
// token AND-ed across tokens: a single typo at position ≥2 leaves the 2-char prefix intact, and AND-ing the
// tokens keeps the pool tight (validated: "ve% AND llp%" → 10 rows incl. VENABLE LLP; a 4-char prefix
// FAILED — a mid-token typo like VOGEL→VOEL breaks "Voge"). Fetch tokens are ≥3 chars (so a distinctive
// short suffix like "llp"/"inc" helps narrow); the precision filter (_fuzzyNameMatch, ≥4-char tokens, 0.8
// floor) then rejects the near-misses. Bounded + JS-gated. Fail-soft. NOTE: a typo in the first 2 chars, or
// a single short-token name, can still miss — a fully-universal fix needs a spellfix1/trigram index in Echo.
const _FETCH_STOP = new Set(['the', 'and', 'for', 'of']);
async function _fuzzyCandidates(d, name, preferType) {
  const ftoks = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length >= 3 && !_FETCH_STOP.has(t)).slice(0, 4);
  if (!ftoks.length) return [];
  const where = [], params = [];
  if (preferType) { where.push('entity_type = ?'); params.push(preferType); }
  for (const t of ftoks) { const p = t.slice(0, 2); where.push('(name LIKE ? OR name LIKE ?)'); params.push(p + '%', '% ' + p + '%'); }
  const sql = `SELECT id, name, entity_type FROM entities WHERE ${where.join(' AND ')} ORDER BY degree DESC LIMIT 50`;
  let r; try { r = await d({ kind: 'do', name: 'db_query', args: { sql, params } }); } catch { return []; }
  if (!r || !r.ok) return [];
  let data; try { data = JSON.parse(r.text); } catch { return []; }
  const rows = Array.isArray(data && data.rows) ? data.rows : [];
  return rows.filter(e => e && e.name && _fuzzyNameMatch(name, e.name)).map(e => ({ id: e.id, name: String(e.name), entity_type: e.entity_type }));
}

async function _resolveMentionCore(name, { preferType = null, dispatch = null, context = null } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const n = String(name || '').trim();
  if (!d) return { status: 'error', mention: n };
  if (!n) return { status: 'nil', mention: n, reason: 'empty' };
  // Strip honorifics before hitting Echo — "Sen. Curtis" as a raw FTS query matches nothing (no entity
  // name carries "sen"); the search must run on the actual name tokens.
  const q = _cleanMention(n);
  let cands = await _searchEntities(d, q, preferType);
  // TYPO FALLBACK (R4): exact FTS missed → recover fuzzy candidates (edit-distance gated). These are
  // already name-verified, so they bypass the exact name-gate below.
  let fuzzy = false;
  if (!cands.length) { try { cands = await _fuzzyCandidates(d, q, preferType); fuzzy = cands.length > 0; } catch {} }
  if (!cands.length) return { status: 'nil', mention: n, reason: 'no-match' };
  // NAME-GATE: search_entities also matches on SUMMARIES, so it drags in tangential people (a staffer
  // whose bio names the target). Keep only candidates whose NAME actually carries the query's core tokens.
  const gated = fuzzy ? cands : _nameGate(cands, _coreNameKey(q));
  // DISTINCT by ENTITY IDENTITY (QID), not name-key — so same-name-DIFFERENT-entity ("John F. Kennedy" the
  // President vs "…(GA)" the state senator) is correctly ambiguous, while duplicate records of ONE entity
  // collapse to their richest. This is the instance-blind-resolution fix.
  const distinct = await _distinctEntities(d, gated);
  // >1 genuinely-different name (not dup records / initial variants) → ambiguous. Before asking, try
  // CONTEXT: the doc's co-occurring entities may pick the right candidate (R2). Only a strict winner
  // resolves; otherwise stay ambiguous (bias-to-clarify).
  if (distinct.length > 1) {
    if (Array.isArray(context) && context.length) {
      try {
        const winner = await _disambiguateByContext(d, distinct, context, _coreNameKey(q));
        if (winner) { const obj = await recallObject(winner.name, { preferType, dispatch: d }); if (obj) return { status: 'resolved', mention: n, object: obj, via: 'context' }; }
      } catch {}
    }
    // structural affiliation (R3): a c4 arm + its c3 (legally distinct, one org) → resolve generic to primary.
    try {
      const primary = await _affiliatedPrimary(d, distinct);
      if (primary) { const obj = await recallObject(primary.name, { preferType, dispatch: d }); if (obj) return { status: 'resolved', mention: n, object: obj, via: 'affiliation' }; }
    } catch {}
    // fuzzy multi-candidate (R4): the typo brought back >1 near-name; resolve to the CLOSEST edit-distance
    // match when it strictly beats the runner-up (else genuinely ambiguous → ask). Runs AFTER context +
    // affiliation so an org cluster still resolves to its primary, not the nearest arm.
    if (fuzzy) {
      const qk = _coreNameKey(q);
      const ranked = distinct.map(c => ({ c, dist: _levenshtein(qk, _coreNameKey(c.name)) })).sort((a, b) => a.dist - b.dist);
      if (ranked.length === 1 || ranked[0].dist < ranked[1].dist) {
        const obj = await recallObject(ranked[0].c.name, { preferType, dispatch: d });
        if (obj) return { status: 'resolved', mention: n, object: obj, via: 'fuzzy' };
      }
    }
    return { status: 'ambiguous', mention: n, candidates: distinct.slice(0, 4).map(c => c.name), candidateObjs: distinct.slice(0, 4).map(c => ({ name: c.name, type: c.type || null })) };
  }
  // single ENTITY — resolve its RICHEST record (distinct[0] is already the richest by degree). Using the
  // rep's exact stored name (not the raw query q) is what defeats the instance-blind FTS pick: q="John
  // Curtis" fed to quick_lookup grabs a degree-1 bill, but the rep name is the degree-320 Senator's record.
  const rep = distinct[0];
  if (fuzzy) { const obj = await recallObject(rep.name, { preferType, dispatch: d }); return obj ? { status: 'resolved', mention: n, object: obj, via: 'fuzzy' } : { status: 'nil', mention: n, reason: 'no-object' }; }
  const obj = await recallObject((rep && rep.name) || q, { preferType: preferType || (rep && rep.type) || null, dispatch: d });
  if (!obj) return { status: 'nil', mention: n, reason: 'no-object' };
  // Resolve ONLY when a record genuinely DOMINATES (rich object). Several thin same-name records with no
  // clear winner = we can't safely pick → ask rather than popularity-guess (the overshadowing trap).
  const dominant = obj.degree >= 8 || (obj.facts || []).length >= 4 || (obj.committees || []).length >= 1;
  if (!dominant) return { status: 'ambiguous', mention: n, reason: 'low-confidence', candidates: distinct.map(c => c.name), candidateObjs: distinct.slice(0, 4).map(c => ({ name: c.name, type: c.type || null })) };
  return { status: 'resolved', mention: n, object: obj };
}
// match.hit — when a local mention RESOLVES to an existing Echo entity, the active core shoots a recognition
// thread to the matched corpus node ("I know this"). One tap over every resolved return of the core; the
// emit is fail-safe and never alters the resolution result. anchor = the local mention, anchor2 = canonical.
async function resolveMention(name, opts = {}) {
  const r = await _resolveMentionCore(name, opts);
  try {
    if (r && r.status === 'resolved' && r.object && r.object.name) {
      kga.emit({ db: 'sidequest', kind: 'match.hit', anchor: String(name || '').trim(), anchor2: r.object.name, count: 1 });
    }
  } catch (e) { /* never disturb resolution */ }
  return r;
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
// DISTINCT ENTITIES by IDENTITY (wikidata_qid, else entity id) — THE instance-blind fix. "John F. Kennedy"
// (President) and "John F. Kennedy (GA)" (a state senator) collapse to the SAME core-NAME key (the "(GA)" is
// stripped), so _distinctNames wrongly sees ONE entity and the naive FTS picks the higher-degree wrong one.
// Grouping by QID instead: the two are DIFFERENT entities (different QIDs) → genuinely ambiguous (→ ASK),
// while the many duplicate records of ONE entity (Trump's mayor+president twins share a QID) collapse to
// their RICHEST record. One db_query enriches every candidate with qid+degree. Returns one richest
// representative per distinct entity, degree-desc. Fail-soft → name-key distinctness. Never throws.
async function _distinctEntities(d, cands) {
  const list = Array.isArray(cands) ? cands : [];
  const ids = [...new Set(list.map(c => Number(c && c.id)).filter(Number.isInteger))];
  if (ids.length < 2) return _distinctNames(list).map(c => ({ id: c.id, name: c.name, qid: null, degree: 0, type: c.entity_type || null, subtype: null }));
  let rows = [];
  try {
    const r = await d({ kind: 'do', name: 'db_query', args: { sql: `SELECT id, name, degree, wikidata_qid qid, entity_type et, entity_subtype est FROM entities WHERE id IN (${ids.join(',')})` } });
    const j = JSON.parse(r.text); rows = (j && j.rows) || [];
  } catch { rows = []; }
  if (!rows.length) return _distinctNames(list).map(c => ({ id: c.id, name: c.name, qid: null, degree: 0, type: c.entity_type || null, subtype: null }));
  const cs = rows.map(row => ({ id: row.id, name: String(row.name || ''), qid: (row.qid && String(row.qid).trim()) || null, degree: Number(row.degree) || 0, type: row.et || null, subtype: row.est || null }))
    .sort((a, b) => (b.degree || 0) - (a.degree || 0));   // richest first so groups seed on the best record
  // 1) records that SHARE a wikidata_qid are the same entity — collapse to the richest.
  const groups = [];   // each: the richest representative of a distinct entity
  const byQid = new Map();
  for (const c of cs) {
    if (!c.qid) continue;
    if (byQid.has(c.qid)) continue;   // richest-first → first seen is the representative
    byQid.set(c.qid, c); groups.push(c);
  }
  // 2) a QID-LESS record (an FEC/committee stub of the same person, e.g. "Donald J. Trump [FEC:…]") folds
  // into a name-compatible same-core-type group rather than counting as a separate entity (which would
  // trigger a spurious "did you mean…?"). No compatible group → it's its own distinct entity.
  for (const c of cs) {
    if (c.qid) continue;
    const host = groups.find(g => (g.type || null) === (c.type || null) && _nameCompatible(g.name, c.name));
    if (!host) groups.push(c);
  }
  return groups.sort((a, b) => (b.degree || 0) - (a.degree || 0));
}
// Pure: two names are the same person if one core-name is a token-subset of the other ("Donald Trump" ⊆
// "Donald J Trump"); different people carry incompatible extras. Mirrors _sameEntity's pairwise rule.
function _nameCompatible(a, b) {
  const ka = _coreNameKey(a).split(' ').filter(Boolean), kb = _coreNameKey(b).split(' ').filter(Boolean);
  if (!ka.length || !kb.length) return false;
  return ka.every(t => kb.includes(t)) || kb.every(t => ka.includes(t));
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

// ── PROMINENCE-AWARE RESOLUTION (R1) ──────────────────────────────────────────────────────────────────
// The KG ranks people by `degree`, which in a LEGISLATIVE graph = bill-cosponsorship volume — so a bare
// famous name resolves to a high-degree, QID-less STATE legislator while the actual referent isn't in the
// graph at all. Proven live: "John F. Kennedy" → "John F. Kennedy (GA)" state_senator (degree 1533, no
// QID); the President (Wikidata Q9696, 250 sitelinks) is absent. No KG re-ranking fixes this (the referent
// isn't there) and we can NOT blanket-drop civic records — legislative research IS the KG's core job. The
// only correct disambiguator is an EXTERNAL prominence signal, and only for the suspect signature.
//
// Suspect signature (pure): a PERSON with NO wikidata_qid and a SUB-NATIONAL/local legislative subtype.
// A record WITH a QID has an established global identity → trust it. Federal subtypes (us_senator/
// us_representative) are excluded — a sitting federal figure is a legitimate answer, not a namesake.
const _SUBNATIONAL_SUBTYPE_RE = /state_senator|state_rep|state_representative|assembly|delegate|counc[\s_-]?member|alderman|county|city_|local|school_board|^legislator$|legislator_legacy/i;
function _isCivicLocalNamesake(obj) {
  if (!obj || !/person/i.test(String(obj.type || ''))) return false;
  if (obj.wikidata_qid) return false;                 // has a global identity → the KG record is trustworthy
  return _SUBNATIONAL_SUBTYPE_RE.test(String(obj.subtype || '').toLowerCase());
}

// PROMINENCE PROBE — Wikidata sitelinks ARE the prominence oracle (keyless, ~2-4s, tiny payload). Query the
// most-linked HUMAN sharing this label. A globally-prominent person clears the floor easily (JFK 250); a
// civic namesake sits at ~0-1. Exact-label match (canonical full names match their rdfs:label — "John F.
// Kennedy" → Q9696); an altLabel UNION catches common variants. Returns the prominent human or {found:false}.
// Fail-soft; never throws. web_fetch is reached through the same dispatch tier wikiLookup uses.
const _WD_SPARQL = 'https://query.wikidata.org/sparql';
function _sparqlBindings(rawText) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let o = tryParse(rawText);
  if (o && !o.results && (o.text_preview || o.text || o.body)) { const inner = tryParse(o.text_preview || o.text || o.body || ''); if (inner) o = inner; }  // web_fetch wraps the body
  return o && o.results && Array.isArray(o.results.bindings) ? o.results.bindings : null;
}
async function prominenceProbe(name, { dispatch = null } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const nm = String(name || '').trim();
  if (!d || nm.length < 3) return { found: false };
  const lit = nm.replace(/\\/g, '\\\\').replace(/"/g, '\\"');   // SPARQL string literal
  const sparql = 'SELECT ?item ?sitelinks ?desc WHERE {'
    + ` { ?item rdfs:label "${lit}"@en } UNION { ?item skos:altLabel "${lit}"@en }`
    + ' ?item wdt:P31 wd:Q5 . ?item wikibase:sitelinks ?sitelinks .'
    + ' OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc)="en") } }'
    + ' ORDER BY DESC(?sitelinks) LIMIT 1';
  const url = _WD_SPARQL + '?format=json&query=' + encodeURIComponent(sparql);
  let r; try { r = await d({ kind: 'do', name: 'web_fetch', args: { url } }); } catch { return { found: false }; }
  if (!r || !r.ok) return { found: false };
  const b = (_sparqlBindings(r.text) || [])[0];
  if (!b || !b.item) return { found: false };
  const qid = String(b.item.value || '').split('/').pop() || null;
  const sitelinks = b.sitelinks ? parseInt(b.sitelinks.value, 10) : 0;
  return { found: !!qid, qid, sitelinks: Number.isFinite(sitelinks) ? sitelinks : 0, description: b.desc ? String(b.desc.value) : null, label: nm };
}

// PROMINENCE CHECK — the gate + verdict. Fires the external probe ONLY on the suspect signature and a
// full-name mention (≥2 substantive tokens — never a bare surname). On a far-more-prominent same-name human
// (sitelinks ≥ floor; the KG namesake has ~0 so the floor alone separates them), returns a `mismatch` verdict
// carrying a ready-to-inject IDENTITY note: answer about the prominent referent, footnote the record we hold.
// probeFn injectable for offline tests. Everything else → {status:'ok'} (resolve exactly as before; no probe,
// no latency). Fail-soft → 'ok'.
const _PROMINENCE_FLOOR = 15;
function _identityNote(m) {
  const p = m.prominent, n = m.namesake;
  const who = p.description ? `${p.label} — ${p.description}` : p.label;
  const alt = `${n.name}${n.subtype ? ` (${String(n.subtype).replace(/_/g, ' ')})` : ''}`;
  return `IDENTITY: "${p.label}" most prominently refers to ${who}. Answer about THAT person. Our records also hold a far less prominent same-name entry — ${alt} — which is almost certainly NOT who is meant; mention it only as a brief aside ("we also have a ${alt} on file"), never answer about them.`;
}
async function prominenceCheck(mention, obj, { dispatch = null, probeFn = null, minSitelinks = _PROMINENCE_FLOOR } = {}) {
  if (!_isCivicLocalNamesake(obj)) return { status: 'ok' };
  const toks = String(mention || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  if (toks.length < 2) return { status: 'ok' };            // bare surname → not a confident famous-name query
  const probe = probeFn || ((nm) => prominenceProbe(nm, { dispatch }));
  let p = null; try { p = await probe(mention); } catch { p = null; }
  if (!p || !p.found || (p.sitelinks || 0) < minSitelinks) return { status: 'ok' };
  const verdict = {
    status: 'mismatch',
    prominent: { qid: p.qid, label: p.label || mention, description: p.description || null, sitelinks: p.sitelinks },
    namesake: { name: obj.name, type: obj.type, subtype: obj.subtype || null, degree: obj.degree || 0 },
  };
  verdict.note = _identityNote(verdict);
  return verdict;
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
// Cloud tool executor (Phase 4): let the CLOUD pick + run the right recipe/tool for a plain-language
// need — so the interface never has to. Fail-soft; null when Echo/cloud unavailable.
async function routeNeed(query, opts = {}) {
  if (!liveReady()) return null;
  try { return await _live.routeNeed(query, opts); } catch { return null; }
}

// WIKIPEDIA recovery — the reliable, keyless encyclopedic tier for the enrich loop. The audit that
// exposed "dying on simple questions": DDG web search returns 0 results (endpoint blocked) and Echo's
// web_search has no provider keys, so the loop's "let me find out" reached nothing — while mediawiki (one
// of the 521 working tools) returns the exact answer page. This wires that in: search → pull the lead
// extracts of the top pages. Covers the whole who/what/current-X space ("Lee Zeldin → 17th EPA
// Administrator since Jan 2025"). Returns [{title, extract}] (or []). Fail-soft; never throws.
const _wikiUrl = (title) => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(title || '').trim().replace(/ /g, '_'));
async function wikiLookup(query, { dispatch = null, pages = 3, sentences = 4 } = {}) {
  const d = dispatch || (liveReady() ? (tag) => _live.dispatch(tag) : null);
  const q = String(query || '').trim();
  if (!d || !q) return [];
  let titles = [];
  try {
    const r = await d({ kind: 'do', name: 'mediawiki_search', args: { query: q, limit: 6 } });
    if (r && r.ok) { const j = JSON.parse(r.text); const rows = (j && j.results) || []; titles = rows.map(x => x && x.title).filter(Boolean); }
  } catch {}
  if (!titles.length) return [];
  const out = [];
  // TOP page — the FULL readable body via web_extract, not just the lead. The lead extract of an OFFICE
  // page is generic ("the administrator of the EPA is the head of…"); the INCUMBENT ("Lee Zeldin is the
  // current administrator") lives in the body/infobox. web_extract catches it (mediawiki_get_extract
  // can't). This is what makes "who is the current X?" answerable, not just "who is <person>?".
  try {
    const r = await d({ kind: 'do', name: 'web_extract', args: { url: _wikiUrl(titles[0]) } });
    if (r && r.ok) {
      let body = '';
      try {
        const j = JSON.parse(r.text);
        if (j && typeof j === 'object') {
          body = String(j.text || j.content || j.markdown || j.extract || j.body || '').trim();
          if (!body) { let longest = ''; for (const v of Object.values(j)) if (typeof v === 'string' && v.length > longest.length) longest = v; body = longest.trim(); }  // unknown shape → longest string field
        }
      } catch {}
      if (!body) body = String(r.text || '').trim();   // web_extract may return plain text (not JSON)
      body = body.replace(/\s+/g, ' ').trim();
      if (body.length > 80) out.push({ title: titles[0], extract: body.slice(0, 1800) });
    }
  } catch {}
  // REMAINING pages — cheap lead extracts for breadth (covers plain "who/what is X").
  for (const title of titles.slice(out.length ? 1 : 0, pages + 1)) {
    try {
      const r = await d({ kind: 'do', name: 'mediawiki_get_extract', args: { title, sentences } });
      if (r && r.ok) { const j = JSON.parse(r.text); const ex = j && String(j.extract || '').replace(/\s+/g, ' ').trim(); if (ex && ex.length > 40) out.push({ title: (j && j.title) || title, extract: ex.slice(0, 500) }); }
    } catch {}
  }
  return out;
}

// Utility readout for the P2 go/no-go gate — what the memo and the coalescer actually saved on the
// LIVE suit. Null members mean the layer never engaged (flag off, or nothing memoizable yet).
function routeCacheStats() {
  const s = _live || null;
  return {
    memo: (s && s._memo && s._memo.stats()) || null,
    coalesce: (s && s._coalescer && s._coalescer.stats()) || null,
  };
}

module.exports = {
  routeCacheStats,
  EchoSuit, createSuit, parseEchoTags, parseArgs, stripEchoTags, normalizeToolResult, resultText, filterToolMap, buildRecipeMenu, filterRecipes, echoCloudRouteEnabled,
  setLiveSuit, liveReady, liveStatus, recallKnowledge, recallObject, resolveMention, normalizeObject, normalizeNeighbors, dispatch, liveDispatch, routeNeed, wikiLookup, expandNeighbors, relatedEntities, officeHolders, prominenceProbe, prominenceCheck, _coreNameKey, _distinctNames, _distinctEntities, _nameCompatible, _nameGate, _cleanMention, _sameEntity, _relevanceGate, _isBareOfficeTitle, _isCivicLocalNamesake, _identityNote, _setLiveForTest, _contextScore, _pickByContext, _disambiguateByContext, _entitySignature, _entityRelations, _affiliatedPrimary, _levenshtein, _tokenSim, _fuzzyNameMatch, _fuzzyCandidates
};
