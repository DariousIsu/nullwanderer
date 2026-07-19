/* lib/memo.js — SHORT-TTL RESULT MEMO for Echo reads (memory path mapping, P2).
 *
 * Measured problem (route observation log, 24h to 2026-07-19, 102,590 observations — with
 * `route.coalesce` ALREADY ON):
 *
 *   56% of all hashed Echo calls are EXACT repeats — same tool, same args — costing 2,892
 *   minutes of engine time per day. For search_entities alone: 50,589 calls, 21,597 distinct
 *   questions, 57% redundant, 1,657 minutes.
 *
 * In-flight coalescing cannot touch this. It shares a call only while one is RUNNING; the
 * moment it settles the entry is dropped. But the duplicates are mostly SEQUENTIAL, not
 * concurrent — only 20% arrive within 5s of each other, and 71% of the wasted time sits in
 * repeats 5s-to-5min apart. Closing that needs a result that OUTLIVES the call. That is a
 * cache, with everything a cache implies, so the safety reasoning below is the whole design.
 *
 * WHY THIS IS A SPEED FIX AND NOT JUST A COST FIX — the load/latency curve from the same log:
 *
 *   <20 calls/min → 321ms avg      200+ calls/min → 3,024ms avg   (9.4x)
 *
 * and 265 of ~314 measured minutes sit in that 200+/min band. search_entities' p10 is 614ms
 * against a p50 of 2,905ms. The engine is not slow; it is SATURATED, by us. Removing ~38% of
 * reads removes offered load, which lowers latency for the reads that remain — including the
 * foreground turn a human is waiting on. That is the compounding part.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────────────────
 *
 * READS ONLY. Same allowlist as coalesce.js (imported, not copied, so the two can never drift).
 * Anything unrecognised is passed straight through — an unknown tool is never cached by accident.
 *
 * ERRORS ARE NEVER STORED. A transport failure or an engine error is not an answer, and caching
 * one would harden a transient fault into a repeated false negative. This is the same rule the
 * design doc's absence model takes from RFC 2308: a failed lookup is `somevalue`, never
 * `novalue`. Empty-but-successful results ARE cached — "nothing matched" is a real answer.
 *
 * INVALIDATION IS NAME-SCOPED, NOT GLOBAL. Zoe writes to the graph roughly once every 11
 * seconds (4,830 propose_entity + 2,805 propose_relation per day). Dropping the whole cache on
 * every write was simulated against the real log and costs most of the benefit:
 *
 *   TTL 5m, no invalidation     37.6% hit   1,658 min/day saved
 *   TTL 5m, global invalidation 15.0% hit     721 min/day saved
 *
 * So instead: a successful write drops only the entries whose arguments MENTION what was
 * written. That keeps the failure mode this is guarding against — she proposes an entity, then
 * re-reads and is told by a stale cache that it does not exist, and proposes it AGAIN — while
 * keeping the unrelated 99% of the cache warm. Over-invalidation is safe (it only costs a
 * re-read); under-invalidation is not, so the token match is deliberately generous.
 *
 * NOT PERSISTED. In-memory only, dropped on reboot. Same posture as the route map itself: a
 * droppable index whose staleness costs SPEED and never becomes a FACT.
 *
 * Flag-gated (`route.memo` meta, default OFF) so it ships inert and its utility is measured
 * before it is trusted — the P2 go/no-go gate in docs/MEMORY_PATH_MAPPING_DESIGN.md §10.
 *
 * Pure except for the entry Map; the policy functions are exported for the smokes.
 */
'use strict';

const { READ_TOOLS, isCoalescable } = require('./coalesce');

const DEFAULT_TTL_MS = 5 * 60 * 1000;   // measured sweet spot: 71% of duplicate wall-clock, 5min staleness
const DEFAULT_MAX = 4000;               // ~21.6k distinct read questions/day; 4k holds the hot set
const MAX_TOKENS = 24;                  // per-entry invalidation fingerprint cap

// Memoizable = exactly the coalescable read set. One allowlist, two consumers.
function isMemoizable(tool) { return isCoalescable(tool); }

// A write that can change what a read would return. Mirrors echo_tier's mutation surface; the
// test is on the NAME because that is all dispatch gives us before the call runs.
const WRITE_RE = /^(propose_|merge_|promote_|approve_|decide_|resolve_entity_|resolve_or_mint|add_|update_|save_|delete_|prune_|revert_|restamp_|set_|import_|ingest_|archive_|move_|rename_|run_|auto_promote)/;
function isInvalidatingWrite(tool) {
  return typeof tool === 'string' && WRITE_RE.test(tool) && !READ_TOOLS.has(tool);
}

// ── Invalidation fingerprints ─────────────────────────────────────────────────────────────────
//
// A read and a write "touch the same thing" when their token sets intersect. The two sides are
// DELIBERATELY ASYMMETRIC, and getting this backwards is the whole risk:
//
//   READS are fingerprinted BROADLY — every string value, every id, including inside SQL. A read
//   should collide with any write that could possibly have changed its answer. Over-collision
//   costs one re-read.
//
//   WRITES are fingerprinted NARROWLY — only the values of IDENTIFYING keys (name/title/label,
//   *_id). Fingerprinting a write broadly looks safer and is in fact useless: propose_entity
//   carries `entity_type:'person'`, so a broad write fingerprint drops every cached read whose
//   text contains the word "person" — which is most of them. That is global invalidation wearing
//   a disguise, and it was measured to cost 60% of the cache's value.
//
// Stopwords cover only tokens that would match nearly everything; anything a name could plausibly
// be is kept, because a missed overlap is the one failure that serves a wrong answer.
const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'that', 'this', 'select', 'where',
  'join', 'null', 'not', 'order', 'limit', 'desc', 'asc', 'true', 'false', 'left', 'inner',
  'group', 'count', 'case', 'when', 'then', 'else', 'end', 'distinct', 'union']);

