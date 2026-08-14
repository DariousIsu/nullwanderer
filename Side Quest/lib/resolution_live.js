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

// ── THE FOREGROUND YIELD VALVE (2026-08-14, the 1664s-turn audit) ───────────────────────────────────
// Every consumer of makeLiveDeps is a BACKGROUND mention lane by construction (doc-decompose, graph
// walk, news, events, edge resolution), and the gate's fan-out is ~10 Echo reads per mention. Measured
// live: ~4 engine reads/sec sustained (22,909 calls in 95min on one session, ~1.5 engine cores) while
// a foreground verification turn spun for 27 minutes — the engine had no lane priority, and the load
// was invisible to every turn surface (the "unattributed stall"). The cure follows the quota
// principle (user-directed work is never throttled; background yields): while the conversation is
// LIVE, gate lookups PAUSE (poll 3s), resuming on quiet or after a bounded cap so a long chat can
// never starve the metabolism forever. main.js injects the signal at boot via setYieldProvider —
// with no provider (smokes, scripts) the valve is inert.
let _yieldFn = null;
function setYieldProvider(fn) { _yieldFn = (typeof fn === 'function') ? fn : null; }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _yieldLogAt = 0;
async function _yieldToConversation({ pollMs = 3000, capMs = 120000 } = {}) {
  if (!_yieldFn) return;
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    let active = false;
    try { active = !!_yieldFn(); } catch { return; }
    if (!active) return;
    if (Date.now() - _yieldLogAt > 5 * 60 * 1000) {   // audible once/5min, never invisible (load-defer convention)
      _yieldLogAt = Date.now();
      console.log('[resolve-gate] yielding Echo reads to the live conversation (resumes on quiet; 120s cap per lookup)');
    }
    await _sleep(pollMs);
  }
}

// makeLiveDeps(dispatch, opts) → { byStrongId, byNameKey, byBlock, byAnn, neighborsOf }.
function makeLiveDeps(dispatch, { annK = 12, cap = 30, yieldPollMs = 3000, yieldCapMs = 120000 } = {}) {
  const search = async (query, k) => {
    if (typeof dispatch !== 'function') return [];
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    await _yieldToConversation({ pollMs: yieldPollMs, capMs: yieldCapMs });
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
    byBlock: async (blockKey) => search(String(blockKey).replace(/^(sn:|tok:|nm:)/, '').replace(/\|g:/g, ' ').replace(/\|/g, ' '), annK),
    // CIVIC neighbors as resolved entity IDS (the collective precision guard needs ids, not names). get_entity
    // returns the entity card + its outgoing relations with target_id — the correct civic-graph neighbor set.
    // (kg_neighborhood is the WRONG source — it returns Wikipedia-sidecar node ids, a different id space.)
    neighborsOf: async (cand) => {
      if (typeof dispatch !== 'function' || !cand || !cand.name) return [];
      await _yieldToConversation({ pollMs: yieldPollMs, capMs: yieldCapMs });
      try {
        const r = await dispatch({ kind: 'do', name: 'get_entity', args: { name: cand.name } });
        if (!r || !r.ok || r.isError) return [];
        const obj = JSON.parse(r.text);
        const rels = (obj && Array.isArray(obj.relations)) ? obj.relations : [];
        return rels.map((x) => x.target_id).filter((v) => v != null);
      } catch { return []; }
    },
  };
}

module.exports = { makeLiveDeps, setYieldProvider, _parseEntities };
