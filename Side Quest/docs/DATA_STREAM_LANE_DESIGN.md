# Data-Stream Lane — Design & Mapping (AS-BUILT)

> Status: **BUILT + LIVE** (2026-07-02). Commits `fc78074` (lane) + `51a731a` (screen-read model).
> The design/mapping below is the original spec, kept as reference; the summary here is what shipped.
>
> **AS-BUILT summary:**
> - **Collection** — isolated bucket (`lib/news_db`) fed from **244 feeds** (national wire + local/civic +
>   county/city gov Granicus/CivicPlus + federal agency + state legislature + 33 Substacks + 22 independent
>   creators). `lib/news_store` / `news_poll` / `news_watch`. `data/feeds.json` is runtime (gitignored).
> - **Compression (hourly)** — `lib/news_lane`: rolling-story clustering + cloud adjudicator for the
>   ambiguous band; **corroboration = min(distinct outlets, distinct reports)** (defeats cross-outlet
>   syndication AND single-outlet multi-article inflation). Daily pass promotes worthy stories → Echo events.
> - **Brief** — `lib/news_brief`: schema-locked, cloud-written (pinned **mistral-large-3:675b**) with a
>   deterministic fallback; Monitors **Briefing drawer** (`renderer/canvas`).
> - **Video lane** — `lib/video_capture`: hidden webContents read the 4 live streams' CC into the bucket
>   (`source_kind=video`); a music/visual stretch **periodically screenshots (~30s) + vision-reads on-screen
>   data** (charts/tickers) via mistral-large-3:675b, closing on the next spoken word.
> - **Ad-filter** — `lib/news_ads`: heuristic hard-ad drop at capture + batched gemma classify at
>   compression (fail-safe to news); `markDropped` sentinel.
> - **Gate**: 88 offline-deterministic smokes green. **Pending next**: email reader (newsletters + Gemini
>   meeting notes, read-only IMAP on `lib/inbox`). Social media **shelved** by decision.
>
> Companion `docs/DATA_STREAM_LANE_BRIEF.md` is superseded by this doc.

---

## 1. Vision in one paragraph

Turn the **Monitors** surface (live RSS wall + video feeds) from a display-only widget into a real
**news cognition lane**: a backend collector fills a **reservoir** continuously; an **hourly pass**
compacts each hour into a clean layer (+ a briefing + a semantic catch-net); a **daily pass** turns
24 clean layers into **news objects + edges** in Echo's knowledge graph; and an on-demand **snapshot**
answers "what's going on right now." Per-item cognition is deliberately avoided — the only live touch
is a deterministic keyword/phrase/concept matcher; everything smarter is **batched and budget-bounded**,
which is how we don't repeat the personality-drift colonization (`[[personality-drift-diagnosis]]`).

---

## 2. The pipeline (tiered compaction)

```
COLLECT (continuous, deterministic, model-free)     per-source lanes → reservoir
   │   every few min · N RSS lanes (items) + 4 video threads (caption rivers), ALL ISOLATED
   ▼  every hour
HOURLY PASS
   Stage 1  PER-SOURCE NORMALIZE   video: segment + ad-strip + repeat-collapse; rss: same-source dedup
   Stage 2  CROSS-SOURCE CLUSTER   attach items → rolling news_stories (open→continuation / new)
   • standardized briefing block → Monitors widget (presence.notify INTERRUPT on a trigger)
   • THINKING PASS: 1 budgeted model call for missed relevance → pointer(s) + FEEDS the watchlist
   ▼  every 24h  (rides the existing nightly curation cadence)
DAILY PASS                                           worthy rolling stories → news OBJECTS + edges
   • story → doc_store doc (source:'news')     ── rides promoteDocumentsPass (auto entity extract)
   • story → propose_entity{event} + edges, idempotent on story.event_ref  (ONE object per story)
   ▼  on demand
SNAPSHOT / "dam"                                     open stories + recent layers → one summary
   • default today→now; also "update since <explicit time>"
```

Each tier sheds volume while adding structure: **raw items → hourly layers → daily objects.**

---

## 3. The four access modes

### Source integration — per-source isolation (raw stays separate until the hourly pass)

Raw sources are **kept in separate per-source lanes** in the reservoir; nothing merges or cross-dedups
before the hourly pass. Two shapes, because a broadcast caption river is nothing like an RSS feed:

- **RSS feeds** → discrete, already-clean items. Each carries its `source`; dedup is **same-source
  guid/url only**, never cross-feed (two outlets running the same wire story stay two items until
  clustering). N feeds = N lanes.
- **Video feeds** → a continuous **caption transcript per feed thread** — *not* item-shaped, *not*
  deduped at collection. It's an ordered, timestamped stream mixing stories + ADS + top-of-hour
  repeats. Segmentation/cleanup is a per-source job done in the hourly pass, not at collection.

