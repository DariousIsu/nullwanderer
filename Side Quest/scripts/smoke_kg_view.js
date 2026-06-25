/**
 * Offline smoke for the Knowledge Graph view model (studio/kg_view.js): the graph builders +
 * styling ported from Echo's KnowledgeGraphSurface, over REAL tool shapes captured live (2026-06-25).
 *
 * Run: node scripts/smoke_kg_view.js
 */
const KG = require('../studio/kg_view');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const OVERVIEW = {
  nodes: [
    { id: 1491752, name: 'HR 2670 (US, 118)', entity_type: 'bill', summary: 'NDAA 2024', degree: 458, source: 'hub' },
    { id: 262716, name: 'Michael J. Madigan (IL)', entity_type: 'person', summary: 'Sponsor in IL 100th', degree: 12107, source: 'hub' },
    { id: 1519651, name: 'LAMP Network', entity_type: 'network', summary: 'roster', degree: 8796, source: 'both' },
    { id: 193979, name: 'Chang (HI)', entity_type: 'person', summary: 'Sponsor', degree: 9293, source: 'recent' },
  ],
  edges: [
    { source: 'Chang (HI)', target: 'LAMP Network', relation_type: 'MEMBER_OF' },
    { source: 'Chang (HI)', target: 'Ghost Node', relation_type: 'RELATED_TO' },
  ],
  total_entities: 27, total_relations: 2,
};
const EGO = {
  root: { id: 1519651, name: 'LAMP Network', entity_type: 'network', summary: 'roster' },
  hops: 1, result_count: 3, related: [
    { name: 'Chang (HI)', entity_type: 'person', summary: 'Sponsor', relation_type: 'MEMBER_OF', depth: 1, path: 'LAMP Network -> Chang (HI)' },
    { name: 'Alexander (SC)', entity_type: 'person', summary: 'Senator', relation_type: 'MEMBER_OF', depth: 1, path: 'LAMP Network -> Alexander (SC)' },
    { name: 'HR 2670 (US, 118)', entity_type: 'bill', summary: 'NDAA', relation_type: 'AUTHORED_BY', depth: 1, path: 'LAMP Network -> HR 2670 (US, 118)' },
  ],
};
const SEARCH = { result: [
  { id: 254948, name: 'HR 238 (IL, 100th)', entity_type: 'bill', summary: 'CONGRATS - ANTHONY PELOSI', rank: -17.9 },
  { id: 1702170, name: 'UNSEAT PELOSI PAC', entity_type: 'organization', summary: 'FEC', rank: -16.8 },
] };

// --- styling maps ---
ok('color: known type', KG.colorFor('person') === '#14B8A6' && KG.colorFor('bill') === '#F59E0B');
ok('color: unknown type → fallback', KG.colorFor('zzz') === '#7dd3fc');
ok('edge: category mapping', KG.categoryFor('MEMBER_OF') === 'projected' && KG.categoryFor('AUTHORED_BY') === 'legislative' && KG.categoryFor('NOPE') === 'generic');
ok('edge: color + width by category', KG.edgeColorFor('FUNDED_BY') === KG.CATEGORY_COLOR.funding && KG.edgeWidthFor('FUNDED_BY') === 1.4);

// --- search hits ---
{
  const h = KG.searchHits(SEARCH);
  ok('search: hits mapped', h.length === 2 && h[0].id === 254948 && h[0].entity_type === 'bill');
  ok('search: tolerates bare array', KG.searchHits([{ id: 1, name: 'x', entity_type: 'person' }]).length === 1);
}

// --- overview graph ---
{
  const g = KG.buildOverview(OVERVIEW);
  ok('overview: node per entity (keyed by name)', g.nodes.length === 4 && g.nodes[0].id === 'HR 2670 (US, 118)');
  ok('overview: degree + source carried', g.nodes.find(n => n.id === 'LAMP Network').degree === 8796 && g.nodes.find(n => n.id === 'LAMP Network').overviewSource === 'both');
  ok('overview: edge with both endpoints present kept', g.links.some(l => l.source === 'Chang (HI)' && l.target === 'LAMP Network'));
  ok('overview: edge to absent node dropped (Ghost Node)', !g.links.some(l => l.target === 'Ghost Node'));
  const filtered = KG.buildOverview(OVERVIEW, ['person']);
  ok('overview: type filter keeps only persons', filtered.nodes.every(n => n.entityType === 'person') && filtered.nodes.length === 2);
}

// --- ego graph (walks path strings) ---
{
  const g = KG.buildEgo(EGO);
  ok('ego: root + related nodes', g.nodes.length === 4 && g.nodes.find(n => n.isFocal).id === 'LAMP Network');
  ok('ego: only root is focal', g.nodes.filter(n => n.isFocal).length === 1);
  ok('ego: edges from path strings', g.links.length === 3 && g.links.every(l => l.source === 'LAMP Network'));
  ok('ego: relation type preserved', g.links.find(l => l.target === 'HR 2670 (US, 118)').relType === 'AUTHORED_BY');
  const filtered = KG.buildEgo(EGO, ['person']);
  ok('ego: filter keeps root + persons, drops bill', filtered.nodes.some(n => n.id === 'LAMP Network') && !filtered.nodes.some(n => n.entityType === 'bill') && filtered.nodes.length === 3);
  const errCase = KG.buildEgo({ error: 'not found' });
  ok('ego: error payload → empty + error flag', errCase.nodes.length === 0 && errCase.error === 'not found');
}

// --- available types ---
{
  ok('types: overview distinct + sorted', JSON.stringify(KG.availableTypes('overview', OVERVIEW)) === JSON.stringify(['bill', 'network', 'person']));
  ok('types: ego from root + related', JSON.stringify(KG.availableTypes('ego', EGO)) === JSON.stringify(['bill', 'network', 'person']));
  ok('types: ego error → empty', KG.availableTypes('ego', { error: 'x' }).length === 0);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
