/*
 * lib/api_stream.js — the API management STREAM surface: conservative snapshot pulls + raw-pull hooks.
 *
 * Two consumption modes (Lucas):
 *   1. PROCESSED → DB (like news): scheduled snapshots of slow-moving sources land here, and a later pass
 *      processes CHANGED snapshots into the memory DB (short-term → long-term objects). This module owns the
 *      pull + persist + change-detection; the landing pass reads store.changedSince().
 *   2. RAW HOOKS for other sections (namely the forecasting suite): getSnapshot(id) = the latest persisted
 *      snapshot with no network; pull(api, path) = an on-demand live pull (markets/weather) through the
 *      manager (rate-limit + cache). Other sections import this module — the stable hook surface.
 *
 * Snapshot APIs update slowly (econ monthly/quarterly, census annually) so cadences are CONSERVATIVE and a
 * refresh no-ops while the stored snapshot is still within cadence. Realtime sources (markets/weather) are
 * NOT scheduled here — they're on-demand pulls. Deps (call / now) injectable → offline-testable.
 */
'use strict';
const store = require('./api_store');
const manager = require('./api_manager');

const H = 3_600_000, D = 86_400_000;

// Hard-coded SNAPSHOT datasets — slow-moving public series pulled on a conservative cadence. (Markets/weather
// are deliberately absent: those are on-demand pull() calls, not scheduled snapshots.)
const DATASETS = [
  { id: 'fred:gdp', api: 'fred', path: 'series/observations', params: { series_id: 'GDP', file_type: 'json' }, cadenceMs: 12 * H, category: 'economics', label: 'US GDP (quarterly)' },
  { id: 'fred:cpi', api: 'fred', path: 'series/observations', params: { series_id: 'CPIAUCSL', file_type: 'json' }, cadenceMs: 12 * H, category: 'economics', label: 'CPI-U (monthly)' },
  { id: 'fred:unrate', api: 'fred', path: 'series/observations', params: { series_id: 'UNRATE', file_type: 'json' }, cadenceMs: 12 * H, category: 'economics', label: 'Unemployment rate (monthly)' },
  { id: 'fred:fedfunds', api: 'fred', path: 'series/observations', params: { series_id: 'FEDFUNDS', file_type: 'json' }, cadenceMs: 12 * H, category: 'economics', label: 'Fed funds rate (monthly)' },
  { id: 'fred:dgs10', api: 'fred', path: 'series/observations', params: { series_id: 'DGS10', file_type: 'json' }, cadenceMs: 6 * H, category: 'economics', label: '10-yr Treasury yield (daily)' },
  { id: 'census:acs-pop-states', api: 'census', path: '2021/acs/acs1', params: { get: 'NAME,B01001_001E', for: 'state:*' }, cadenceMs: 30 * D, category: 'demographics', label: 'State populations (ACS1 2021)' },
];
const BY_ID = Object.fromEntries(DATASETS.map((d) => [d.id, d]));

function datasets() { return DATASETS.slice(); }
function getDataset(id) { return BY_ID[String(id || '')] || null; }
function isStale(id, now = Date.now()) {
  const ds = getDataset(id); if (!ds) return false;
  const s = store.getSnapshot(id);
  return !s || !s.ok || (now - s.fetched_ts) >= ds.cadenceMs;
}

// Refresh a snapshot IF stale (conservative — no-ops while within cadence unless force). Returns
// { datasetId, fetched, changed?, skipped?, snapshot, error? }. `call` (manager.managedCall) + `now` injectable.
async function refreshDataset(id, { force = false, now = null, call = null } = {}) {
  const ds = getDataset(id);
  if (!ds) return { datasetId: id, fetched: false, error: 'unknown dataset' };
  const t = now || Date.now();
  const cur = store.getSnapshot(id);
  if (cur && cur.ok && !force && (t - cur.fetched_ts) < ds.cadenceMs) return { datasetId: id, fetched: false, skipped: 'within-cadence', snapshot: cur };

  const fn = call || manager.managedCall;
  // force at the manager (cache) level — cadence IS our freshness gate, so don't also serve a manager cache hit.
  const r = await fn(ds.api, ds.path, { params: ds.params, now: t, force: true });
  if (!r || !r.ok) return { datasetId: id, fetched: false, error: (r && r.error) || 'pull failed', snapshot: cur };
  const put = store.putSnapshot(id, { apiId: ds.api, path: ds.path, params: ds.params, body: r.data, ok: true, status: r.status, now: t });
  return { datasetId: id, fetched: true, changed: put.changed, snapshot: store.getSnapshot(id) };
}

// --- RAW HOOKS (the stable surface other sections import) ---
// Latest persisted snapshot — no network. What the forecasting section reads for slow-moving series.
function getSnapshot(id) { return store.getSnapshot(id); }
// On-demand live pull through the manager (rate-limit + cache) — for realtime/ad-hoc needs (markets/weather).
async function pull(apiId, path, opts = {}) { return manager.managedCall(apiId, path, opts); }

// --- conservative scheduler ---
function dueDatasets({ now = null } = {}) { const t = now || Date.now(); return DATASETS.filter((d) => isStale(d.id, t)).map((d) => d.id); }
async function runDue({ now = null, call = null, limit = Infinity } = {}) {
  const due = dueDatasets({ now });
  const slice = due.slice(0, limit);
  const results = [];
  for (const id of slice) results.push(await refreshDataset(id, { now, call }));
  return { due: due.length, refreshed: results.filter((r) => r.fetched).length, changed: results.filter((r) => r.changed).length, results };
}

module.exports = { DATASETS, datasets, getDataset, isStale, refreshDataset, getSnapshot, pull, dueDatasets, runDue };
