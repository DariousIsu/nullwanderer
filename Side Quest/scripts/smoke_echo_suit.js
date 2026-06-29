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

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` - ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
