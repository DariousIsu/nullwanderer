/** Heavy offline smoke for the Echo Suit dispatch bridge. Mock client (no real Echo, no reboot).
 *  Covers: pure helpers (parse/normalize/filter), connect lifecycle, suit-context, dispatch of
 *  all 5 verbs incl. structured-error feedback + malformed-JSON self-correct prompts. */
const S = require('../lib/echo_suit');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

function mockClient(overrides = {}) {
  const calls = [];
  const toolMap = JSON.stringify({ grouping: 'intent', total_tools: 3, by_intent: {
    search: [{ name: 'search_knowledge', description: 'Search attached FTS5 corpora (Wikipedia, etc.)' }],
    retrieve: [{ name: 'get_entity', description: 'Fetch one entity by id from the civic graph' }],
    edit: [{ name: 'propose_entity', description: 'Propose a new entity into the knowledge graph' }],
  } });
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  return {
    calls,
    serverInfo: { name: 'nx-echo', version: '3.3.1' },
    async initialize() { calls.push(['initialize']); if (overrides.failInit) throw new Error('boot failed'); return { serverInfo: this.serverInfo }; },
    async listTools() { calls.push(['listTools']); return [{ name: 'search_knowledge' }, { name: 'get_entity' }, { name: 'propose_entity' }, { name: 'get_tool_map' }, { name: 'spawn_agent_async' }]; },
    async callTool(name, args) {
      calls.push([name, args]);
      if (overrides.tools && overrides.tools[name]) return overrides.tools[name](args);
      if (name === 'get_usage_guide') return text('# README_MCP - load this BEFORE other calls.');
      if (name === 'get_atlas') return text('{"system":"NX-ECHO Data Atlas","fast_paths":[]}');
      if (name === 'get_tool_map') return text(toolMap);
      if (name === 'search_knowledge') return text('Found 3 results about water policy.');
      if (name === 'get_entity') return text('Entity: Joseph Rainey Center (org).');
      if (name === 'spawn_agent_async') return text('{"run_id":"agent_42","status":"queued"}');
      if (name === 'propose_entity') return text('{"proposal_id":"p_7","status":"pending_verification"}');
      if (name === 'quick_lookup') return text('2 validation errors for call[quick_lookup]\nname\n  Missing required argument');
      if (name === 'list_recipes') return text(JSON.stringify({ count: 2, recipes: [
        { name: 'search-vault', intent: 'Search our Rainey vault documents by keyword.', arg: 'a keyword', category: 'echo-data' },
        { name: 'lamp-count', intent: 'Count LAMP members by category.', arg: '(none)', category: 'echo-data' },
      ] }));
      if (name === 'run_recipe') {
        if (!args || !args.name) return text(JSON.stringify({ ok: false, error: 'requires name' }));
        return text(JSON.stringify({ ok: true, recipe: args.name, rows: [{ n: 434 }], row_count: 1, ms: 0.3 }));
      }
      return text('ok');
    },
  };
}

