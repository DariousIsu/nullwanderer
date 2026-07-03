/*
 * lib/news_objects.js — the OBJECT VIEW over the news short-term store (the "accessible as objects" half).
 *
 * The hourly compression already writes clean, clustered STORIES into the isolated news_bucket.db — that IS
 * the news short-term memory. But a story was a ROW, walled off from the object interface everything else is
 * reached through. This adapter presents those rows AS first-class `event` OBJECTS (name + connections +
 * corroboration metadata), read live from the bucket, so a story is queryable/traversable the moment it forms
 * — WITHOUT copying the firehose into the grounded personal-facts graph (lib/graph_memory) and flooding her
 * idle-loop prompt. Read-only; no writes, no cross-DB contention.
 *
 * The complementary long-term path is the overnight promotion (news_lane.runDailyPass → public Echo `event`
 * objects, gated on corroboration); this is its short-term twin. Canonical entity RESOLUTION of the principals
 * (the right Echo person/place, not a bare name) is the other context's R1 — consumed later; here principals
 * are the story's own entity tokens, name-matched, which is enough for "news about X" over the working set.
 */
'use strict';
const newsdb = require('./news_db');
const lane = require('./news_lane');

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const jparse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const toArr = (v) => (v instanceof Set ? [...v] : jparse(v, []));

// A news_stories row → its OBJECT form: type='event', name, connections (principals + outlets), corroboration
// metadata, and event_ref (the public Echo id, set once the overnight pass promotes it — the bridge to long-term).
function toObject(s) {
  if (!s) return null;
  const oc = Number(s.outlet_count) || 0;
  const rc = Number(s.report_count) || (s.report_set instanceof Set ? s.report_set.size : jparse(s.report_set, []).length);
  return {
    id: s.id,
    type: 'event',
    name: s.title || '(untitled)',
    category: s.category || null,
    summary: s.summary || null,
    corroboration: { outlets: oc, reports: rc, independent: Math.min(oc, rc), tier: lane.corroborationTier(oc) },
    principals: toArr(s.entity_set),          // the entity tokens this event involves (→ "news about X")
    outlets: toArr(s.outlet_set),
    developing: (Number(s.update_count) || 1) > 1,
    redaction: !!s.redaction,
    event_ref: s.event_ref || null,           // public Echo entity id once promoted (long-term link); null = short-term only
    first_ts: s.first_ts,
    last_ts: s.last_ts,
    status: s.status,
  };
}

// Resolve a story to its object — by numeric id, or by title (all query tokens present; most-recent wins). null if none.
function resolveNewsObject(idOrName) {
  lane.ensureSchema();
  if (idOrName == null) return null;
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    return toObject(newsdb.get().prepare('SELECT * FROM news_stories WHERE id = ?').get(Number(idOrName)));
  }
  const toks = norm(idOrName).split(' ').filter(Boolean);
  if (!toks.length) return null;
  const rows = newsdb.get().prepare('SELECT * FROM news_stories ORDER BY last_ts DESC LIMIT 500').all();
  const hit = rows.find((r) => { const t = norm(r.title); return toks.every((k) => t.includes(k)); });
  return toObject(hit || null);
}

// "News about X" — the connected event objects whose principals include the entity (the both-ways graph query
// the object interface is for). Gated by corroboration so single-source noise doesn't surface.
function newsAbout(entityName, { sinceMs = 0, limit = 20, minCorroboration = 1 } = {}) {
  lane.ensureSchema();
  const toks = norm(entityName).split(' ').filter(Boolean);
  if (!toks.length) return [];
  const rows = newsdb.get().prepare('SELECT * FROM news_stories WHERE last_ts >= ? ORDER BY last_ts DESC LIMIT 1000').all(sinceMs);
  const out = [];
  for (const r of rows) {
    const ents = new Set(toArr(r.entity_set).map((x) => String(x).toLowerCase()));
    if (!toks.every((k) => ents.has(k))) continue;                      // the event involves the entity
    if (Math.min(Number(r.outlet_count) || 0, Number(r.report_count) || 0) < minCorroboration) continue;
    out.push(toObject(r));
  }
  out.sort((a, b) => (b.corroboration.independent - a.corroboration.independent) || (b.last_ts - a.last_ts));
  return out.slice(0, limit);
}

// The recent worthy news as objects — the object view of the hourly-compressed short-term store (anti-glob gated).
function recentNewsObjects({ sinceMs = 0, limit = 30, minCorroboration = 2 } = {}) {
  lane.ensureSchema();
  const rows = newsdb.get().prepare(
    'SELECT * FROM news_stories WHERE last_ts >= ? AND MIN(outlet_count, report_count) >= ? ORDER BY MIN(outlet_count, report_count) DESC, last_ts DESC LIMIT ?'
  ).all(sinceMs, minCorroboration, limit);
  return rows.map(toObject);
}

module.exports = { toObject, resolveNewsObject, newsAbout, recentNewsObjects };
