# World-Model / Social-Forecasting / Prediction-Builder Suite — Brainstorm Brief

> **Purpose:** pre-reading + agenda for the initial brainstorm on a new workspace suite for **world
> modeling, social forecasting, and a prediction builder** (elections as the first vertical). Grounded in
> a review of the existing **Monitor / data-stream lane** (`docs/DATA_STREAM_LANE_DESIGN.md`, memory
> `data-stream-lane`). Nothing designed or locked yet — this frames the decisions.
>
> **One-line thesis:** we already have a world-class **narrative/situational** intake (the news lane) and
> the perfect **substrate** (Echo's object-memory KG with `event` objects). We do **not** yet have the
> **structured, quantitative, time-series signal** or the **model/scoring layer** that forecasting needs.
> The suite is mostly *additive lanes + a model layer on the memory we already have* — not a rebuild.

---

## 0. Two suites — the architecture split (Lucas, 2026-07-03)

This is **two separate suites** with a one-way data contract, not one monolith.

**Suite A — Polling (EXISTS → extend).** The standalone polling workspace
(`renderer/polling.*`, `studio/poll_view.js`, Echo `electoral` fielding model). It **owns poll intake +
processing + storage + browsing** and stays a dedicated standalone space. Additions:
- **Home for Rainey poll uploads → processing** (unchanged role; keep it the intake point for internal
  Rainey Center polls).
- **Two channels:** a **Rainey channel** (internal Rainey Center polling) and an **"everyone else"
  channel** (538 / Pew / external aggregate). Provenance-split of the same fielding model.
- **Auto-update: NOT built today (verified 2026-07-03).** `refresh_external_polling` exists but is a
  **manual admin tool** (hits the 538 repo + Pew pages, upserts; tags `["admin"]`, no recent runs) — and
  **nothing schedules it** (Side Quest wires only inbox/news/chat pollers; no poll cadence). The 49-day
  staleness confirms it isn't running. Echo *has* scheduling infra to hang it off (skuld `schedule` +
  `data_freshness` tables), but it's unwired for polling. → auto-update is **net-new work (A2).**
- **Product:** it *produces* clean, current, provenance-tagged poll data.

**Suite B — Forecasting (NEW → build).** **Fed by THREE internal producers + external inflows.**
Wholly dedicated to the **visual representation of multi-model forecasting and prediction runs.** Owns the
`Question`/`Prediction` objects, the model layer (ensemble + bespoke Bayesian), calibration/track-record,
and the rich viz. **Never owns intake of any kind.** Its feeds:
- **Suite A — polls** (read-only): the fielding store + the two channels.
- **The news / data-stream lane** ([[data-stream-lane]], EXISTS + live): the corroborated, entity-linked
  `event` objects + categorized/tone signal. This is a **first-class forecasting feed, not just
  situational awareness** — see §4a.
- **External new inflows:** prediction markets, GDELT (structured event/tone), fundamentals.

**The contract:** Forecasting *reads* its producers through stable interfaces; the producers (Polling, the
news lane) never depend on Forecasting. Suite A + the news lane are data producers; Suite B is a consumer +
modeler + visualizer.

**Boundary question — RESOLVED (Lucas, Option 2):** the **quality-weighted poll average** (house-effects +
pollster ratings + recency-decay trendline, §2.B.1) lives in **Forecasting (Suite B) as a model input** —
the weighting/house-effect choices are modeling decisions and belong with the model. **Suite A stays
purely descriptive + provenance** (raw/processed fieldings, the two channels, toplines); it does **not**
compute the weighted average.

Everything below (§1–§7) is written to this split: §1 + §4 (polls, historical) feed **Suite A** + the news
lane; §2 (model layer, incl. the weighted average), §3 (viz/toolkits), §4a (news→forecast), §5–§7 are
**Suite B**.

---

## 1. What we already have (grounded review of the Monitor streams)

The data-stream lane is **built, live, and mature** — this is the foundation the suite sits on.

**Intake (the reservoir):**
- **244 RSS feeds** — national wire + local/civic + **county/city gov** (Granicus/CivicPlus/Legistar) +
  **federal agency** (FDA/DOL/NOAA/SEC/FedReserve/CBO/GAO…) + **state legislature** (bills/votes/memos) +
  33 Substacks + 22 independent creators. Nationwide civic coverage down to county commissions.
