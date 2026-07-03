# News Tuner — Design (topical balance for the feed + brief)

**Status: DESIGN ONLY (2026-07-02). Not built.** Locked decisions from Lucas below; build in slices after sign-off.

## The problem

"I'd love World Cup news, but it can't drown out actual news." The imbalance lives in **two** rankings, and
neither is a bug we can patch in place:

- **Scrolling feed** (`renderMonitors`) ranks by **recency** → a burst of World Cup items floods the top.
- **Brief** (`buildBriefing` / `storiesActiveInWindow`) ranks by **corroboration** = `min(outlets, reports)`.
  A World Cup result is *genuinely* reported by many independent outlets → high **real** corroboration (NOT
  syndication inflation), so `min(outlet,report)` can't help. It tops the brief legitimately and buries a
  single-outlet local story that matters more.

So the fix is a new **category-balance layer** shared by both surfaces, not a change to either ranker's core.

## Locked decisions (Lucas, 2026-07-02)

1. **Tuner UI = fine per-category sliders + caps** (not simple levels).
2. **Anti-drown mechanism = reserved hard-news slots** (guarantee N slots for protected "hard news"
   categories; the rest compete freely).
3. **Classification = cloud on everything** (every item + story cloud-classified once, cached).

## 1. Category model (shared)

Fixed taxonomy — small enough to tune, big enough to matter:

| key | label | default protected? |
|-----|-------|--------------------|
| `world` | World & Conflict | ✅ |
| `politics` | US Politics / Gov | ✅ |
| `local` | Local / Civic | ✅ |
| `markets` | Business / Markets | ✅ |
| `health` | Health / Science | ✅ |
| `weather` | Weather & Disaster | ✅ (protected **and uncapped** — Lucas) |
| `tech` | Technology | ⬜ |
| `sports` | Sports | ⬜ |
| `culture` | Culture / Other | ⬜ |

`lib/news_topics.js` (pure, UMD like `feeds_view` so it runs in Node **and** the browser):
`categorize({title, summary, source})` → `{category, confidence}`.

**Cloud on everything, but classify-once + cache** (the cost control):
- Every **item** is cloud-classified **once**, at the **collector** (batched per poll tick — only the *new*
  items each tick), and the verdict is cached on the row (`news_items.category`). Never re-classified.
- Every **story** is cloud-classified once at clustering (`news_stories.category`), or inherits its dominant
  member item's category.
- A deterministic keyword/source map (`categorizeFast`) is the **provisional** label shown for the ≤1 refresh
  before the cloud verdict lands, and the **fail-safe** when cloud is down (→ its best guess, else `culture`).
- **Cost estimate:** ~1–3k new items/day across 189 feeds → batched ~20/call → ~100–150 cloud calls/day,
  comparable to the ad-filter. Bounded because each item is paid for exactly once.

Reuses the proven `classifyBatch` shape (heuristic-provisional + batched cloud + regex-tolerant validator +
fail-safe). New table/column: `news_items.category TEXT`, `news_stories.category TEXT` (additive migration in
the bucket, which the lane already owns).

## 2. Tuner config (persisted, UI-editable)

`db.getMeta('news_tuner')` → JSON:

```json
{
  "version": 1,
  "reservedSlots": { "feed": 12, "brief": 5 },      // top slots guaranteed to PROTECTED categories
  "categories": {
    "world":   { "weight": 1.4, "capPct": null, "protected": true  },
    "politics":{ "weight": 1.2, "capPct": null, "protected": true  },
    "local":   { "weight": 1.3, "capPct": null, "protected": true  },
    "markets": { "weight": 1.0, "capPct": null, "protected": true  },
    "health":  { "weight": 1.0, "capPct": null, "protected": true  },
    "weather": { "weight": 1.2, "capPct": null, "protected": true  },   // uncapped — hurricanes/wildfires never capped
    "tech":    { "weight": 1.0, "capPct": 25,   "protected": false },
    "sports":  { "weight": 0.6, "capPct": 20,   "protected": false },  // World Cup: on, weighted down, capped
    "culture": { "weight": 0.5, "capPct": 15,   "protected": false }
  }
}
```

