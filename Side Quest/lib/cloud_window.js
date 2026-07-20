/**
 * cloud_window — how much context a CLOUD call is actually allowed to use.
 *
 * Every cloud call in this codebase asked for `num_ctx: 8192`. That number is the LOCAL model's
 * window, hardcoded back when the local model made every call, and it silently followed the work up
 * to the cloud. Measured against the live account (2026-07-20):
 *
 *     gpt-oss:120b     131,072      deepseek-v4-pro  524,288
 *     kimi-k2.6        262,144      minimax-m3       524,288
 *     qwen3.5:397b     262,144      …all of them requested at 8,192
 *
 * So a frontier model was being run inside 1.6% of its window — and worse, every truncation cap in
 * the system was calibrated to fit that: grounding 4,600 chars, readings 2,600, tool results 4,000,
 * drafts 400 output tokens. We were paying frontier prices to keep a local model's constraints.
 * Nothing errored, because a small window is not an error — it just quietly drops the tail.
 *
 * lib/models already knew how to discover the real window (modelContext → /api/show →
 * *.context_length). It was simply never consulted on the cloud path. This resolves it, caches it
 * (a model's window does not change), and fails SAFE: if discovery fails we return exactly today's
 * 8192 rather than guessing a large window the endpoint might reject.
 *
 * Deliberately NOT the model's whole window by default. Requesting 524k allocates a KV cache to
 * match and buys latency and cost for context we don't have; DEFAULT_MAX is the working ceiling and
 * ZOE_CLOUD_CTX_MAX raises it when there is genuinely that much to say.
 */
'use strict';

const FLOOR = 8192;                 // today's behaviour — the fail-safe, never go below it
const DEFAULT_MAX = 131072;         // 16× the old cap; matches Echo's own documented safe default
const DEFAULT_PREDICT = 2048;       // was 900 — a capped OUTPUT is its own truncation source

const _cache = new Map();           // model -> resolved context length (or null when unknown)

function _envInt(name) {
  const v = parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Working ceiling: how much of a discovered window we're willing to ask for. */
function maxCtx() { return _envInt('ZOE_CLOUD_CTX_MAX') || DEFAULT_MAX; }

/** Output budget. A "complete thought" cannot be longer than this, whatever the input window. */
function numPredict() { return _envInt('ZOE_CLOUD_NUM_PREDICT') || DEFAULT_PREDICT; }

/**
 * Resolve { num_ctx, num_predict, discovered, source } for a cloud model.
 *
 * source: 'override' (env pin) | 'discovered' (asked the endpoint) | 'floor' (discovery failed).
 * Never throws — a resolution failure must not be able to break a user-facing turn.
 */
async function resolve({ model, base = null, token = null, deps = {} } = {}) {
  const num_predict = numPredict();
  const pinned = _envInt('ZOE_CLOUD_NUM_CTX');
  if (pinned) return { num_ctx: pinned, num_predict, discovered: null, source: 'override' };
  if (!model) return { num_ctx: FLOOR, num_predict, discovered: null, source: 'floor' };

  let discovered = _cache.has(model) ? _cache.get(model) : undefined;
  if (discovered === undefined) {
    discovered = null;
    try {
      const modelContext = deps.modelContext || require('./models').modelContext;
      const v = await modelContext(model, base, token);
      if (Number.isFinite(v) && v > 0) discovered = v;
    } catch { /* fail safe → floor */ }
    _cache.set(model, discovered);
    if (discovered) console.log(`[cloud_window] ${model} context ${discovered.toLocaleString()} → using ${Math.max(FLOOR, Math.min(discovered, maxCtx())).toLocaleString()}`);
    else console.warn(`[cloud_window] ${model}: context length unknown → holding the ${FLOOR} floor`);
  }

  if (!discovered) return { num_ctx: FLOOR, num_predict, discovered: null, source: 'floor' };
  // Clamp both ways: never below today's floor (a tiny discovered window would be a regression),
  // never above the working ceiling (see the module header).
  const num_ctx = Math.max(FLOOR, Math.min(discovered, maxCtx()));
  return { num_ctx, num_predict, discovered, source: 'discovered' };
}

function _resetCache() { _cache.clear(); }   // tests

module.exports = { resolve, maxCtx, numPredict, _resetCache, FLOOR, DEFAULT_MAX, DEFAULT_PREDICT };
