/*
 * Knowledge Graph surface — standardized VIEW model. Pure port of the graph-building + styling
 * logic from Echo's KnowledgeGraphSurface.tsx (the React wrapper is dropped; the rendering rides
 * the vanilla `force-graph` canvas lib — MIT — in renderer/kg.js). Two modes: corpus OVERVIEW
 * (graph_overview) and ego-network (query_graph, walks `path` strings). Plus entity-type colors
 * and relation-type edge categories. No model, no I/O — read-only. Grounded on REAL shapes
 * captured live (2026-06-25). Fourth ported Echo surface; see project_echo_surface_port.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KgView = api;
})(this, function () {
  'use strict';

  // The lower block is the vocabulary the type ladder (T1-T5) put into circulation. Without it every one
  // of these fell through to the single fallback, so a government body, a place and an honestly-unknown
  // object all drew the same colour as the corpus itself — T1's whole point is that a government is NOT a
  // company, and the palette was still saying they were the same thing.
  //
  // `unknown` is deliberately DARKER than `concept`: T5 stopped minting `concept` for things nobody typed,
  // and the colour should let "nobody has said what this is" recede rather than pose as a decided type.
  const TYPE_COLOR = {
    legislation: '#F59E0B', person: '#14B8A6', event: '#A855F7', organization: '#22C55E', concept: '#94A3B8',
    bill: '#F59E0B', committee: '#22C55E', source: '#94A3B8',
    unknown: '#64748B', thing: '#94A3B8',
    government_body: '#3B82F6', gov: '#3B82F6', body: '#3B82F6',
    location: '#EC4899', place: '#EC4899',
    office_held: '#818CF8', work: '#22D3EE', document: '#A3E635', meeting: '#FB923C',
    // Measured against the live corpus (2026-07-22): these five carried 123 of 525 overview nodes — 23% of
    // the cloud drawing as "no type we recognise" when Echo types them perfectly well. Grouped by family so
    // the palette still reads: the legal/legislative work sits in the ambers beside legislation and bill.
    decision: '#FACC15', legal_instrument: '#B45309',
    poll: '#FB7185', network: '#D8B4FE', theme: '#FDE68A',
  };
  const colorFor = (t) => TYPE_COLOR[(t || '').toLowerCase()] || '#7dd3fc';

  const EDGE_CATEGORY = {
    MEMBER_OF: 'projected', DIRECTED_BY: 'projected', PARENT_OF: 'projected', WORKS_FOR: 'projected',
    FUNDED_BY: 'funding',
    AUTHORED_BY: 'legislative', VOTES_FOR: 'legislative', VOTES_AGAINST: 'legislative', PROPOSES: 'legislative', SUPERSEDES: 'legislative', INFLUENCED_BY: 'legislative',
    COMMITTEE_PEER: 'derived', CAUCUS_PEER: 'derived', CO_SPONSORS_WITH: 'derived', DONOR_OVERLAP: 'derived', VOTE_ALIGNED_WITH: 'derived', BOARD_PEER: 'derived',
    RELATED_TO: 'generic', LINKED_TO: 'generic',
  };
  const CATEGORY_COLOR = {
    projected: 'rgba(96,165,250,0.70)', funding: 'rgba(34,197,94,0.72)', legislative: 'rgba(20,184,166,0.62)', derived: 'rgba(245,158,11,0.64)', generic: 'rgba(148,163,184,0.50)',
  };
  const CATEGORY_WIDTH = { projected: 1.3, funding: 1.6, legislative: 0.9, derived: 0.8, generic: 0.55 };
  const CATEGORIES = ['projected', 'funding', 'legislative', 'derived', 'generic'];
  const categoryFor = (rt) => EDGE_CATEGORY[(rt || '').toUpperCase()] || 'generic';
  const edgeColorFor = (rt) => CATEGORY_COLOR[categoryFor(rt)];
  const edgeWidthFor = (rt) => CATEGORY_WIDTH[categoryFor(rt)];

  function asArray(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    if (payload && Array.isArray(payload.result)) return payload.result;
    return [];
  }

  // search_entities payload → fuzzy-search hits.
  function searchHits(payload) {
    return asArray(payload, 'result').map(h => ({ id: h.id, name: h.name, entity_type: h.entity_type, summary: h.summary || null }));
  }

  // Ego-network from query_graph: walk each related entity's `path` ("A -> B -> C") into nodes+links.
  // Pure port of buildGraphData. typeFilter is an array (empty = no filter); the root always survives.
  function buildEgo(result, typeFilter = []) {
    if (!result || !result.root) return { nodes: [], links: [], error: result && result.error };
    const filt = new Set(typeFilter);
    const typeByName = new Map(), summaryByName = new Map();
    typeByName.set(result.root.name, result.root.entity_type || 'concept'); summaryByName.set(result.root.name, result.root.summary);
    for (const r of (result.related || [])) { typeByName.set(r.name, r.entity_type); summaryByName.set(r.name, r.summary); }
    const nodes = new Map(), links = new Map();
    const wantsNode = (name) => { const t = typeByName.get(name) || 'concept'; return !(filt.size > 0 && !filt.has(t) && name !== result.root.name); };
    const addNode = (name) => {
      if (!wantsNode(name) || nodes.has(name)) return;
      const et = typeByName.get(name) || 'concept';
      nodes.set(name, { id: name, entityType: et, color: colorFor(et), summary: summaryByName.get(name) || null, isFocal: name === result.root.name });
    };
    const addEdge = (a, b, rel) => {
      if (a === b || !nodes.has(a) || !nodes.has(b)) return;
      const key = `${a}->${b}::${rel}`; if (!links.has(key)) links.set(key, { source: a, target: b, relType: rel, color: edgeColorFor(rel), width: edgeWidthFor(rel), category: categoryFor(rel) });
    };
    addNode(result.root.name);
    for (const r of (result.related || [])) {
      const segs = String(r.path || '').split(' -> ').map(s => s.trim()).filter(Boolean);
      if (!segs.length) continue;
      addNode(segs[0]);
      for (let i = 1; i < segs.length; i++) { addNode(segs[i]); addEdge(segs[i - 1], segs[i], r.relation_type); }
      if (r.depth === 1) { addNode(r.name); addEdge(result.root.name, r.name, r.relation_type); }
    }
    return { nodes: Array.from(nodes.values()), links: Array.from(links.values()), error: null };
  }

  // Corpus overview from graph_overview: nodes carry degree + hub/recent source; edges key by name.
  function buildOverview(result, typeFilter = []) {
    if (!result || !Array.isArray(result.nodes)) return { nodes: [], links: [] };
    const filt = new Set(typeFilter);
    const nodes = result.nodes
      .filter(n => filt.size === 0 || filt.has(n.entity_type))
      .map(n => ({ id: n.name, entityType: n.entity_type, color: colorFor(n.entity_type), summary: n.summary || null, isFocal: false, overviewSource: n.source, degree: n.degree }));
    const present = new Set(nodes.map(n => n.id));
    const links = (result.edges || []).filter(e => present.has(e.source) && present.has(e.target))
      .map(e => ({ source: e.source, target: e.target, relType: e.relation_type, color: edgeColorFor(e.relation_type), width: edgeWidthFor(e.relation_type), category: categoryFor(e.relation_type) }));
    return { nodes, links };
  }

  // Distinct entity types present (for the filter pills), sorted.
  function availableTypes(mode, payload) {
    if (mode === 'overview') {
      if (!payload || !Array.isArray(payload.nodes)) return [];
      return Array.from(new Set(payload.nodes.map(n => n.entity_type))).sort();
    }
    if (!payload || !payload.root || payload.error) return [];
    const s = new Set(); if (payload.root) s.add(payload.root.entity_type);
    for (const r of (payload.related || [])) s.add(r.entity_type);
    return Array.from(s).sort();
  }

  // Edge-category legend rows (for the surface's legend box).
  function legend() { return CATEGORIES.map(cat => ({ category: cat, color: CATEGORY_COLOR[cat], width: CATEGORY_WIDTH[cat] })); }

  return {
    TYPE_COLOR, colorFor, EDGE_CATEGORY, CATEGORY_COLOR, CATEGORY_WIDTH, CATEGORIES,
    categoryFor, edgeColorFor, edgeWidthFor, searchHits, buildEgo, buildOverview, availableTypes, legend,
  };
});
