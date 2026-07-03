# News Feed — Tie-In Handoff

**For:** any section consuming the news lane (primary consumer = the **forecasting suite**).
**Status:** built + committed, gate-green. Reboot-gated (the daily marker is written by the nightly pass in `main.js`).
**You do NOT need to touch:** `news_bucket.db`, `news_store`, `news_lane`, or `news_objects`. One managed surface owns all of that. You import `lib/news_feed`.

---

## 1. The one rule

**Never reach past `lib/news_feed.js` into the news bucket, `news_store`, or `news_lane` directly.** `news_feed` is the single managed contract (same pattern as `api_stream`). Going direct to the DB bypasses the corroboration gating, the source-kind split, and the DB isolation that keep a forecast from moving on a lone raw caption.

```js
const news = require('./lib/news_feed');
```

Every function is **fail-soft** — a reader error returns `[]` (or zeroed entities for `momentum`), never throws. Every function accepts injected readers (`store` / `lane` / `objects`) so you can unit-test offline.

---

## 2. The tiers — pick by what you're modeling

The news lane compresses in time. A consumer taps whichever granularity fits the signal:

| Hook | Tier | Returns | Use it for |
|---|---|---|---|
| `raw()` | **raw firehose** | every collected item incl. video CCs | the un-aggregated stream |
| `momentum()` | **raw, per-entity** | mention VOLUME per entity, split by source_kind | a continuous covariate (noise averages out) |
| `events()` | **compressed** | corroborated, entity-linked rolling stories in a window | a discrete event-**shock** the model reacts to |
| `layers()` | **hourly marker** | persisted per-hour compression checkpoints | "what changed this hour" |
| `digest()` | **24h marker (durable)** | persisted daily digest rows | the stable "what happened on day X" pointer |
| `today()` | **24h view (live)** | the current day's corroborated event objects, on demand | "today so far", before the nightly pass runs |

**Rule of thumb:** raw/`momentum` for real-time noisy covariates → `events` for corroborated triggers → `layers` for hourly deltas → `digest`/`today` for the daily view.

---

## 3. Signatures

```js
// RAW — the firehose. sourceKind ∈ 'rss'|'aggregator'|'video'|'newsletter' (omit = all).
news.raw({ sinceMs, limit = 500, sourceKind })
//   → [ { id, source, source_kind, title, summary, url_or_guid, ts, entities, ... } ]

// RAW, per-entity VOLUME (sentiment is a null placeholder until the tone pass lands).
news.momentum({ sinceMs, entities: ['JD Vance', 'Ohio Senate'] })
//   → [ { entity, mentions, by_source_kind:{rss,video,...}, video_mentions, first_ts, last_ts, sentiment:null } ]

// COMPRESSED event-shocks — corroboration-gated (min(outlets,reports) ≥ minCorroboration), most-corroborated first.
news.events({ startMs, entities, minCorroboration = 2, limit = 200 })
//   → [ { id, title, summary, entities, matched, corroboration, tier, outlet_count, report_count, category, last_ts, event_ref } ]

// HOURLY MARKERS — persisted per-hour checkpoints, newest-first, since sinceMs.
news.layers({ sinceMs, limit = 48 })
//   → [ { hour_start, hour_end, briefing, item_count, story_count } ]

// 24h MARKERS (durable) — persisted daily digest rows, newest-first, since sinceMs.
news.digest({ sinceMs, limit = 30 })
//   → [ { day_start, day_end, briefing, story_count, promoted, event_refs:[<echo id>...] } ]

// 24h VIEW (live) — assemble the current day's corroborated event OBJECTS on demand.
news.today({ sinceMs = <start of day>, entities, minCorroboration = 2, limit = 30 })
//   → [ { id, type:'event', name, category, summary, corroboration:{outlets,reports,independent,tier},
//         principals:[...], outlets:[...], developing, redaction, event_ref, first_ts, last_ts, status } ]
```

---

## 4. `digest()` vs `today()` — durable marker vs live view

Both answer "what happened today," at different points in the lifecycle:

- **`digest()`** reads the **persisted `news_days` markers** written by the nightly daily pass (`news_lane.runDailyPass`). One row per calendar day, keyed by start-of-day, **idempotent** (a re-run that day updates the same row). This is the stable pointer — *"the July 3 marker"* is a real row you can reference forever, with `event_refs` linking to the promoted Echo `event` objects. Use this for durable, reproducible day-level features.
- **`today()`** assembles the **current day's** corroborated event objects **live** from `news_stories`, independent of whether the nightly pass has run yet. Use this for "today so far" during the day.

So: **past days → `digest()`; the day in progress → `today()`.**

`event_ref` on both is the bridge to long-term memory: `null` = short-term only (in the news bucket), an id = promoted into the public Echo civic graph (traversable, cited). See [reconciliation-core] / the news→Echo daily pass.

---

## 5. The `news_days` marker (what the daily pass writes)

`news_lane.runDailyPass` now writes one durable digest row per day and returns its key:

```js
const r = await news_lane.runDailyPass({ dispatch, landDoc, now });
// r = { promoted, updated, docs, edges, rejected, stories, dayMarker /* = start-of-day ms */ }
```

Row shape (`news_days`, keyed by `day_start`, idempotent upsert):
`{ day_start, day_end, briefing, story_count, promoted, event_refs[], created_at, updated_at }`.

Direct accessors (if you're in-process and not going through `news_feed.digest`): `news_lane.recentDays(limit)`, `news_lane.dayMarker(dayStartMs)`.

---

## 6. TL;DR for the forecasting tie-in

```js
const news = require('./lib/news_feed');

// continuous covariate — real-time entity attention (incl. broadcast CCs):
const attention = news.momentum({ sinceMs: hourAgo, entities: CANDIDATES });

// discrete shocks — only corroborated stories move the forecast:
const shocks = news.events({ startMs: dayStart, entities: CANDIDATES, minCorroboration: 2 });

// hourly delta feature:
const hourly = news.layers({ sinceMs: dayStart });

// durable day-level feature (reproducible), + the day in progress:
const pastDays = news.digest({ sinceMs: weekAgo });
const todaySoFar = news.today({ entities: CANDIDATES });
```

That's the whole contract. Don't reach past `news_feed`.
