/**
 * lib/econ_feed.js — the FORECASTING ⇄ api_stream CONTRACT (the managed macro-data surface, exactly like
 * news_feed.js is the managed news surface). The forecasting machine NEVER reaches past this into api_store /
 * api_client / the raw APIs — it reads the seeded economic snapshots through the ONE hook the api-stream lane
 * exposes (`api_stream.getSnapshot(id)`, no network, always-fresh) and hands the models a forecasting-shaped
 * indicator: level + YoY change + short-term trend/direction.
 *
 * Why compute changes here: FRED series arrive as raw levels — CPI is an INDEX (~334, not an inflation rate),
 * GDP is a $-level (~31.8T). The directional economic signal a forecast wants is the RATE OF CHANGE, so the
 * pure cores derive YoY % and a 90-day trend from the observation series (robust across quarterly/monthly/daily
 * cadences by measuring over a TIME window, not a period count). `unrate`/`dgs10`/`fedfunds` are already rates,
 * so their level is used directly + a trend. PURE cores (seriesFrom / changeOver / indicatorFrom) take a raw
 * body → offline-testable; the live wrappers inject `getSnapshot`. Fail-soft everywhere → [] / null fields.
 */
'use strict';

const DAY = 86400000;
const r4 = (x) => Math.round(x * 10000) / 10000;

// The seeded FRED macro set (docs/API_STREAM_TIEIN_HANDOFF.md §3). key = the compact name the model reads.
const FRED_SET = [
  { id: 'fred:gdp', key: 'gdp', label: 'US GDP (nominal, quarterly)' },
  { id: 'fred:cpi', key: 'cpi', label: 'CPI-U (index)' },
  { id: 'fred:unrate', key: 'unrate', label: 'Unemployment rate (%)' },
  { id: 'fred:fedfunds', key: 'fedfunds', label: 'Fed funds rate (%)' },
  { id: 'fred:dgs10', key: 'dgs10', label: '10-yr Treasury yield (%)' },
];

// PURE — a FRED observations body → ascending [{date, t, value}] with missing ('.') / non-finite rows dropped.
function seriesFrom(body) {
  const obs = body && Array.isArray(body.observations) ? body.observations : [];
  const out = [];
  for (const o of obs) {
    const v = Number(o && o.value);
    const t = o && o.date ? Date.parse(o.date) : NaN;
    if (Number.isFinite(v) && Number.isFinite(t)) out.push({ date: o.date, t, value: v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function latest(series) { return series && series.length ? series[series.length - 1] : null; }

// the last observation at or before targetT (series is ascending)
function valueBefore(series, targetT) {
  let found = null;
  for (const p of series) { if (p.t <= targetT) found = p; else break; }
  return found;
}

// PURE — change of a series over ~`days` (abs + %). null when the window can't be spanned.
function changeOver(series, days) {
  const last = latest(series);
  if (!last || series.length < 2) return null;
  const ref = valueBefore(series, last.t - days * DAY);
  if (!ref || ref.t === last.t) return null;
  const abs = last.value - ref.value;
  const pct = ref.value !== 0 ? (abs / Math.abs(ref.value)) * 100 : null;
  return { abs: r4(abs), pct: pct == null ? null : r4(pct), from: ref.date, to: last.date };
}

// PURE — a raw body → the normalized indicator the model consumes.
function indicatorFrom(id, body, opts = {}) {
  const s = seriesFrom(body);
  const last = latest(s);
  const yoy = changeOver(s, 365);
  const trend = changeOver(s, 90);
  return {
    id, label: opts.label || id,
    value: last ? last.value : null, asOf: last ? last.date : null, n: s.length,
    yoyPct: yoy ? yoy.pct : null, yoyAbs: yoy ? yoy.abs : null,
    trendAbs: trend ? trend.abs : null,
    direction: trend ? (trend.abs > 0 ? 'up' : trend.abs < 0 ? 'down' : 'flat') : null,
  };
}

// ---- LIVE wrappers (inject api_stream.getSnapshot). Fail-soft. ----
function readBody(id, getSnapshot) { try { const s = getSnapshot(id); return s && s.body ? s.body : null; } catch { return null; } }

// array of normalized indicators for the macro set (for a raw view / a UI listing).
function indicators({ getSnapshot, set = FRED_SET } = {}) {
  if (typeof getSnapshot !== 'function') return [];
  return set.map((d) => indicatorFrom(d.id, readBody(d.id, getSnapshot), { label: d.label }));
}

// the compact { gdp, cpi, unrate, fedfunds, dgs10 } indicator object the fundamentals model reads.
function environment({ getSnapshot } = {}) {
  const out = {};
  for (const d of FRED_SET) out[d.key] = typeof getSnapshot === 'function' ? indicatorFrom(d.id, readBody(d.id, getSnapshot), { label: d.label }) : indicatorFrom(d.id, null, { label: d.label });
  return out;
}

module.exports = { FRED_SET, seriesFrom, latest, valueBefore, changeOver, indicatorFrom, indicators, environment };