So collection holds **4 video caption threads + N RSS lanes, all isolated**. The messy normalization
(ad-strip, repeat-collapse, story segmentation) happens **per source inside the hourly pass** (§Mode 2
Stage 1), then cross-source clustering merges them (Stage 2). Provenance rides through every stage — a
clustered story knows exactly which source threads fed it.

#### Story identity & the running-story model (the continuation-vs-new boundary)

A story is **not hour-bounded** — a developing story at 3pm is the *same* thing as at 2pm. So clusters
**persist across hourly layers** in an `news_stories` registry rather than being re-clustered from
scratch each hour. This one construct makes continuation, cross-source corroboration, and
one-event-object-per-story all fall out of the same place.

- **Cluster key = principal entities + normalized headline signature.** Reuse the existing lineage —
  `graph_walk.visitKey` / `echo_suit._coreNameKey` (entity-name normalization) — for the entity set,
  plus a token signature of the headline. Deterministic-first.
- **Continuation gate (deterministic → model fallback):** a new item attaches to an **open** story when
  its entity set + title tokens overlap an open story's above a threshold, within the open window.
  Above the high band → continuation (attach, bump `last_ts`, refresh summary). Below the low band →
  new story. **Only the middle band** costs one model adjudication (mirrors the tiered-relevance
  discipline — deterministic does the bulk, model only for the ambiguous edge).
- **Open vs closed.** A story stays `open` while it keeps drawing fresh material; it **closes after N
  cold hours** (no new item). Continuation only attaches to open stories, so a topic that resurfaces a
  week later is correctly a *new related* story, not a resurrection.
- **This is what collapses the repeats.** Broadcast top-of-hour loops and re-published wire updates both
  land as continuations of the open story — so the daily pass proposes/updates **ONE** `event` object
  (idempotent on `story.event_ref`), with related-to edges to prior stories, never 12 duplicates.
- **Source-count is a signal.** A story corroborated by several sources carries higher worthiness +
  proposal confidence than a single-source video mention — feeds the daily worthiness gate.

#### Real feed shapes (sampled live via `fetch_feeds_batch`, 2026-07-02)

- **`guid` is present + stable** on every feed sampled (TechCrunch `?p=3138430`, BBC `…articles/…#0`,
  Google opaque `CBMi…`) → `guid` is the primary dedup key; `url` is a rare fallback.
- **`published_iso` is precise ISO-8601** everywhere → clean reservoir `ts`.
- **`tags`** present on some feeds (TechCrunch `["AI","Enterprise",…]`), empty on others → an
  *opportunistic* topical signal for the watchlist/cluster where present, never relied upon.
- **⚠️ Aggregators are PRE-CLUSTERED.** A **Google News** item is not an article — it's an `<ol>` of
  ~5 sub-articles from *different outlets* (WaPo/CNN/Fortune/NBC/The Hill) on the **same** story, outlet
  names embedded (`<font color="#6f6f6f">Outlet</font>`). So an aggregator is a **special source-kind**:
  its `summary` must be **parsed into member {outlet, headline}** (not `stripHtml`'d to text), and each
  item is a **pre-built cluster + corroboration list** that *seeds* Stage-2 — then gets reconciled
  against the standalone outlet feeds via the signature gate.
- **Live proof of the merge gate:** in the sample the Kyiv attack appeared as *both* a Google cluster
  ("kills at least 17") *and* a standalone BBC item ("At least 18 killed") — same event, different
  counts/headlines. Our entity+headline signature must bind them into ONE rolling story (the event
  object then carries the best-corroborated summary). → this exact pair becomes a `smoke_news_lane` fixture.

#### RSS repetition patterns (the RSS analogue of top-of-hour repeats)

- **Stable re-surfacing** (aggregators like Google News repeat the same headline every poll): stable
  `url/guid` → same-source dedup catches it; keep **first-seen ts**, ignore re-surfaces.
- **Same-outlet updates** (a story re-published with a *new* guid): guid dedup misses it, so add a
  **same-source near-title** collapse → treat as a continuation/update, not a new item.
- **Wire stories** (AP/Reuters picked up by many outlets, different guids): **NOT** a collection-time
  dedup — they stay separate per-source items and merge at **Stage-2 cross-source clustering**, where
  the multi-source corroboration is the *value*, not noise to squash.

### Mode 0 — COLLECT (passive reservoir)
- A **backend poller in `main.js`** (modeled on the inbox poller `main.js:712`/`836` and the
  canvas-ingest poller `main.js:760`/`838`): initial-sweep `setTimeout` + `setInterval` + shutdown
  `clearInterval`, interval from `FEED_POLL_MS` (default ~2–5 min).
- RSS via the **existing** `feeds:fetch` path (`main.js:925` → engine `fetch_feeds_batch` →
  `studio/feeds_view.js` `mergeReports`), which already returns the normalized item shape we persist.
- **Lifecycle (decoupled from the widget):** collection is **ON at launch**, independent of whether
  the Monitors pane is open. The pane is a *view* onto the reservoir, not the collector. A persisted
  meta flag (`news.collect` = on/off) is the kill-switch; closing the widget offers "keep collecting
  in background?" (default yes). This fixes the current UI-gated/ephemeral behavior
  (`renderer/canvas.js:481–487` — polling today only runs while the pane is open).

### Mode 1 — WATCH (active, deterministic relevance)
- A **keyword / phrase / concept watchlist**. As items land, exact-ish deterministic matching against
  it — **no embeddings, no per-item model call**. A hit is surfaced as one **source-grounded pointer**
  ("I saw on Reuters…"), carrying attribution end-to-end.
- Watchlist seeds from **live-conversation concepts** (+ standing terms). The hourly thinking pass
  **feeds the watchlist** with concepts it catches, so the deterministic tier learns over time.

### Mode 2 — ORGANIZE (hourly + daily passes)
- **Hourly pass** (`news_layer`) runs in two stages so per-source mess never leaks across sources:
  - **Stage 1 — per-source normalize** (each lane on its own terms, no cross-mixing):
    - *video lane (×4):* segment the hour's caption river into candidate stories; **strip ads**;
      **collapse top-of-hour repeats** (looped headline block); across hours, treat "still the top
      story" as a **continuation/update of the same event**, not a new one (keeps the daily pass from
      proposing the same event 12×). → clean per-source story items.
    - *rss lane (×N):* same-source dedup; carry discrete items forward.
  - **Stage 1b — aggregator parse:** an aggregator item (Google News) is exploded into its member
    {outlet, headline} list → a pre-built cluster that **seeds** Stage-2 with instant corroboration.
  - **Stage 2 — cross-source cluster into the rolling registry:** attach the clean per-source items
    (and aggregator pre-clusters) to **open `news_stories`** (continuation) or open new ones (CNN-video +
    Reuters-RSS + BBC = one story), bumping `last_ts`/`source_count`, preserving which sources fed each
    story. Aggregator pre-clusters are reconciled against standalone outlet items via the signature gate.
    Clusters persist across hours; they are not re-derived each pass.
  - Then: write the standardized briefing, run ONE budgeted model pass for missed triggers (feeds the
    watchlist), render the briefing in the Monitors widget (`presence.notify` interrupt on a trigger).
