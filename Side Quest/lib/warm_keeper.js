/**
 * lib/warm_keeper.js — hold the interactive main models HOT on ollama.com.
 *
 * The disease (live audit 2026-08-03): on ollama.com a model that isn't already loaded answers the FIRST
 * request with `done_reason:"load"` in ~0.1ms and generates NOTHING — a non-billed model-load ping, not a
 * reply. The curator (gpt-oss:120b) and distiller (gemma4:31b) get ~1-2 cloud calls/minute from their own
 * work, so they stay loaded and generate ~100% (195 / 145 successful calls in 2h). The replier (kimi-k2.6)
 * is hit ONLY on user turns — far too rare to stay warm — so every reply cold-load-only'd (0 successful
 * kimi calls in 2h). It's a chicken-and-egg a rarely-called model can't escape on its own.
 *
 * The fix Lucas asked for: keep kimi (and the rest of the main fleet) warm with our own cheap heartbeat, so
 * all three are viable main models. A tiny periodic 1-token completion holds the model loaded (keep_alive is
 * '24h' on our transport) exactly the way the distiller's traffic holds gemma.
 *
 * COST-AWARE: a model that real traffic already touched within the interval is SKIPPED (usage_meter.lastSeen)
 * — we never pay to warm gpt-oss/gemma while curation/distillation is hammering them; the spend lands only on
 * an otherwise-idle replier. Fleet + interval are meta-configurable. Fail-soft: never throws, cloud-down → no-op.
 */
'use strict';

const DEFAULT_FLEET = ['kimi-k2.6'];   // only the replier NEEDS warming; gpt-oss/gemma stay hot on real work.
const DEFAULT_INTERVAL_S = 75;         // ~matches the distiller cadence that keeps gemma at ~100% (145 calls/2h).
const PING_MESSAGES = [{ role: 'user', content: 'ping' }];

let _inFlight = false;   // never let two ticks overlap (a slow cloud ping must not stack)

function _db() { try { return require('./db'); } catch { return null; } }

// The models to hold warm. meta `models.warm_fleet` (JSON array) overrides; else the replier + any pinned
// fallback, deduped — so whatever Lucas sets as his interactive voice is the thing we keep hot.
function fleet(db = _db()) {
  try {
    const raw = db && db.getMeta('models.warm_fleet');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return [...new Set(a.map(String).filter(Boolean))]; }
  } catch { /* fall through to the derived default */ }
  try {
    const rep = db && db.getMeta('model.replier');
    const fb = db && db.getMeta('model.replier_fallback');
    const derived = [rep, fb].filter(Boolean).map(String);
    if (derived.length) return [...new Set(derived)];
  } catch { /* fall through */ }
  return DEFAULT_FLEET.slice();
}

function intervalMs(db = _db()) {
  try { const v = parseInt(db && db.getMeta('models.warm_interval_s'), 10); if (Number.isFinite(v) && v >= 20) return v * 1000; } catch {}
  return DEFAULT_INTERVAL_S * 1000;
}

// Only CLOUD models cold-load-only; a local model is loaded once and stays. Warm the cloud fleet only.
function _isCloudModel(name) { return /-cloud$|:cloud$|\bk2\b|kimi|gpt-oss|deepseek|qwen3|minimax|gemma4:31b/i.test(String(name || '')); }

/**
 * One warm pass: for each fleet model not touched by real traffic within the interval, fire a 1-token
 * completion to keep it loaded. deps.complete / deps.lastSeen injectable for tests. Returns a small report.
 */
async function tick({ db = _db(), deps = {} } = {}) {
  if (_inFlight) return { skipped: 'in-flight' };
  _inFlight = true;
  const report = { pinged: [], skipped: [], warm: [], cold: [] };
  try {
    const cloud = require('./cloud_logic');
    const meter = deps.meter || require('./usage_meter');
    const now = Date.now();
    const iv = intervalMs(db);
    for (const model of fleet(db)) {
      if (!_isCloudModel(model)) { report.skipped.push(`${model}:local`); continue; }
      // Real traffic within the interval already keeps it warm — don't pay to re-warm it.
      const seen = (deps.lastSeen || meter.lastSeen)(model, now);
      if (seen && now - seen < iv) { report.skipped.push(`${model}:recent`); continue; }
      report.pinged.push(model);
      try {
        const c = (deps.complete || cloud._complete)
          ? await (deps.complete || cloud._complete)(PING_MESSAGES, { model, num_predict: 1, think: false, temperature: 0 })
          : null;
        if (c && typeof c.text === 'string' && c.text.trim().length > 0) report.warm.push(model);
        else report.cold.push(model);   // still load-only — the ping itself begins warming it for next time
      } catch (e) { report.cold.push(`${model}:${e && e.message ? e.message.slice(0, 40) : 'err'}`); }
    }
  } catch (e) { report.error = e && e.message; }
  finally { _inFlight = false; }
  return report;
}

module.exports = { tick, fleet, intervalMs, DEFAULT_FLEET, DEFAULT_INTERVAL_S, _isCloudModel };
