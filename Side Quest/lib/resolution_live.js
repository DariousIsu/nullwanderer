'use strict';
/**
 * lib/resolution_live.js — the LIVE Echo-backed deps for the node-resolution gate (design §7 wiring). Wraps
 * the engine's search_entities (hybrid BM25+ANN) and kg_neighborhood behind the blocker/neighbor interface
 * that lib/resolution_gate expects. `dispatch` (echoSuit.dispatch) is injected → the ORCHESTRATION here is
 * offline-smoke-testable with a mock; the live Echo semantics are validated by the backlog dry-run.
 *
 * IMPORTANT: echoSuit.dispatch returns the raw JSON ARRAY as `text` (NOT a {result:[…]} envelope like the
 * MCP tool wrapper) — parsed accordingly. Every lookup is fail-soft (a bad/absent result → []).
 */

function _parseEntities(text) {
  try {
    const p = JSON.parse(text);
    const arr = Array.isArray(p) ? p : (Array.isArray(p && p.result) ? p.result : []);
    return arr.filter(Boolean).map((e) => ({ id: e.id, name: e.name, type: e.entity_type || e.type, degree: e.degree }));
  } catch { return []; }
}
// defensively collect entity ids from ANY kg_neighborhood response shape (neighbors[]/nodes[]/edges[]).
function _collectIds(obj, out, depth) {
  if (obj == null || depth > 4) return;
  if (Array.isArray(obj)) { for (const x of obj) _collectIds(x, out, depth + 1); return; }
  if (typeof obj === 'object') {
    for (const k of ['id', 'target_id', 'source_id', 'entity_id', 'neighbor_id']) if (obj[k] != null && (typeof obj[k] === 'number' || /^\d+$/.test(String(obj[k])))) out.add(Number(obj[k]));
    for (const v of Object.values(obj)) if (v && typeof v === 'object') _collectIds(v, out, depth + 1);
  }
}

// makeLiveDeps(dispatch, opts) → { byStrongId, byNameKey, byBlock, byAnn, neighborsOf }.
function makeLiveDeps(dispatch, { annK = 12, cap = 30 } = {}) {
  const search = async (query, k) => {
    if (typeof dispatch !== 'function') return [];
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    try {
      const r = await dispatch({ kind: 'do', name: 'search_entities', args: { query: q.slice(0, 120), top_k: k || annK } });
      return (r && r.ok && !r.isError) ? _parseEntities(r.text).slice(0, cap) : [];
    } catch { return []; }
  };
  return {
    annK, cap,
    byStrongId: async (_system, id) => search(id, 5),                       // the id token is embedded in the tagged name
    byNameKey: async (nameKey) => search(nameKey, annK),
    byAnn: async (query, k) => search(query, k),
    // block key → a searchable string: "sn:howell|va" → "howell va", "tok:a b" → "a b", "sn:x|g:j" → "x j"
    byBlock: async (blockKey) => search(String(blockKey).replace(/^(sn:|tok:)/, '').replace(/\|g:/g, ' ').replace(/\|/g, ' '), annK),
    neighborsOf: async (cand) => {
      if (typeof dispatch !== 'function' || !cand || cand.id == null) return [];
      try {
        const r = await dispatch({ kind: 'do', name: 'kg_neighborhood', args: { entity_id: cand.id, limit: 40 } });
        if (!r || !r.ok || r.isError) return [];
        const ids = new Set(); _collectIds(JSON.parse(r.text), ids, 0); ids.delete(Number(cand.id));
        return [...ids];
      } catch { return []; }
    },
  };
}

module.exports = { makeLiveDeps, _parseEntities };