- **4 live video streams** (Al Jazeera / ABC / CNN / Yahoo Finance) — YouTube CC captured, garbled
  fragments **reconstructed** into clean headlines, screen-read for on-chart market data (vision model).
- **Email newsletter intake** — read-only IMAP, newsletters → same rail, meeting-notes → docs.

**Cognition (tiered compaction):**
- COLLECT (per-source isolated bucket, `news_bucket.db`, physically separate from memory) →
  HOURLY (per-source normalize → cross-source cluster into rolling `news_stories` with a cloud
  **adjudicator** for the ambiguous band) → DAILY (worthy stories → Echo **`event` objects + edges**) →
  SNAPSHOT/Brief on demand.
- **Corroboration = `min(distinct outlets, distinct reports)`** — defeats wire syndication AND
  single-outlet inflation. This is a genuinely strong signal-quality primitive.
- **9-category topic model** (`news_topics`) + a **News Tuner** (weight/reserve/cap selector) for
  topical balance. Ad/promo filtering on video + newsletter lanes.
- **Brief** = schema-locked, cloud-written (mistral-large-3), rendered deterministically from our data.

**What this gives forecasting:** a live, corroborated, entity-linked, time-stamped **event stream** and a
self-densifying **knowledge graph** of people/orgs/places/events. That is the *situational / qualitative*
half of a world model. **It answers "what is happening."** It does **not** answer "what is the
probability of X by date D," and it carries **no structured quantitative time series.**

**Also already reachable (via the `nx-echo` MCP tool surface — under-exploited):**
- **GDELT** (`gdelt_article_search`, `gdelt_timeline_volume`, `gdelt_tone_distribution`) — the canonical
  global event/tone feed for social forecasting. **Wired but unused by the lane.**
- **FEC** (`fec_candidate_search/get`, `fec_committee_search`) — campaign finance.
- **Economic fundamentals** — `econdb_get_series`, `wb_indicator_data`, `treasury_query`, `sdmx_data`,
  `un_population_data` — GDP/unemployment/inflation/rates.
- **Legislative** — `legiscan_*`, `bill_lookup`, legislative trackers; **courts** — `courtlistener_*`.
- **Polls — a real aggregation layer already exists (verified live 2026-07-03).** Echo's **`electoral`
  DB** ("PUBLIC CRM foundation — contacts, accounts, bill_meta, and **538 public polls**") holds a proper
  **fielding model: 293 fieldings — 272 ingested from FiveThirtyEight** (30+ vendors: YouGov, Ipsos,
  Morning Consult, Ipsos/WaPo, Navigator, Data for Progress, Echelon, Economist/YouGov, TIPP, Cygnal…) +
  **21 internal Rainey Center**, spanning **2024-07 → 2026-05**, each with dates / sample_size / MoE /
  frame / mode / vendor / sponsor / weighting / themes / pollster. Plus **68+ Pew** issue/approval
  references (`list_external_references`). Charting tools already exist (`chart_topline` / `chart_trend` /
  `chart_subgroup` / `compare_subgroups` / `synthesize_fielding`) and `refresh_external_polling` is the
  ingest hook. **Side Quest already ships a polling atlas UI** (`renderer/polling.html`/`polling.js`,
  `studio/poll_view.js`) — read-only fielding list + methodology card + topline bars + issues triage,
  source-aware (rainey/538/pew), frame-aware (RV/LV/A/V).
- **Echo's own DB is directly queryable** (`db_query`, `get_db_map`, `get_schema`, `kg_query_*`) — 8
  databases incl. `electoral` (82 tables), `main` civic graph, `caselaw` (1.7M), `courtlistener` (22M),
  `us_code`/`cfr`, `wikipedia` (2.3M). So a large slice of the **historical / base-rate substrate is
  already in Echo** — map it (`get_db_map`) and ingest only gaps, don't rebuild.

---

## 2. What a forecasting suite actually requires (the components to build)

Standard architecture for resolvable-event forecasting (the 538 / Economist / Metaculus lineage):

