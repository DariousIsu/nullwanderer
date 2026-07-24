/* smoke_dispatch_guards.js — the four deterministic dispatch guards (Slice A, 2026-07-24).
 *
 * boot94's route-obs log showed a weak model fumbling the raw <echo-do>/<echo-recipe> grammar the same
 * few ways on every deliverable attempt:
 *   • a literal "…" placeholder where JSON args go   → "args weren't valid JSON"
 *   • an unescaped ' in a search query               → "fts5: syntax error near '"
 *   • a real TOOL called as a recipe                 → "unknown recipe 'search_documents_semantic'"
 *   • a db_query with no timeout on a big table      → "Query exceeded the 5.0s budget"
 *
 * These guards catch each deterministically at the one dispatch chokepoint. The pure helpers are proven
 * in isolation AND end-to-end through EchoSuit.dispatch (with a fake client that captures the args it was
 * actually handed). No live Echo.
 */
'use strict';
const es = require('../lib/echo_suit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// A fake Echo client that records the args callTool was handed, so we can assert prepareDoArgs applied.
function fakeClient() {
  const calls = [];
  return {
    calls,
    async initialize() { return { serverInfo: { name: 'fake-echo' } }; },
    async listTools() {
      return [
        { name: 'db_query', inputSchema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array' }, timeout_seconds: { type: 'integer' } }, required: ['sql'] } },
        { name: 'search_entities', inputSchema: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer' } }, required: ['query'] } },
        { name: 'search_documents_semantic', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      ];
    },
    async callTool(name, args) {
      if (name === 'get_usage_guide' || name === 'get_atlas' || name === 'list_recipes') return { content: [{ type: 'text', text: '' }] };
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

async function main() {
  // ── Guard 1: placeholderComplaint names the "…" cause (pure) ──────────────────────────────────
  {
    ok(/placeholder/.test(es.placeholderComplaint('…') || ''), 'a bare "…" body is named as a placeholder');
    ok(/placeholder/.test(es.placeholderComplaint('...') || ''), 'an ASCII "..." body too');
    ok(/placeholder/.test(es.placeholderComplaint('  {…}  ') || ''), 'a "…" wrapped in braces/space still reads as a placeholder');
    ok(/placeholder/.test(es.placeholderComplaint('"…"') || ''), 'a quoted "…" too');
    ok(es.placeholderComplaint('{"sql":"SELECT 1"}') === null, 'real JSON is NOT flagged as a placeholder');
    ok(es.placeholderComplaint('') === null, 'an empty body is not a placeholder (that is the no-args case)');
    ok(es.placeholderComplaint('find the … in the middle') === null, 'a "…" INSIDE real text is left alone — only a whole-body placeholder counts');
  }

  // ── Guard 1 through the parser: a <echo-do> with a "…" body carries the sharp hint ─────────────
  {
    const tags = es.parseEchoTags('<echo-do name="db_query">…</echo-do>');
    ok(tags.length === 1 && tags[0].kind === 'do', 'the tag parses');
    ok(/placeholder/.test(tags[0].parseError || ''), '⭐ its parseError now NAMES the placeholder instead of a generic "invalid JSON"');
  }

  // ── Guard 2: sanitizeFtsQuery (pure) ───────────────────────────────────────────────────────────
  {
    ok(es.sanitizeFtsQuery("O'Brien") === 'O Brien', "an apostrophe → space (matches how unicode61 tokenizes O'Brien)");
    ok(es.sanitizeFtsQuery('rainey papers') === 'rainey papers', 'a clean query is byte-identical — untouched');
    ok(es.sanitizeFtsQuery('weather (modification)') === 'weather modification', 'parens stripped');
    ok(es.sanitizeFtsQuery('type:person') === 'type person', 'a colon stripped');
    ok(es.sanitizeFtsQuery('  a  b  ') === '  a  b  ', 'no breaker → returned verbatim, even with odd spacing');
  }

  // ── Guard 4: prepareDoArgs injects a db_query timeout only when absent (pure) ──────────────────
  {
    ok(es.prepareDoArgs('db_query', { sql: 'SELECT 1' }).timeout_seconds === 20, 'db_query with no timeout → default 20 injected');
    ok(es.prepareDoArgs('db_query', { sql: 'SELECT 1', timeout_seconds: 3 }).timeout_seconds === 3, "a caller's own timeout is respected — never overridden");
    const passthrough = { sql: 'SELECT 1' };
    ok(es.prepareDoArgs('db_query', passthrough).timeout_seconds === 20 && passthrough.timeout_seconds === undefined, 'PURE: the input object is not mutated');
    ok(es.prepareDoArgs('list_contacts', { state: 'MI' }).timeout_seconds === undefined, 'a non-db_query tool gets no timeout');
    const fts = es.prepareDoArgs('search_entities', { query: "O'Brien" });
    ok(fts.query === 'O Brien', 'an FTS tool with a breaker query is sanitized by prepareDoArgs');
    ok(es.prepareDoArgs('search_entities', { query: 'clean' }).query === 'clean', 'a clean FTS query is untouched');
    ok(es.prepareDoArgs('db_query', null) === null && es.prepareDoArgs('db_query', 'x') === 'x', 'non-object args pass through unharmed');
  }

  // ── Guard 3: recipeMisrouteHint (pure) ─────────────────────────────────────────────────────────
  {
    const isTool = (n) => n === 'search_documents_semantic';
    const argShape = (n) => n === 'search_documents_semantic' ? 'search_documents_semantic args: { "query": string (REQUIRED) }' : null;
    const hit = es.recipeMisrouteHint('search_documents_semantic', { isTool, argShape });
    ok(hit && /is a TOOL, not a recipe/.test(hit), 'a recipe-name that is really a tool → a redirect hint');
    ok(/<echo-do name="search_documents_semantic">/.test(hit) && /<echo-find>/.test(hit), 'the hint names BOTH the raw-tool grammar and the easy <echo-find> path');
    ok(/"query": string/.test(hit), 'and carries the tool signature so the next hop has the args');
    ok(es.recipeMisrouteHint('search-vault', { isTool, argShape }) === null, 'a genuine recipe name → null (the normal recipe path runs)');
    ok(es.recipeMisrouteHint('', { isTool }) === null, 'an empty name → null');
  }

  // ── end-to-end through dispatch: prepareDoArgs is actually applied before callTool ─────────────
  {
    const c = fakeClient();
    const suit = new es.EchoSuit({ client: c });
    await suit.connect();

    await suit.dispatch({ kind: 'do', name: 'db_query', args: { sql: 'SELECT COUNT(*) FROM entities' } });
    const dbCall = c.calls.find((x) => x.name === 'db_query');
    ok(dbCall && dbCall.args.timeout_seconds === 20, '⭐ dispatch hands db_query a 20s timeout the model never wrote');

    await suit.dispatch({ kind: 'do', name: 'search_entities', args: { query: "O'Brien", top_k: 5 } });
    const seCall = c.calls.find((x) => x.name === 'search_entities');
    ok(seCall && seCall.args.query === 'O Brien' && seCall.args.top_k === 5, "⭐ dispatch sanitizes the FTS query (O'Brien → O Brien) and keeps the other args");

    // Guard 1 end-to-end: a "…" body errors with the sharp hint AND the tool signature.
    const g1 = await suit.dispatch({ kind: 'do', name: 'db_query', parseError: es.placeholderComplaint('…'), args: null });
    ok(g1.isError && /placeholder/.test(g1.text) && /db_query args: \{ "sql": string \(REQUIRED\)/.test(g1.text), '⭐ a "…" db_query errors by NAMING the placeholder AND showing the real shape');

    // Guard 3 end-to-end: the tool-as-recipe never reaches run_recipe.
    const g3 = await suit.dispatch({ kind: 'recipe', name: 'search_documents_semantic', arg: 'weather' });
    ok(g3.isError && /is a TOOL, not a recipe/.test(g3.text), '⭐ a tool-called-as-recipe is redirected, not sent to run_recipe');
    ok(!c.calls.find((x) => x.name === 'run_recipe'), 'and run_recipe was never invoked for it');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
