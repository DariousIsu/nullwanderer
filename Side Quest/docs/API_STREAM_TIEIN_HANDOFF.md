# API Management Stream — Tie-In Handoff

**For:** any section consuming public-data APIs (primary consumer = the **forecasting suite**).
**Status:** built + committed, gate-green. **Post-reboot scheduler seeding VERIFIED 2026-07-03 — all 6 datasets seeded (§7).**
**You do NOT need to touch:** auth, keys, rate limits, caching, or the DB. The stream owns all of that. You import two functions.

---

## 1. The one rule

**Never call an API directly, and never call `lib/api_client` directly.** Go through `lib/api_stream`. That's the managed surface — it enforces rate limits, caches, persists, and keeps keys out of your code. Bypassing it will blow free-tier quotas (e.g. Alpha Vantage is 25 calls/**day**).

```js
const apiStream = require('./lib/api_stream');   // in-process consumers (forecasting lib, landing, etc.)
```

Renderer/UI consumers use the `sq.api` bridge instead (see §5).

---

## 2. The two hooks (this is the whole surface)

```js
// (A) SLOW-MOVING SERIES — read the latest PERSISTED snapshot. No network. Instant. Never rate-limited.
const snap = apiStream.getSnapshot('fred:gdp');
//   → null if never pulled yet, else:
//   { datasetId, apiId, path, params, body, hash, ok, status, fetched_ts, changed_ts }
//   `body` is the raw parsed API payload (for fred:gdp → { observations: [...] }).

// (B) REALTIME / AD-HOC — an on-demand LIVE pull through the manager (rate-limit + cache applied).
const res = await apiStream.pull('openweather', 'weather', { params: { q: 'London' } });
//   → { ok, status, data }            on success
//   → { ok:false, error }             on failure
//   → { ok:false, rateLimited:true, error, window, limit }   if the quota is spent
//   → { ok:true, cached:true, ... }   if served from the TTL cache
```

**Decision rule for which hook:**
- The data updates monthly/quarterly/annually (GDP, CPI, unemployment, population) → it's a **scheduled dataset**; use `getSnapshot(id)`. The stream already keeps it fresh in the background. Zero-latency, no quota cost.
- The data is realtime or you need an arbitrary endpoint not on the schedule (a stock quote, current weather, a one-off FRED series) → use `pull(apiId, path, opts)`.

**Never poll `pull()` in a loop for slow data.** If you find yourself pulling GDP every request, it should be a scheduled dataset instead (see §4) and you read it with `getSnapshot`.

---

## 3. Available scheduled datasets (read via `getSnapshot`)

Defined in [lib/api_stream.js](../lib/api_stream.js) `DATASETS`. The background scheduler keeps these fresh on a conservative cadence.

| dataset id | series | cadence | `body` shape |
|---|---|---|---|
| `fred:gdp` | US GDP (quarterly) | 12h | `{ observations: [{date, value}, ...] }` |
| `fred:cpi` | CPI-U (monthly) | 12h | same FRED shape |
| `fred:unrate` | Unemployment rate | 12h | same |
| `fred:fedfunds` | Fed funds rate | 12h | same |
| `fred:dgs10` | 10-yr Treasury yield (daily) | 6h | same |
| `census:acs-pop-states` | State populations (ACS1 2021) | 30d | Census array-of-arrays |

To get the latest value of a FRED series:
```js
const s = apiStream.getSnapshot('fred:cpi');
const obs = s?.body?.observations || [];
const latest = obs[obs.length - 1];   // { date: '2026-06-01', value: '...' }
```

---

## 4. Adding a scheduled dataset (one edit)

Append an entry to `DATASETS` in [lib/api_stream.js](../lib/api_stream.js). Nothing else — the scheduler, persistence, and change-detection pick it up automatically.

```js
{ id: 'fred:payems', api: 'fred', path: 'series/observations',
  params: { series_id: 'PAYEMS', file_type: 'json' },
  cadenceMs: 12 * H, category: 'economics', label: 'Nonfarm payrolls (monthly)' },
```
- `id` — your stable read key (`getSnapshot('fred:payems')`).
- `api` — an id from the catalog (§6).
- `cadenceMs` — how often it *may* refresh. Be conservative: a monthly series doesn't need sub-daily pulls. `H` and `D` (hour/day ms) are in scope.
- Pick a cadence well under the update frequency but not wasteful — 12h for monthly/quarterly is plenty.

After adding: it lands into memory automatically too (§8) with a FRED formatter. For a non-FRED shape, add a formatter in `lib/api_landing.js` or it falls back to a generic row-count summary.

---

## 5. Renderer / UI consumers — the `sq.api` bridge

Wired in [preload.js](../preload.js) → IPC in [main.js](../main.js). All async.

