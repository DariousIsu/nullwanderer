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
  const c = await cog.answerGrounded({ userMessage: 'who are the members of his cabinet?', grounding: 'Donald Trump (US) — President', object: { id: 1528616, name: 'Donald Trump (US)' }, deps: { ask: askMock, dispatch: emptyDispatch } });
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

  // 6) THE dying-question fix: graph empty → WIKIPEDIA tier recovers a fact no local tier held.
  const wikiMock = async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since January 2025.' }];
  const f = await cog.answerGrounded({ userMessage: 'who is the head of the EPA?', grounding: '', deps: { ask: async ({ input }) => /Zeldin|EPA/i.test(input.grounding) ? 'Lee Zeldin is the head of the EPA.' : 'NEED: head of the EPA', dispatch: emptyGraph, wikiLookup: wikiMock } });
  ok(f && f.enriched === true && f.enrichSource === 'wiki' && /Zeldin/.test(f.say), 'graph empty → WIKI tier recovers the answer (the dying-question fix)');

  // 7) CURRENCY VERIFY: grounding gives a plausible (stale) answer, but the question asks "now" → verify
  // against a fresh source and correct it.
  const askStale = async ({ input }) => /EPA|administrator/i.test(String(input.grounding)) ? 'Lee Zeldin is the EPA Administrator, since 2025.' : 'Lee Zeldin is a U.S. Representative.';
  const g = await cog.answerGrounded({ userMessage: 'what does Lee Zeldin do now?', grounding: 'Lee Zeldin — title: U.S. Representative', object: { name: 'Lee Zeldin' }, deps: { ask: askStale, wikiLookup: async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since Jan 2025.' }] } });
  ok(g && g.enrichSource === 'wiki-verify' && /EPA/.test(g.say), 'currency-marked question verifies stale records via wiki-verify');

  // 8) currency-marked but NO fresh source → keep the grounded answer (never worse than before).
  const h = await cog.answerGrounded({ userMessage: 'who is the CEO now?', grounding: 'Acme CEO is Jane Doe', object: { name: 'Acme' }, deps: { ask: async () => 'Jane Doe is the CEO.', wikiLookup: async () => [] } });
  ok(h && h.enrichSource === null && /Jane/.test(h.say), 'currency-marked but no fresh source → keep the grounded answer');

  // 9) _enrichWiki formatting unit.
  ok(/From Wikipedia/.test(await cog._enrichWiki('x', { wikiLookup: async () => [{ title: 'T', extract: 'E' }] })), '_enrichWiki formats found pages');
  ok((await cog._enrichWiki('x', { wikiLookup: async () => [] })) === '', '_enrichWiki no pages → empty string');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
