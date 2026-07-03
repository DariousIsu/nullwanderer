/* Smoke: lib/cognition.js — the enrich/recovery loop (offline, injected deps → gate-safe).
 * Proves: NEED detection, graph-first enrich (+ web fallback), and the answer→NEED→enrich→redraft path
 * that turns a dead-end ("records don't specify") into a found answer.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cognition.js
 */
'use strict';
const cog = require('../lib/cognition');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// A mock cloud `ask`: answers when the grounding names cabinet members, else emits NEED.
const askMock = async ({ input }) => {
  const g = String(input.grounding || '');
  if (/Marco Rubio|cabinet:/i.test(g)) return 'Trump’s cabinet includes Marco Rubio and Lee Zeldin.';
  return 'NEED: members of Donald Trump’s cabinet';
};
// A mock dispatch: search_entities → the cabinet entity; kg_neighborhood → the members.
const dispatchMock = async (tag) => {
  if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 1656102, name: 'second cabinet of Donald J. Trump', entity_type: 'organization', entity_subtype: 'cabinet', summary: 'the cabinet of the second Trump administration' }] }) };
  if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [{ name: 'Marco Rubio' }, { name: 'Lee Zeldin' }, { name: 'Ryan Zinke' }] }) };
  if (tag.name === 'web_search') return { ok: true, text: JSON.stringify({ results: [{ title: 'Trump cabinet', snippet: 'Rubio Secretary of State' }] }) };
  return { ok: false };
};
const emptyDispatch = async () => ({ ok: true, text: '{"result":[]}' });