- **Daily pass** (news objects + edges): promotes worthy **rolling stories** (open + recently-closed)
  to `event` objects, idempotent on `story.event_ref` (§4). Rides the existing nightly cadence
  (`maybeRunCuration` → `promoteDocumentsPass`, `main.js:397`/`412`).

**Confirmation — corroboration + integrity (Lucas, 2026-07-02; BUILT `news_lane`, `smoke_news_lane` 45/45):**
- **Outlet corroboration** — a story tracks distinct **outlets** (`outlet_set`/`outlet_count`), not just our
  feeds. `outletsOf(item)` pulls **member outlets from aggregators** (one Google News item = ~5 outlets) or
  the source name otherwise → real-world corroboration. `corroborationTier` = single-source / corroborated
  (≥2) / widely reported (≥5). `newOutletsSince(id, ts)` = the "new outlets this hour" momentum signal.
- **Redaction/correction** — `detectRedactionSignal(text)` flags a source issuing a **correction/retraction/
  editor's note** (narrowed to source-INTEGRITY language; NOT subject-level "X denies"/"disputed"). Sets
  `redaction`/`redaction_note` on the story + the update log. Surfaces as ⚠ in the briefing + an
  "Integrity" callout in the brief document.
- **Deferred (needs model/seen-tracking, flagged not faked):** whole redaction (item pulled from a feed —
  RSS roll-off makes "gone" ≠ "retracted") and partial redaction (a fact reversed, e.g. toll 20→17 —
  semantic; pairs with the adjudicator).

**Compression behavior — clarified (Lucas, 2026-07-02):**
- **The news object IS the rolling story — BORN on the hour, MAPPED overnight.** `createStory`/`clusterItems`
  (hourly) births + curates the story locally; the daily/overnight pass does the *intense* Echo KG mapping
  (event entity + edges + `extract_entities`). After each hourly pass, `news_stories` = the program's
  **fully curated awareness of world events**, with **no Echo dependency** — Echo is the overnight projection.
- **Story deltas (developing stories):** every touch is logged to `news_story_updates` (born + each update,
  with the contributing source/headline). `storyDeltas(id)` reads the timeline; `formatDeltas` renders the
  evolution ("how the story developed"); `update_count > 1` ⇒ `(developing)` badge in the briefing. BUILT +
  proven (`smoke_news_lane` 35/35).
- **Hourly brief → surface:** the hourly pass *produces* the brief. Two forms: `buildBriefing` (a plain
  deterministic bullet list, cheap) and **`lib/news_brief.js` — the CONSISTENT brief DOCUMENT** (BUILT,
  `smoke_news_brief` 24/24): the cloud fills a FIXED SCHEMA (`{edition, stories:[{id,summary,developing}]}`)
  and a deterministic renderer applies all formatting + attribution. Reliability by construction — sources
  render from OUR data (never confabulated), invented story ids are dropped, omitted stories fall to "Also
  Tracking", and a cloud-down fallback always renders. **PROVEN on real news** (`news_brief_demo`): a live
  model produced a valid, fully-grounded brief; the template rendered cleanly. Printing it to **Zoe's
  Canvas** is a SURFACING step — `studio/canvas_emit.js` is the other context's file, so the canvas target
  is wired in the **interface phase**; the compression emits the brief via its return value + a main.js
  hook (Monitors widget is our owned fallback surface meanwhile).

