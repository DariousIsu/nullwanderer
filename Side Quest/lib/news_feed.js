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
 * Sentiment: momentum now carries a DETERMINISTIC per-entity tone (toneOf, a compact news polarity lexicon)
 * aggregated over the mentioning items — `sentiment` ∈ [-1,1] (null when no polar tokens) + `sentiment_n` =
 * the polar-token sample size (confidence). It stays lexicon-based ON PURPOSE: momentum() is the hot,
 * frequently-polled real-time path, so tone must be free + network-free; over many mentions the noise
 * averages out (same "continuous covariate" logic as volume). A model-grade tone pass, if ever wanted,
 * belongs at the BATCHED compression tier (annotating stories), not per momentum() call. PURE cores
 * (eventsFrom / momentumFrom / toneOf) take arrays → offline-testable; live wrappers inject the readers. Fail-soft.
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

// A compact NEWS polarity lexicon. Not exhaustive — a DIRECTIONAL covariate, so recall over precision;
// aggregated over many mentions it's stable. Deliberately deterministic + free (see header). Word-stem-ish.
const POS_WORDS = new Set(('win wins won victory victories triumph gain gains gained surge surges surged rally rallies rallied ' +
  'rise rises rose soar soars soared jump jumps climbs climbed advance advances approve approved approval support supports supported ' +
  'backs backed lead leads leading ahead boost boosts boosted growth grow grew record breakthrough deal deals agreement agree agrees ' +
  'praise praised optimistic strong strengthen strengthens recovery recover relief secures secured wins peace progress upgrade upgraded ' +
  'landmark historic hopeful hope momentum resilient thrive thriving').split(' '));
const NEG_WORDS = new Set(('loss losses lost defeat defeats defeated fall falls fell drop drops dropped plunge plunges plunged crash ' +
  'crashes crashed slump slumps decline declines declined slid tumble tumbles collapse collapses crisis scandal scandals fraud corruption ' +
  'attack attacks attacked killed kill dead death deaths war conflict violence violent protest protests fear fears warn warns warned ' +
  'threat threats threaten threatens sanction sanctions ban bans banned deny denies denied reject rejects rejected criticism criticize ' +
  'criticized probe investigation lawsuit lawsuits recession layoffs cuts shortage shortages outbreak disaster weak weakens worsen worse ' +
  'crackdown blast strike strikes turmoil unrest slowdown default').split(' '));
const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nothing', 'none']);

// PURE — signed tone of a text via the polarity lexicon. Returns { pos, neg } counts (a negator within the
// preceding 3 tokens FLIPS a polar word: "no growth" → negative). Aggregate then normalize for a [-1,1] score.
function toneOf(text) {
  const toks = norm(text).split(' ').filter(Boolean);
  let pos = 0, neg = 0;
  for (let i = 0; i < toks.length; i++) {
    let polarity = POS_WORDS.has(toks[i]) ? 1 : (NEG_WORDS.has(toks[i]) ? -1 : 0);
    if (!polarity) continue;
    for (let j = Math.max(0, i - 3); j < i; j++) { if (NEGATORS.has(toks[j])) { polarity = -polarity; break; } }
    if (polarity > 0) pos++; else neg++;
  }
  return { pos, neg };
}

/**
 * PURE — per-entity mention momentum from raw items (incl. video CCs).
 * opts: { entities (required — the candidates/issues to track) }.
 * Each result: { entity, mentions, by_source_kind:{rss,video,...}, video_mentions, first_ts, last_ts,
 *                sentiment:[-1,1]|null, sentiment_n }  // sentiment = aggregate lexicon tone over the
 *                mentioning items; null when no polar tokens; sentiment_n = polar-token sample size (confidence).
 */
function momentumFrom(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const entities = (opts.entities || []);
  return entities.map((entity) => {
    const acc = { entity, mentions: 0, by_source_kind: {}, video_mentions: 0, first_ts: null, last_ts: null, sentiment: null, sentiment_n: 0 };
    let pos = 0, neg = 0;
    for (const it of list) {
      if (!it || !mentions(itemText(it), entity)) continue;
      acc.mentions++;
      const k = it.source_kind || 'rss';
      acc.by_source_kind[k] = (acc.by_source_kind[k] || 0) + 1;
      if (k === 'video') acc.video_mentions++;
      const ts = Number(it.ts) || 0;
      if (ts) { acc.first_ts = acc.first_ts == null ? ts : Math.min(acc.first_ts, ts); acc.last_ts = acc.last_ts == null ? ts : Math.max(acc.last_ts, ts); }
      const t = toneOf(itemText(it)); pos += t.pos; neg += t.neg;
    }
    const denom = pos + neg;
    acc.sentiment_n = denom;
    acc.sentiment = denom ? Math.round(((pos - neg) / denom) * 10000) / 10000 : null;
    return acc;
  });
}

// ---- LIVE wrappers (inject the news readers; default to the real libs). Fail-soft → []. ----
function events({ startMs = 0, entities = null, minCorroboration = 2, limit = 200, lane = null } = {}) {
  try {
    const L = lane || require('./news_lane');
    // A floor at or above the lane's worthy floor is exact to push into the read (eventsFrom drops the
    // rest anyway) — and it is what lets the forecast's whole-table read (startMs 0) use the worthy index.
    const worthyOnly = Number(minCorroboration) >= (Number(L.WORTHY_FLOOR) || 2);
    return eventsFrom(L.storiesActiveInWindow(startMs, { limit, worthyOnly }), { entities, minCorroboration });
  } catch { return []; }
}
function momentum({ sinceMs = 0, entities = [], limit = 500, store = null } = {}) {
  try {
    const S = store || require('./news_store');
    return momentumFrom(S.recentItems({ sinceMs, limit }), { entities });
  } catch { return (entities || []).map((entity) => ({ entity, mentions: 0, by_source_kind: {}, video_mentions: 0, first_ts: null, last_ts: null, sentiment: null, sentiment_n: 0 })); }
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

module.exports = { events, momentum, raw, layers, digest, today, eventsFrom, momentumFrom, toneOf, storyCorroboration, tierOf, mentions };
