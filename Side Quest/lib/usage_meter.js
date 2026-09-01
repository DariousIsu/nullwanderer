/**
 * lib/usage_meter.js — Zoe's own model-usage meter (the canvas top-bar usage pill).
 *
 * WHY internal, not Ollama's number: ollama.com's usage page is auth-gated and cloud calls return NO
 * rate-limit / quota / reset headers (probed live) — so their actual counter + reset timer are not readable
 * by any API. Instead we meter what WE spend: every model call's token usage is recorded here (keyed by
 * model + timestamp), and summary() rolls it up over a window. The window is configurable so it can be set
 * to track ALONGSIDE the Ollama plan's reset cadence (Pro resets daily → a 24h window mirrors it).
 *
 * DURABLE rolling ring (M1.1a): the ring is persisted to db meta (throttled) and RESTORED on boot, so
 * `spentSince` in the quota gate survives a reboot — otherwise every reboot reset the meter to 0 and the
 * gate silently under-counted (Disease A: "usage_meter in-memory (resets per boot)"). Still PURE given
 * explicit timestamps → the aggregation is gate-testable; persistence is fail-soft + injectable for tests.
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETAIN_MS = 26 * HOUR_MS;        // keep a bit more than a day so a 24h window is always complete
const PERSIST_THROTTLE_MS = 30 * 1000; // at most one meta write per 30s (record() is hot)
const META_KEY = 'usage.meter.ring';

const _log = [];   // [{ model, tokens, ts }] — append-only ring, pruned to RETAIN_MS
let _dirty = false;
let _lastPersist = 0;

function _prune(now) {
  const cutoff = now - RETAIN_MS;
  if (_log.length && _log[0].ts < cutoff) { let i = 0; while (i < _log.length && _log[i].ts < cutoff) i++; _log.splice(0, i); }
}

// Record one model call's token cost. `tokens` is the total (prompt + generated). Fail-soft: bad input is
// ignored, never throws. Prunes anything older than the retention horizon so memory stays bounded, then
// throttled-persists so the durable ledger tracks live spend without a meta write on every hot call.
function record(model, tokens, ts = Date.now(), lane = '?') {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return;
  const now = Number(ts) || Date.now();
  // LANE TAG (#115, Lucas-approved): the ring carries which lane spent, so the quota pace can
  // charge background against BACKGROUND spend instead of the all-lane hour. '?' = untagged.
  _log.push({ model: String(model || 'unknown'), tokens: Math.round(t), ts: now, lane: String(lane || '?') });
  _prune(now);
  _dirty = true;   // main.js drives persist() on its periodic tick + on shutdown (keeps this hot path pure)
}

// Per-model tokens in [since, now], optionally filtered to a lane set ('?'/missing counts as
// UNTAGGED and is included when `lanes` contains '?' — safe-biased: unattributed spend charges
// against background until the tags populate). PURE over the ring.
function byModelSince(since, now = Date.now(), { lanes = null } = {}) {
  const out = {};
  const set = Array.isArray(lanes) && lanes.length ? new Set(lanes) : null;
  for (const e of _log) {
    if (e.ts < since || e.ts > now) continue;
    if (set && !set.has(e.lane || '?')) continue;
    out[e.model] = (out[e.model] || 0) + e.tokens;
  }
  return out;
}

// Persist the pruned ring to db meta (fail-soft; injectable setMeta for tests). main.js calls this every
// periodic tick — self-throttled to one write per PERSIST_THROTTLE_MS so a hot tick is cheap. Pass
// force:true on graceful shutdown so the last window of spend is flushed regardless of the throttle.
function persist(now = Date.now(), { setMeta, force = false } = {}) {
  if (!_dirty) return false;
  if (!force && now - _lastPersist < PERSIST_THROTTLE_MS) return false;
  _prune(now);
  const put = setMeta || ((k, v) => require('./db').setMeta(k, v));
  try { put(META_KEY, JSON.stringify(_log)); _lastPersist = now; _dirty = false; return true; }
  catch { return false; }
}

// Restore the ring from db meta on boot (fail-soft; injectable getMeta for tests). Drops anything past the
// retention horizon. Returns the count restored. Safe to call once at startup before any record().
function restore(now = Date.now(), { getMeta } = {}) {
  try {
    const get = getMeta || ((k) => require('./db').getMeta(k));
    const raw = get(META_KEY);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    const cutoff = now - RETAIN_MS;
    const kept = arr.filter((e) => e && Number.isFinite(Number(e.ts)) && Number(e.ts) >= cutoff && Number(e.tokens) > 0)
      .map((e) => ({ model: String(e.model || 'unknown'), tokens: Math.round(Number(e.tokens)), ts: Number(e.ts), lane: String(e.lane || '?') }))
      .sort((a, b) => a.ts - b.ts);
    _log.splice(0, _log.length, ...kept);
    return kept.length;
  } catch { return 0; }
}

// Roll up usage over a window: { total, byModel:{model:tokens}, rate (tokens in the last rateMs), calls,
// windowMs, sinceTs }. PURE over the current ring given `now`. Sorted byModel descending for display.
function summary({ now = Date.now(), windowMs = DAY_MS, rateMs = HOUR_MS } = {}) {
  const since = now - windowMs;
  const rateSince = now - rateMs;
  let total = 0, rate = 0, calls = 0;
  const by = {};
  for (const e of _log) {
    if (e.ts < since) continue;
    total += e.tokens; calls++;
    by[e.model] = (by[e.model] || 0) + e.tokens;
    if (e.ts >= rateSince) rate += e.tokens;
  }
  const byModel = Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
  return { total, byModel, rate, calls, windowMs, rateMs, sinceTs: since };
}

// Compute total tokens from any Ollama-ish usage object (both the normalized {prompt_tokens,eval_tokens}
// and the raw {prompt_eval_count,eval_count} shapes). Returns 0 on anything unusable.
function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = Number(usage.prompt_tokens) || Number(usage.prompt_eval_count) || 0;
  const e = Number(usage.eval_tokens) || Number(usage.eval_count) || 0;
  const tot = p + e;
  return Number.isFinite(tot) && tot > 0 ? tot : 0;
}

// Most recent timestamp we saw a call for `model` (exact match), or 0 if never. Lets the warm-keeper
// skip a model that real traffic already keeps hot — so we only spend pings on an idle replier.
function lastSeen(model, before = Date.now()) {
  const m = String(model || '');
  let ts = 0;
  for (const e of _log) { if (e.model === m && e.ts <= before && e.ts > ts) ts = e.ts; }
  return ts;
}

function reset() { _log.length = 0; }
function _size() { return _log.length; }

module.exports = { record, summary, byModelSince, tokensOf, lastSeen, reset, persist, restore, _size, DAY_MS, HOUR_MS, RETAIN_MS };