// Keys whose VALUE identifies a thing. Anything else on a write is metadata (types, confidence,
// summaries, flags) and must not drive invalidation.
const ID_KEY_RE = /(^|_)(name|title|label|query|entity|target|source|subject|holder|person|org)(_name)?$/i;
const ID_NUM_RE = /(^|_)id$/i;

function _tokenize(s, out) {
  for (const raw of String(s).toLowerCase().split(/[^a-z0-9_]+/)) {
    if (out.size >= MAX_TOKENS) return;
    if (!raw) continue;
    // numeric FIRST — an id inside a SQL literal must land in the same `#N` space as an integer
    // arg, or `source_id=262716` would never collide with `{entity_id: 262716}`.
    if (/^\d+$/.test(raw)) { if (raw.length >= 2) out.add('#' + Number(raw)); continue; }
    if (raw.length >= 3 && !STOP.has(raw)) out.add(raw);
  }
}

// Broad — for cached READS.
function fingerprint(args) {
  const out = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 4 || out.size >= MAX_TOKENS) return;
    if (typeof v === 'number') { if (Number.isInteger(v) && v > 0) out.add('#' + v); return; }
    if (typeof v === 'string') { _tokenize(v, out); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], depth + 1); }
  };
  walk(args, 0);
  return out;
}

// Narrow — for WRITES. Only identifying keys contribute.
function writeFingerprint(args) {
  const out = new Set();
  const walk = (v, key, depth) => {
    if (v == null || depth > 4 || out.size >= MAX_TOKENS) return;
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v > 0 && (ID_NUM_RE.test(key) || ID_KEY_RE.test(key))) out.add('#' + v);
      return;
    }
    if (typeof v === 'string') { if (ID_KEY_RE.test(key)) _tokenize(v, out); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], k, depth + 1); }
  };
  walk(args, '', 0);
  return out;
}

// Which object on a tag actually carries its arguments. A `do` tag uses .args; an <echo-propose>
// tag uses .payload. Reading only .args meant every proposal made through the tag syntax
// invalidated nothing — the guard was wired but inert, which is worse than absent because the
// stats read zero and look like "nothing needed dropping". Exported so that stays regression-tested.
function writeArgsOf(tag) {
  if (!tag || typeof tag !== 'object') return {};
  return tag.args || tag.payload || {};
}

function createMemo({ hashFn, ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = () => Date.now() } = {}) {
  // Map preserves insertion order, so the first key is the oldest → O(1) eviction without an LRU
  // list. Re-inserting on hit would make it a true LRU; we deliberately do NOT, because an entry
  // that keeps being served is also an entry whose TTL keeps it honest. Age, not use, decides.
  const entries = new Map();
  const stats = { reads: 0, hits: 0, stores: 0, evicted: 0, expired: 0, invalidated: 0, savedMs: 0 };

  const keyFor = (tool, args) => {
    if (!isMemoizable(tool)) return null;
    const h = hashFn(args);
    return h ? `${tool}|${h}` : null;
  };

  // Look up a cached result. Returns null on any miss so the caller's `if (hit)` stays simple.
  function get(tool, args) {
    const key = keyFor(tool, args);
    if (!key) return null;
    stats.reads++;
    const e = entries.get(key);
    if (!e) return null;
    if (now() - e.storedAt > ttlMs) { entries.delete(key); stats.expired++; return null; }
    stats.hits++;
    stats.savedMs += e.costMs || 0;   // what the original call cost is what this one avoids
    return e.value;
  }

  // Store a result. Refuses errors outright — see the header on why a failure is not an answer.
  function put(tool, args, value, costMs) {
    const key = keyFor(tool, args);
    if (!key) return false;
    if (!value || value.isError || value.ok === false || value.blocked) return false;
    if (entries.size >= max && !entries.has(key)) {
      entries.delete(entries.keys().next().value);
      stats.evicted++;
    }
    entries.delete(key);                                  // re-insert so eviction order tracks age
    entries.set(key, { value, storedAt: now(), costMs: costMs || 0, tokens: fingerprint(args) });
    stats.stores++;
    return true;
  }

  // Drop every entry whose arguments mention anything this write touched. Linear over the cache,
  // which at 4k entries and ~7,600 writes/day is nothing, and keeps the structure a plain Map.
  function invalidate(args) {
    const wt = writeFingerprint(args);
    if (!wt.size) return 0;
    let n = 0;
    for (const [key, e] of entries) {
      for (const t of e.tokens) {
        if (wt.has(t)) { entries.delete(key); n++; break; }
      }
    }
    stats.invalidated += n;
    return n;
  }

  return {
    get, put, invalidate, keyFor,
    stats: () => ({ ...stats, size: entries.size,
      rate: stats.reads ? +(stats.hits / stats.reads).toFixed(4) : 0 }),
    reset: () => {
      entries.clear();
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
    _entries: entries,
  };
}

module.exports = { isMemoizable, isInvalidatingWrite, fingerprint, writeFingerprint, writeArgsOf, createMemo, DEFAULT_TTL_MS, DEFAULT_MAX };