### A. Structured signal ingestion (time series — the missing intake)
| Signal | Why it matters | Have it? |
|---|---|---|
| **Polls** (horse-race, approval, generic ballot, issue) | The primary short-horizon signal | ✅ mostly — Echo `electoral` 538+Rainey (293) + Pew + atlas UI; widen + add a model (§4) |
| **Prediction markets** (Polymarket, Kalshi, Manifold, Metaculus) | Market-implied probability; hard to beat | ❌ |
| **Fundamentals** (GDP, unemployment, inflation, real income, approval, incumbency, PVI) | The prior; the long-horizon signal | ⚠️ reachable via Echo, not tracked |
| **Campaign finance** (FEC) | Viability / enthusiasm proxy | ⚠️ reachable, not tracked |
| **GDELT event/tone** | Instability / conflict / sentiment nowcasting | ⚠️ reachable, not ingested |
| **Historical results / outcomes** | Base rates, reference classes, backtesting | ❌ (need a results DB) |

Each is a **low-volume, high-value time series** (kilobytes/day) — the opposite of the news firehose.
The challenge is **structure + history + featurization**, not volume.

### B. The model layer (the actual forecast)
1. **Poll aggregation** — quality-weighted, recency-decayed average with **house-effect** correction and
   a trend line (state-space / Kalman). **Lives in Suite B (Lucas, Option 2)** — reads the raw fieldings
   from Suite A but the weighting/house-effect model is here. Not a new data pipeline; the model the atlas
   lacks.
2. **Fundamentals model** — economy + incumbency → a prior distribution.
3. **Bayesian combination** — fundamentals as prior, polls update it (the Linzer / Economist hierarchical
   state-space approach).
4. **Correlated simulation** — Monte Carlo over **correlated** state/demographic errors → a full outcome
   distribution (electoral college, seat counts), not a point estimate. *Correlation is where naïve
   models fail.*
5. **Ensemble / market blend** — combine our model + market-implied + crowd forecasts.

### C. The world-model / general social-forecasting layer (beyond elections)
- **Reusable resolvable-question framework** — a first-class **"Question"/"Prediction" object**:
  statement + resolution criteria + resolution date + probability **time series** + score. Elections are
  one instance; "will the Fed cut in September," "will ceasefire hold 30 days," etc. are others.
- **Reference-class / base-rate engine** — superforecasting discipline: find the reference class and base
  rate *before* modeling. Leans directly on the Echo event KG we already build.
- **Causal / driver graph** — which tracked signals feed which question (already have edges + object
  memory; this is a typed overlay, not a new graph).

### D. Calibration + scoring + track record (the trust substrate)
- **Brier / log score, calibration curves, resolution/discrimination.** This is what makes the forecaster
  *trustworthy* — and it maps directly onto Lucas's standing principle that the slow/deep track is for
  **trust, not speed** (memory `verifiable-research-track`).

### E. The workspace UI — the "prediction builder"
- Create a question → attach signals → pick/compose a model → run simulation → **track probability over
  time** → resolve + score. A Metaculus question-notebook fused with a 538-style dashboard.

---

## 3. Open-source programs to learn from

**Election models (methodology + code):**
- **The Economist 2020 US model** — `TheEconomist/us-potus-model` (Gelman/Morris/Heidemanns), **R + Stan**,
  fully open. The reference-grade reproducible Bayesian state-space election model. **Start here for the
  model layer.**
- **FiveThirtyEight** — methodology public; historical **pollster ratings** + poll data repo
  (CC-licensed); Silver Bulletin methodology posts. Reference for pollster weighting + house effects.
- **270toWin** — electoral-map UX reference for outcome visualization.

**Question / market / aggregation platforms:**
- **Metaculus** — the question/resolution/scoring/community-aggregation pattern; public API + track record.
  The canonical "prediction builder" UX to study.
- **Manifold Markets** — **fully open-source** play-money market (TypeScript). Reference for the market
  mechanism *and* a live data source.
- **Metaforecast** (QURI) — **open-source aggregator** across many prediction markets/platforms. Reference
  for blending market signals. Pairs with **Squiggle** (QURI) — a probabilistic estimation language +
  notebook — the best model for **composable estimates** in the builder UX.
- **Live market APIs** — Polymarket, Kalshi, Manifold, Metaculus, PredictIt (all free/cheap).

**Social forecasting / instability:**
- **The GDELT Project** — global event DB + tone (already wired via Echo). GDELT + Goldstein/tone is the
  standard instability nowcast feed.