(async () => {
  ok('NEED: x'.match(cog.NEED_RE)[1] === 'x', 'NEED_RE parses the need');

  // 1) grounding already answers → no enrich
  const a = await cog.answerGrounded({ userMessage: 'who is in his cabinet?', grounding: 'cabinet: Marco Rubio, Lee Zeldin', deps: { ask: askMock, dispatch: dispatchMock } });
  ok(a && a.enriched === false && /Rubio/.test(a.say), 'sufficient grounding → grounded answer, no enrich');

  // 2) THE cabinet case: thin grounding → NEED → graph enrich → redraft → found answer
  const b = await cog.answerGrounded({ userMessage: 'who are the members of his cabinet?', grounding: 'Donald Trump (US) — President', object: { id: 1528616, name: 'Donald Trump (US)' }, deps: { ask: askMock, dispatch: dispatchMock } });
  ok(b && b.enriched === true && b.enrichSource === 'graph', 'thin grounding → NEED → GRAPH enrich → answer (the cabinet fix)');
  ok(b && /Rubio/.test(b.say), 'enriched answer names the members it went and found');

  // 3) NEED but nothing found anywhere → honest recovery, NOT a dead-end, NOT invented
  const c = await cog.answerGrounded({ userMessage: 'who are the members of his cabinet?', grounding: 'Donald Trump (US) — President', object: { id: 1528616, name: 'Donald Trump (US)' }, deps: { ask: askMock, dispatch: emptyDispatch, webSearch: async () => ({ results: [] }), excavate: async () => ({ found: false }) } });
  ok(c && c.missed === true && /couldn't/i.test(c.say) && !/Rubio/.test(c.say), 'nothing found → honest "couldn\'t pin down", never invented');

  // 4) graph empty → escalate to WEB via deps.webSearch (the app's own DDG, not Echo's keyless one)
  const emptyGraph = async () => ({ ok: true, text: '{"result":[]}' });
  const webMock = async (q) => ({ results: [{ title: 'Trump cabinet', snippet: 'Marco Rubio Secretary of State' }] });
  const d = await cog.answerGrounded({ userMessage: 'latest on X?', grounding: '', deps: { ask: async ({ input }) => /Rubio|Secretary/.test(input.grounding) ? 'It is happening.' : 'NEED: latest on X', dispatch: emptyGraph, webSearch: webMock } });
  ok(d && d.enriched === true && d.enrichSource === 'web', 'empty graph → escalate to WEB (deps.webSearch) → answer');

  // 5) graph empty → cloud TOOL EXECUTOR (routeNeed) answers a count before falling to web
  const routeMock = async (q) => ({ ok: true, text: 'John Curtis sponsored 42 bills in the 118th Congress.', chose: 'recipe count-bills' });
  const e = await cog.answerGrounded({ userMessage: 'how many bills did Curtis sponsor?', grounding: 'John Curtis (US-US) — US Senator', object: { id: 1524282, name: 'John Curtis (US-US)' }, deps: { ask: async ({ input }) => /42/.test(input.grounding) ? 'Curtis sponsored 42 bills.' : 'NEED: number of bills sponsored by John Curtis', dispatch: emptyGraph, routeNeed: routeMock } });
  ok(e && e.enriched === true && e.enrichSource === 'routed' && /42/.test(e.say), 'graph empty → routeNeed (cloud tool executor) answers the count');
  // _enrichRouted must NOT feed an error / no-fit result as grounding (the stale "Lloyd Austin" bug: an
  // error-as-grounding made the model confabulate from training AND short-circuit excavation).
  ok((await cog._enrichRouted('x', { routeNeed: async () => ({ ok: false, isError: true, text: '1 validation error: unexpected keyword argument for the tool' }) })).text === '', '_enrichRouted: tool error → no grounding (never confabulate from an error)');
  ok((await cog._enrichRouted('x', { routeNeed: async () => ({ ok: false, routed: true, text: 'I looked for an Echo tool but nothing fit; this may be an open-web question.' }) })).text === '', '_enrichRouted: no-fit message → no grounding');
  ok(/42/.test((await cog._enrichRouted('x', { routeNeed: async () => ({ ok: true, text: 'John Curtis sponsored 42 bills in the 118th Congress.', chose: 'recipe count' }) })).text), '_enrichRouted: genuine success → grounding');

  // 6) THE dying-question fix: graph empty → WIKIPEDIA tier recovers a fact no local tier held.
  const wikiMock = async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since January 2025.' }];
  let wikiWb = null;
  const f = await cog.answerGrounded({ userMessage: 'who is the head of the EPA?', grounding: '', deps: { ask: async ({ input }) => /Zeldin|EPA/i.test(input.grounding) ? 'Lee Zeldin is the head of the EPA.' : 'NEED: head of the EPA', dispatch: emptyGraph, wikiLookup: wikiMock, webSearch: async () => ({ results: [] }), writeBack: async (a) => { wikiWb = a; } } });
  ok(f && f.enriched === true && f.enrichSource === 'wiki' && /Zeldin/.test(f.say), 'graph empty → WIKI tier recovers the answer (the dying-question fix)');
  await new Promise(r => setTimeout(r, 5));
  ok(wikiWb && /Zeldin/.test(wikiWb.answer) && /wikipedia\.org/.test(wikiWb.url) && wikiWb.source === 'wiki', 'write-back EXTENDED: a WIKI recovery also feeds the DB (source url + answer)');

  // 7) CURRENCY VERIFY: grounding gives a plausible (stale) answer, but the question asks "now" → verify
  // against a fresh source and correct it.
  const askStale = async ({ input }) => /EPA|administrator/i.test(String(input.grounding)) ? 'Lee Zeldin is the EPA Administrator, since 2025.' : 'Lee Zeldin is a U.S. Representative.';
  const g = await cog.answerGrounded({ userMessage: 'what does Lee Zeldin do now?', grounding: 'Lee Zeldin — title: U.S. Representative', object: { name: 'Lee Zeldin' }, deps: { ask: askStale, wikiLookup: async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since Jan 2025.' }], writeBack: async () => {} } });
  ok(g && g.enrichSource === 'wiki-verify' && /EPA/.test(g.say), 'currency-marked question verifies stale records via wiki-verify');

  // 8) currency-marked but NO fresh source → keep the grounded answer (never worse than before).
  const h = await cog.answerGrounded({ userMessage: 'who is the CEO now?', grounding: 'Acme CEO is Jane Doe', object: { name: 'Acme' }, deps: { ask: async () => 'Jane Doe is the CEO.', wikiLookup: async () => [], excavate: async () => ({ found: false }), writeBack: async () => {} } });
  ok(h && h.enrichSource === null && /Jane/.test(h.say), 'currency-marked but no fresh source → keep the grounded answer');

  // 9) _enrichWiki unit — returns { text, url } (source url for the write-back).
  const wr = await cog._enrichWiki('x', { wikiLookup: async () => [{ title: 'Lee Zeldin', extract: 'E' }] });
  ok(/From Wikipedia/.test(wr.text) && /wikipedia\.org\/wiki\/Lee_Zeldin/.test(wr.url), '_enrichWiki returns {text, source url}');
  ok((await cog._enrichWiki('x', { wikiLookup: async () => [] })).text === '', '_enrichWiki no pages → empty');

  // 10) ALL cheaper tiers miss → FORENSIC EXCAVATION reads it off the rendered page AND kicks the write-back.
  let wbCall = null;
  const excavateMock = async () => ({ found: true, answer: 'Pete Hegseth is the U.S. Secretary of Defense.', url: 'https://en.wikipedia.org/wiki/United_States_Secretary_of_Defense' });
  const x = await cog.answerGrounded({ userMessage: 'who is the current secretary of defense?', grounding: '', deps: {
    ask: async ({ input }) => /Hegseth|rendered page/i.test(String(input.grounding)) ? 'Pete Hegseth is the Secretary of Defense.' : 'NEED: current US Secretary of Defense',
    dispatch: emptyGraph, webSearch: async () => ({ results: [] }), excavate: excavateMock, writeBack: async (a) => { wbCall = a; } } });
  ok(x && x.enrichSource === 'excavate' && /Hegseth/.test(x.say), 'all text tiers miss → forensic excavation recovers the answer');
  ok((await cog._enrichExcavate('x', { excavate: async () => ({ found: false }) })).text === '', '_enrichExcavate not-found → empty');
  await new Promise(r => setTimeout(r, 5));   // let the fire-and-forget write-back run
  ok(wbCall && /Hegseth/.test(wbCall.answer) && /Secretary_of_Defense/.test(wbCall.url) && wbCall.source === 'excavate', 'self-heal: excavation kicks the write-back with answer + source URL (non-blocking)');

  // 11) _kickWriteBack skips when there's no source URL (graph/routed = our own data → nothing to bank).
  let kicked = false;
  cog._kickWriteBack({ query: 'q', answer: 'a', url: null, source: 'graph', deps: { writeBack: async () => { kicked = true; } } });
  await new Promise(r => setTimeout(r, 5));
  ok(!kicked, '_kickWriteBack: no source URL → no write-back (our-own-data tiers do not re-bank)');

  // 12) EXCAVATION GUARD — fire for fact lookups (research fuel), skip subjective/advice (don't pop browser).
  ok(cog._worthExcavating('current US Secretary of Defense') === true, 'guard: fact lookup → excavate');
  ok(cog._worthExcavating('who is grace hopper') === true, 'guard: who-is entity → excavate');
  ok(cog._worthExcavating('population of mongolia') === true, 'guard: quantity fact → excavate');
  ok(cog._worthExcavating('what is the best pizza topping') === false, 'guard: subjective "best" → skip');
  ok(cog._worthExcavating('should i invest in crypto') === false, 'guard: advice → skip');
  ok(cog._worthExcavating('hi') === false, 'guard: too short → skip');
  let excCalled = false;
  const skip = await cog._enrichExcavate('what is the best movie ever', { excavate: async () => { excCalled = true; return { found: true, answer: 'x', url: 'u' }; } });
  ok(skip.text === '' && !excCalled, 'guard: _enrichExcavate skips the browser for a subjective need');

  // 13) STALENESS re-verify — a STALE volatile verified_fact in grounding triggers a fresh re-check
  // (even without a currency word in the question), then supersedes it. Fresh facts do NOT re-verify.
  const NOW = Date.parse('2026-07-08');
  ok(cog._hasStaleGrounding('[VERIFIED as of 2026-01-01] The current chair of Acme is Old Person.', NOW) === true, '_hasStaleGrounding: aged volatile fact → stale');
  ok(cog._hasStaleGrounding('[VERIFIED as of 2026-07-05] The current chair of Acme is New Person.', NOW) === false, '_hasStaleGrounding: recent fact → not stale');
  ok(cog._hasStaleGrounding('[VERIFIED as of 1973-02-16] Acme was founded in 1973.', NOW) === false, '_hasStaleGrounding: permanent fact (founding) → never stale');
  const staleG = '[VERIFIED as of 2026-01-01] The current chair of Acme is Old Person.';
  const stv = await cog.answerGrounded({ userMessage: 'who chairs Acme', grounding: staleG, object: { name: 'Acme' }, deps: {
    now: NOW,
    ask: async ({ input }) => /New Person/i.test(String(input.grounding)) ? 'New Person chairs Acme.' : 'Old Person chairs Acme.',
    wikiLookup: async () => [{ title: 'Acme', extract: 'The current chair of Acme is New Person.' }], writeBack: async () => {} } });
  ok(stv && stv.enrichSource === 'wiki-verify' && /New Person/.test(stv.say), 'staleness: stale fact in grounding → re-verify → fresh answer (no currency word needed)');
  const frv = await cog.answerGrounded({ userMessage: 'who chairs Acme', grounding: '[VERIFIED as of 2026-07-05] The current chair of Acme is Person.', object: { name: 'Acme' }, deps: {
    now: NOW, ask: async () => 'Person chairs Acme.', wikiLookup: async () => { throw new Error('wiki should not be called for a fresh fact'); } } });
  ok(frv && frv.enrichSource === null && /Person/.test(frv.say), 'staleness: a FRESH verified fact does not trigger re-verify');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
