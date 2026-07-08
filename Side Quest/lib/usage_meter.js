/**
 * lib/usage_meter.js — Zoe's own model-usage meter (the canvas top-bar usage pill).
 *
 * WHY internal, not Ollama's number: ollama.com's usage page is auth-gated and cloud calls return NO
 * rate-limit / quota / reset headers (probed live) — so their actual counter + reset timer are not readable
 * by any API. Instead we meter what WE spend: every model call's token usage is recorded here (keyed by
 * model + timestamp), and summary() rolls it up over a window. The window is configurable so it can be set
 * to track ALONGSIDE the Ollama plan's reset cadence (Pro resets daily → a 24h window mirrors it).
 *
 * In-memory rolling ring (reboot resets it — acceptable for a live activity pill; persistence can come later).
 * PURE given explicit timestamps → the aggregation is gate-testable.
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETAIN_MS = 26 * HOUR_MS;        // keep a bit more than a day so a 24h window is always complete

const _log = [];   // [{ model, tokens, ts }] — append-only ring, pruned to RETAIN_MS

// Record one model call's token cost. `tokens` is the total (prompt + generated). Fail-soft: bad input is
// ignored, never throws. Prunes anything older than the retention horizon so memory stays bounded.
function record(model, tokens, ts = Date.now()) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return;
  _log.push({ model: String(model || 'unknown'), tokens: Math.round(t), ts: Number(ts) || Date.now() });
  const cutoff = (Number(ts) || Date.now()) - RETAIN_MS;
  if (_log.length && _log[0].ts < cutoff) { let i = 0; while (i < _log.length && _log[i].ts < cutoff) i++; _log.splice(0, i); }
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

function reset() { _log.length = 0; }
function _size() { return _log.length; }

module.exports = { record, summary, tokensOf, reset, _size, DAY_MS, HOUR_MS, RETAIN_MS };