(async () => {
  console.log('Echo Suit - heavy offline smoke\n');

  console.log('parseEchoTags (pure, ordered):');
  const P = S.parseEchoTags;
  ok('parses <echo-guide/>', P('<echo-guide/>')[0].kind === 'guide');
  ok('parses <echo-find>', (() => { const t = P('<echo-find>water policy</echo-find>')[0]; return t.kind === 'find' && t.query === 'water policy'; })());
  ok('parses <echo-do> name+args', (() => { const t = P('<echo-do name="search_knowledge">{"query":"x"}</echo-do>')[0]; return t.kind === 'do' && t.name === 'search_knowledge' && t.args.query === 'x'; })());
  ok('parses <echo-delegate> name+task', (() => { const t = P('<echo-delegate name="briefing_writer">draft it</echo-delegate>')[0]; return t.kind === 'delegate' && t.agent === 'briefing_writer' && /draft it/.test(t.task); })());
  ok('parses <echo-propose> kind+payload', (() => { const t = P('<echo-propose kind="entity">{"name":"X"}</echo-propose>')[0]; return t.kind === 'propose' && t.proposeKind === 'entity' && t.payload.name === 'X'; })());
  ok('malformed <echo-do> JSON -> parseError (not a throw)', (() => { const t = P('<echo-do name="t">{bad json}</echo-do>')[0]; return t.kind === 'do' && !!t.parseError; })());
  ok('preserves document order across tag types', (() => { const ts = P('<echo-find>a</echo-find> then <echo-do name="t">{}</echo-do>'); return ts[0].kind === 'find' && ts[1].kind === 'do'; })());
  ok('ignores non-echo text', P('just a normal reply with no tags').length === 0);
  ok('multiple finds all captured', P('<echo-find>a</echo-find><echo-find>b</echo-find>').length === 2);

  console.log('\nnormalizeToolResult (pure):');
  ok('plain content -> ok', (() => { const r = S.normalizeToolResult({ content: [{ type: 'text', text: 'hello' }] }); return r.ok && !r.isError && r.text === 'hello'; })());
  ok('isError flag -> error', S.normalizeToolResult({ isError: true, content: [{ text: 'boom' }] }).isError === true);
  ok('validation text in content -> error (live quick_lookup case)', S.normalizeToolResult({ content: [{ text: '2 validation errors for call[x]\nname\n  Missing required argument' }] }).isError === true);
  ok('empty result -> ok empty', S.normalizeToolResult(null).text === '');

  console.log('\nfilterToolMap (pure, small-model nav aid):');
  const tm = JSON.stringify({ by_intent: { search: [{ name: 'search_knowledge', description: 'FTS5 corpora search' }], edit: [{ name: 'propose_entity', description: 'propose entity to graph' }] } });
  ok('filters to query match', /search_knowledge/.test(S.filterToolMap(tm, 'search')) && !/propose_entity/.test(S.filterToolMap(tm, 'search')));
  ok('no match -> intent overview + fallback hint', /Intent buckets/.test(S.filterToolMap(tm, 'zzzznomatch')));
  ok('garbage json -> capped passthrough (no throw)', typeof S.filterToolMap('not json', 'x') === 'string');

  console.log('\nfilterRecipes (pure — recipe-aware find, the LAMP-confusion fix):');
  const rj = JSON.stringify({ recipes: [
    { name: 'lamp-count', intent: 'Count LAMP members, broken down by category.', arg: '(none)', arg_required: false, domain: 'identity' },
    { name: 'find-bill', intent: 'Find legislation by keyword.', arg: 'a topic', arg_required: true, domain: 'legislation' },
  ] });
  ok('surfaces the matching recipe (lamp)', /lamp-count/.test(S.filterRecipes(rj, 'how many lamp members')));
  ok('excludes non-matching recipe', !/find-bill/.test(S.filterRecipes(rj, 'how many lamp members')));
  ok('no match -> empty string', S.filterRecipes(rj, 'zzzznomatch') === '');
  ok('garbage json -> empty (no throw)', S.filterRecipes('not json', 'x') === '');

  console.log('\nconnect lifecycle:');
  {
    const suit = S.createSuit({ client: mockClient() });
    const r = await suit.connect();
    ok('connect ok', r.ok === true);
    ok('records tool count', suit.status().tools === 5);
    ok('records server info', suit.status().server.name === 'nx-echo');
    ok('pinned guide+atlas (suitContextBlock non-null)', !!suit.suitContextBlock());
    ok('suit block names the tags', /<echo-find>/.test(suit.suitContextBlock()) && /<echo-do/.test(suit.suitContextBlock()));
    ok('suit block points to <echo-guide/> for the full map (not inlined)', /<echo-guide\/>/.test(suit.suitContextBlock()) && !/README_MCP/.test(suit.suitContextBlock()));
    ok('suit block names the recipe tag (preferred path)', /<echo-recipe/.test(suit.suitContextBlock()));
    ok('suit block carries the recipe MENU', /search-vault/.test(suit.suitContextBlock()) && /lamp-count/.test(suit.suitContextBlock()));
    ok('suit block bounded (ctx-budget: < 4000 chars incl menu)', suit.suitContextBlock().length < 4000);
  }
  {
    const suit = S.createSuit({ client: mockClient({ failInit: true }) });
    const r = await suit.connect();
    ok('connect failure handled (no throw, ok:false)', r.ok === false && !suit.connected);
    ok('suitContextBlock null when disconnected', suit.suitContextBlock() === null);
  }

  console.log('\ndispatch (all 5 verbs):');
  {
    const suit = S.createSuit({ client: mockClient() });
    await suit.connect();
    const find = await suit.dispatch({ kind: 'find', query: 'search' });
    ok('find returns filtered tool list', find.ok && /search_knowledge/.test(find.text));
    const findLamp = await suit.dispatch({ kind: 'find', query: 'how many LAMP members' });
    ok('find is RECIPE-AWARE — surfaces lamp-count for the LAMP question (the fix)', findLamp.ok && /lamp-count/.test(findLamp.text) && /RECIPES/.test(findLamp.text));
    const doR = await suit.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: 'water' } });
    ok('do invokes the named tool', doR.ok && /water policy/.test(doR.text));
    const del = await suit.dispatch({ kind: 'delegate', agent: 'briefing_writer', task: 'draft' });
    ok('delegate -> spawn_agent_async (run_id back)', del.ok && /agent_42/.test(del.text));
    const prop = await suit.dispatch({ kind: 'propose', proposeKind: 'entity', payload: { name: 'X' } });
    ok('propose -> propose_entity (pending_verification)', prop.ok && /pending_verification/.test(prop.text));
    const guide = await suit.dispatch({ kind: 'guide' });
    ok('guide surfaces the full contract+atlas on demand', guide.ok && /README_MCP|atlas|contract/i.test(guide.text));
  }

  console.log('\ngather stamp (Spine 2 absence-gate probe):');
  {
    const suit = S.createSuit({ client: mockClient() });
    await suit.connect();
    ok('lastGatherTs is exported and numeric', typeof S.lastGatherTs === 'function' && typeof S.lastGatherTs() === 'number');
    const before = S.lastGatherTs();
    await new Promise((r) => setTimeout(r, 2));   // guarantee the clock advances, so afterGather>before proves a FRESH stamp
    await suit.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: 'water' } });   // a GATHER tool
    const afterGather = S.lastGatherTs();
    ok('a dispatched gather tool (search_knowledge) advances lastGatherTs — she LOOKED', afterGather > before);
    const propped = S.lastGatherTs();
    await suit.dispatch({ kind: 'propose', proposeKind: 'entity', payload: { name: 'X' } });    // NOT a gather
    ok('a non-gather dispatch (propose) does NOT advance the gather stamp', S.lastGatherTs() === propped);
    await suit.dispatch({ kind: 'delegate', agent: 'briefing_writer', task: 'draft' });         // NOT a gather
    ok('a delegate dispatch does NOT advance the gather stamp', S.lastGatherTs() === propped);
    // markGather: the direct stamp for browser/excavate lanes that bypass dispatch()
    const preMark = S.lastGatherTs();
    await new Promise((r) => setTimeout(r, 2));
    S.markGather();
    ok('markGather() advances the gather stamp (browser/excavate lane)', typeof S.markGather === 'function' && S.lastGatherTs() > preMark);
    // TWO-TIER: an INTERNAL recall (search_knowledge) advances the BROAD stamp but NOT the external one;
    // an EXTERNAL tool (quick_lookup) advances BOTH. The absence gate + step 5 read the external stamp.
    ok('lastExternalGatherTs is exported and numeric', typeof S.lastExternalGatherTs === 'function' && typeof S.lastExternalGatherTs() === 'number');
    const extBefore = S.lastExternalGatherTs();
    await new Promise((r) => setTimeout(r, 2));
    await suit.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: 'x' } });   // INTERNAL recall
    ok('an INTERNAL recall (search_knowledge) does NOT advance the external stamp', S.lastExternalGatherTs() === extBefore);
    ok('…but it DOES advance the broad stamp', S.lastGatherTs() >= extBefore);
    await new Promise((r) => setTimeout(r, 2));
    await suit.dispatch({ kind: 'do', name: 'quick_lookup', args: { query: 'x' } });        // EXTERNAL retrieval
    ok('an EXTERNAL tool (quick_lookup) DOES advance the external stamp', S.lastExternalGatherTs() > extBefore);
    const extAfter = S.lastExternalGatherTs();
    await new Promise((r) => setTimeout(r, 2));
    S.markGather();
    ok('markGather() (browser lane) advances the external stamp too', S.lastExternalGatherTs() > extAfter);
    // TURN-SCOPED: a dispatch on the AUTONOMOUS (background) lane must NOT stamp — background gathering is
    // not "she looked THIS user turn." Wrap the dispatch in an autonomous ambient lane and assert no advance.
    const lane = require('../lib/lane');
    const broadBefore = S.lastGatherTs(), extBefore2 = S.lastExternalGatherTs();
    await new Promise((r) => setTimeout(r, 2));
    await lane.run({ autonomous: true }, () => suit.dispatch({ kind: 'do', name: 'web_fetch', args: { url: 'x' } }));
    ok('an AUTONOMOUS (background) external gather does NOT advance the broad stamp', S.lastGatherTs() === broadBefore);
    ok('an AUTONOMOUS (background) external gather does NOT advance the external stamp', S.lastExternalGatherTs() === extBefore2);
    await new Promise((r) => setTimeout(r, 2));
    await lane.run({ autonomous: true }, async () => { S.markGather(); });
    ok('markGather() under an autonomous lane does NOT stamp', S.lastExternalGatherTs() === extBefore2);
  }

  console.log('\ndispatch error feedback (self-correction):');
  {
    const suit = S.createSuit({ client: mockClient() });
    await suit.connect();
    const bad = await suit.dispatch({ kind: 'do', name: 'quick_lookup', args: {} });
    ok('structured validation error surfaced as isError', bad.isError === true && /validation error/i.test(bad.text));
    const badJson = await suit.dispatch({ kind: 'do', name: 't', args: {}, parseError: 'Unexpected token' });
    ok('malformed-JSON tag -> self-correct prompt (no call made)', badJson.isError === true && /valid JSON/.test(badJson.text));
    const thrower = S.createSuit({ client: { initialize: async () => ({ serverInfo: {} }), listTools: async () => [], callTool: async () => { throw new Error('socket dead'); } } });
    await thrower.connect();
    const crashed = await thrower.dispatch({ kind: 'do', name: 'x', args: {} });
    ok('transport throw -> caught, fed back', crashed.isError === true && /Echo call failed/.test(crashed.text));
  }

  console.log('\nper-call dispatch timeout override (heavy idle-gated maintenance):');
  {
    const slow = (ms, val) => () => new Promise((res) => setTimeout(() => res({ content: [{ type: 'text', text: val }] }), ms));
    const suit = S.createSuit({ client: mockClient({ tools: { get_entity: slow(120, 'Entity: slow one.') } }) });
    await suit.connect();
    const prev = process.env.ZOE_TOOL_DISPATCH_TIMEOUT_MS;
    process.env.ZOE_TOOL_DISPATCH_TIMEOUT_MS = '40';                  // default budget BELOW the 120ms tool
    const abandoned = await suit.dispatch({ kind: 'do', name: 'get_entity', args: { id: 1 } });
    ok('a slow tool is abandoned at the default budget', abandoned.timedOut === true && abandoned.isError === true);
    const raised = await suit.dispatch({ kind: 'do', name: 'get_entity', args: { id: 2 } }, { timeoutMs: 4000 });
    ok('a per-call timeoutMs override lets the SAME slow tool complete', !raised.isError && /slow one/.test(raised.text));
    if (prev == null) delete process.env.ZOE_TOOL_DISPATCH_TIMEOUT_MS; else process.env.ZOE_TOOL_DISPATCH_TIMEOUT_MS = prev;
  }

  console.log('\ndispatchAll (end-to-end from her output):');
  {
    const suit = S.createSuit({ client: mockClient() });
    await suit.connect();
    const results = await suit.dispatchAll('Let me check. <echo-find>entity</echo-find> then <echo-do name="get_entity">{"id":1}</echo-do>');
    ok('dispatched both tags in order', results.length === 2 && results[0].kind === 'find' && results[1].kind === 'do');
    ok('second got entity', /Rainey Center/.test(results[1].text));
  }

  console.log('\nstripEchoTags (pure):');
  ok('strips <echo-do> block, keeps prose', (() => { const s = S.stripEchoTags('Sure. <echo-do name="search_knowledge">{"q":"x"}</echo-do> done'); return /Sure\./.test(s) && /done/.test(s) && !/echo-do/.test(s); })());
  ok('strips all five tag forms', (() => { const s = S.stripEchoTags('<echo-guide/><echo-find>a</echo-find><echo-do name="t">{}</echo-do><echo-delegate name="x">y</echo-delegate><echo-propose kind="entity">{}</echo-propose>'); return s.trim() === ''; })());
  ok('null-safe', S.stripEchoTags(null) === null);

  console.log('\n<echo-recipe> tag (the preferred path):');
  {
    const t1 = P('<echo-recipe name="search-vault" arg="weather modification"/>')[0];
    ok('parses self-closing recipe tag', t1 && t1.kind === 'recipe' && t1.name === 'search-vault' && t1.arg === 'weather modification');
    const t2 = P('<echo-recipe name="lamp-count"/>')[0];
    ok('parses no-arg recipe tag', t2 && t2.name === 'lamp-count' && t2.arg === null);
    const t3 = P('<echo-recipe name="officials-in-state" arg="NY" limit="5"/>')[0];
    ok('parses limit attr', t3 && t3.arg === 'NY' && t3.limit === 5);
    const t4 = P('<echo-recipe name="find-person">Schumer</echo-recipe>')[0];
    ok('parses paired form (arg in body)', t4 && t4.name === 'find-person' && t4.arg === 'Schumer');
    ok('strips recipe tags', !/echo-recipe/.test(S.stripEchoTags('hi <echo-recipe name="x" arg="y"/> there')) && /hi/.test(S.stripEchoTags('hi <echo-recipe name="x" arg="y"/> there')));
    ok('buildRecipeMenu renders lines', /search-vault/.test(S.buildRecipeMenu(JSON.stringify({ recipes: [{ name: 'search-vault', intent: 'x', arg: 'k' }] }))));

    const suit = S.createSuit({ client: mockClient() });
    await suit.connect();
    const good = await suit.dispatch({ kind: 'recipe', name: 'lamp-count' });
    ok('dispatch recipe -> run_recipe ok', good.ok === true && good.kind === 'recipe' && /434/.test(good.text));
    const noName = await suit.dispatch({ kind: 'recipe', name: '' });
    ok('recipe without name -> self-correct prompt', noName.isError === true && /needs name/.test(noName.text));
    const calledRunRecipe = suit.client().calls.some(c => c[0] === 'run_recipe' && c[1] && c[1].name === 'lamp-count');
    ok('dispatch routed to run_recipe with name', calledRunRecipe);
  }

  console.log('\ndispatch auto-connect (self-heal before warm-connect finishes):');
  {
    const suit = S.createSuit({ client: mockClient() });
    // not connected yet (no connect() call) — dispatch should connect on demand
    const r = await suit.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: 'x' } });
    ok('auto-connected on first dispatch', suit.status().connected === true && r.ok);
  }
  {
    const suit = S.createSuit({ client: mockClient({ failInit: true }) });
    const r = await suit.dispatch({ kind: 'do', name: 'search_knowledge', args: {} });
    ok('disconnected suit → graceful "not connected" (no throw)', r.isError === true && /isn't connected/.test(r.text));
  }

  // --- ⭐ DELIBERATIVE tags: contemplation is not a call (live regression 2026-07-31) -------------
  {
    // The exact reasoning that shipped twelve failing db_query hops and then had her tell Lucas
    // "Your db_query call needs a proper JSON payload" — her own musing, handed back as his mistake.
    // The body regex is non-greedy, so the EARLIER mention of <echo-find> paired with the LATER real
    // close and the whole paragraph between them became the search query.
    const musing = 'I could use <echo-find> here.\nwith a query like "tenant proposals" or "bulk promote". Let\'s try that.\n\nWe need to emit exactly one Echo tag. So we will do <echo-find>tenant proposals bulk promotion</echo-find>';
    const loose = S.parseEchoTags(musing);
    ok('the old bar accepts the deliberation as a real tag (the bug)', loose.length === 1 && /Let's try that/.test(loose[0].query));
    const strict = S.parseEchoTags(musing, { deliberative: true });
    ok('⭐ deliberative bar REJECTS a payload that spans lines — contemplation is not a call', strict.length === 0);

    // …and it must not become a blanket "reject everything from reasoning": a real tag authored in
    // the reasoning channel is exactly why that channel is scanned at all.
    const real = S.parseEchoTags('Let me look this up. <echo-find>Rainey Center 990 revenue</echo-find>', { deliberative: true });
    ok('⭐ a COMMITTED single-line tag in the reasoning channel still dispatches', real.length === 1 && real[0].query === 'Rainey Center 990 revenue');

    const bigDo = S.parseEchoTags('<echo-do name="db_query">{"sql":"SELECT 1"}</echo-do>', { deliberative: true });
    ok('a well-formed echo-do with valid JSON survives the bar', bigDo.length === 1 && bigDo[0].name === 'db_query');
    const badDo = S.parseEchoTags('<echo-do name="db_query">maybe something like SELECT ...</echo-do>', { deliberative: true });
    ok('an echo-do whose args do not parse is dropped in deliberative mode', badDo.length === 0);
    const para = S.parseEchoTags(`<echo-find>${'x'.repeat(300)}</echo-find>`, { deliberative: true });
    ok('a paragraph-length query is not a query', para.length === 0);
    // the default path is untouched — only the reasoning channel opts in
    ok('non-deliberative parsing is unchanged', S.parseEchoTags(`<echo-find>${'x'.repeat(300)}</echo-find>`).length === 1);

    // F5 (2026-08-15 deep-dive): clean JSON is STRUCTURAL proof of commitment — a real canvas
    // block's full content exceeds the old 240-char/one-line bar by design, and the bar was
    // dropping exactly the blocks the package commands to carry their content in full.
    const bigBlock = S.parseEchoTags(`<echo-do name="saga_canvas_add_block">{"tab_key":"k","block_type":"paragraph","md":"${'real content '.repeat(40)}\\nsecond line"}</echo-do>`, { deliberative: true });
    ok('F5: a long clean-JSON canvas block SURVIVES the committed bar', bigBlock.length === 1 && bigBlock[0].name === 'saga_canvas_add_block');
    const spec = S.parseEchoTags('<echo-delegate name="briefing_writer">Write the brief.\nCover finances.\nCite everything.</echo-delegate>', { deliberative: true });
    ok('F5: a multi-line delegate task spec survives (the manifest instructs the full spec)', spec.length === 1);
    const swallow = S.parseEchoTags('<echo-delegate>we could use <echo-find> for this later maybe</echo-delegate>', { deliberative: true });
    ok('F5: a span that swallowed another tag mention is still deliberation — dropped', swallow.length === 0);

    // F3 (2026-08-15 deep-dive): parse grammar now matches strip grammar — a single-quoted name
    // used to be stripped from the say and silently never executed.
    const sq = S.parseEchoTags(`<echo-do name='db_query'>{"sql":"SELECT 1"}</echo-do>`);
    ok('F3: a single-quoted name PARSES (it was strip-without-execute)', sq.length === 1 && sq[0].name === 'db_query');
    const attrs = S.parseEchoTags('<echo-do name="db_query" extra="junk">{"sql":"SELECT 1"}</echo-do>');
    ok('F3: attribute slack parses', attrs.length === 1 && attrs[0].name === 'db_query');
    const sqd = S.parseEchoTags(`<echo-delegate name='press_monitor'>watch the wires</echo-delegate>`);
    ok('F3: single-quoted delegate parses', sqd.length === 1 && sqd[0].agent === 'press_monitor');
  }

  // --- ⭐ STRIPPING A TAG MUST NOT DAMAGE THE SENTENCE AROUND IT (live 2026-07-31) --------------
  {
    // She writes tags inline mid-sentence. Removing them to '' left the damage in the user's face.
    // The sentence still reads oddly — the tag WAS the object of "the" — but that is the model's
    // phrasing, not the stripper's job. What the stripper owes is a clean seam.
    const hole = S.stripEchoTags('Then I can re-emit the <echo-do name="db_query">{"sql":"SELECT 1"}</echo-do> with a valid JSON object.');
    ok('⭐ no double-space hole where the tag was', hole === 'Then I can re-emit the with a valid JSON object.');
    ok('…and the seam is a single space', !/ {2,}/.test(hole));
    const fused = S.stripEchoTags('I\'ll fire off the proper<echo-do name="db_query">{}</echo-do>JSON now.');
    ok('⭐ two words separated only by a tag do not fuse ("validJSON")', /proper JSON now\./.test(fused));
    const punct = S.stripEchoTags('Let me look that up <echo-find>rainey 990</echo-find>.');
    ok('the seam is not stranded before punctuation', /up\.$/.test(punct) && !/ \.$/.test(punct));
    ok('a tag-only message still strips to empty', S.stripEchoTags('<echo-find>x</echo-find>') === '');
  }

  // --- ARG-TEMPLATE FAST-PATH (deterministic-loops #2c, 2026-08-15) -----------------------------
  {
    ok('template: search → {query}', JSON.stringify(S.templateArgs('search', 'reno city council')) === '{"query":"reno city council"}');
    ok('template: search_documents_semantic → {query}', S.templateArgs('search_documents_semantic', 'charter powers').query === 'charter powers');
    ok('template: get_pass_status → {} (no-arg tool)', JSON.stringify(S.templateArgs('get_pass_status', 'whatever')) === '{}');
    ok('template: whitespace normalized + capped', S.templateArgs('search', '  a\n\n b  ').query === 'a b');
    ok('template: db_query NEVER templates (needs SQL comprehension)', S.templateArgs('db_query', 'find things') === null);
    ok('template: legistar_list_persons NEVER templates (needs a client name)', S.templateArgs('legistar_list_persons', 'allentown roster') === null);
    ok('template: unknown tool → null (cloud path unchanged)', S.templateArgs('some_new_tool', 'x') === null);
    ok('template: query tool with EMPTY need → null (never dispatch a blank query)', S.templateArgs('search', '   ') === null);
  }

  // --- THE BROWSER-LANE PAGE READ (the fuel wall, 2026-08-25) -----------------------------------
  // web_extract's static fetch is 0 chars on a JS-rendered page and its `js` depth is stubbed on this
  // box; browserRead composes her own headless stealth browser to render it. dispatch is a test seam;
  // the mock mirrors the REAL normalized shapes (open → {session_id}, extract → {"text":<body>} JSON).
  {
    console.log('\nbrowserRead — the browser-lane page read (fuel wall):');
    const mkDisp = (opts = {}) => {
      const calls = [];
      const disp = async (tag) => {
        calls.push(tag.name);
        if (tag.name === 'browser_open_session') {
          if (opts.openStatus) return { ok: true, text: JSON.stringify({ status: opts.openStatus }) };
          if (opts.openTimeout) return { ok: false, isError: true, timedOut: true, text: 'Tool timed out after 15s and was abandoned.' };
          return { ok: true, text: JSON.stringify({ ok: true, session_id: 'sid1' }) };
        }
        if (tag.name === 'browser_navigate') return { ok: true, text: JSON.stringify({ ok: true, title: 't' }) };
        // browser_extract: the app double-wraps — r.text = {"ok":true,"text":"{\"ok\":true,\"text\":\"<body>\"}"}.
        if (tag.name === 'browser_extract') return { ok: true, text: JSON.stringify({ ok: true, text: JSON.stringify({ ok: true, text: opts.body == null ? '' : opts.body }) }) };
        if (tag.name === 'browser_close_session') return { ok: true, text: JSON.stringify({ ok: true }) };
        return { ok: true, text: '{}' };
      };
      return { calls, disp };
    };

    const body = 'Quotes to Scrape\n' + '“It is our choices that show what we truly are.” by J.K. Rowling '.repeat(4) + '\nby Albert Einstein';
    const m1 = mkDisp({ body });
    const t1 = await S.browserRead('https://quotes.toscrape.com/js/', { dispatch: m1.disp });
    ok('⭐ renders a JS page → the inner body, unwrapped from the {text:…} envelope', t1 === body);
    ok('drives open → navigate → extract → close, in order', m1.calls.join(',') === 'browser_open_session,browser_navigate,browser_extract,browser_close_session');

    const m2 = mkDisp({ body: 'The requested URL was rejected. Please consult with your administrator. Your support ID is: 3305068709 [Go Back]' });
    ok('⭐ a bot-wall body (F5 "support ID", le.utah.gov) is an honest miss → null', (await S.browserRead('https://le.utah.gov/x', { dispatch: m2.disp })) === null);
    ok('…and the session is STILL closed after a bot-wall miss', m2.calls.includes('browser_close_session'));

    ok('a blank/near-blank render (≤80 chars) → null', (await S.browserRead('https://x.example/', { dispatch: mkDisp({ body: 'tiny render' }).disp })) === null);

    const m4 = mkDisp({ openStatus: 'confirmation_required' });
    ok('⭐ a held confirmation (no session_id) → honest miss, never self-approved', (await S.browserRead('https://x.example/', { dispatch: m4.disp })) === null);
    ok('…and no navigate/extract fired without a session', !m4.calls.includes('browser_navigate') && !m4.calls.includes('browser_extract'));

    ok('an open-session soft-error (timeout, non-JSON text) → null', (await S.browserRead('https://x.example/', { dispatch: mkDisp({ openTimeout: true }).disp })) === null);

    const m6 = mkDisp({ body });
    ok('a non-http(s) url is refused before ANY dispatch (SSRF floor)', (await S.browserRead('file:///etc/passwd', { dispatch: m6.disp })) === null && m6.calls.length === 0);
    ok('a null/blank url → null, no dispatch', (await S.browserRead('', { dispatch: m6.disp })) === null && m6.calls.length === 0);

    ok('_BOT_WALL_RE matches Cloudflare "just a moment / checking your browser"', S._BOT_WALL_RE.test('Just a moment... Checking your browser before accessing the site.'));
    ok('_BOT_WALL_RE matches a captcha gate', S._BOT_WALL_RE.test('Please complete the reCAPTCHA to continue.'));
    ok('_BOT_WALL_RE does NOT match a real bill page', !S._BOT_WALL_RE.test('HB0606 Sponsor: Rep. Jane Doe. Title: Public Education Amendments. Status: enrolled.'));
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` - ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