### Mode 3 — SNAPSHOT ("dam")
- On demand — "what's going on in the news right now, Zoe" — **triggers the SAME compression path**
  (`news_lane.runCompression`, `writeLayer:false`) on the un-clustered tail so "right now" is fresh,
  then returns the briefing over stories active in the window. **No separate summarizer** — the snapshot
  IS a compression run + its briefing (Lucas's simplification). Idempotent via the `story_id IS NULL`
  guard, so on-demand + hourly runs never double-process. Default window today→now; explicit
  "update since `<time>`" (`sinceMs`) supported. **No** open-ended "since I last asked" state-tracking.
  (BUILT + proven — `smoke_news_snapshot`.)

---

## 4. Object / edge mapping (we build in the existing direction)

Reviewed: `lib/echo_suit.js`, local graph tables `lib/db.js:341–425`, `lib/graph_walk.js`,
`promoteDocumentsPass` `main.js:4965`. The news lane **reuses** the object/edge system — no parallel graph.

- **Objects** are Echo entities typed by the **closed enum** `person | organization | place | work |
  event | concept`. A **news story = `event`**; an **outlet (Reuters) = `organization`**. We file
  within the ontology; we **never** add a "news" type.
- **Edges** are `relation_type` (free-text): `involves`, `about`, `sourced_from`/`reported_by`,
  `related_to` (event→priorEvent).
- **Writes = proposals only.** `graph_walk` and `echo_tier` establish that autonomous writes go through
  `propose_entity` / `propose_relation` (pending, Echo-gated at promotion). The news lane obeys the same.
- **The accretion rail already extracts entities.** `promoteDocumentsPass`: `doc_store` doc →
  `ingest_file` (vault) + **`extract_entities_from_doc`** → Echo pulls people/orgs into the KG for us.

**Daily-pass write plan — operates on `news_stories` (open + recently-closed), NOT raw items.** Because
clustering already happened continuously (Stage 2 into the rolling registry), the daily pass just
promotes each worthy story once:
1. **Evidence** — land the story digest as a `doc_store` document (`source:'news'`) → the existing
   promote rail ingests it to the vault and auto-extracts its entities (spokes).
2. **Hub (idempotent)** — if the story has no `event_ref` yet, `propose_entity {entity_type:'event',
   name, summary}` and record the returned id on `story.event_ref`; if it already has one, this is an
   **update** of the same event (new summary/edges), never a duplicate. Then `propose_relation` edges
   to its principals (`event —involves→ person/org`, `event —sourced_from→ outlet`,
   `event —related_to→ priorEvent`).

Event node = hub; extracted entities = spokes; vault doc = evidence; `event_ref` = the idempotency key
that guarantees one object per story across days. All gated, all fail-safe (Echo down → skip, mirroring
`promoteDocumentsPass`).

**Verified Echo write contract (via `describe_tool`, 2026-07 — not inferred):**
- `propose_entity{name, entity_type, summary?, entity_subtype?, confidence?}` → returns
  `{action:'created'|'already_exists'|'merge_suggested'|'rejected', entity_id, name}`. **It returns
  `entity_id`** — so `story.event_ref` = that id. ⚠️ `graph_walk.proposeEntity` **discards** the id
  (returns only `!!ok`); the news lane needs its **own** propose helper that *captures* `entity_id`.
- Auto-disambiguation is **Levenshtein 0.85** on same-type entities → a near-title story yields
  `merge_suggested` rather than a blind dup. That's Echo's backstop under our own continuation gate.
- `propose_relation{source_name, target_name, relation_type, confidence?}` requires **both endpoints
  to already exist** → strict ordering: propose the event entity + principals **first**, relations
  **last**.
- `extract_entities_from_doc{doc_id, threshold?}` runs GLiNER+regex → feeds candidates through
  `propose_entity`.
- **⚠️ Tier gotcha (verified in `echo_tier.js`):** `ingest_file` classifies as **`write`** and
  `extract_entities_from_doc` matches no rule → safe-default **`write`** — **both are BLOCKED on the
  autonomous loop.** Therefore the **daily pass MUST dispatch NON-autonomous** (omit the `autonomous`
  flag), exactly as `promoteDocumentsPass` does (`main.js:4977/4981`). This is legitimate: scheduled
  maintenance passes run non-autonomous; only the free-roaming idle/research loop is "autonomous."
  By contrast `propose_(entity|relation)` are the **`propose` tier** and *are* allowed autonomously
  (`echo_tier.js:35,70`) — so the event-hub proposals could run from either context, but we keep the
  whole promotion in the one non-autonomous daily pass for simplicity + the promote precedent.
- **Sequencing (daily pass, one story):** land doc → `ingest_file` → `extract_entities_from_doc`
  (creates principals) → `propose_entity{event}` (capture id → `event_ref`) → `propose_relation` edges.
- `fetch_feeds_batch{feed_urls, item_limit}` → `{feeds:[report…], requested, succeeded, skipped}`;
  one bad URL is skipped, not fatal. `feeds_view.mergeReports` already consumes this shape.

---

## 5. Proposed modules & tables (NEW — additive)

**New libs (pure brain in lib, live I/O in main — mirrors `lib/promote.js` + `promoteDocumentsPass`):**
- `lib/news_store.js` — pure store: reservoir + layers CRUD, dedup (RSS by guid/url; caption by hash),
  window queries for snapshot. Offline-testable.
- `lib/news_watch.js` — pure deterministic matcher (item ↔ watchlist), watchlist read/append.
- `lib/news_lane.js` — pure brain of the hourly + daily passes: **Stage-1 per-source normalize**
  (video caption segmentation, ad-strip, top-of-hour repeat-collapse, continuation detection; RSS
  same-source dedup), **Stage-2 cross-source cluster**, briefing format, worthiness gate, per-story
  recipe → the `propose_*` + `doc_store` plan. No I/O; deps injected (mirrors `promote.js`). Video
  caption normalization reuses `media_cc`'s `parseCaptionBlock`/`freshFrom`.
- Live wiring (poller + Echo calls + canvas surface) lives in **`main.js`** confined to the agreed
  regions (§9), plus a small preload/renderer touch for the snapshot command and briefing display.

**New DB tables (additive migration in `lib/db.js`, `CREATE TABLE IF NOT EXISTS` + `MIGRATIONS[]`).**
Per-source isolation is in the schema — everything is tagged by source, and video captions are a raw
stream, not items:
- `news_items` — discrete items (RSS at collection; video story-items after Stage-1 normalize).
  `id, source, source_kind ('rss'|'aggregator'|'video'), source_url, title, url_or_guid, ts, summary,
  members (json — aggregator sub-{outlet,headline}), story_id, layer_id, seen`. **Dedup is same-source
  only** (`UNIQUE(source, url_or_guid)`), never cross-feed. `aggregator` items keep parsed `members`.
- `news_captions` — the raw video caption threads, kept **separate per feed**, ordered/timestamped,
  NOT item-deduped: `id, feed (video id/source), ts, text, normalized_at`. The hourly Stage-1 reads a
  feed's hour of captions → segments/ad-strips/repeat-collapses → emits `news_items(source_kind='video')`.
- `news_stories` — the **persistent rolling-story registry** (clusters that span hourly layers):
  `id, cluster_key, title, entity_set (json), status ('open'|'closed'), source_count, first_ts,
  last_ts, summary, event_ref (Echo entity id once proposed — idempotency key), closed_at`. Stage 2
  attaches items to open stories or opens new ones; the daily pass proposes/updates ONE `event` per
  story keyed on `event_ref`.
- `news_items.story_id` — FK assigned during Stage-2 clustering (which rolling story an item belongs to).
- `news_layers` — `id, hour_start, hour_end, briefing, item_count, organized_at, created_at`.
- Watchlist can live in `meta` (JSON) or a small `news_watch` table — TBD in §8.

**Verified reusable helpers (grounded):**
- **Worthiness gate** → `importance.quickScore` (sync, model-free fast path) — not the async
  `importance.score` — so the gate stays cheap/deterministic.
- **Entity-name normalization** for cluster keys → exported `graph_walk.visitKey` +
  `echo_suit._coreNameKey` (both public). **No shared text-similarity module exists** (jaccard /
  token-overlap live copy-pasted across `monologue.js`, `focus.js`, `rumination.js`, `consolidate.js`,
  `memory.js`) — so `news_lane` carries its **own** small pure token-overlap helper (tiny, testable),
  rather than pretending to reuse one.
- **Notify** → `presence.notify(title, body)` (verified signature) for the trigger interrupt.
- **Caption normalize** → `media_cc.parseCaptionBlock` / `freshFrom` (exported).
- **Doc landing** → `doc_store.land({title, body, source, ref, understanding})` (as used by
  `canvas_ingest` / `media_cc`).

**Config / env:** `FEED_POLL_MS` (like the inbox poll const), reuse the subconscious **token budget**
(`subc.budgetOk` / `subcBudgetTokensPerHour`) for the hourly/daily model passes so news cognition is
budget-capped alongside the rest.

---

## 6. Surfacing contract (respects lane isolation)

**Briefings live on the Monitors surface, not the canvas chat.** We have providence over the Monitors
integration (the feeds infra is unwired — the program has no awareness of it yet), so briefings render
**in the Monitors widget itself** (a new briefing section) and we do **not** reach into the canvas-chat
turn machinery the other context owns. Trigger interrupts use **`presence.notify`** — the same light
notification path the media/gmeet lanes already use — rather than injecting into the chat stream.

- **Pointers, not auto-dump.** Deterministic hits + hourly-catch-net hits surface as **source-attributed
  readings** (`db.insertMonologue({content, model:'feed', type:'reading'})`) + the **Monitors briefing
  section**; a trigger hit escalates to a `presence.notify`. Every item carries its **source**; she
  never confabulates attribution.
- **Identity-isolated.** The lane **never** writes `self_model` or any identity store — feeds inform
  what she KNOWS / can surface, nothing more (the drift lesson).
- **Budget-capped.** Hourly/daily model passes draw on the shared subconscious token budget; the live
  tier is model-free.
- **`lib/monologue.js` internals stay untouched.** If we want the graph-builder to also *pursue* a news
  entity as an anchor, that's ONE agreed line added to `runGraphWalkMove` at the merge checkpoint — the
  lane exposes the anchor; it does not edit their file. (Optional; the readings + daily-pass objects are
  the guaranteed path.)

---

## 7. The 4 live video feeds — autoplay + CC-confirmed capture

**Requirement (added):** the 4 video tiles **autoplay** and have **CC confirmed ON**, so their captions
render in the DOM and become a live text source for the reservoir. This makes **Option C** (read captions
off the existing `persist:zoe-media` webviews) the chosen path — no separate headless caption harness,
no contention with `media_cc`'s single-video watch-along.

**Live observation (2026-07-02 running Monitors screenshot):** 4 live-news tiles confirmed (Al Jazeera,
NEWS?LIVE, CNN, yahoo!finance). ⚠️ The text visible in the tiles is **burned-in broadcast chyron
(pixels), NOT the YouTube CC DOM track** — the tiles are muted players with CC *not* enabled. So our
readable path **depends entirely on enabling the CC track + reading `.ytp-caption-window-container`**;
if that fails the only fallback is OCR of the chyron (a much harder, separate project — flagged, not
planned). Confirmed live: **ads are real** (a "7OH gas-station-heroin" product segment; a yahoo-finance
sponsor read) → ad-strip is load-bearing. CNN showed a **"DEVELOPING STORY"** banner → broadcasters
literally label continuation (a usable signal once captions are read). ⇒ the probe is the decisive test.

**Mechanism (our owned surface — the clean player server + Monitors renderer):**
- **Autoplay + muted.** Browsers only autoplay when muted (the tiles already `setAudioMuted(true)` on
  `dom-ready`, `renderer/canvas.js:462`). The clean player embed (`main.js:893–895`) gets
  `&autoplay=1&mute=1` for monitor tiles; the full-ingestion pane keeps its audio-on `a=1` path.
- **CC on.** Add `&cc_load_policy=1` (+ optional `cc_lang_pref`) to the embed so captions load by default.
- **CC *confirmed*, not just requested.** `cc_load_policy=1` silently no-ops on a video with no caption
  track — so the lane must **verify captions are actually rendering** (poll the caption container in the
  webview, e.g. `media_cc`'s `.ytp-caption-window-container` selector) before treating a feed as a source.
  The confirmation check also tells us *which* of the 4 feeds are usable.
- **Caption read** reuses the proven cascade/normalizer from `lib/media_cc.js`
  (`parseCaptionBlock` / `freshFrom` dedup) — read from the tile's webview, dedup, write source-attributed
  caption items into `news_items` (source = the channel).

**Lifecycle decision (open):** the tiles are alive only while the Monitors pane is open. For **always-on**
capture the collector should own **hidden/offscreen webviews** for the 4 streams so capture continues when
the pane is closed (consistent with "collection ON at launch, decoupled from the widget"). v1 could accept
UI-gated capture (only while the pane is open) to keep it simple — **confirm which** (see §8).

**PROBE RESULT (2026-07-02): ✅ CONFIRMED 4/4 — every stream's CC track is DOM-readable.** Clean run
(app closed, one Electron process per stream): all four (`gCNeDWCI0vo` AJ, `iipR5yUp36o` ABC,
`GotlA1KKWoo` CNN, `KQp-e_XQnDE` Yahoo Finance) → `opened=true, playing=true, cc=already-on`, caption
lines read from `.ytp-caption-window-container` in a hidden autoplay window. **We are NOT stuck at
chyron-OCR.** Findings:
- **Real news captured** (AJ: Ukraine/Russia energy exports; ABC: "1.4 BILLION… FAMILY'S CRYPTO
  BUSINESS… WORLD LIBERTY FINANCIAL"; Yahoo: the "lump of labor fallacy / AI creates jobs" segment).
- **Live cross-source cluster proof:** ABC's captions carried the **Trump $1.4B crypto** story — the
  SAME event as the Google News RSS cluster in the §"Real feed shapes" sample. Video-caption + RSS
  corroboration of one event, live → real Stage-2 fixture.
- **Ads interleaved with news in the CC stream** (CNN pulled a pet-food ad; other runs got
  warranty / AI-notetaker ad prerolls) → **ad-strip confirmed load-bearing.**
- **Resolves knob §8.5 → offscreen always-on is feasible.** NB: the probe's *sequential* BrowserWindow
  create/destroy in a bare Electron process crashed on the 2nd window (GPU) — a **probe artifact, not a
  production concern**: the live app already runs **4 concurrent video webviews stably** (screenshot),
  so production capture reads from persistent per-stream webviews (co-existing), not sequential windows.
  Build note: capture should attach to persistent per-stream webContents, never open/destroy windows in a loop.

**Live probe (built):** `scripts/probe_video_cc.js` validates the mechanism end-to-end — hidden
`BrowserWindow` (autoplay policy forced) → watch page → enable CC → read `.ytp-caption-window-container`
→ report per-stream caption lines. Mirrors `media_cc`'s top-document read (embeds are cross-origin,
unreadable). Doubles as the offscreen-always-on feasibility test (knob §8.5). Isolated: no `lib/` imports
(never opens `sq.db`), throwaway `persist:probe-media` partition. Run (Electron runtime, **not**
RUN_AS_NODE): `./node_modules/.bin/electron scripts/probe_video_cc.js [--show] [url|id …]`. Known risk:
a fresh session may hit YouTube's consent/interstitial wall (the probe reports it) — if so, point capture
at her already-authed media session/partition.

**Sequencing:** still build the reservoir/watch/hourly/daily/snapshot **spine on RSS first**
(deterministic, low-risk, ~80% ready); land autoplay+CC-confirmed video capture as the focused second
slice against the working buffer. The caption items flow into the *same* `news_items` reservoir and the
*same* hourly/daily passes — video is just another source into the pipeline.

---

## 8. Decisions locked / still open

**Locked in conversation:**
- Collection ON at launch, decoupled from the widget; closing the pane = gated choice, meta kill-switch.
- Hourly pass = clean layers + hourly briefing + missed-trigger thinking pass.
- Missed-trigger concepts **feed the watchlist**.
- Hourly briefing → **standardized block rendered in the Monitors widget** (our owned surface),
  **`presence.notify` interrupt** when a trigger hit this hour. (Not the canvas chat — avoids the
  other context's chat-turn machinery.)
- Snapshot = today→now default + explicit "update since `<time>`"; no ambiguous open-ended deltas.
- News objects = `event` hubs + typed edges, via proposals + the promote rail; no new entity type.
- RSS-first; video capture is a later slice.
- **Video tiles autoplay + CC confirmed ON** → captions read off the `persid:zoe-media` webviews
  (Option C, `persist:zoe-media`) into the same reservoir; CC must be *verified rendering*, not just
  requested (§7).

**Knobs — SET (defaults, all tunable against live data; 2026-07-02):**
1. **Watchlist storage → `news_watch` table** (not meta JSON) — the hourly pass *feeds* it, so it grows
   and needs per-term metadata: `id, term, kind('keyword'|'phrase'|'concept'), origin('conversation'|
   'hourly'|'manual'), weight, hits, last_hit_ts, created_at, active`. Queryable + ageable.
2. **News-object boundary → one `event` per clustered STORY** (never per item). Rolling story = the unit.
3. **Retention windows:**
   - raw `news_items` + `news_captions`: **48h** then prune (covers today→now across midnight + "since
     ≤1d ago").
   - `news_layers`: **7 days** (hourly briefings; cheap; supports "this week" + daily-pass audit).
   - `news_stories`: `open` until closed; on close+promote, **trim to an `event_ref` pointer** (drop bulky
     members), keep the row **30 days** for continuation-relink + snapshot, then prune. Echo objects forever.
   - **Cold-close N = 6h** of no new item → close a story (a genuinely live story keeps drawing material
     within a news cycle; top-of-hour repeats keep it open).
4. **Continuation similarity** — combined score `S = 0.6·entitySetJaccard + 0.4·headlineTokenJaccard`
   (entities dominate — same principals > shared wording). Bands: **S ≥ 0.60 → auto-continuation**;
   **S < 0.30 → new story**; **0.30 ≤ S < 0.60 → one model adjudication** (the tiered-relevance discipline).
   **MEASURED (build, smoke_news_lane): the real BBC-vs-NBC Kyiv pair scores S=0.42 → the ambiguous
   band.** So the model adjudicator is **load-bearing for cross-source clustering**, not a rare edge —
   differently-worded headlines of the same event live in the middle band by design. Near-identical
   headlines auto-continue (S≈0.93); unrelated stories are cleanly new (S≈0). Without an adjudicator the
   pipeline conservatively opens a new story (proven).
   **CONFIRMED AT SCALE (`news_brief_demo`, 14 real items, NO adjudicator): almost nothing merged** — Kyiv
   (18/20), Vatican, Damascus, Bending Spoons all split → the rendered brief **double-reported** events.
   ⇒ the cloud adjudicator is REQUIRED for real hourly clustering (deterministic-only badly under-merges);
   band-tuning alone risks false merges. **BUILD TODO: wire the adjudicator into `runCompression`** (a
   cheap yes/no per ambiguous pair, same cloud the brief uses) — done in the coordinated pass.
5. **Video capture lifecycle → offscreen always-on IF the probe proves it feasible**, else UI-gated
   (pane-open) for v1 with offscreen as a fast-follow. The probe (`scripts/probe_video_cc.js`) tests
   exactly this (a hidden window loading a stream), so it doubles as the feasibility test. RSS is
   always-on regardless, so the reservoir never goes fully dark.
6. **Snapshot invocation → Monitors-widget "Briefing" button + a snapshot IPC** (our owned surface) for
   v1. Chat-phrase invocation ("what's the news / update since <time>") is a later integration that needs
   the Zoe-builder's chat-turn hook — deferred, not in the critical path.
7. **Video Stage-1 method → heuristics for ad/repeat, ONE budgeted model pass per feed-hour for story
   segmentation + summary.** Deterministic caption-gap + repeated-block detection strips ads and collapses
   top-of-hour loops; the semantic story-boundary + summary is the model's job (budget-gated via
   `subc.budgetOk`).

---

## 9. Coordination model & collision map

**Coordination model (Lucas, 2026-07-02): build + verify the ENTIRE backend SOLO, then involve the
interface builder.** We build and prove the full stream → collection → compression → objects → snapshot
system independently. The **only** cross-context need during this phase is **reboot agreements**
(request + approve, as established). The **interface builder is involved only AFTER** the backend is
built + verified — for the surfacing/interface layer (how briefings/snapshots/pointers reach the UI or
chat). So there is **no pre-build check-in gate**; this section is a technical collision map, not an
approval gate.

- **PROVIDENCE — the Monitors integration is ours.** The feeds infra (`lib/feeds.js`, the `feeds:*`
  IPC, `studio/feeds_view.js`, the Monitors renderer/preload surface) is **unwired into cognition — the
  program has no awareness of it yet**, so integrating it is not a live collision. We own the Monitors
  surface: `lib/feeds.js`, `renderer/canvas.js` / `canvas.html` (Monitors block), `preload.js`
  (`feeds` bridge), and any new Monitors integration.
- **Shared-file edits we make** (in the worktree; reconciled at the interface phase, not sign-off-gated now):
  - `lib/db.js` — additive migration (new `news_*` tables). Additive → merge-clean.
  - `main.js` — poller wiring in the boot/poller region (~700–763) + shutdown clears (~836–839) + the
    Monitors IPC block (~867+); daily-pass hook alongside `maybeRunCuration`/`promoteDocumentsPass`
    (~412); a snapshot IPC handler. Confined to these regions (disjoint from their chat-turn/condense edits).
  - `scripts/run_smokes.js` — register new smokes (append only).
- **No canvas-chat writes in this phase.** Briefings render in the Monitors widget + `presence.notify`.
  Any chat-turn surfacing is an INTERFACE-PHASE item, handed to the interface builder after backend verify.
- **Files we do NOT edit** (owned by the other context): `lib/monologue.js`, `lib/context.js`,
  `lib/research.js`, `lib/compose.js`, `studio/canvas_emit.js`, and the chat-turn/condense regions of
  `main.js`. The optional `runGraphWalkMove` anchor hook is an interface-phase proposal, not applied now.
- **Isolation:** build in a worktree/branch (`feature/data-stream-lane`), temp-DB smokes only, never
  write prod `data/sq.db` while the operator is live-testing. Reboots to live-verify are request+approve.

**Interface-builder involvement (deferred to after backend build + verify):** briefing/snapshot surfacing
into the UI or chat; the optional graph-walk anchor hook; reconciling the disjoint `main.js` regions at merge.

---

## 10. Test plan (offline, temp-DB smokes — proof required)

Mirror the harness in existing `scripts/smoke_*.js` (temp `SQ_DB_PATH`, `PASS/FAIL — N ok, M failed`
line, Electron-as-node). Register each in `scripts/run_smokes.js`.
- `smoke_news_store.js` — reservoir insert + dedup (guid/url), layer assignment, window queries.
- `smoke_news_watch.js` — deterministic matcher (hit/miss, phrase/concept), watchlist append/feed.
- `smoke_news_lane.js` — hourly cluster + briefing format; daily per-story recipe emits the right
  `propose_entity{event}` + `propose_relation` plan + `doc_store` doc (mocked dispatch/echo).
- `smoke_news_poll.js` — poller tick with mocked `fetch_feeds_batch` writes only NEW items, deduped;
  clean shutdown.
- `smoke_news_snapshot.js` — today→now and "since `<time>`" window assembly (deterministic).

Acceptance: poller runs autonomously (sweep+interval+shutdown), persists deduped items; relevant items
reach the main strain as source-attributed pointers, budget-capped, **zero** `self_model`/identity
writes; daily pass produces `event` objects + edges via proposals; `npm test` green; no edits to the
other context's owned files.
