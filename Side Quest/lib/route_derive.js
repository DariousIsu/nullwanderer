/* lib/route_derive.js — MEMORY PATH MAPPING slice P1: derive ROUTE TEMPLATES from the observation log.
 *
 * P0 recorded every Echo call; P0.5 added the causal link (parent_id) that says which call's OUTPUT
 * fed which call's INPUT. This turns those linked observations into ROUTES: the repeated ordered
 * chains that answer a question class (search_entities → kg_neighborhood → get_entity).
 *
 * READ-ONLY and PURE where it counts. The derivation functions take plain rows and return plain
 * objects; nothing here writes to the DB or consumes a route. Executing a route is P2 — and P2 only
 * earns its place if these templates prove real, which is what this pass exists to check.
 *
 * WHAT A ROUTE IS HERE: a chain is a maximal parent→child path within one focus (walk parent_id
 * links). A route template is the chain reduced to its TOOL SEQUENCE (search_entities →
 * kg_neighborhood → get_entity) — the arg VALUES are gone by design, so a template generalises over
 * every entity the same shape of question was asked about. A template's WEIGHT is how many distinct
 * chains instantiated it; its VALUE is the wall-clock those chains cost (what a replay could save).
 *
 * HONEST LIMITS, surfaced not hidden:
 *  - A template seen in ONE focus is within-episode structure, not a proven cross-episode route.
 *    Each template carries its focus spread so the caller never mistakes one for the other.
 *  - Utility is a CEILING (sum of step latencies), not a prediction. Real replay pays a match cost
 *    and must invalidate on graph change (Minton). P2 decides; P1 only measures the ceiling.
 */
'use strict';

// Build parent→children adjacency and id→row maps from a flat list of linked observations.
function _index(rows) {
  const byId = new Map();
  const children = new Map();
  for (const r of rows) {
    byId.set(r.id, r);
    if (r.parent_id != null) {
      if (!children.has(r.parent_id)) children.set(r.parent_id, []);
      children.get(r.parent_id).push(r);
    }
  }
  return { byId, children };
}

// A row is a chain ROOT if it has no parent in this set (parent_id null, or parent not present).
function _roots(rows, byId) {
  return rows.filter(r => r.parent_id == null || !byId.has(r.parent_id));
}

// Walk every root-to-leaf path. Each path is one CHAIN (an ordered list of rows). Branching is
// followed — a search feeding three different lookups yields three chains sharing a prefix. A depth
// cap guards against a pathological self-referential link (which the recorder should never produce,
// but a derived pass must not trust its input to be acyclic).
function extractChains(rows, { maxDepth = 32 } = {}) {
  const { byId, children } = _index(rows);
  const chains = [];
  const walk = (row, acc, seen) => {
    if (acc.length >= maxDepth || seen.has(row.id)) { if (acc.length) chains.push(acc.slice()); return; }
    acc.push(row); seen.add(row.id);
    const kids = children.get(row.id) || [];
    if (!kids.length) chains.push(acc.slice());
    else for (const k of kids) walk(k, acc, seen);
    acc.pop(); seen.delete(row.id);
  };
  for (const root of _roots(rows, byId)) walk(root, [], new Set());
  // A single call with no parent and no children is not a route — a route needs at least one hop.
  return chains.filter(c => c.length >= 2);
}

// Reduce a chain to its template key: the ordered tool sequence. Values are already absent from the
// rows; this drops the arg SHAPE too, so "search by query then walk neighbors" is one template
// whether the search was by name or by type.
function templateKey(chain) {
  return chain.map(r => r.tool).join(' → ');
}

// Roll chains up into templates. Each template carries the evidence a caller needs to judge it:
// how many chains, across how many focuses (the cross-episode test), total wall-clock (the savings
// ceiling), and the outcome mix of its final step (does this route usually LAND or usually miss?).
function deriveTemplates(rows, opts = {}) {
  const chains = extractChains(rows, opts);
  const tpl = new Map();
  for (const chain of chains) {
    const key = templateKey(chain);
    let t = tpl.get(key);
    if (!t) { t = { key, tools: chain.map(r => r.tool), length: chain.length, count: 0, focuses: new Set(), totalMs: 0, tailHit: 0, tailMiss: 0, tailErr: 0 }; tpl.set(key, t); }
    t.count++;
    if (chain[0].focus_id != null) t.focuses.add(chain[0].focus_id);
    for (const r of chain) t.totalMs += (r.latency_ms || 0);
    const tail = chain[chain.length - 1];
    if (tail.outcome === 'hit') t.tailHit++;
    else if (tail.outcome === 'miss') t.tailMiss++;
    else t.tailErr++;
  }
  const out = [];
  for (const t of tpl.values()) {
    out.push({
      key: t.key,
      tools: t.tools,
      length: t.length,
      count: t.count,                       // how many chains instantiated this template
      focusCount: t.focuses.size,           // across how many episodes — the cross-episode test
      crossEpisode: t.focuses.size > 1,     // the load-bearing distinction
      totalMs: t.totalMs,
      avgMs: Math.round(t.totalMs / t.count),
      tail: { hit: t.tailHit, miss: t.tailMiss, err: t.tailErr },
      // savings CEILING: every instance after the first is, at best, replayable. Not a prediction —
      // Minton's match cost and invalidation eat into it; P2 measures the real number.
      savingsCeilingMs: Math.round(t.totalMs * (t.count - 1) / t.count),
    });
  }
  // most repeated first; ties broken by savings ceiling
  out.sort((a, b) => b.count - a.count || b.savingsCeilingMs - a.savingsCeilingMs);
  return out;
}

// The whole pass over a row set → a report a human (or the allocator) can read.
function derive(rows, opts = {}) {
  const linked = rows.filter(r => r.seq != null);
  const templates = deriveTemplates(linked, opts);
  const crossEp = templates.filter(t => t.crossEpisode);
  return {
    observations: rows.length,
    linkedObservations: linked.length,
    chains: extractChains(linked, opts).length,
    templates,
    crossEpisodeTemplates: crossEp,
    summary: {
      totalTemplates: templates.length,
      crossEpisodeTemplates: crossEp.length,
      // the honest headline: within-episode structure is cheap; cross-episode is what routes are for
      note: crossEp.length
        ? `${crossEp.length} template(s) recur across >1 focus — candidate durable routes.`
        : `No template yet spans >1 focus — within-episode structure only. Need more focuses before routes generalise.`,
    },
  };
}

module.exports = { extractChains, templateKey, deriveTemplates, derive, _index, _roots };
