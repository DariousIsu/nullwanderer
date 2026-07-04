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

// --- tier 2: frontier thin nodes, thinnest first, deduped ---
const thin = [
  { name: 'R Street Institute', degree: 6 },
  { name: 'Cicero Institute', degree: 2 },
  { name: 'Cicero Institute', degree: 2 },   // dup
  { name: 'I', degree: 0 }                    // junk
];
const fc = A.frontierCandidates(thin);
ok(fc[0] === 'Cicero Institute', 'frontierCandidates: thinnest (degree 2) first');
ok(fc.filter(n => n === 'Cicero Institute').length === 1, 'frontierCandidates: dedups repeats');
ok(!fc.some(n => n === 'I'), 'frontierCandidates: drops junk single-stopword node');

// --- tier 3: convo names ---
const cc = A.convoCandidates(['Nuclear Innovation Alliance', 'it', 'Nuclear Innovation Alliance']);
ok(cc.length === 1 && cc[0] === 'Nuclear Innovation Alliance', 'convoCandidates: dedup + junk filter');

// --- assembleAnchors: priority order, cross-tier dedup, source tags, visited filter ---
const q = A.assembleAnchors({
  news: [{ principals: ['Alpha Corp'], corroboration: { independent: 4 } }],
  frontier: [{ name: 'Beta Org', degree: 3 }, { name: 'Alpha Corp', degree: 1 }],  // Alpha also in news → deduped
  convo: ['Gamma Inc', 'Beta Org'],                                                 // Beta also in frontier → deduped
  visitedKeys: new Set([visitKey('Gamma Inc')])                                     // Gamma already worked → skip
});
ok(q[0].mention === 'Alpha Corp' && q[0].source === 'news', 'assembleAnchors: news tier leads, tagged source=news');
ok(q.some(x => x.mention === 'Beta Org' && x.source === 'frontier'), 'assembleAnchors: Beta from frontier (not re-added from convo)');
ok(!q.some(x => x.mention === 'Alpha Corp' && x.source === 'frontier'), 'assembleAnchors: Alpha not duplicated into frontier tier');
ok(!q.some(x => x.mention === 'Gamma Inc'), 'assembleAnchors: a visited anchor is filtered out');

// --- max cap ---
const many = Array.from({ length: 20 }, (_, i) => ({ name: `Org ${i}`, degree: i }));
ok(A.assembleAnchors({ frontier: many }).length <= A.MAX_TOTAL, 'assembleAnchors: respects MAX_TOTAL cap');

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
