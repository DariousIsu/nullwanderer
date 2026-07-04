/* Smoke: lib/idle_anchors — GROUNDED anchor sourcing for the idle graph-builder. Fully offline.
 * Asserts the three-tier cascade (news → thin frontier → convo), cross-tier dedup, visited filtering,
 * junk/stopword rejection, corroboration-weighted news ranking, thinnest-first frontier, and the
 * fail-soft async gatherer.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_idle_anchors.js
 */
const A = require('../lib/idle_anchors');
const { visitKey } = require('../lib/graph_walk');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- tier 1: news principals, corroboration-weighted, junk-filtered ---
const news = [
  { name: 'Story A', principals: ['Emergence Water', 'Tyler Breton', 'zoe'], corroboration: { independent: 5 } },
  { name: 'Story B', principals: ['Emergence Water', 'the'], corroboration: { independent: 3 } },
  { name: 'Story C', principals: ['Watergen'], corroboration: { independent: 1 } }
];
const nc = A.newsCandidates(news);
ok(nc[0] === 'Emergence Water', 'newsCandidates: most-corroborated principal (5+3) ranks first');
ok(nc.includes('Tyler Breton') && nc.includes('Watergen'), 'newsCandidates: keeps other real principals');
ok(!nc.some(n => /^(zoe|the)$/i.test(n)), 'newsCandidates: drops stopword/self principals');

// --- tier 2: frontier thin nodes, thinnest first, deduped, id preserved ---
const thin = [
  { id: 10, name: 'R Street Institute', degree: 6 },
  { id: 11, name: 'Cicero Institute', degree: 2 },
  { id: 11, name: 'Cicero Institute', degree: 2 },   // dup
  { id: 99, name: 'I', degree: 0 }                    // junk
];
const fc = A.frontierCandidates(thin);
ok(fc[0].name === 'R Street Institute' && fc[0].id === 10, 'frontierCandidates: most-connectable (degree 6, DESC) first, id preserved');
ok(fc.filter(r => r.name === 'Cicero Institute').length === 1, 'frontierCandidates: dedups repeats');
ok(!fc.some(r => r.name === 'I'), 'frontierCandidates: drops junk single-stopword node');

// --- QID display-tag stripping (graph names come with "[Q…]"/"[wd:Q…]" suffixes) ---
const qidStripped = A.frontierCandidates([{ id: 1, name: 'Toyota [Q53268]', degree: 7 }, { id: 2, name: 'Woodrow Wilson [wd:Q34296]', degree: 6 }]);
ok(qidStripped[0].name === 'Toyota' && qidStripped[1].name === 'Woodrow Wilson', 'frontierCandidates: strips the [Q…]/[wd:Q…] display tag from graph names');
ok(qidStripped[0].raw === 'Toyota [Q53268]', 'frontierCandidates: preserves the raw canonical name (for propose targeting)');
const bioguide = A.frontierCandidates([{ id: 3, name: 'William Tauzin [T000058]', degree: 5 }]);
ok(bioguide[0].name === 'William Tauzin' && bioguide[0].raw === 'William Tauzin [T000058]', 'frontierCandidates: strips bioguide tag "[T000058]" too, keeps raw');
const canonQ = A.assembleAnchors({ frontier: [{ id: 5, name: 'Toyota [Q53268]', degree: 7 }] });
ok(canonQ[0].mention === 'Toyota' && canonQ[0].object.canonical === 'Toyota [Q53268]', 'assembleAnchors: frontier carries clean mention + canonical raw for propose');

// --- tier 3: convo names ---
const cc = A.convoCandidates(['Nuclear Innovation Alliance', 'it', 'Nuclear Innovation Alliance']);
ok(cc.length === 1 && cc[0] === 'Nuclear Innovation Alliance', 'convoCandidates: dedup + junk filter');