Per category the tuner exposes three fine controls:
- **weight** (slider, 0.0–3.0; 0 = mute): multiplies the surface's base rank score.
- **capPct** (optional, 0–100): the category may not exceed this share of the surface. `null` = uncapped.
- **protected** (toggle): counts toward the reserved hard-news slots.

Global: **reservedSlots.feed / .brief** — how many top slots are held for protected categories.

Fail-safe: a missing/parse-broken config → everything `weight 1.0`, uncapped, protected-by-default set →
today's behavior, so a bad config never blanks the feed.

## 3. Application

Shared selector `lib/news_rank.js` (pure, tested) — `arrange(items, cfg, {slots})`:

1. **Mute** — drop `weight === 0` categories.
2. **Reserve** — fill the first `reservedSlots` positions from **protected** categories only, best-first by the
   surface's weighted base score. Guarantees hard news is never buried under a loud topic.
3. **Fill** — fill the remaining positions from **all** categories by weighted score.
4. **Cap** — enforce `capPct` per category across the whole surface (a capped category that would overflow is
   truncated; freed slots go to the next-best uncapped item).

- **Feed:** base score = recency (× category weight). Runs after the syndication collapse, in the view path.
- **Brief:** base score = `min(outlet,report)` corroboration (× category weight). Replaces the flat
  corroboration sort in `buildBriefing` / `storiesActiveInWindow` selection. World Cup still appears — it just
  can't take a reserved slot and is bounded by its cap.

## 4. Tuner UI

A gear on the Monitor widget → compact panel: one row per category = **weight slider + cap field + protected
toggle**, plus the two reserved-slot fields. Persists to `news_tuner` meta; live-applies to the feed on save;
the brief picks it up on the next compression / on-demand snapshot. Optional later: per-item "less/more like
this" nudging the category weight.

## 5. Build slices

1. ✅ **DONE** `news_topics.js` — cloud classifier (classify-once) + deterministic provisional/fail-safe + smoke (24). 9 cats incl. weather.
2. ✅ **DONE** Bucket: `news_items.category` + `news_stories.category` migrations; classify new items at the
   collector (batched 50/tick, cached, cloud via editor model in main.js `classifyNewItems`); story category
   set at `createStory`. Store helpers `uncategorizedItems`/`setCategories`/`categoriesByGuid`.
3. ✅ **DONE** `news_rank.js` — the shared reserve/weight/cap selector + smoke (17). Weather uncapped verified.
4. ✅ **DONE** Feed: `feeds:fetch` enriches items with cached categories (+ provisional) & ships the tuner;
   `renderMonitors` applies `arrange` (recency score) + category chip.
5. ✅ **DONE** Brief: `buildBriefing` + the prose-brief path apply `balanceStories` (`arrange`, corroboration
   score); threaded through `runCompression`/`snapshot`/`news:briefing`.
6. ✅ **DONE** Tuner UI panel (⚙ on the Monitor head → per-category weight slider + cap + 🛡 protected +
   reserved-slot fields) + `news_tuner` meta persistence + `news:tuner-get/set` IPC; save re-arranges live.

**All slices built + committed. Reboot-gated (renderer/main.js) to go live — request per [[request-reboots]].**
Default config balances out-of-the-box (sports capped 20% / weather uncapped / hard-news reserved), so the
tuner works before the operator touches a slider.

## Open / notes

- **Feed category source:** the widget's live-fetched items are matched to cached categories by `id`
  (guid/link) from the bucket; brand-new items show the deterministic provisional label for ≤1 refresh until
  the collector's classify pass fills them. (Alternative: classify synchronously in `feeds:fetch` — rejected,
  adds latency to every widget refresh.)
- **Reserved-slot starvation:** if protected categories can't fill their reserved slots (quiet news day), the
  unused reserved slots fall through to the general fill (no empty holes).
- **Per-surface weights:** config is shared feed+brief for v1; a per-surface override map can be added later if
  the two surfaces want different mixes.
- Ties into the existing corroboration/`min(outlet,report)` logic — the tuner multiplies it, never replaces
  the anti-syndication guard.
