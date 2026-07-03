/**
 * lib/news_feed.js — the FORECASTING ⇄ news-lane CONTRACT (the one managed surface, like api_stream).
 *
 * The forecasting machine NEVER reaches past this into news_bucket.db, news_store, or news_lane directly.
 * It exposes the two news tiers as forecasting-shaped hooks (decided w/ Lucas 2026-07-03, hybrid):
 *
 *   • events({startMs, entities, minCorroboration})  → the COMPRESSED tier: corroborated, entity-linked
 *     rolling stories (news_lane.storiesActiveInWindow). A confirmed story = a discrete EVENT-SHOCK the
 *     model can react to + the "why" annotation. Significance-gated by min(outlets, reports) so a forecast
 *     moves on CORROBORATED news, never a lone raw caption.
 *
 *   • momentum({sinceMs, entities})  → the RAW tier: every item incl. broadcast video CCs
 *     (news_store.recentItems, source_kind='video'). Per-entity mention VOLUME split by source_kind — a
 *     continuous covariate where noise averages out (NOT a trigger). This is the real-time / CC-inclusive
 *     path; a tighter window + more frequent calls = the opt-in "live mode" (debate / election night).
 *
 * Sentiment is a PLACEHOLDER (null) until the per-entity sentiment pass (sentiment.ai / gpt-oss) is built —
 * momentum returns volume now, tone later, same shape. PURE cores (eventsFrom / momentumFrom) take arrays →
 * offline-testable; the live wrappers inject the news readers (default to the real libs). Fail-soft.
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
const asArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v ? (() => { try { const j = JSON.parse(v); return Array.isArray(j) ? j : [v]; } catch { return [v]; } })() : []));

// does `haystackText` mention `entity` (normalized substring — "Vance", "Ohio Senate", "Donald Trump")?
function mentions(haystackText, entity) {
  const e = norm(entity); if (!e) return false;
  return norm(haystackText).includes(e);
}

// independent corroboration of a story = min(distinct outlets, distinct reports); robust to older rows.
function storyCorroboration(s) {
  const oc = Number(s && s.outlet_count) || 0, rc = Number(s && s.report_count) || 0;
  const m = (oc && rc) ? Math.min(oc, rc) : (oc || rc);
  return m || Number(s && s.source_count) || 1;
}
function tierOf(n) { return n >= 5 ? 'widely reported' : (n >= 2 ? 'corroborated' : 'single-source'); }

// story searchable text = title + entity_set + summary
function storyText(s) { return [s && s.title, asArr(s && s.entity_set).join(' '), s && s.summary].filter(Boolean).join(' '); }
function itemText(it) { return [it && it.title, it && it.summary, asArr(it && it.entities).join(' ')].filter(Boolean).join(' '); }

/**
 * PURE — corroborated event-shocks from a set of rolling stories.
 * opts: { entities?, minCorroboration=2 }  → returns normalized events (most-corroborated first).
 * Each event: { id, title, summary, entities, matched, corroboration, tier, outlet_count, report_count,
 *               category, last_ts, event_ref }
 */
function eventsFrom(stories, opts = {}) {
  const { entities = null, minCorroboration = 2 } = opts;
  const out = [];
  for (const s of (Array.isArray(stories) ? stories : [])) {
    if (!s) continue;
    const corr = storyCorroboration(s);
    if (corr < minCorroboration) continue;
    let matched = null;
    if (entities && entities.length) {
      const txt = storyText(s);
      matched = entities.filter((e) => mentions(txt, e));
      if (!matched.length) continue;
    }
    out.push({
      id: s.id, title: s.title || '', summary: s.summary || '',
      entities: asArr(s.entity_set), matched,
      corroboration: corr, tier: tierOf(corr),
      outlet_count: Number(s.outlet_count) || 0, report_count: Number(s.report_count) || 0,
      category: s.category || null, last_ts: Number(s.last_ts) || 0, event_ref: s.event_ref || null,
    });
  }
  return out.sort((a, b) => b.corroboration - a.corroboration || b.last_ts - a.last_ts);
}

/**
 * PURE — per-entity mention momentum from raw items (incl. video CCs).
 * opts: { entities (required — the candidates/issues to track) }.
 * Each result: { entity, mentions, by_source_kind:{rss,video,...}, video_mentions, first_ts, last_ts,
 *                sentiment:null }  // sentiment filled by a later pass; volume is the signal now.
 */
