/* Smoke: lib/graph_walk — the subconscious graph-builder. Fully offline: cloud / web / recall /
 * dispatch are all injected fakes. Asserts the ANCHOR→RESOLVE→WALK→GUARD→VOICE move: it picks a
 * recent-conversation GAP (missing/thin, not rich), fills from web+cloud, PROPOSES the missing
 * object + related objects + connecting edges under budget, records visited (no re-anchor), and
 * returns a voice line only for a notable move.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_graph_walk.js
 */
const G = require('../lib/graph_walk');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- pure helpers ---
ok(Array.isArray(G.parseJsonLoose('junk ["A","B"] tail')) , 'parseJsonLoose digs a JSON array out of prose');
ok(G.parseJsonLoose('not json') === null, 'parseJsonLoose → null on garbage');
ok(G.classifyObject(null) === 'missing', 'classifyObject: null → missing');
ok(G.classifyObject({ degree: 2, facts: [] }) === 'thin', 'classifyObject: low degree + no facts → thin');
ok(G.classifyObject({ degree: 320, facts: ['a', 'b', 'c', 'd'] }) === 'rich', 'classifyObject: rich object → rich');
ok(G.classifyObject({ degree: 1, committees: ['Energy'] }) === 'rich', 'classifyObject: a committee makes it non-thin');
const pn = G.extractProperNouns('We met Sen. John Curtis about the Nuclear Innovation Alliance today.');
ok(pn.some(n => /John Curtis/.test(n)) && !pn.some(n => /^Sen/.test(n)), 'extractProperNouns: gets "John Curtis", drops the honorific');
ok(pn.some(n => /Nuclear Innovation Alliance/.test(n)), 'extractProperNouns: multi-word org captured');

// --- rankGaps: missing first, then thin (thinnest first); rich + visited dropped ---
const assessed = [
  { mention: 'Rich Corp', kind: 'rich', object: { degree: 99 } },
  { mention: 'Thin B', kind: 'thin', object: { degree: 5 } },
  { mention: 'Missing A', kind: 'missing', object: null },
  { mention: 'Thin C', kind: 'thin', object: { degree: 1 } }
];
const ranked = G.rankGaps(assessed, new Set());
ok(ranked[0].mention === 'Missing A', 'rankGaps: missing anchor first');
ok(ranked[1].mention === 'Thin C' && ranked[2].mention === 'Thin B', 'rankGaps: thin ordered thinnest-first');
ok(!ranked.some(r => r.mention === 'Rich Corp'), 'rankGaps: rich dropped');
const rankedV = G.rankGaps(assessed, new Set([G.visitKey('Missing A')]));
ok(rankedV[0].mention === 'Thin C', 'rankGaps: a visited anchor is skipped');

