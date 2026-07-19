/* lib/coalesce.js — IN-FLIGHT REQUEST COALESCING for Echo reads.
 *
 * Measured problem (route observation log, 2026-07-19): 578 identical questions were asked within
 * 2s of each other, costing 1,986s of engine time. 496 of them were INTERLEAVED with other calls
 * (median 5 apart) and 259 landed within 100ms — that shape is not a retry loop, it is
 * research.workers=2 racing: two background workers independently asking the same thing because
 * nothing tells either that the other is already asking.
 *
 * The fix is the cheapest possible one: if an identical read is ALREADY IN FLIGHT, hand the second
 * caller the SAME promise instead of issuing a second call. No cache, no TTL, no invalidation, no
 * staleness — the moment the first call settles the entry is dropped, so a later caller always gets
 * fresh work. That is what makes this safe in a way a result cache would not be.
 *
 * WHY READS ONLY: two concurrent identical reads must return the same thing, so sharing one answer
 * is semantically free. Writes are the opposite — two identical propose_entity calls may be
 * intentional, and collapsing them would silently drop one. Anything not on the read allowlist is
 * passed straight through, so an unrecognised tool is never coalesced by accident.
 *
 * Pure except for the in-flight Map; the policy functions are exported for the smokes.
 */
'use strict';

// Conservative allowlist. Absent = not coalesced. Deliberately excludes every propose_/run_/merge_/
// promote_/auto_ mutation, canvas writes, and agent spawning.
const READ_TOOLS = new Set([
  'search_entities', 'search_knowledge', 'search_documents_semantic', 'search_facts', 'search_contacts',
  'get_entity', 'get_document', 'get_bill', 'get_contact', 'get_project', 'get_account',
  'quick_lookup', 'kg_neighborhood', 'knowledge_neighborhood', 'kg_query_local', 'kg_query_global',
  'query_graph', 'graph_overview', 'db_query', 'get_sources_for', 'get_entity_history',
  'fetch_feeds_batch', 'fetch_feed', 'web_fetch', 'web_extract', 'mediawiki_search',
  'mediawiki_get_extract', 'get_schema', 'get_db_map', 'get_master_index', 'find_mentions',
]);

// db_query is on the list, but a SELECT is only safely shareable because db_query is read-only by
// contract (the engine rejects INSERT/UPDATE/DELETE/PRAGMA outright). Re-check that assumption if
// the engine ever loosens it.
function isCoalescable(tool) {
  return typeof tool === 'string' && READ_TOOLS.has(tool);
}

// Key = tool + a digest of the args. Reuses route_obs's canonical hashing so "same question" means
// exactly the same thing in both subsystems — if they disagreed, the measured duplicate rate and the
// coalescing rate would silently diverge and neither number could be trusted.
function keyFor(tool, args, hashFn) {
  if (!isCoalescable(tool)) return null;
  const h = hashFn(args);
  return h ? `${tool}|${h}` : null;
}

function createCoalescer({ hashFn, now = () => Date.now(), maxInFlight = 256 } = {}) {
  const inFlight = new Map();
  const stats = { calls: 0, coalesced: 0, savedMs: 0 };

  // run(tool, args, thunk) -> promise. On an in-flight identical read, returns the SAME promise.
  //
  // Deliberately NOT declared `async`: an async function always allocates a fresh promise around
  // its return value, so callers would each get a distinct wrapper and never literally share one.
  // The work would still be shared, but "same promise" is the property this is supposed to provide
  // (and the one the smokes assert), so return the shared promise itself.
  function run(tool, args, thunk) {
    stats.calls++;
    const key = keyFor(tool, args, hashFn);
    if (!key) return thunk();

    const existing = inFlight.get(key);
    if (existing) {
      stats.coalesced++;
      // Attribute the avoided cost: however long the leader has been running so far is, to a first
      // approximation, what this caller would have spent doing the same work itself.
      stats.savedMs += Math.max(0, now() - existing.startedAt);
      return existing.promise;
    }

    // Bound the map so a pathological burst cannot grow it without limit. Dropping the guard means
    // NOT coalescing (correct-but-slower), never breaking the call.
    if (inFlight.size >= maxInFlight) return thunk();

    const startedAt = now();
    // Settle-then-delete: the entry lives ONLY for the duration of the call. A caller arriving one
    // millisecond after it settles gets fresh work, which is why this can never serve a stale answer.
    const promise = (async () => { try { return await thunk(); } finally { inFlight.delete(key); } })();
    inFlight.set(key, { promise, startedAt });
    return promise;
  }

  return {
    run,
    stats: () => ({ ...stats, inFlight: inFlight.size,
      rate: stats.calls ? +(stats.coalesced / stats.calls).toFixed(4) : 0 }),
    reset: () => { inFlight.clear(); stats.calls = 0; stats.coalesced = 0; stats.savedMs = 0; },
    _inFlight: inFlight,
  };
}

module.exports = { READ_TOOLS, isCoalescable, keyFor, createCoalescer };
