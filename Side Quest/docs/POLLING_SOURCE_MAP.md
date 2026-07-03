# 538 Replacement — Polling Source Map & Data Homes

> **Purpose (Lucas, 2026-07-03):** 538 is dead — "find a place for all the data we lost: approval polls,
> up/downs [favorability], race estimates, etc." This maps **where each category of data now comes from**
> (post-538 successor sources, access terms verified where possible) **and where it lands** (schema/home in
> the two-suite architecture, `docs/WORLD_MODEL_FORECAST_BRAINSTORM.md` §0).
>
> **Headline finding:** there is **no single drop-in 538 API replacement.** The data 538 provided is now
> fragmented across ~8 sources — but it's fully recoverable, anchored by **two FREE, verified backbones**
> plus one clean REST API. 538 officially **dissolved March 2025**; its live feeds are frozen.

---

## 1. The two free backbones (verified live 2026-07-03)

These two cover the bulk of what 538 gave us, at no cost, with clean licensing:

- **Wikipedia — "Opinion polling on the second Trump presidency"** (+ sister pages, below). *Verified:*
  hundreds of polls in scrapable HTML tables — **nationwide + statewide (15 states) approval, issue/policy
  approval, cabinet-official approval, approval by race**, each row with pollster / dates / sample / MoE /
  approve-disapprove-unsure. Cites every successor aggregator (Ballotpedia, CNN, DDHQ, RCP, Economist, NYT,
  VoteHub) + 50+ pollsters (Gallup, Reuters/Ipsos, Quinnipiac, YouGov, Emerson, Morning Consult…). **The
  best free CURRENT-data backbone.** License: CC-BY-SA. Sister pages to ingest:
  - *"Nationwide opinion polling for the [next] United States presidential election"* (horse-race)
  - *"Generic ballot"* / *"…for the next United States House of Representatives elections"* (generic ballot)
  - favorability tables on candidate/figure pages ("up/downs")
- **FiveThirtyEight legacy data repo — `github.com/fivethirtyeight/data`.** *Verified: still up*, **data
  CC-BY 4.0 / code MIT.** Contains `pollster-ratings`, `congress-generic-ballot`, `election-forecasts-2020/
  2022`, approval + poll directories. Live forecasts stopped, but the **historical archive is intact** —
  the backbone for **base rates, pollster-rating priors, and backtesting.**

---

## 2. Category → source map (matches Lucas's list)

| 538 product (lost) | Primary replacement | Also / fallback | Access |
|---|---|---|---|
| **Presidential approval** | **VoteHub REST API** (real-time approval) + **Wikipedia** (2nd-term approval, full tables) | RCP approval avg (scrape); Silver Bulletin (paid); Strength in Numbers (G.E. Morris) | API + free scrape |
| **Favorability / "up-downs"** | **Wikipedia** favorability tables; **YouGov/Economist** net-favorables (weekly, free) | Silver Bulletin favorability tracker (paid); Morning Consult Political Intelligence | free scrape |
| **Generic ballot** | **VoteHub API** (generic ballot) + **Wikipedia** generic-ballot page | RCP; 538 legacy repo (historical) | API + free scrape |
| **Horse-race / race estimates** | **Wikipedia** race-polling pages; **Silver Bulletin** model (paid); **Split Ticket** | DDHQ; Race to the WH; Economist model (open source); prediction markets (Polymarket/Kalshi/Manifold) | mixed |
| **Race ratings** (Toss-up/Lean/Likely/Safe) | **Cook Political Report**, **Sabato's Crystal Ball**, **Inside Elections**, **Split Ticket** | **270toWin** (aggregates all raters) | free-read / scrape (Cook partial paywall) |
| **Pollster ratings** | **538 legacy `pollster-ratings`** (historical, CC-BY) | **Silver Bulletin** ratings (paid); **or build our own** from historical accuracy | free + paid |
| **Election model / forecast** | **Silver Bulletin** (paid, no API); **The Economist model** (open R+Stan) | Split Ticket; DDHQ; prediction markets; **our own** (Suite B) | mixed |
| **Historical polls & results** | **538 legacy repo** (CC-BY); **MIT Election Lab** (results, open) | Roper/iPoll (archive, institutional); UCSB American Presidency Project (approval history); Gallup | free |

