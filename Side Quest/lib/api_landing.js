/*
 * lib/api_landing.js — the PROCESSED→DB path: changed API snapshots become memory documents (like news).
 *
 * Mode 1 of the two consumption modes (Lucas: "processed into the development of the database like news").
 * When a slow-moving snapshot's content actually CHANGES (store detects it via hash), this pass formats it
 * into a concise, human-readable document and lands it into short-term memory (doc_store) — which then rides
 * the existing overnight promote rail into Echo long-term (vault doc + entity extraction), exactly the way a
 * news evidence doc does. Idempotent: a dataset is (re)landed only when its content changed (landed_hash), so
 * a monthly series that hasn't moved is never re-processed.
 *
 * landDoc is injected (doc_store.land) → offline-testable. Formatting is per-source (a FRED time-series
 * formatter + a generic fallback); more formatters are a later slice as datasets grow.
 */
'use strict';
const store = require('./api_store');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US') : String(v); };
const ymd = (ms) => { try { return new Date(ms).toISOString().slice(0, 10); } catch { return ''; } };

// FRED series → latest value + prior + % change. Returns { title, body, understanding } | null if no data.
function fredSummary(ds, snap) {
  const obs = (snap.body && snap.body.observations) || [];
  const valid = obs.filter((o) => o && o.value != null && o.value !== '.');
  if (!valid.length) return null;
  const latest = valid[valid.length - 1];
  const prior = valid[valid.length - 2] || null;
  const series = (ds.params && ds.params.series_id) || ds.id;
  let line = `As of ${latest.date}, ${ds.label} = ${num(latest.value)}.`;
  if (prior) {
    const d = Number(latest.value) - Number(prior.value);
    const pct = Number(prior.value) !== 0 ? (d / Number(prior.value)) * 100 : null;
    line += ` Prior (${prior.date}): ${num(prior.value)}${pct != null ? ` — ${d >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}.`;
  }
  const body = `# ${ds.label}\n\n${line}\n\nSource: FRED series \`${series}\` (${valid.length} observations). Pulled ${ymd(snap.fetched_ts)}.`;
  return { title: ds.label, body, understanding: line };
}

// Fallback for any non-FRED snapshot: a compact summary + a truncated payload preview.
function genericSummary(ds, snap) {
  const b = snap.body;
  const count = Array.isArray(b) ? b.length : (b && typeof b === 'object' ? Object.keys(b).length : 0);
  const body = `# ${ds.label}\n\nSnapshot from ${ds.api} (${count} rows/keys). Pulled ${ymd(snap.fetched_ts)}.\n\n\`\`\`\n${JSON.stringify(b).slice(0, 800)}\n\`\`\``;
  return { title: ds.label, body, understanding: `${ds.label} — ${ds.api} snapshot (${count} rows)` };
}

function formatSnapshot(ds, snap) {
  if (!ds || !snap) return null;
  if (ds.api === 'fred') return fredSummary(ds, snap) || genericSummary(ds, snap);
  return genericSummary(ds, snap);
}

// Land every UNLANDED-CHANGED snapshot into memory. `landDoc` = doc_store.land (injected). `getDataset`
// resolves dataset metadata (defaults to the api_stream registry). Idempotent via store.markLanded. Never throws.
async function landChanged({ landDoc = null, getDataset = null, now = Date.now() } = {}) {
  const gd = getDataset || require('./api_stream').getDataset;
  const pending = store.unlandedChanged();
  let landed = 0, skipped = 0;
  const results = [];
  for (const snap of pending) {
    const ds = gd(snap.datasetId);
    const doc = ds ? formatSnapshot(ds, snap) : null;
    if (!doc) { store.markLanded(snap.datasetId, snap.hash); skipped++; continue; }   // unknown/empty → mark so it doesn't loop
    try {
      if (typeof landDoc === 'function') {
        await landDoc({ title: `Data — ${doc.title}`.slice(0, 120), body: doc.body, source: 'api', ref: `api:snapshot:${snap.datasetId}`, understanding: doc.understanding });
      }
      store.markLanded(snap.datasetId, snap.hash);
      landed++; results.push({ datasetId: snap.datasetId, ok: true });
    } catch (e) { results.push({ datasetId: snap.datasetId, ok: false, error: e && e.message }); }
  }
  return { landed, skipped, results };
}

module.exports = { formatSnapshot, fredSummary, genericSummary, landChanged };
