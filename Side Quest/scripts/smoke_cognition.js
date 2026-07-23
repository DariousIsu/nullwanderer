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
// A mock dispatch: search_entities → the cabinet entity; db_query → the relations-table members (the graph
// traversal now reads `relations`, not the dead kg_neighborhood).
const dispatchMock = async (tag) => {
  if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 1656102, name: 'second cabinet of Donald J. Trump', entity_type: 'organization', entity_subtype: 'cabinet', summary: 'the cabinet of the second Trump administration' }] }) };
  if (tag.name === 'db_query') return { ok: true, text: JSON.stringify({ ok: true, rows: [
    { rt: 'HELD_OFFICE', md: '{"tenure_end":null,"role_type":"Secretary of State"}', id: 1484834, nm: 'Marco Rubio', et: 'person', est: '' },
    { rt: 'MEMBER_OF', md: '{}', id: 2, nm: 'Lee Zeldin', et: 'person', est: '' },
    { rt: 'MEMBER_OF', md: '{}', id: 3, nm: 'Ryan Zinke', et: 'person', est: '' } ] }) };
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
  const d = await cog.answerGrounded({ userMessage: 'latest on X?', grounding: '', deps: { ask: async ({ input }) => /Rubio|Secretary/.test(input.grounding) ? 'It is happening.' : 'NEED: latest on X', dispatch: emptyGraph, webSearch: webMock, newsStories: () => [] } });
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

  // 5b) FORECAST TIER (F2): an election-odds question leads with HER model, never a web guess.
  ok(cog.isForecastQuestion('who wins the senate in 2026?') && cog.isForecastQuestion('what are the odds the house flips?') && cog.isForecastQuestion('balance of power forecast for congress'),
    'isForecastQuestion: election odds/who-wins/balance-of-power questions detected');
  ok(!cog.isForecastQuestion('who is the senate majority leader?') && !cog.isForecastQuestion('what time is the house vote?'),
    'isForecastQuestion: a who-holds-office / logistics question is NOT a forecast question');
  const fcSnap = { ok: true, as_of: '2026-07-23', illustrative: false, work: { sim: { chambers: { senate: { pA_control: 0.62, seatsA_mean: 51, seatsA_p10: 48, seatsA_p90: 54, total_seats: 100, n_races: 35 } } } } };
  const efc = await cog._enrichForecast('senate 2026', { forecast: () => fcSnap });
  ok(efc.text && /P\(A control\) 62/.test(efc.text) && /48–54/.test(efc.text) && efc.source === 'forecast', '_enrichForecast: formats her model\'s chamber topline (control %, seat band)');
  ok((await cog._enrichForecast('x', { forecast: () => null })).text === '', '_enrichForecast: no run → empty (no-op, ladder falls through untouched)');
  const fc = await cog.answerGrounded({ userMessage: 'who wins the senate in the 2026 election?', grounding: '', deps: { ask: async ({ input }) => /control|seats|band/i.test(input.grounding) ? 'Her model gives Party A a 62% chance of Senate control.' : 'NEED: 2026 senate control odds', dispatch: emptyGraph, forecast: () => fcSnap, newsStories: () => [], webSearch: async () => ({ results: [] }) } });
  ok(fc && fc.enriched === true && fc.enrichSource === 'forecast' && /62%/.test(fc.say), 'forecast question → answered from HER model (leads the ladder, beats web)');

  // 6) THE dying-question fix: graph empty → WIKIPEDIA tier recovers a fact no local tier held.
  const wikiMock = async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since January 2025.' }];
  let wikiWb = null;
  const f = await cog.answerGrounded({ userMessage: 'who is the head of the EPA?', grounding: '', deps: { ask: async ({ input }) => /Zeldin|EPA/i.test(input.grounding) ? 'Lee Zeldin is the head of the EPA.' : 'NEED: head of the EPA', dispatch: emptyGraph, wikiLookup: wikiMock, newsStories: () => [], webSearch: async () => ({ results: [] }), writeBack: async (a) => { wikiWb = a; } } });
  ok(f && f.enriched === true && f.enrichSource === 'wiki' && /Zeldin/.test(f.say), 'graph empty → WIKI tier recovers the answer (the dying-question fix)');
  await new Promise(r => setTimeout(r, 5));
  ok(wikiWb && /Zeldin/.test(wikiWb.answer) && /wikipedia\.org/.test(wikiWb.url) && wikiWb.source === 'wiki', 'write-back EXTENDED: a WIKI recovery also feeds the DB (source url + answer)');
  ok(wikiWb && typeof wikiWb.content === 'string' && /Zeldin/.test(wikiWb.content), 'write-back carries the READ TEXT (content) — the grounding gate can check the answer against the page');

  // 7) CURRENCY VERIFY: grounding gives a plausible (stale) answer, but the question asks "now" → verify
  // against a fresh source and correct it.
  const askStale = async ({ input }) => /EPA|administrator/i.test(String(input.grounding)) ? 'Lee Zeldin is the EPA Administrator, since 2025.' : 'Lee Zeldin is a U.S. Representative.';
  const g = await cog.answerGrounded({ userMessage: 'what does Lee Zeldin do now?', grounding: 'Lee Zeldin — title: U.S. Representative', object: { name: 'Lee Zeldin' }, deps: { ask: askStale, newsStories: () => [], wikiLookup: async () => [{ title: 'Lee Zeldin', extract: 'Lee Zeldin is the 17th administrator of the EPA since Jan 2025.' }], writeBack: async () => {} } });
  ok(g && g.enrichSource === 'wiki-verify' && /EPA/.test(g.say), 'currency-marked question verifies stale records via wiki-verify');

  // 8) currency-marked but NO fresh source → keep the grounded answer (never worse than before).
  const h = await cog.answerGrounded({ userMessage: 'who is the CEO now?', grounding: 'Acme CEO is Jane Doe', object: { name: 'Acme' }, deps: { ask: async () => 'Jane Doe is the CEO.', newsStories: () => [], wikiLookup: async () => [], excavate: async () => ({ found: false }), writeBack: async () => {} } });
  ok(h && h.enrichSource === null && /Jane/.test(h.say), 'currency-marked but no fresh source → keep the grounded answer');

  // 9) _enrichWiki unit — returns { text, url } (source url for the write-back).
  const wr = await cog._enrichWiki('x', { wikiLookup: async () => [{ title: 'Lee Zeldin', extract: 'E' }] });
  ok(/From Wikipedia/.test(wr.text) && /wikipedia\.org\/wiki\/Lee_Zeldin/.test(wr.url), '_enrichWiki returns {text, source url}');
  ok((await cog._enrichWiki('x', { wikiLookup: async () => [] })).text === '', '_enrichWiki no pages → empty');

  // 9b) SALIENCE (the Pasig Cathedral miss, 2026-07-23): "parish leadership" searched bare resolved
  // to a Philippine cathedral while the talk had just established Ouachita Parish. The conversation's
  // anchor entities (deps.contextTerms) ride the wiki search; empty anchored result falls back bare.
  const _sSeen = [];
  const _twoSense = async (q) => { _sSeen.push(q); return /Ouachita/.test(q)
    ? [{ title: 'Ouachita Parish, Louisiana', extract: 'A parish in Louisiana; seat: Monroe.' }]
    : [{ title: 'Pasig Cathedral', extract: 'A Roman Catholic parish church in the Philippines.' }]; };
  const _sr = await cog._enrichWiki('parish leadership', { wikiLookup: _twoSense, contextTerms: ['Ouachita Parish', 'Monroe'] });
  ok(/Ouachita Parish, Louisiana/.test(_sr.text) && _sSeen[0] === 'parish leadership Ouachita Parish',
    'SALIENCE: the conversation anchor rides the wiki search — the talked-about sense wins');
  const _sSeen2 = [];
  const _sr2 = await cog._enrichWiki('plain need', { wikiLookup: async (q) => { _sSeen2.push(q); return /Anchorville/.test(q) ? [] : [{ title: 'Plain', extract: 'E' }]; }, contextTerms: ['Anchorville'] });
  ok(/Plain/.test(_sr2.text) && _sSeen2.length === 2, 'SALIENCE: an empty anchored search falls back to the bare need (never worse)');
  const _sSeen3 = [];
  await cog._enrichWiki('Ouachita Parish leadership', { wikiLookup: async (q) => { _sSeen3.push(q); return []; }, contextTerms: ['Ouachita Parish'] });
  ok(_sSeen3.length === 1 && _sSeen3[0] === 'Ouachita Parish leadership', 'SALIENCE: an anchor already inside the need never re-augments');

  // 9c) HER OWN NEWS STREAM (boots 47/48: three turns promised "fetching…" while the Iran story sat
  // current in her own bucket — the ladder had no news tier). A needs_fresh question reads it FIRST.
  const _mockStories = () => [
    { id: 1, title: 'Iran war live: US launches new attacks; Houthis attack 2 Saudi oil tankers', summary: 'Strikes resumed near Bandar Abbas; tanker traffic disrupted.', last_ts: Date.now() - 3600e3 },
    { id: 2, title: 'Local bake sale raises funds', summary: 'A bake sale happened.', last_ts: Date.now() - 7200e3 },
  ];
  const nr = await cog._enrichNews('latest update on the Iran war', { newsStories: _mockStories, newsUpdates: (id) => id === 1 ? [
    { title: 'Hormuz strait closed to tanker traffic', ts: Date.now() - 7200e3 },
    { title: 'US carrier group repositioned to the Gulf of Oman', ts: Date.now() - 1800e3 },
  ] : [] });
  ok(/From my own news stream/.test(nr.text) && /Bandar Abbas/.test(nr.text) && !/bake sale/.test(nr.text),
    'NEWS tier: the matching story surfaces with its substance; unrelated stories stay out');
  ok(/↳ latest: US carrier group repositioned/.test(nr.text) && /Hormuz strait closed/.test(nr.text),
    'NEWS tier: THE LATEST rides from the update rows, not just the story header (the 55k-updates sweep find)');
  ok((await cog._enrichNews('quantum topology seminar', { newsStories: _mockStories })).text === '' || !/Iran/.test((await cog._enrichNews('quantum topology seminar', { newsStories: _mockStories })).text.split('\n')[1] || ''),
    'NEWS tier: no real match → empty or weak (falls through to the next tier)');
  const nf = await cog.answerGrounded({ userMessage: 'what is the latest update on the Iran war?', grounding: '', deps: {
    ask: async ({ input }) => /Bandar Abbas|news stream/i.test(String(input.grounding)) ? 'Strikes resumed near Bandar Abbas and tanker traffic is disrupted.' : 'NEED: latest Iran war update',
    newsStories: _mockStories, dispatch: emptyGraph, wikiLookup: async () => [], webSearch: async () => ({ results: [] }), excavate: async () => ({ found: false }), writeBack: async () => {} } });
  ok(nf && nf.enriched === true && nf.enrichSource === 'news' && /Bandar Abbas/.test(nf.say),
    'NEWS tier end-to-end: a needs_fresh war question answers from HER OWN stream');

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

  // 10b) TRUNCATION GUARD — the freshest tier must LEAD the re-draft grounding. Regression lock for the proven
  // SecDef bug: an early verbose tier (a full wiki body) had already pinned the grounding at _draftOrNeed's
  // 4200-char cap, so the LATER excavate answer — appended last under the old ordering — fell past the cap and
  // the cloud never saw it. Here wiki returns >4200 chars of filler WITHOUT the answer, excavate returns the
  // answer; the mock ask only answers when the answer token survives into the (already-4200-sliced) grounding
  // it receives. PASSES iff fresh leads; would MISS under fresh-last (answer truncated away).
  const bigFiller = 'FILLER FILLER FILLER '.repeat(300);   // ~6300 chars, well past the 4200 cap, no answer token
  ok(bigFiller.length > 4200, 'guard precondition: filler exceeds the 4200-char draft cap');
  const y = await cog.answerGrounded({ userMessage: 'who holds the office of the thing?', grounding: '', deps: {
    ask: async ({ input }) => /Zephyr Kellander/.test(String(input.grounding)) ? 'The officeholder is Zephyr Kellander.' : 'NEED: current officeholder of the thing',
    dispatch: emptyGraph,
    wikiLookup: async () => [{ title: 'Office of the Thing', extract: bigFiller }],
    routeNeed: async () => ({ ok: false }),
    webSearch: async () => ({ results: [] }),
    excavate: async () => ({ found: true, answer: 'Zephyr Kellander holds the office.', url: 'https://en.wikipedia.org/wiki/Office_of_the_Thing' }),
    writeBack: async () => {} } });
  ok(y && y.enrichSource === 'excavate' && /Zephyr/.test(y.say), 'truncation guard: a late-tier answer survives the draft cap because the freshest tier LEADS the grounding');

  // 10c) CURRENCY-VERIFY MUST NOT SERVE A STALE GUESS ON FAILURE — the live "who is the president?" → "Joe
  // Biden" bug. A currency question with NO grounding drafts a pure model guess (stale training); when the
  // fresh check reaches nothing (Echo not ready seconds after a reboot), the OLD code returned that guess.
  // Fix: a pure guess (empty grounding) for a current fact that can't be verified falls through to the full
  // ladder → honest-miss if all fail; a grounded answer is still best-effort served.
  const presAsk = async ({ input }) => /trump/i.test(String(input.grounding)) ? 'Donald Trump is the president.' : 'Joe Biden is the president.';
  // (A) fresh check AND every ladder tier fail → honest miss, NEVER the stale guess
  const pA = await cog.answerGrounded({ userMessage: 'who is the president of the united states?', grounding: '', deps: {
    ask: presAsk, dispatch: emptyGraph, wikiLookup: async () => [], newsStories: () => [], excavate: async () => ({ found: false }),
    routeNeed: async () => ({ ok: false }), webSearch: async () => ({ results: [] }), writeBack: async () => {} } });
  ok(pA && pA.missed === true && !/Biden/i.test(pA.say), 'currency guard: unverifiable pure guess → honest miss, NOT the stale "Joe Biden"');
  // (B) fresh check fails but the WEB tier (which the verify loop lacks) recovers → correct current answer
  const pB = await cog.answerGrounded({ userMessage: 'who is the president of the united states?', grounding: '', deps: {
    ask: presAsk, dispatch: emptyGraph, wikiLookup: async () => [], newsStories: () => [], excavate: async () => ({ found: false }), routeNeed: async () => ({ ok: false }),
    webSearch: async () => ({ results: [{ url: 'https://x/pres', title: 'President', snippet: 'Donald Trump' }] }),
    fetchPage: async () => ({ ok: true, title: 'President', text: 'The current president of the United States is Donald Trump, who assumed office on January 20, 2025. '.repeat(2) }),
    writeBack: async () => {} } });
  ok(pB && pB.enrichSource === 'web' && /Trump/.test(pB.say) && !/Biden/i.test(pB.say), 'currency guard: fresh-check fails but the fall-through ladder (web) recovers the current answer');

  // 10d) OFFICE-HOLDER Q → FRESH SOURCES LEAD (our KG may be stale). Regression lock for the live "who's the
  // president?" → graph tier served Echo's stale "Joe Biden". The graph would answer "Biden"; wiki answers the
  // fresh "Trump". Because it's an office-holder question the ladder must run wiki FIRST → Trump, not the KG's
  // stale Biden. ("who's the" isn't matched by _CURRENCY_RE — the office-word signal is what triggers it.)
  const staleKgDispatch = async ({ name }) => name === 'search_entities'
    ? { ok: true, text: JSON.stringify([{ name: 'Joe Biden', entity_type: 'person', summary: '46th president of the United States' }]) }
    : { ok: true, text: JSON.stringify({ rows: [] }) };
  const od = await cog.answerGrounded({ userMessage: "who's the president?", grounding: '', deps: {
    ask: async ({ input }) => { const gg = String(input.grounding); return /trump/i.test(gg) ? 'Donald Trump is the president.' : (/biden/i.test(gg) ? 'Joe Biden is the president.' : 'NEED: current US president'); },
    dispatch: staleKgDispatch, wikiLookup: async () => [{ title: 'President of the United States', extract: 'The current president of the United States is Donald Trump, who assumed office on January 20, 2025.' }],
    webSearch: async () => ({ results: [] }), excavate: async () => ({ found: false }), routeNeed: async () => ({ ok: false }), writeBack: async () => {} } });
  ok(od && od.enrichSource === 'wiki' && /Trump/.test(od.say) && !/Biden/i.test(od.say), 'office-holder Q: FRESH (wiki) leads over our stale graph → "Trump", not the KG stale "Biden"');
  // 10e) CONTROL: a multi-hop question (no office word) must STILL lead with the graph — the reorder is office-scoped.
  const graphDispatch = async ({ name }) => name === 'search_entities'
    ? { ok: true, text: JSON.stringify([{ name: 'Sam Altman', entity_type: 'person', summary: 'CEO of OpenAI, the company that makes ChatGPT' }]) }
    : { ok: true, text: JSON.stringify({ rows: [] }) };
  const md = await cog.answerGrounded({ userMessage: 'who leads the company that makes ChatGPT?', grounding: '', deps: {
    ask: async ({ input }) => /altman/i.test(String(input.grounding)) ? 'Sam Altman leads OpenAI.' : 'NEED: leader of the company that makes ChatGPT',
    dispatch: graphDispatch, wikiLookup: async () => [{ title: 'x', extract: 'irrelevant filler' }],
    webSearch: async () => ({ results: [] }), excavate: async () => ({ found: false }), routeNeed: async () => ({ ok: false }), writeBack: async () => {} } });
  ok(md && md.enrichSource === 'graph' && /Altman/.test(md.say), 'multi-hop Q (no office word): graph still leads → OpenAI→Altman (reorder is office-scoped)');
  // 10f) cognition consumes the PARSED INTENT (the model-primary replacement for the phrase regexes). The
  // deps.intent seam supplies what a model would return for "who runs the country?" — a phrasing with NO
  // office word, which the regex fallback classifies "other" (→ graph-first → stale Biden). With the parsed
  // office_holder intent it routes fresh-only → wiki → Trump. This is the phrasing-robustness the model buys.
  const ri = await cog.answerGrounded({ userMessage: 'who runs the country?', grounding: '', deps: {
    intent: { kind: 'office_holder', topic: 'President of the United States', needs_fresh: true },
    ask: async ({ input }) => /trump/i.test(String(input.grounding)) ? 'Donald Trump runs the country as president.' : 'NEED: current US president',
    dispatch: staleKgDispatch, wikiLookup: async () => [{ title: 'President of the United States', extract: 'The current president of the United States is Donald Trump, since January 20, 2025.' }],
    webSearch: async () => ({ results: [] }), excavate: async () => ({ found: false }), routeNeed: async () => ({ ok: false }), writeBack: async () => {} } });
  ok(ri && ri.enrichSource === 'wiki' && /Trump/.test(ri.say) && !/Biden/i.test(ri.say), 'cognition consumes parsed intent: "who runs the country?" (no office word) → office_holder → wiki → Trump');

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
    now: NOW, newsStories: () => [],
    ask: async ({ input }) => /New Person/i.test(String(input.grounding)) ? 'New Person chairs Acme.' : 'Old Person chairs Acme.',
    wikiLookup: async () => [{ title: 'Acme', extract: 'The current chair of Acme is New Person.' }], writeBack: async () => {} } });
  ok(stv && stv.enrichSource === 'wiki-verify' && /New Person/.test(stv.say), 'staleness: stale fact in grounding → re-verify → fresh answer (no currency word needed)');
  const frv = await cog.answerGrounded({ userMessage: 'who chairs Acme', grounding: '[VERIFIED as of 2026-07-05] The current chair of Acme is Person.', object: { name: 'Acme' }, deps: {
    now: NOW, newsStories: () => [], ask: async () => 'Person chairs Acme.', wikiLookup: async () => { throw new Error('wiki should not be called for a fresh fact'); } } });
  ok(frv && frv.enrichSource === null && /Person/.test(frv.say), 'staleness: a FRESH verified fact does not trigger re-verify');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