```js
await sq.api.datasets();               // { ok, datasets:[...], catalog:[...] } — inventory
await sq.api.snapshot('fred:gdp');     // { ok, snapshot } — persisted, no network
await sq.api.pull('polygon', 'v2/aggs/ticker/AAPL/prev', { ...params });  // live pull
await sq.api.refresh('fred:gdp', true); // force a refresh now (bypasses cadence)
await sq.api.keyStatus();              // { ok, keys:[{id, hasKey}] } — which keys are present (no values)
await sq.api.health();                 // { ok, health:[{id, ok, status}] } — live liveness+auth probe
```

---

## 6. The catalog (available `apiId`s for `pull`)

From [lib/api_catalog.js](../lib/api_catalog.js). `pull(apiId, path, ...)` accepts any of these ids. Auth/keys are handled for you.

| apiId | category | free-tier limit (enforced) | notes |
|---|---|---|---|
| `fred` | economics | 120/min | `?series_id=...&file_type=json` |
| `fec` | elections | 1000/hr | OpenFEC |
| `bls` | economics | 500/day | **POST**, key in body |
| `bea` | economics | — | `?method=GetData&...` |
| `census` | demographics | — | array-of-arrays payload |
| `newsapi` | news | 100/day | header auth |
| `polygon` | markets | 5/min | ⚠ key currently 401 (§7) |
| `alphavantage` | markets | 5/min + 25/day | very tight — cache-friendly only |
| `fmp` | markets | 250/day | ⚠ key currently 403 (§7) |
| `openweather` | weather | 60/min | `?q=` or `?lat=&lon=` |
| `notion` | productivity | 180/min | bearer + Notion-Version |

`pull` passes `path` relative to the catalog `baseUrl`. Extra request options (`method`, `body`, `params`) flow through. You never pass a key.

**Rate/cache behavior you can rely on:** the manager blocks an over-quota call *before* spending it (returns `rateLimited:true`), and serves a per-API TTL cache (FRED/FEC/BLS 1h, Census 1d, markets 60s, weather 10m, Notion uncached). Pass `force:true` in opts to bypass the cache read.

---

## 7. Known caveats (don't rediscover these)

- **`fmp` → 403, `polygon` → 401**: those two keys are currently rejected by the provider. Left as-is deliberately (mechanism over sources). Don't build a hard dependency on markets data via these two until the keys are confirmed. `openweather`, `fred`, `census`, `fec`, `notion` are live-verified 200.
- **Rate windows are in-memory**: an app restart resets the min/hour/day counters. Acceptable for now; a persistent usage store is a later slice. Don't assume cross-restart quota accounting.
- **Post-reboot scheduler seeding — VERIFIED 2026-07-03**: all **6/6** datasets seeded post-reboot, ok=200,
  fetched within ~12–36 min of boot (the +5 min scheduler + refreshes fired). Confirmed live values: fred:gdp
  321 obs (2026-01), fred:cpi 953 obs (2026-05 = 333.98), fred:unrate 942 obs (4.2%), fred:fedfunds 864 obs
  (3.63%), fred:dgs10 16,827 obs (4.48%), census:acs-pop-states 53 rows. *(Workaround if a future snapshot is
  ever `null` — scheduler not yet run: `sq.api.refresh(id, true)` or `apiStream.refreshDataset(id, {force:true})`.)*

---

## 8. Where raw data goes without you (context)

You don't need to wire this — it's automatic — but so you understand the flow:

- **Raw layer**: `lib/api_store.js` — isolated DB `data/api_stream.db` (NOT sq.db). Raw payloads live here, keyed by dataset, with a content hash for change-detection. This is what `getSnapshot` reads.
- **Processed layer**: `lib/api_landing.js` runs on the schedule, takes any *changed* snapshot, formats it to a concise memory doc (`source:'api'`, `ref:'api:snapshot:<id>'`), lands it in sq.db, and it rides the overnight promotion into Echo — same rail as a news evidence doc. Idempotent: an unchanged monthly series is never re-processed.

So a dataset you add in §4 shows up in **both** places: readable raw via `getSnapshot`, and processed into long-term memory automatically.

---

## 9. TL;DR for the forecasting tie-in

```js
const api = require('./lib/api_stream');

// slow econ signals — free, instant, always fresh:
const gdp    = api.getSnapshot('fred:gdp')?.body?.observations;
const cpi    = api.getSnapshot('fred:cpi')?.body?.observations;
const yield10 = api.getSnapshot('fred:dgs10')?.body?.observations;

// anything realtime / off-schedule — rate-limited + cached for you:
const wx = await api.pull('openweather', 'weather', { params: { q: 'Des Moines' } });

// need a new recurring series? add one line to DATASETS in lib/api_stream.js.
```

That's the whole contract. Don't reach past `api_stream`.