- **ICEWS / Phoenix / Cline Center** — political event-coding datasets for conflict/instability reference
  classes and backtesting.
- **Good Judgment / INFER** — the *human* superforecasting methodology (reference classes, granular
  probabilities, frequent small updates, extremized aggregation). Method, not code — but it defines the
  discipline the whole suite should encode.

**Inference engines & modeling toolkits** *(all live in the Python sidecar — decision §6.3 locked):*
- **Stan** / **PyMC** — Bayesian; the bespoke model (Economist port) lives here. Plus plain Monte Carlo
  for the correlated simulation.
- **Prophet** (Meta) — time-series forecasting (uses Stan under the hood). The **cheap strong baseline**
  for the fundamentals/econ series and any date-indexed signal. Low effort, high value in the ensemble.
- **scikit-learn** — regression + classification baselines. **Logistic regression** is the natural
  resolver for binary questions ("will X happen? yes/no"); **decision trees** for interpretable splits.
  Covers most of the ensemble's non-Bayesian members.
- **H2O.ai (AutoML)** — auto-searches models over a tabular feature set and returns a leaderboard +
  explainability. A fast way to get a competitive baseline and to sanity-check which features matter.
- **KNIME** — visual, no-code pipeline builder. **Not embeddable** (it's a standalone desktop app), so
  treat it as a *UX reference* for drag-and-drop model composition in our builder, not a dependency.

  *Mapping to your primer:* linear/logistic regression = the ensemble's baseline members (scikit-learn +
  the poll/market aggregation); decision trees = interpretable resolvers; neural nets = the heavy end,
  almost certainly overkill early — **Prophet + scikit-learn + the Bayesian model cover ~80% cheaply.**
  This directly reinforces the §6.3 "Python sidecar" call: it's where every one of these runs.