// --- assembleAnchors: priority order, cross-tier dedup, source tags, visited filter ---
const q = A.assembleAnchors({
  news: [{ principals: ['Alpha Corp'], corroboration: { independent: 4 } }],
  frontier: [{ id: 7, name: 'Beta Org', degree: 3 }, { id: 8, name: 'Alpha Corp', degree: 1 }],  // Alpha also in news → deduped
  convo: ['Gamma Inc', 'Beta Org'],                                                 // Beta also in frontier → deduped
  visitedKeys: new Set([visitKey('Gamma Inc')])                                     // Gamma already worked → skip
});
ok(q[0].mention === 'Alpha Corp' && q[0].source === 'news', 'assembleAnchors: news tier leads, tagged source=news');
const beta = q.find(x => x.mention === 'Beta Org');
ok(beta && beta.source === 'frontier', 'assembleAnchors: Beta from frontier (not re-added from convo)');
ok(beta && beta.kind === 'thin' && beta.object && beta.object.id === 7, 'assembleAnchors: frontier entry carries pre-classification {kind:thin, object.id}');
ok(!q.some(x => x.mention === 'Alpha Corp' && x.source === 'frontier'), 'assembleAnchors: Alpha not duplicated into frontier tier');
ok(!q.some(x => x.mention === 'Gamma Inc'), 'assembleAnchors: a visited anchor is filtered out');

// --- per-tier caps: news can't crowd out frontier ---
const manyNews = Array.from({ length: 10 }, (_, i) => ({ principals: [`News ${i}`], corroboration: { independent: 10 - i } }));
const manyFrontier = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Frontier ${i}`, degree: i + 1 }));
const capped = A.assembleAnchors({ news: manyNews, frontier: manyFrontier });
ok(capped.filter(x => x.source === 'news').length <= A.NEWS_MAX, 'assembleAnchors: news capped at NEWS_MAX (no crowding)');
ok(capped.filter(x => x.source === 'frontier').length >= 4, 'assembleAnchors: frontier still gets a healthy share');
ok(capped.length <= A.MAX_TOTAL, 'assembleAnchors: respects MAX_TOTAL cap');

// --- visited-exhaustion: when the top frontier nodes are all visited, FRESH ones still surface ---
// (the old bug: cap-before-filter meant the same top-N got visited then filtered → tier went empty)
const pool = Array.from({ length: 12 }, (_, i) => ({ id: 200 + i, name: `Node ${i}`, degree: 12 - i }));  // Node 0 = degree 12 (highest)
const visitedTop = new Set(['Node 0', 'Node 1', 'Node 2', 'Node 3', 'Node 4', 'Node 5'].map(visitKey));  // top 6 by degree already worked
const fresh = A.assembleAnchors({ frontier: pool, visitedKeys: visitedTop });
ok(fresh.filter(x => x.source === 'frontier').length >= 4, 'assembleAnchors: surfaces FRESH frontier nodes past the visited top (no exhaustion)');
ok(!fresh.some(x => visitedTop.has(visitKey(x.mention))), 'assembleAnchors: never re-offers a visited node');

// --- rotateFrontierCursor: walk the whole thin set, wrap at the end ---
ok(A.rotateFrontierCursor(0, 200, 200) === 200, 'rotateFrontierCursor: a full page advances the window');
ok(A.rotateFrontierCursor(200, 200, 200) === 400, 'rotateFrontierCursor: keeps advancing');
ok(A.rotateFrontierCursor(400, 137, 200) === 0, 'rotateFrontierCursor: a short page (end of set) wraps to 0');
ok(A.rotateFrontierCursor(0, 0, 200) === 0, 'rotateFrontierCursor: empty page wraps to 0');

(async () => {
  // --- provideAnchors: async providers, fail-soft (one tier throws → others still contribute) ---
  const out = await A.provideAnchors({
    recentNews: async () => [{ principals: ['Live News Co'], corroboration: { independent: 2 } }],
    thinNodes: async () => { throw new Error('echo down'); },   // dead tier → contributes nothing, no throw
    convoNames: ['Convo Thing'],
    visitedKeys: new Set(),
    log: () => {}
  });
  ok(out.some(x => x.mention === 'Live News Co' && x.source === 'news'), 'provideAnchors: resolves async news provider');
  ok(out.some(x => x.mention === 'Convo Thing' && x.source === 'convo'), 'provideAnchors: convo tier survives a dead frontier tier');
  ok(!out.some(x => x.source === 'frontier'), 'provideAnchors: a throwing tier is fail-soft (no frontier anchors, no crash)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
