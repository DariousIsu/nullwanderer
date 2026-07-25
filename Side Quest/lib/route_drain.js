/**
 * lib/route_drain.js — the CONSUMPTION QUEUE for route_obs (2026-07-25).
 *
 * route_obs was a WRITE-ONLY pool: every tool call and Echo dispatch appended a row, and the only
 * consumer ever built — the route-template derivation in lib/route_derive.js — was wired into offline
 * scripts, never a running pass. So the log grew to 2.6M rows / ~470k a day, bloated sq.db to 2.1 GB,
 * and stalled the main thread on every synchronous insert: total systems lag with NO CPU spike,
 * because it was I/O + WAL-checkpoint wait, not compute (Lucas, 2026-07-25).
 *
 * The fix is not to throttle the writes or time-prune the pile — it is to make the table a QUEUE that
 * DRAINS. This pass folds the raw observations into `route_health` (durable per-tool rolling
 * aggregates — the self-correction signal of what is slow and what fails), advances a watermark, and
 * DELETES the rows it consumed. route_obs then stays a small tail (one batch behind), so inserts stay
 * sub-millisecond and the DB never re-bloats, while the value the pool was meant to hold finally lands
 * where a lane can read it.
 *
 * WHY HEALTH, NOT TEMPLATES, HERE: the route-TEMPLATE derivation (lib/route_derive.js) needs whole
 * parent→child CHAINS intact, so it cannot run against a table that is being pruned batch-by-batch —
 * a chain split across a prune boundary is lost. Health folding is ROW-INDEPENDENT (each observation
 * stands alone), so it is safe to consume-and-prune. Templates are the P2 job: it registers as a
 * SECOND consumer over COMPLETED focuses and prunes below the MIN watermark of both. Deferred on
 * purpose — deriving durable routes from tools/schema still in flux would only bake in churn.
 *
 * Pure fold + a bounded, fail-soft DB pass (injected deps for offline tests).
 */
'use strict';

const WATERMARK_KEY = 'route_drain.after_id';
const DEFAULT_BATCH = 8000;

// PURE: fold a batch of route_obs rows into per-tool health deltas. Outcome tiers mirror the log's own
// vocabulary — `error` is a failure, `miss` is a lookup that found nothing; everything else (hit/ok)
// is a plain successful call. latency is summed with its own count so a mean survives the merge.
function foldHealth(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const tool = (r && r.tool) || '?';
    let h = by.get(tool);
    if (!h) { h = { calls: 0, errors: 0, misses: 0, latencySum: 0, latencyN: 0 }; by.set(tool, h); }
    h.calls++;
    const o = String((r && r.outcome) || '').toLowerCase();
    if (o === 'error') h.errors++;
    else if (o === 'miss') h.misses++;
    if (r && r.latency_ms != null) { h.latencySum += Number(r.latency_ms) || 0; h.latencyN++; }
  }
  return by;
}

/**
 * One drain: read up to `batch` unconsumed rows → fold into route_health → advance watermark → delete
 * the consumed rows. Returns { processed, pruned, tools, watermark }. Fail-soft: any error returns the
 * zero result and leaves the table untouched (a stalled drain is safe; a half-applied fold is not).
 */
function drainPass({ deps = {}, batch = DEFAULT_BATCH, now = Date.now() } = {}) {
  const db = deps.db || require('./db');
  const conn = db.getDb();
  const out = { processed: 0, pruned: 0, tools: 0, watermark: 0 };

  let after = 0;
  try { after = parseInt(db.getMeta(WATERMARK_KEY) || '0', 10) || 0; } catch {}
  // SELF-HEAL after a truncate: if the watermark points past the current max id (the table was
  // cleared/VACUUMed and ids restarted low), a `WHERE id > watermark` read would skip every fresh row
  // forever. Reset to 0 so the drain picks up the new data.
  try {
    const maxId = ((conn.prepare('SELECT MAX(id) AS m FROM route_obs').get()) || {}).m || 0;
    if (after > maxId) after = 0;
  } catch { return out; }

  let rows = [];
  try {
    rows = conn.prepare('SELECT id, tool, outcome, latency_ms FROM route_obs WHERE id > ? ORDER BY id LIMIT ?')
      .all(after, Math.max(1, batch | 0));
  } catch { return out; }
  if (!rows.length) { out.watermark = after; return out; }

  const by = foldHealth(rows);
  const maxProcessed = rows[rows.length - 1].id;
  try {
    for (const [tool, d] of by) db.bumpRouteHealth(tool, d, now);
    db.setMeta(WATERMARK_KEY, String(maxProcessed));
    const info = conn.prepare('DELETE FROM route_obs WHERE id <= ?').run(maxProcessed);
    out.pruned = (info && info.changes) || 0;
  } catch { return out; }

  out.processed = rows.length;
  out.tools = by.size;
  out.watermark = maxProcessed;
  return out;
}

module.exports = { foldHealth, drainPass, WATERMARK_KEY, DEFAULT_BATCH };