(async () => {
  // --- extractCandidates: cloud first, regex fallback ---
  const turns = [
    { speaker: 'user', content: 'Can you prep for our meeting with the Nuclear Innovation Alliance?' },
    { speaker: 'ai_said', content: 'Sure.' }
  ];
  const cloudList = async () => '["Nuclear Innovation Alliance","R Street Institute"]';
  const c1 = await G.extractCandidates(turns, { cloud: cloudList });
  ok(c1[0] === 'Nuclear Innovation Alliance' && c1.includes('R Street Institute'), 'extractCandidates: uses the cloud list');
  const c2 = await G.extractCandidates(turns, { cloud: async () => 'garbage' });
  ok(c2.some(n => /Nuclear Innovation Alliance/.test(n)), 'extractCandidates: falls back to regex when cloud gives garbage');

  // --- assessGaps: Echo-first classify ---
  const recall = async (name) => name === 'Rich Person' ? { degree: 300, facts: ['a', 'b', 'c'] } : (name === 'Thin Org' ? { id: 42, degree: 2, facts: [], neighbors: ['Existing Ally'] } : null);
  const gaps = await G.assessGaps(['Missing Thing', 'Thin Org', 'Rich Person'], { recall });
  ok(gaps[0].kind === 'missing' && gaps[1].kind === 'thin' && gaps[2].kind === 'rich', 'assessGaps: classifies missing/thin/rich via recall');

  // --- growAround a MISSING anchor: proposes the entity + related + edges, under budget ---
  const calls = [];
  const dispatch = async (tag) => { calls.push([tag.name, tag.args]); return { ok: true, text: '{"status":"pending_verification"}' }; };
  const web = async () => [{ text: 'The Nuclear Innovation Alliance is a nuclear policy nonprofit that works with Congress.' }];
  const dossierCloud = async () => JSON.stringify({
    entity_type: 'organization',
    summary: 'A nuclear-energy policy nonprofit that advances advanced reactor deployment and works with Congress.',
    related: [
      { name: 'Advanced Reactor Demonstration Program', type: 'concept', relation: 'advocates_for' },
      { name: 'John Curtis', type: 'person', relation: 'engages_with' }
    ]
  });
  const grown = await G.growAround(
    { mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null },
    { web, cloud: dossierCloud, dispatch }
  );
  ok(grown.built === true, 'growAround: a missing anchor is BUILT (propose_entity)');
  ok(calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Nuclear Innovation Alliance'), 'growAround: proposes the anchor entity itself');
  ok(calls.some(c => c[0] === 'propose_relation'), 'growAround: proposes connecting edges');
  ok(grown.connections >= 1 && grown.connections <= G.WALK_MAX_CONNECTIONS, 'growAround: connections within budget');
  ok(grown.summary.length > 10, 'growAround: carries the grounded summary');

  // --- growAround a THIN anchor: does NOT re-propose an existing neighbour edge ---
  calls.length = 0;
  const thinCloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'x', related: [{ name: 'Existing Ally', type: 'organization', relation: 'allied_with' }, { name: 'New Partner', type: 'organization', relation: 'partners_with' }] });
  const grownThin = await G.growAround(
    { mention: 'Thin Org', kind: 'thin', object: { id: 42, degree: 2, neighbors: ['Existing Ally'] } },
    { web, cloud: thinCloud, dispatch }
  );
  ok(!calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Thin Org'), 'growAround: does NOT re-propose the existing thin anchor entity');
  ok(!calls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Existing Ally'), 'growAround: skips an edge that already exists in the graph');
  ok(calls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'New Partner'), 'growAround: still forges the NEW connection');

  // --- runMove end-to-end + visited guard ---
  const meta = {};
  const getMeta = (k) => meta[k]; const setMeta = (k, v) => { meta[k] = v; };
  const recall2 = async () => null;  // everything missing → the top candidate anchors
  const move = await G.runMove({ recentTurns: turns, cloud: async (msgs) => (String(msgs[0].content).includes('extract') || String(msgs[1] && msgs[1].content).includes('array')) ? '["Nuclear Innovation Alliance"]' : dossierCloud(), web, recall: recall2, dispatch, getMeta, setMeta, now: () => 1000 });
  ok(move.acted === true && move.anchor === 'Nuclear Innovation Alliance', 'runMove: anchors on the conversation gap and acts');
  ok(typeof move.voiceLine === 'string' && move.voiceLine.length > 0, 'runMove: returns a voice line for a notable move');
  ok(G.visitedKeySet(getMeta, 1000).has(G.visitKey('Nuclear Innovation Alliance')), 'runMove: records the anchor as visited');
  const move2 = await G.runMove({ recentTurns: turns, cloud: async () => '["Nuclear Innovation Alliance"]', web, recall: recall2, dispatch, getMeta, setMeta, now: () => 2000 });
  ok(move2.acted === false && move2.reason === 'no-gap', 'runMove: a just-visited anchor is skipped → quiet (no re-anchor)');

  // --- no candidates → quiet ---
  const moveQuiet = await G.runMove({ recentTurns: [], cloud: async () => '[]', web, recall: recall2, dispatch, getMeta, setMeta, now: () => 3000 });
  ok(moveQuiet.acted === false, 'runMove: empty conversation → quiet (no forced noise)');

  // --- injected candidates (idle_anchors cascade) + iterate-until-grow (no-op-move fix) ---
  // Two MISSING anchors: the first yields no dossier (a dud → no growth); the move must iterate PAST it
  // to the second, which builds. This is the fix for the "anchor on one un-growable node, voice nothing"
  // stall. recentTurns is empty, so ONLY the injected list can be driving this.
  const meta2 = {}; const gM = (k) => meta2[k]; const sM = (k, v) => { meta2[k] = v; };
  const iterCloud = async (msgs) => {
    const u = String((msgs[1] && msgs[1].content) || (msgs[0] && msgs[0].content) || '');
    if (/Entity: "Buildable Co"/.test(u)) return JSON.stringify({ entity_type: 'organization', summary: 'A real org that partners with others on water technology and policy.', related: [{ name: 'Partner X', type: 'organization', relation: 'partners_with' }] });
    if (/Entity: "Dud Co"/.test(u)) return 'not json — no dossier here';   // dud → dossier null → no growth
    return '[]';
  };
  const moveInj = await G.runMove({
    recentTurns: [],
    candidates: [{ mention: 'Dud Co', source: 'frontier' }, { mention: 'Buildable Co', source: 'news' }],
    cloud: iterCloud, web, recall: async () => null, dispatch, getMeta: gM, setMeta: sM, now: () => 5000
  });
  ok(moveInj.acted === true && moveInj.anchor === 'Buildable Co', 'runMove: injected candidates drive it; iterates PAST the dud to the buildable anchor');
  ok(moveInj.source === 'news', 'runMove: carries the winning anchor source tag (news)');
  ok(G.visitedKeySet(gM, 5000).has(G.visitKey('Dud Co')), 'runMove: the tried-but-dud anchor is still recorded visited (no re-grind next tick)');

  // --- PRE-CLASSIFIED frontier candidate is NOT rich-flipped by recall ---
  // recall would call this a rich same-name twin, but a frontier candidate carries its own {kind,object}
  // (selected by graph degree), so runMove enriches it instead of dropping it.
  const meta3 = {}; const gM3 = (k) => meta3[k]; const sM3 = (k, v) => { meta3[k] = v; };
  const richRecall = async () => ({ degree: 999, facts: ['a', 'b', 'c', 'd'] });   // recall says RICH (a famous twin)
  const thinCloud2 = async () => JSON.stringify({ entity_type: 'organization', summary: 'A small local org.', related: [{ name: 'New Ally Org', type: 'organization', relation: 'allied_with' }] });
  const kgNbr = async () => [];   // the real thin node has no existing neighbours
  const preCalls = [];
  const dispatchPre = async (tag) => { preCalls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; };
  const movePre = await G.runMove({
    recentTurns: [],
    candidates: [{ mention: 'Thin Local Org', source: 'frontier', kind: 'thin', object: { id: 555, degree: 2, canonical: 'Thin Local Org [Q999]' } }],
    cloud: thinCloud2, web, recall: richRecall, dispatch: dispatchPre, kgNeighbors: kgNbr, getMeta: gM3, setMeta: sM3, now: () => 7000
  });
  ok(movePre.acted === true && movePre.source === 'frontier', 'runMove: a pre-classified frontier node is enriched, NOT rich-flipped by recall');
  ok(movePre.connections >= 1, 'runMove: frontier enrichment forges a new connection');
  ok(preCalls.some(c => c[0] === 'propose_relation' && c[1].source_name === 'Thin Local Org [Q999]'), 'runMove: propose_relation targets the CANONICAL name (exact node), not the clean mention');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
