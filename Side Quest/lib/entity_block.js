'use strict';
/**
 * lib/entity_block.js — Step 2 of the node-resolution-&-fusion gate: BLOCKING / candidate generation
 * (docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md §1). Blocking optimizes RECALL — the Step-1 matcher owns
 * PRECISION — and the literature is clear that NO SINGLE blocker suffices on heterogeneous data, so we UNION
 * complementary blockers, dedup by entity id, and cap:
 *   • strong-id  — exact match on any embedded id (highest-precision block; also the Tier-1 fast path)
 *   • name-key   — the normalized full name (our `name_key` column) — catches surface-form variants
 *   • block-key  — coarse RECALL keys: surname[+jurisdiction] / surname+given-initial for people, a
 *                  sorted-significant-token key for orgs/places (order-independent)
 *   • ann        — embedding nearest-neighbors (our entity vector index) — semantic recall
 *
 * PURE key generation + INJECTED lookups → exhaustively offline-smoke-testable. main.js supplies the live
 * Echo/DB/ANN lookups; the smoke supplies mocks. This module never decides a match — it only proposes the
 * candidate set that Step-1 (entity_match.resolveAgainst) then adjudicates precisely.
 */
const { parseEntity } = require('./entity_match');

// Tokens too common to block on (would make a block the size of the graph). Blocking keys drop these.
const STOP = new Set(['the', 'of', 'and', 'for', 'inc', 'llc', 'corp', 'co', 'committee', 'city', 'county',
  'state', 'us', 'usa', 'department', 'office', 'board', 'association', 'national', 'american', 'united', 'states']);

// blockingKeys(record) → { ids:[{system,id}], nameKey, blockKeys:[...], annQuery }. PURE.
function blockingKeys(rec = {}) {
  const p = parseEntity(rec);
  const ids = Object.entries(p.ids).map(([system, id]) => ({ system, id }));
  const nameKey = p.nameKey;                                   // normalized full name (exact block)
  const blockKeys = [];
  const jur = p.jurisdiction ? p.jurisdiction.replace(/^US-?/, '') : null;
  if (p.isPerson && p.surname) {
    const sn = p.surname.toLowerCase();
    blockKeys.push(jur ? `sn:${sn}|${jur.toLowerCase()}` : `sn:${sn}`);          // surname [+ jurisdiction]
    if (p.given) blockKeys.push(`sn:${sn}|g:${p.given[0].toLowerCase()}`);       // surname + given-initial
  } else if (nameKey) {
    const toks = nameKey.split(' ').filter((t) => t.length >= 3 && !STOP.has(t)).sort();
    if (toks.length) blockKeys.push('tok:' + toks.slice(0, 4).join(' '));        // sorted significant tokens
  }
  return { ids, nameKey, blockKeys, annQuery: p.display };
}

// generateCandidates(record, deps) → { candidates, keys, via, truncated }. Union of the injected blockers,
// deduped by candidate id, capped. Every lookup is OPTIONAL + fail-soft (a throwing/absent blocker is skipped,
// never sinks the set). Lookups each return [{ id, name, ... }]:
//   byStrongId(system, id) · byNameKey(nameKey) · byBlock(blockKey) · byAnn(query, k)
async function generateCandidates(rec, { byStrongId, byNameKey, byBlock, byAnn, annK = 10, cap = 50 } = {}) {
  const keys = blockingKeys(rec);
  const seen = new Map();          // id → candidate (dedup across blockers)
  const via = {};                  // id → which blocker first surfaced it (diagnostics + Tier-1 hinting)
  const add = (list, tag) => {
    for (const c of (Array.isArray(list) ? list : [])) {
      if (c && c.id != null && !seen.has(c.id)) { seen.set(c.id, c); via[c.id] = tag; }
    }
  };
  if (typeof byStrongId === 'function') {
    for (const { system, id } of keys.ids) { try { add(await byStrongId(system, id), 'strong-id'); } catch { /* skip */ } }
  }
  if (typeof byNameKey === 'function' && keys.nameKey) { try { add(await byNameKey(keys.nameKey), 'name-key'); } catch { /* skip */ } }
  if (typeof byBlock === 'function') {
    for (const bk of keys.blockKeys) { try { add(await byBlock(bk), 'block'); } catch { /* skip */ } }
  }
  if (typeof byAnn === 'function') { try { add(await byAnn(keys.annQuery, annK), 'ann'); } catch { /* skip */ } }

  const truncated = seen.size > cap;
  return { candidates: [...seen.values()].slice(0, cap), keys, via, truncated };
}

module.exports = { STOP, blockingKeys, generateCandidates };