**Sentiment / NLP toolkits — for the news→forecast momentum feature (§4a.2)** *(all Python → live in the
sidecar; these turn the news lane's text into a per-entity sentiment covariate GDELT's document-level tone
can't localize):*
- **`sentiment.ai`** (BenWiseman, **MIT**) — *best fit.* Embeddings-based (on-device `e5-small`/`e5-base`,
  ~100 languages, no API key), with opt-in `twitter-roberta` (English) / `xlm-roberta` (multilingual).
  **Has a verified Python sibling `sentimentai-py`** (PyPI), **models a neutral class**, and gives
  **calibrated confidence** — beats VADER-style lexicons on context + out-of-vocabulary. Calibrated
  confidence + neutral is precisely what a *model input* wants (weight by confidence, don't force polarity).
- **`SentiLog-AI`** (**MIT**) — notable for **news bias / political-slant detection (left/right/neutral)**
  on top of VADER + Transformers, via a **Python/Flask ML microservice**. Two takeaways: (a) the
  **outlet-lean control** we need when using news tone as signal (§4a.2), and (b) its Flask-microservice
  shape is a concrete reference for the **B0 sidecar** pattern.
- **`sena.ai`** (**MIT**) — **multimodal** sentiment (text/image/video/URL) via HF Transformers/TF/PyTorch
  + Flask. Relevant to scoring the **video-CC / screen-read broadcast lane**, not just text.
- **Field standards to reach for first:** **VADER** (fast rule-based, fine for a cheap baseline),
  **Hugging Face Transformers** — esp. **`cardiffnlp/twitter-roberta-base-sentiment`** (the standard for
  political/social short text) and **`finBERT`** (financial/markets tone); **Flair**, **spaCy**, **NLTK**.
- **Discipline (important):** sentiment is a genuinely useful but **noisy, overfit-prone** covariate — it
  must be **validated against outcomes (calibration)** and **outlet-lean-controlled**, or a partisan
  outlet's negativity reads as real movement. Treat it as one weighted ensemble feature, never a headline
  signal. (Matches the trust-not-speed ethos, [[verifiable-research-track]].) We also **already have a
  structured tone signal — GDELT** — so these libs are the *entity-level* refinement on our own lane, not
  a from-scratch sentiment stack.

**Visually rich interface — open source to poach** *(you want to lead to a rich UI; the app is
Electron/Chromium, so web-native JS viz drops straight into the renderer — it already ships
`force-graph.min.js` for the KG):*
- **Charting engines (embed in the renderer):** **Apache ECharts** or **Plotly.js** for interactive
  dashboards (Plotly.js pairs with the Python side's Plotly/Dash); **D3.js** + **Observable Plot** for
  bespoke forecast visuals; **Vega-Lite** if we want declarative specs. *Recommend ECharts/Plotly.js for
  dashboards, D3/Observable Plot for the signature forecast charts.*
- **Uncertainty visualization (the distinctive, hard part — get this right):** **fan charts / probability
  cones** (538 presidential-forecast style); **quantile dotplots** and **Hypothetical Outcome Plots
  (HOPs)** from Matthew Kay / UW-IDL (`ggdist`, "Presidential Plinko") — the research-backed way to make
  probability legible to non-experts; the **NYT election needle** (not open, but the reference for
  jitter-as-uncertainty). This is where a forecasting UI earns trust or misleads.
- **Election-specific UX references:** **270toWin** (interactive drag-state electoral map); **Metaculus**
  (probability-over-time timeline + community distribution + track-record cards — the strongest candidate
  for the *builder spine*); **Manifold** (**open-source** TS/React market + probability cards — directly
  poachable code).
- **Maps:** **MapLibre / Leaflet** + **us-atlas** TopoJSON for choropleth electoral maps; **D3-geo** for
  custom cartograms.
- **Dashboard / data-app frameworks:** **Observable Framework** and **Evidence.dev** (SQL→dashboards —
  interesting given direct Echo-DB access) for static/BI surfaces; **Streamlit / Gradio** (Python, pairs
  with the sidecar) for fast internal model views — less custom/rich, good for prototyping a model before
  we build the polished renderer surface.
- **Graph:** reuse the existing **`force-graph`** for the causal/driver graph (which signals feed which
  question) — no new dependency.

---

## 4. Data assessment — is what we ingest enough?

**For the world-model / situational layer: YES.** The 244-feed + video + newsletter lane, compacted into
corroborated Echo `event` objects, is a strong, arguably best-in-class narrative world-model already.

**For quantitative forecasting: NO — but the gap is narrow, structured, and mostly free.**

What's missing, in priority order:

1. **Prediction-market feed** *(highest value / lowest effort)* — Polymarket + Kalshi + Manifold +
   Metaculus. Free/cheap APIs, tiny volume, gives an instant market-implied baseline to blend against and
   to calibrate our own model. **Days of work, not weeks.**
2. **Polling — reframed: the aggregate mostly EXISTS; the job is *widen it + model it*, not source it
   from zero.** (Lucas's steer: "aggregate as much as we can" + "we already have polling data/sources.")
   Echo's `electoral` DB already aggregates **538 (272 fieldings, 30+ vendors) + Rainey (21) + Pew (68
   refs)** with a full fielding schema and a Side Quest atlas UI (§1). So the polling work is:
   - **(a) Widen the aggregate — one fielding model, many inflows.** Add **VoteHub** (RESTful real-time
     approval + generic ballot + polling averages + results; confirm free/key/limits at build — JS-rendered,
     403s a plain fetch), **RealClearPolitics**, **Silver Bulletin / Wikipedia** aggregations, and more
     pollsters — all normalized into the *same* fielding model via the `refresh_external_polling` pattern.
   - **(b) Fill the metadata gaps that weighting needs** — `frame` (population LV/RV/A) is null on 273/293
     rows, and there's **no pollster-rating / house-effect model** yet. Both are prerequisites for a
     credible weighted average.
   - **(c) Check coverage + freshness** — themes skew issue/approval/demographic ("identity/demographics"
     86, "democracy/elections" 33); confirm **head-to-head ballot + generic-ballot + approval trendlines**
     exist at forecast cadence, and that the 538 feed is still live/current (data reaches 2026-05; the 538
     brand was wound down — verify the ingest source). This is exactly where VoteHub/RCP fill in.
   - **(d) Build the aggregation *model*** — the atlas is a read-only browser, not a model: add the
     quality-weighted, recency-decayed, house-effect-corrected trendline (the §2.B.1 poll-average) on top
     of the existing store.

   **⚠️ COVERAGE + FRESHNESS CHECK — live findings (2026-07-03, direct `db_query` on Echo `electoral`):**
   - **The 538 slice is 2025 issue/approval tracking, NOT election horse-race.** All **272** 538 fieldings
     are dated **2025**; their **272 questions** break down to **0 horse-race matchups, 0 generic-ballot,
     11 approval, 261 issue/policy** (sample wordings: "Pardoning Jan-6 convicts," "Tax employer health
     benefits" — 538's *Trump-policy tracker*, one item per fielding). So the head-to-head / generic-ballot
     signal an election model needs is **essentially absent today** — widening (VoteHub/RCP) is **required,
     not optional.**
   - **The aggregate is stale.** Newest fielding overall = **2026-05-15 (49 days old)**; **0 in the last
     30 days**; the only 2026 entries are the 21 internal **Rainey** surveys — the 538 feed has **nothing
     from 2026** (upstream 538 was wound down; the public repo appears frozen). Confirms the feed is not
     currently updating and the source itself may be defunct.
   - **Net:** Suite A's real gap isn't metadata polish — it's **content type** (no horse-race) and **live
     sourcing** (538 is dead). A3 (widen to live horse-race/generic-ballot sources) is the load-bearing
     work; the existing 538 issue-tracker is useful for *issue salience*, not vote-share modeling.
   - **➡️ Replacement sources fully mapped in [`docs/POLLING_SOURCE_MAP.md`](POLLING_SOURCE_MAP.md)**
     (research, 2026-07-03). Headline: **no single 538 replacement**, but two FREE verified backbones —
     **Wikipedia "Opinion polling on the second Trump presidency"** (hundreds of scrapable polls: approval/
     favorability/generic-ballot/horse-race, by-state/issue/race) + the **538 legacy repo** (CC-BY 4.0,
     historical + pollster ratings) — plus **VoteHub** REST (real-time approval + generic ballot). Category
     map (approval / up-downs / race estimates / ratings / pollster-ratings / historical), access terms,
     and **where each lands** (raw → Suite A `poll_fielding`+ a new race-ratings table; averages/forecasts →
     Suite B) are all in that doc.
3. **GDELT ingestion** *(high value / low effort — already wired)* — turn the existing Echo GDELT tools
   into a tracked time-series lane. Nearly free; unlocks instability/sentiment nowcasting.
4. **Fundamentals featurization** *(moderate)* — pull the economic series already reachable via Echo
   (`econdb`/`wb_indicator`/`treasury`) into a tracked feature set with the right lags/transforms.
5. **Historical-results / outcomes DB** *(foundational, moderate — partly already in Echo)* — past
   elections + resolved-question outcomes, so we can compute base rates, build reference classes, and
   **backtest**. Without this we can't prove calibration. **First step is `get_db_map` on Echo** — its DB
   likely already holds a slice of the history (entities/events/filings/polls); ingest gaps rather than
   duplicating what's there.
6. **FEC time series** *(lower priority)* — campaign-finance trends as an enthusiasm proxy.

**"How much more" — the honest answer, revised after the live inventory:** *less than it first looked.*
Of the six needs, **polls and a big slice of the historical substrate are already in Echo** (the
`electoral` fielding model + civic/caselaw/wiki DBs). The genuinely-new inflows are **prediction markets**
and **GDELT ingestion** (both near-free), plus **fundamentals featurization** and **widening the poll
aggregate** (VoteHub/RCP into the existing model). Forecasting signal is small (a poll is a row, a market
is a number), so this is a **structure-and-modeling problem, not a data-volume problem** — the hard part
(taming the news firehose, aggregating polls) is largely done. What's missing is the **model layer** on
top and a few thin, high-value feeds.

---

## 4a. The news stream as a forecasting feed (not just situational awareness)

The data-stream lane already produces exactly the shape forecasting wants: **corroborated, entity-linked,
time-stamped `event` objects** + categorization + tone. Concretely, it feeds Suite B four ways:

1. **Shock / discontinuity signal.** A corroborated breaking event (indictment, debate, jobs report,
   scandal, withdrawal) is precisely the kind of discontinuity a forecast should react to. The lane's
   `min(outlet, report)` corroboration is a ready-made *significance* gate — only well-corroborated events
   perturb a forecast, so noise doesn't. This is the news-driven update the fundamentals/polls miss between
   poll releases.
2. **Narrative-momentum feature.** News category volume + **per-entity sentiment** over a race's entities
   → a momentum covariate the ensemble can weight (a leading indicator ahead of polls moving). Two tone
   sources compose: **GDELT** gives structured *document-level* tone at scale (already wired); an
   **entity/aspect-level** sentiment pass on our own news-lane text (Python-sidecar libs — `sentiment.ai`
   for calibrated on-device scoring; see §3) localizes it to *this candidate* rather than the article.
   **Outlet-lean-controlled** (reuse the lane's outlet tracking + a slant classifier à la SentiLog) so a
   partisan outlet's tone isn't misread as real movement, and **calibration-validated** before it earns
   weight — sentiment is powerful but noisy (§3 discipline).
3. **Entity routing.** The KG already links events → candidates/orgs/places, so news signal attaches to
   the **right Question/race** automatically (an event `—involves→ candidate` edge routes it).
4. **Event-annotated forecast viz — the marquee visual.** Overlay the forecast trendline with the
   corroborated news events that moved it ("why did the line jump here?"), the 538/Economist event-marker
   pattern but sourced from *our* live lane. This ties **news + viz + forecast** into one surface and is a
   standout feature for a suite "wholly dedicated to visual representation."

Discipline (inherited from the lane): the news feed **informs forecasts as signal**; it never auto-writes
identity/model parameters — the model decides how much to weight it, and every annotation is
source-attributed (no confabulated "why").

## 5. The architectural insight to carry into the session

We should build the suite as **additive lanes + a model layer on the *same* object memory**, mirroring
exactly how the news lane was built (isolated bucket → tiered compaction → Echo objects). Concretely:

- **News lane → situational world-model** — *have it.*
- **NEW structured-signal lanes** (polls / markets / GDELT / fundamentals) → **time-series objects**,
  isolated bucket, same discipline (dedup, corroboration, budget-capped cognition).
- **NEW `Question`/`Prediction` object type** — resolvable statement + criteria + probability series +
  score, linked by edges to the signals that drive it and the KG entities it concerns.
- **NEW model/aggregation layer** — poll average → fundamentals prior → Bayesian blend → Monte Carlo → +
  market/crowd ensemble.
- **NEW calibration/track-record** — Brier/log scoring over resolved questions (the trust substrate).
- **Workspace UI = the prediction builder** — question notebook + signal attach + model run + probability
  timeline + resolution/score.

This reuses the corroboration primitive, the object memory, the tiered-compaction pattern, the tuner/rank
selectors, and the proposal-gated Echo writes — all already built and proven.

**Suite-wide invariant — pluggable source adapters (Lucas, 2026-07-03): "everything, with the option of
adding more later (like the paid ones)."** Every external inflow — poll sources, prediction markets,
GDELT/fundamentals, *and* external forecast references (Silver Bulletin, Economist model, market-implied) —
is a **registered adapter behind one thin contract** (`{name, tier:'free'|'paid', license, enabled(),
fetch(), normalize()}`), tagged with its **tier + license end-to-end**. Build the free adapters now; a paid
source later is *register one adapter, flip a key* — never a schema/pipeline change. The ensemble can then
run "free-only" or "with paid," and never surfaces paid content without the entitlement. (Full spec:
[`docs/POLLING_SOURCE_MAP.md`](POLLING_SOURCE_MAP.md) §4a; idiomatic — mirrors the news lane's
"register one more source" and `lib/poll.js`'s router.)

---

## 6. Decisions

**LOCKED (Lucas, 2026-07-03):**
1. **Scope of v1 → general resolvable-question framework, elections first.** Build the reusable
   `Question`/`Prediction` object; elections are the first vertical.
2. **Model philosophy → BOTH in parallel.** Stand up the **aggregate-and-blend ensemble** (polls +
   markets + crowd) *and* begin the **bespoke Bayesian model** (Economist/Stan-grade) together. The
   ensemble is the fast path to a live, calibrated forecast; the bespoke model is the rigor. They also
   cross-check each other.
3. **Compute → add a Python sidecar.** Enables Stan/PyMC, the Economist `us-potus-model` path, and heavier
   correlated Monte Carlo. Node/Electron stays the app + orchestration; Python owns the inference.

**STILL OPEN (for the session):**
4. **Data priorities / sequencing** — recommend prediction markets → GDELT → **polls (now sourced:
   VoteHub API)**, fundamentals + historical-results DB in parallel since the bespoke model + backtesting
   need them early (and Echo's DB may already hold a chunk of the history — `get_db_map` first).
5. **Prediction-builder UX** — *visual richness is a lead priority (Lucas).* Candidates for the v1 spine:
   **Metaculus** question-notebook (probability timeline + track record) vs. **538** dashboard (fan charts
   + electoral map) vs. **Squiggle** composable estimates. Recommend a Metaculus-style spine for the
   *question/track-record* frame, with 538-style fan-chart + map viz as the signature visuals, built on
   ECharts/Plotly.js + D3 (§3). Get the uncertainty visualization right — it's the trust surface.
6. **Calibration from day one** — recommend committing to Brier/log scoring + a historical-results DB up
   front (can't be retrofitted onto past forecasts; it's the trust substrate).
7. **Autonomy posture** — does the suite autonomously stand up/update forecasts for salient events the news
   lane surfaces, or build on request only? (Ties to lane-isolation / no-drift rules.)

## 7. What the locked choices imply for the build

- **A Python sidecar becomes core infrastructure** — a decision to make early: how it runs alongside
  Electron (spawned child process + local RPC/HTTP, à la the existing Echo engine bridge), how it's
  packaged, and how smokes exercise it offline. Stan/PyMC live here; Node orchestrates + owns the objects.
- **"Both in parallel" means two producers into one `Prediction` object** — the ensemble and the bespoke
  model each emit a probability series onto the *same* question, so the object schema must hold **multiple
  model outputs + a blend**, and the calibration layer scores each producer separately. Design the
  Question object for N models from the start.
- **Elections-first inside a general frame** — the `Question` type is general; the **election vertical**
  adds the electoral-college/seat simulation, the poll/fundamentals features, and the map UX on top. Keep
  election-specific logic in a vertical module, not baked into the core object.
- **Backtesting is now on the critical path** — the bespoke Bayesian model needs the **historical-results
  DB** to validate against, so §4 item 5 (historical outcomes) is promoted from "foundational, later" to
  **early**, alongside the fundamentals featurization.
- **Reuse, don't rebuild** — the structured-signal lanes copy the news-lane discipline (isolated bucket,
  tiered compaction, corroboration, proposal-gated Echo writes, budget caps). The model layer + Python
  sidecar + prediction-builder UI are the genuinely net-new surfaces.

**Suggested first slices (for the session to confirm) — organized by suite:**

*Suite A — Polling (extend the existing space):*
- **A1** — two channels (Rainey vs. everyone-else) over the existing fielding model + atlas UI.
- **A2** — auto-update (scheduled `refresh_external_polling` + keep-current), so the aggregate self-maintains.
- **A3** — widen inflows: VoteHub / RCP / more pollsters normalized into the *same* fielding model; fill
  the `frame`/population + pollster-rating/house-effect metadata gaps.
  *(the weighted poll-average is NOT here — §0 Option 2 puts it in Suite B.)*

*Suite B — Forecasting (new, visual):*
- **B0** — Python-sidecar spine + one trivial round-trip smoke (core infra, §6.3/§7).
- **B1** — `Question`/`Prediction` object type (holds N model outputs + a blend) + calibration scaffold.
- **B2** — prediction-market lane (fastest genuinely-new signal).
- **B3** — GDELT time-series lane (already wired via Echo).
- **B4** — **read-interfaces onto the producers:** Suite A's polls (+ the weighted-average model, §2.B.1)
  **and the news/data-stream lane** (§4a: shock signal, tone/momentum feature, entity routing); +
  fundamentals featurization + map Echo's electoral/civic/caselaw DBs for the historical/base-rate
  substrate (ingest gaps only).
- **B5 / B6** — ensemble blend and bespoke Bayesian model (Economist port), in parallel per §6.2.
- **B-viz** — the rich multi-forecast interface: fan charts, electoral map, probability timeline, uncertainty
  viz (§3), **+ event-annotated trendlines from the news lane** (§4a.4). *Distinct from Suite A's atlas* —
  this visualizes forecast RUNS, not raw fieldings.

---

*Prepared 2026-07-03. Companion to `docs/DATA_STREAM_LANE_DESIGN.md` and memory `data-stream-lane`.
Status: brainstorm pre-reading — no build, no locked decisions.*
