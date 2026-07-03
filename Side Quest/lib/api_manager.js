/*
 * lib/api_manager.js — the MANAGEMENT layer over lib/api_client (the "management" in API management stream).
 *
 * A bare caller hits an endpoint; a MANAGED stream also: (1) RATE-LIMIT guards each API against its free-tier
 * quota so a consumer can't blow the 25/day / 5/min budgets, (2) CACHES responses per-API TTL to avoid
 * redundant spend, (3) tracks USAGE (the management view), and (4) HEALTH-checks liveness+auth. This wraps
 * api_client.call with all four. In-memory to start (rate windows are min/hour/day; a restart resetting them
 * is acceptable for the mechanism-first cut — a persistent store is a later slice). Deps (now / callFn) are
 * injectable so the whole mechanism is offline-testable with no network. Rate/cache POLICY lives here (the
 * management concern); the catalog stays pure identity + auth.
 */
'use strict';
const catalog = require('./api_catalog');
const client = require('./api_client');
const store = require('./api_store');   // durable rate-usage + response cache (survives restart)

const WINDOW_MS = { perMin: 60_000, perHour: 3_600_000, perDay: 86_400_000 };

// Free-tier rate policy — the TIGHTEST known limit per API. Absent → unlimited (generous .gov endpoints).
const LIMITS = {
  polygon: { perMin: 5 }, alphavantage: { perMin: 5, perDay: 25 }, newsapi: { perDay: 100 },
  fmp: { perDay: 250 }, fec: { perHour: 1000 }, openweather: { perMin: 60 }, notion: { perMin: 180 },
  bls: { perDay: 500 }, fred: { perMin: 120 },
};
// Response cache TTL (ms) — econ/demographics change slowly, markets fast, Notion not cached.
const CACHE_TTL = {
  fred: 3_600_000, fec: 3_600_000, bls: 3_600_000, bea: 3_600_000, census: 86_400_000,
  newsapi: 300_000, polygon: 60_000, alphavantage: 300_000, fmp: 60_000, openweather: 600_000, notion: 0,
};
// A cheap GET that proves liveness + auth for health checks. [path, opts].
const HEALTH_PATH = {
  fred: ['releases', { params: { file_type: 'json', limit: 1 } }],
  openweather: ['weather', { params: { q: 'London' } }],
  census: ['2021/acs/acs1', { params: { get: 'NAME', for: 'state:06' } }],
  fec: ['candidates/', { params: { per_page: 1 } }],
  notion: ['users/me', {}],
  fmp: ['quote/AAPL', {}],
  polygon: ['v1/marketstatus/now', {}],
};

const limitsFor = (id) => LIMITS[id] || {};
const cacheTtlFor = (id) => (Object.prototype.hasOwnProperty.call(CACHE_TTL, id) ? CACHE_TTL[id] : 0);
const cacheKey = (apiId, path, params) => `${apiId}|${path}|${JSON.stringify(params || {})}`;

// Rate accounting is now DURABLE (api_store): counts survive a restart so a reboot can't reset a spent daily
// quota. Prune keeps ~2 days (the longest window is a day) so the usage log stays bounded.
function recordCall(apiId, ts) { store.recordUsage(apiId, ts); store.pruneUsage(ts - 2 * WINDOW_MS.perDay); }
function countIn(apiId, windowMs, now) { return store.countUsage(apiId, now - windowMs); }

// The window (if any) currently at/over its cap → null when clear.
function rateHit(apiId, now) {
  const lim = limitsFor(apiId);
  for (const w of Object.keys(lim)) if (countIn(apiId, WINDOW_MS[w], now) >= lim[w]) return { window: w, limit: lim[w] };
  return null;
}

// MANAGED CALL: cache → rate-limit guard → client.call → record + cache. `force` skips the cache read; `now`
// and `callFn` are injectable for tests. Never throws (delegates to client.call's fail-soft).
async function managedCall(apiId, path, { params = {}, force = false, now = null, callFn = null, ...rest } = {}) {
  const api = catalog.get(apiId);
  if (!api) return { ok: false, error: `unknown api: ${apiId}` };
  const t = now || Date.now();
  const ttl = cacheTtlFor(apiId);
  const key = cacheKey(apiId, path, params);

  if (!force && ttl > 0) { const c = store.getCache(key, t); if (c) return { ok: true, status: c.status, data: c.data, cached: true }; }

  const hit = rateHit(apiId, t);
  if (hit) return { ok: false, rateLimited: true, error: `rate limit reached: ${hit.limit}/${hit.window} for ${apiId}`, window: hit.window, limit: hit.limit };

  const r = await (callFn || client.call)(apiId, path, { params, ...rest });
  recordCall(apiId, t);                                                  // only real (non-cached, non-blocked) calls count
  if (r && r.ok && ttl > 0) store.putCache(key, r.data, r.status, t + ttl);
  return r;
}

// USAGE view (management): counts per window + whether currently rate-limited.
function usage(apiId, { now = null } = {}) {
  const t = now || Date.now();
  const used = {};
  for (const w of Object.keys(WINDOW_MS)) used[w] = countIn(apiId, WINDOW_MS[w], t);
  return { apiId, limits: limitsFor(apiId), used, rateLimited: !!rateHit(apiId, t) };
}

// HEALTH: ping the cheap endpoint live (force, so it's a real probe) → { id, ok, status, error? }.
async function health(apiId, { callFn = null, now = null } = {}) {
  const hp = HEALTH_PATH[apiId];
  if (!hp) return { id: apiId, ok: null, error: 'no health endpoint defined' };
  const r = await managedCall(apiId, hp[0], Object.assign({ callFn, now, force: true }, hp[1] || {}));
  return { id: apiId, ok: !!r.ok, status: r.status, error: r.ok ? undefined : r.error };
}

async function healthAll({ callFn = null } = {}) {
  const out = [];
  for (const id of catalog.ids()) if (HEALTH_PATH[id]) out.push(await health(id, { callFn }));
  return out;
}

function resetUsage() { store.clearUsage(); store.clearCache(); }

module.exports = { managedCall, usage, health, healthAll, rateHit, countIn, cacheKey, resetUsage, LIMITS, CACHE_TTL, WINDOW_MS, HEALTH_PATH };
