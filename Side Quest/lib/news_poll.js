/**
 * lib/news_poll.js — the Data-Stream Lane RSS COLLECTOR (Slice 2).
 *
 * The always-on backend poller that fills the reservoir (lib/news_store) from RSS, independent of the
 * Monitors widget being open (design §"Mode 0 — COLLECT"). All I/O is INJECTED so the orchestration is
 * offline-testable with no engine/network: `fetch` (the feeds:fetch path → fetch_feeds_batch →
 * feeds_view.mergeReports, returning {ok, items, sources}), `store` (news_store), `now`, `log`.
 *
 * The setInterval/shutdown LIFECYCLE lives here (start/stop) so main.js wiring is two lines
 * (newsPoll.start({...}) at boot, newsPoll.stop() on window-all-closed) — mirroring the inbox/canvas
 * pollers but kept out of main.js internals to minimize the shared-file footprint.
 *
 * Fail-soft everywhere: a fetch error / bad payload never throws out of a tick.
 */
'use strict';

// Google News (and other aggregators) return items that are PRE-CLUSTERS (an <ol> of sub-articles from
// many outlets). Tag them 'aggregator' at collection so the hourly pass parses their members later
// (design §"Real feed shapes"). Everything else is 'rss'. Pure.
function classifySourceKind(item) {
  const host = String((item && (item.sourceUrl || item.source)) || '').toLowerCase();
  if (/news\.google\.com|\/news\.google\.|google news/.test(host)) return 'aggregator';
  return 'rss';
}

// Run ONE poll tick: fetch the merged feed items, normalize each to a reservoir row, insert (deduped).
// Returns { ok, fetched, inserted, duplicates, rejected, error? }. Never throws.
async function runPollTick({ fetch, store, now = () => Date.now(), log } = {}) {
  if (typeof fetch !== 'function' || !store) return { ok: false, fetched: 0, inserted: 0, duplicates: 0, rejected: 0, error: 'missing deps' };
  let res;
  try { res = await fetch(); }
  catch (e) { log && log('[news-poll] fetch failed: ' + e.message); return { ok: false, fetched: 0, inserted: 0, duplicates: 0, rejected: 0, error: e.message }; }
  const items = (res && Array.isArray(res.items)) ? res.items : [];
  const rows = [];
  let dropped = 0;   // items with no usable dedup key (fromFeedItem → null) — counted so the tick balances
  for (const fi of items) {
    const row = store.fromFeedItem(fi, { sourceKind: classifySourceKind(fi) });
    if (row) rows.push(row); else dropped++;
  }
  const r = store.insertItems(rows, now());
  if (log && r.inserted) log(`[news-poll] +${r.inserted} new (${r.duplicates} dup) from ${items.length} fetched`);
  // fetched === inserted + duplicates + rejected + dropped  (full accounting)
  return { ok: true, fetched: items.length, inserted: r.inserted, duplicates: r.duplicates, rejected: r.rejected, dropped };
}

// --- lifecycle (thin; main.js calls start once + stop on shutdown) ---
let _timer = null, _timeout = null;

function start({ fetch, store, intervalMs = 3 * 60 * 1000, initialDelayMs = 20 * 1000, onTick, now, log } = {}) {
  if (_timer) return false;   // already running
  const tick = () => runPollTick({ fetch, store, now, log }).then(r => { try { onTick && onTick(r); } catch {} }).catch(() => {});
  _timeout = setTimeout(tick, initialDelayMs);   // initial sweep after boot
  _timer = setInterval(tick, intervalMs);
  log && log(`[news-poll] started (every ${Math.round(intervalMs / 1000)}s)`);
  return true;
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_timeout) { clearTimeout(_timeout); _timeout = null; }
}

function isRunning() { return !!_timer; }

module.exports = { runPollTick, classifySourceKind, start, stop, isRunning };
