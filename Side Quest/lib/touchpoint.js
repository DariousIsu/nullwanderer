/**
 * lib/touchpoint.js — M4.1 TOUCHPOINT EMISSION (docs/BUILD_PLAN_2026-08-03.md, Interweave).
 *
 * Every completed product (a decomposed landed doc — meeting notes, canvas drop, browser download,
 * swept/news evidence doc — and a condensed focus run) STAMPS the entities/concepts it touched with
 * the stream that touched them. The stamp is the raw material for M4.2's intersection pass: a fresh
 * touchpoint whose entity also lives in ANOTHER active stream's concept set is a cross-project
 * leverage candidate. Emission is deliberately dumb — no model calls, no resolution, just what the
 * completing product already had in hand — because the JOIN is where judgement belongs, not the stamp.
 *
 * Store: sq.db `touchpoints` (entity_key normalized for joining; one row per entity×stream, latest
 * touch wins — an UPSERT, so re-decomposing a doc refreshes rather than duplicates).
 *
 * FAIL-OPEN EVERYWHERE: a touchpoint is metadata about work, never the work — no caller may break
 * because stamping failed. Kill switch: ZOE_TOUCHPOINTS=0.
 */
'use strict';

const MAX_PER_PRODUCT = 60;          // a dense roster names 40+; beyond this the stamp is noise
const _counts = new Map();           // productRef → stamped-so-far (per-process; caps a chunked decompose)

function enabled() { return !/^(0|false|no|off)$/i.test(String(process.env.ZOE_TOUCHPOINTS || '').trim()); }

function _db() { try { return require('./db').getDb(); } catch { return null; } }

let _schemaReady = false;
function ensureSchema(d = _db()) {
  if (_schemaReady || !d) return !!_schemaReady;
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS touchpoints (
      id INTEGER PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      entity_type TEXT,
      stream_kind TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      stream_label TEXT,
      product_ref TEXT,
      ts INTEGER NOT NULL,
      UNIQUE(entity_key, stream_key)
    );
    CREATE INDEX IF NOT EXISTS idx_touchpoints_entity ON touchpoints(entity_key, ts);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_ts ON touchpoints(ts);`);
    _schemaReady = true;
  } catch { /* fail-open — no schema, no stamps, no breakage */ }
  return _schemaReady;
}

// Join key: canonical-ish, cheap, deterministic. Reuses doc_decompose.coreKey when available (the
// same normalization the extractor's identity path uses, so joins agree with the graph), else a
// lowercase collapse. A key under 3 chars can't join meaningfully → dropped.
function keyOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  let k = '';
  try { k = require('./doc_decompose').coreKey(s) || ''; } catch {}
  if (!k) k = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 3 ? k : '';
}

/**
 * Stamp one entity for one stream. stream = { kind, key, label }, ref = product pointer (doc id/path).
 * Returns true iff a row landed/refreshed. Never throws.
 */
function record({ name, type = null, stream = {}, ref = null, now = Date.now() } = {}) {
  if (!enabled()) return false;
  const entity = String(name || '').trim().slice(0, 200);
  const key = keyOf(entity);
  const skey = String(stream.key || '').trim().slice(0, 120);
  if (!entity || !key || !skey) return false;
  const capKey = String(ref || skey);
  const seen = _counts.get(capKey) || 0;
  if (seen >= MAX_PER_PRODUCT) return false;
  const d = _db();
  if (!d || !ensureSchema(d)) return false;
  try {
    d.prepare(`INSERT INTO touchpoints (entity, entity_key, entity_type, stream_kind, stream_key, stream_label, product_ref, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_key, stream_key) DO UPDATE SET ts = excluded.ts, entity = excluded.entity,
        entity_type = COALESCE(excluded.entity_type, touchpoints.entity_type),
        stream_label = COALESCE(excluded.stream_label, touchpoints.stream_label),
        product_ref = COALESCE(excluded.product_ref, touchpoints.product_ref)`)
      .run(entity, key, type ? String(type).slice(0, 40) : null,
        String(stream.kind || 'doc').slice(0, 40), skey,
        stream.label ? String(stream.label).slice(0, 200) : null,
        ref != null ? String(ref).slice(0, 200) : null, now);
    _counts.set(capKey, seen + 1);
    return true;
  } catch { return false; }
}

// The decompose tee: an extractor observation → a stamp. Only PROMOTED (or unstatused) observations
// with a real source entity count — a held/refused candidate never becomes interweave material.
function recordObservation(obs, { stream = {}, ref = null, now = Date.now() } = {}) {
  if (!obs || !obs.sourceEntity) return false;
  if (obs.status && obs.status !== 'promoted') return false;
  return record({ name: obs.sourceEntity, type: obs.type || null, stream, ref, now });
}

/**
 * Fresh touchpoints for the M4.2 intersection pass: rows younger than sinceMs, grouped per entity
 * with every stream that touched it. Only entities touched by ≥1 fresh stamp return; the caller
 * joins against other streams' concept sets.
 */
function fresh({ sinceMs = 24 * 3600 * 1000, now = Date.now(), limit = 200 } = {}) {
  const d = _db();
  if (!d || !ensureSchema(d)) return [];
  try {
    const rows = d.prepare(`SELECT entity, entity_key, entity_type, stream_kind, stream_key, stream_label, product_ref, ts
      FROM touchpoints WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(now - sinceMs, limit);
    const byKey = new Map();
    for (const r of rows) {
      const g = byKey.get(r.entity_key) || { entity: r.entity, entity_key: r.entity_key, entity_type: r.entity_type, streams: [] };
      if (!g.streams.some((s) => s.key === r.stream_key)) g.streams.push({ kind: r.stream_kind, key: r.stream_key, label: r.stream_label, ref: r.product_ref, ts: r.ts });
      byKey.set(r.entity_key, g);
    }
    return [...byKey.values()];
  } catch { return []; }
}

/** All streams that ever touched an entity key (the historical join surface for 4.2). */
function streamsFor(entityKey, { limit = 20 } = {}) {
  const d = _db();
  if (!d || !ensureSchema(d)) return [];
  try {
    return d.prepare(`SELECT stream_kind kind, stream_key key, stream_label label, product_ref ref, ts
      FROM touchpoints WHERE entity_key = ? ORDER BY ts DESC LIMIT ?`).all(String(entityKey || ''), limit);
  } catch { return []; }
}

module.exports = { enabled, ensureSchema, keyOf, record, recordObservation, fresh, streamsFor, MAX_PER_PRODUCT };