**Raw-pollster direct feeds** (for "aggregate as much as we can" — pull releases straight from the source):
Gallup, Quinnipiac, Marquette Law, Siena/NYT, YouGov/Economist, Marist/NPR-PBS, AP-NORC, Pew, Morning
Consult, Emerson, Data for Progress, Fabrizio/Impact, Napolitan, Reuters/Ipsos. Most publish RSS/press
pages the news lane's feed machinery can already ingest.

---

## 3. Access reality (verified 2026-07-03)

- **VoteHub** — ✅ **API fully characterized (2026-07-03, live)** — better than expected: a **free,
  no-auth REST API at `api.votehub.com`**, JSON, permissive CORS. *(By Luke Wines.)* The cleanest
  programmatic successor, and it covers the whole 538 gap:
  - `GET /poll-types` → `approval, favorability, generic-ballot, presidential-primary, us-senator,
    us-representative, governor, mayor, attorney-general, proposition-50` — **approval + up/downs +
    generic ballot + race estimates, one feed.**
  - `GET /polls[?limit=&poll_type=&subject=…]` → array of poll objects:
    `{ id, poll_type, subject, seat_name, pollster, sponsors[], partisan, internal, population('rv'|'lv'|
    'a'), sample_size, start_date, end_date, created_at, url, answers:[{choice, pct}] }`. **`population`
    fills the LV/RV/A frame gap** the 538 data lacked.
  - `GET /polls/{id}` (single), `GET /subjects` (`[{subject, poll_types[]}]` — races/figures polled),
    `GET /pollsters` (name list).
  - No auth key, no visible rate-limit headers (be polite; cache). License/ToS **still to confirm** (page
    is WordPress; there's a `votehub-wire/v1` WP-REST namespace too). Register as a `tier:'free'` adapter.
- **Silver Bulletin** (Nate Silver) — ✅ the *direct methodological heir* of the 538 forecast (models,
  pollster ratings, averages, adjusts for voter type + house effects). **Paywalled, no API.** Use as a
  benchmark/reference, not a feed.
- **Strength in Numbers** (G. Elliott Morris, ex-538 editorial head) — newsletter, "data-driven analysis
  of polls and elections." Some open data historically; **GitHub handle to confirm** (not `GElliottMorris`
  — 404'd). Verify at build.
- **Wikipedia** — ✅ verified goldmine (§1). Free, scrapable, well-sourced; the practical current backbone.
- **538 legacy repo** — ✅ verified up, CC-BY 4.0. Historical only.
- **RCP / DDHQ / Cook / Sabato / Split Ticket** — free to read; **no clean public APIs** (DDHQ has a paid
  API). Ratings/averages are scrapable HTML; treat as build-time scrapers, license-check each.

---

## 4. Where the data lands (the "place for it" — schema homes)

538 gave us both **raw polls** *and* **derived products** (averages, ratings, forecasts). The two-suite
split (brief §0) decides the home for each:

**Suite A (Polling) — raw external data + provenance.** Extends the existing Echo `electoral` model
(`poll_fielding` / `poll_question` / `poll_topline` / `poll_external_reference`):
- **Approval / favorability / generic-ballot / horse-race raw polls** → `poll_fielding` + `poll_question` +
  `poll_topline`, tagged by new `source_kind` per inflow (`votehub`, `wikipedia`, `538_legacy`, `<pollster>`).
  *These slot into the schema we already have — the gap was content, not structure.*
- **Race ratings** (Cook/Sabato/Inside Elections/Split Ticket) → **NEW small table** (race, rater, rating,
  as_of) — categorical expert judgments, the "race estimates" Lucas named. Raw external data, so Suite A.
- **Historical polls + pollster ratings** (538 legacy) → `poll_fielding` (`source_kind='538_legacy'`) +
  a pollster-ratings reference table → feeds base rates / backtesting.

**Suite B (Forecasting) — derived / modeled series (Option 2, all modeling lives here).**
- **Our own approval/generic-ballot/race AVERAGES** (weighted, house-effect-corrected trendlines) →
  computed in Suite B from Suite A's raw polls (§2.B.1 of the brief). Not stored as Suite A data.
- **External model forecasts + averages** (Silver Bulletin, VoteHub averages, prediction-market implied,
  Economist model) → ingested as **external reference series** for the ensemble blend + as benchmarks —
  clearly tagged as external, never confused with our own model output.

---

## 4a. One pluggable interface — build all the free sources now, add paid later (Lucas, 2026-07-03)

**Design principle:** every source — free *or* paid — is a **registered adapter behind one common
contract**, so adding a paid feed later is *"register one more adapter,"* never a pipeline/schema change.
This is already the idiom in this codebase (the news lane's "register one more source — no new branch";
`lib/poll.js`'s source router), so it's the natural pattern, not new abstraction.

A source adapter implements a thin contract:
```
{ name, tier: 'free'|'paid', license, kind: 'poll'|'rating'|'forecast_ref',
  enabled(): bool,          // gated on a config flag / API key — paid ones ship disabled
  fetch(): rawItems,        // hit the source (scrape | REST | repo | file)
  normalize(raw): rows }    // → the shared fielding/rating/reference shape, tagged source_kind + tier
```
- **Now:** register the FREE adapters — `wikipedia`, `538_legacy`, `votehub`, plus race-rating scrapers.
- **Later (zero rework):** register `silver_bulletin`, `ddhq`, `roper`, any pollster-direct — same
  contract, `tier:'paid'`, `enabled()` false until a key/flag is set. The registry, schema, auto-update
  cadence (A2), the two-channel split, and the aggregation model all treat every adapter uniformly.
- **Provenance carries the tier + license end-to-end** — so a forecast can weight/*exclude by tier*, and
  we never surface paid-source content without the entitlement. (Also lets the ensemble say "free-only run"
  vs "with paid sources.")

This makes "everything, with the option of adding more later" a **property of the architecture**, not a
future migration.

## 5. Recommended sequencing (feeds §7 of the brief, A3)

1. **Wikipedia scrapers first** — free, verified, covers approval + favorability + generic ballot + horse-
   race + by-state + by-issue in one well-structured source. Highest coverage-per-effort. Land into
   `poll_fielding`/`poll_topline` with `source_kind='wikipedia'`.
   **✅ PARSER BUILT + PROVEN (2026-07-03):** `lib/poll_wikipedia.js` — pure, dependency-free, header-driven
   (robust across table types), emits the shared adapter shape. `scripts/smoke_poll_wikipedia.js` (38
   assertions, registered in the gate) + **live-validated: 332 real polls parsed clean from "Opinion polling
   on the second Trump presidency," 0 junk.** Not yet storage-wired (landing = later coordinated slice).
2. **538 legacy repo ingest** — one-time historical load (CC-BY) → base-rate + pollster-rating + backtest
   substrate.
   **✅ ADAPTER BUILT + PROVEN (2026-07-03):** `lib/poll_538legacy.js` — pollster-ratings (grade + `bias_ppm`
   house-effect prior) + raw_polls (`margin_poll` vs `margin_actual` backtest). Own CSV parser (no dep).
   `scripts/smoke_poll_538legacy.js` (20 assertions, gate-registered) + **live: 540 ratings + 20,466
   historical polls-with-actuals.**
3. **VoteHub API** — the clean real-time approval + generic-ballot feed.
   **✅ ADAPTER BUILT + PROVEN (2026-07-03):** `lib/poll_votehub.js` — pure, injected-fetch, emits the shared
   shape (cross-adapter parity smoke'd vs `poll_wikipedia`). `scripts/smoke_poll_votehub.js` (27 assertions,
   gate-registered) + **live: 2,931 approval + 532 generic-ballot polls normalized clean.** ⚠️ `limit` param
   is ignored server-side (returns full set) → pagination/volume is a wiring concern. License/ToS still TBC.
4. **Race-ratings table + scrapers** (Cook/Sabato/Split Ticket/270toWin) — the categorical "race estimates."
5. **Direct pollster feeds** — opportunistically, via the news-lane feed machinery, to widen the aggregate.
6. **Silver Bulletin / DDHQ / Roper / pollster-direct paid feeds** — **registered as `tier:'paid'`
   adapters now (disabled until keyed), enabled if/when justified** (§4a). No rework — they ride the same
   registry, schema, and cadence as the free sources; they just start switched off.

*Net: the data 538 gave us is recoverable — mostly FREE — but it must be re-sourced from ~8 places and
re-homed across the two suites. Wikipedia + the 538 legacy repo + VoteHub cover ~80% at zero/low cost.*

---

*Prepared 2026-07-03. Companion to `docs/WORLD_MODEL_FORECAST_BRAINSTORM.md` (§0 suites, §4 polling).
Verified sources marked ✅; access terms marked "verify at build" need a browser/docs check.*