function momentumFrom(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const entities = (opts.entities || []);
  return entities.map((entity) => {
    const acc = { entity, mentions: 0, by_source_kind: {}, video_mentions: 0, first_ts: null, last_ts: null, sentiment: null };
    for (const it of list) {
      if (!it || !mentions(itemText(it), entity)) continue;
      acc.mentions++;
      const k = it.source_kind || 'rss';
      acc.by_source_kind[k] = (acc.by_source_kind[k] || 0) + 1;
      if (k === 'video') acc.video_mentions++;
      const ts = Number(it.ts) || 0;
      if (ts) { acc.first_ts = acc.first_ts == null ? ts : Math.min(acc.first_ts, ts); acc.last_ts = acc.last_ts == null ? ts : Math.max(acc.last_ts, ts); }
    }
    return acc;
  });
}

// ---- LIVE wrappers (inject the news readers; default to the real libs). Fail-soft → []. ----
function events({ startMs = 0, entities = null, minCorroboration = 2, limit = 200, lane = null } = {}) {
  try {
    const L = lane || require('./news_lane');
    return eventsFrom(L.storiesActiveInWindow(startMs, { limit }), { entities, minCorroboration });
  } catch { return []; }
}
function momentum({ sinceMs = 0, entities = [], limit = 500, store = null } = {}) {
  try {
    const S = store || require('./news_store');
    return momentumFrom(S.recentItems({ sinceMs, limit }), { entities });
  } catch { return (entities || []).map((entity) => ({ entity, mentions: 0, by_source_kind: {}, video_mentions: 0, first_ts: null, last_ts: null, sentiment: null })); }
}

// ---- RAW tier: the firehose passthrough — every collected item incl. broadcast video CCs. For a consumer
// that wants the un-aggregated stream (momentum() is the per-entity VOLUME view over the same items).
// sourceKind filters to one kind ('rss' | 'aggregator' | 'video' | 'newsletter'). Fail-soft → []. ----
function raw({ sinceMs = 0, limit = 500, sourceKind = null, store = null } = {}) {
  try {
    const S = store || require('./news_store');
    const items = S.recentItems({ sinceMs, limit }) || [];
    return sourceKind ? items.filter((i) => (i && (i.source_kind || 'rss')) === sourceKind) : items;
  } catch { return []; }
}

// ---- HOURLY MARKERS: the persisted per-hour compression checkpoints (news_layers). Each:
// { hour_start, hour_end, briefing, item_count, story_count }. Newest-first, since sinceMs. The
// "what changed this hour" view. Fail-soft → []. ----
function layers({ sinceMs = 0, limit = 48, lane = null } = {}) {
  try {
    const L = lane || require('./news_lane');
    return (L.recentLayers(limit) || []).filter((r) => Number(r && r.hour_start) >= sinceMs);
  } catch { return []; }
}

// ---- 24h MARKERS (durable): the persisted daily digest rows (news_days), written by the nightly daily
// pass. Each: { day_start, day_end, briefing, story_count, promoted, event_refs[] }. The stable "what
// happened on day X" pointer — event_refs are the promoted Echo entity ids (long-term traversal links).
// Fail-soft → []. ----
function digest({ sinceMs = 0, limit = 30, lane = null } = {}) {
  try {
    const L = lane || require('./news_lane');
    return (L.recentDays(limit) || []).filter((r) => Number(r && r.day_start) >= sinceMs);
  } catch { return []; }
}

// ---- 24h view (LIVE): assemble the CURRENT day's corroborated event OBJECTS on demand — independent of
// whether the nightly pass has written its marker yet ("today so far"). Corroboration-gated; optional
// entity filter. Each object carries event_ref (null = short-term only, id = promoted to Echo). Fail-soft → []. ----
function today({ sinceMs = null, entities = null, minCorroboration = 2, limit = 30, lane = null, objects = null } = {}) {
  try {
    const O = objects || require('./news_objects');
    const L = lane || require('./news_lane');
    const start = sinceMs != null ? sinceMs : L.startOfDayMs();
    let objs = O.recentNewsObjects({ sinceMs: start, minCorroboration, limit }) || [];
    if (entities && entities.length) {
      const want = entities.map((e) => norm(e)).filter(Boolean);
      objs = objs.filter((o) => { const hay = norm([o.name, (o.principals || []).join(' '), o.summary].filter(Boolean).join(' ')); return want.some((w) => hay.includes(w)); });
    }
    return objs;
  } catch { return []; }
}

module.exports = { events, momentum, raw, layers, digest, today, eventsFrom, momentumFrom, storyCorroboration, tierOf, mentions };
