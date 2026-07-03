# Forecasting Machine — Build Handoff / Status Log

> **Durable state capture (2026-07-03) ahead of a context compact.** The forecasting suite = a downstream
> R&D workspace for **world modeling / social forecasting / election prediction**. First target: **2026
> midterms — balance of the House & Senate.** Everything below is BUILT + smoke-tested + (mostly) live-proven
> unless marked PENDING. Companion memory: `forecast-suite.md`. Related docs listed in §7.

---

## 1. What it is (one paragraph)
A **live, correlated, scenario-generating forecast machine**: read structured signals (polls, fundamentals,
news) → per-race models → a **correlated Monte-Carlo simulator** that rolls races up into **who controls each
chamber** + joint government scenarios → react to breaking news on the fly. It is **downstream**: it CONSUMES
Echo objects + the news lane + the API feed (read-only), DERIVES forecasts in its own store, and PRODUCES
forecast/analysis objects onto the short-term→long-term memory rail. It is **pure R&D** — real validation is
months out, so confidence comes from **backtests + calibration**, not from launch.

## 2. Pipeline (how the pieces connect)
```
forecast_registry (race slate: VoteHub /subjects + Echo enrich, read-only)
   → poll_average (per-race SIGNED margin)   [WIRED via forecast_loop.computeMargins; prior fallback]
   → forecast_reactor (news → margin/σ perturbation)
        ← news_feed.events/momentum (news signals)  +  forecast_assess (gpt-oss judges direction)
   → forecast_sim (correlated Monte-Carlo → chamber control + seat dist + govt scenarios)
   → forecast_service.buildBalancePayload → the UI (studio) + (PENDING) forecast/analysis objects → 24h rail
```
★ **forecast_loop.js is the single call that runs this whole chain** (`runOnce`), fired on main.js's 30-min
cadence (first run ~2m after boot) and cached in `lastForecast`; the `forecast:balance` IPC serves it and
re-sims the same live slate on a seed override (the studio's "Re-run sim" jitter, now on REAL margins).

## 3. BUILT + tested (status)
**Signal adapters (Suite A, read-only sources):**
- `poll_wikipedia.js` — Wikipedia poll-table parser (38 smoke; 332 real polls live). Free backbone.
- `poll_votehub.js` — VoteHub REST API (approval/favorability/generic-ballot/races), no auth (27 smoke; 2,931+ live).
- `poll_538legacy.js` — 538 CC-BY repo: pollster ratings (`bias_ppm` house-effect) + `raw_polls` (backtest) (20 smoke; 540 ratings + 20,466 historical live).

**Models (Suite B):**
- `poll_average.js` — quality/recency/house-effect weighted average + trend + modal-choice-set (31 smoke; live Trump approval 39.8/57.2).
- `forecast_sim.js` — ★ correlated Monte-Carlo scenario simulator (chamber control, seat p10/p90, govt scenarios); own PRNG + Φ/inverse (20 smoke; correlation-fattens-tails proven).
- `forecast_reactor.js` — news → race perturbation: VOLATILITY (σ↑, direction-free, immediate/live-mode) vs MARGIN SHIFT (needs gpt-oss attribution); provisional+audited+capped+decayed (19 smoke; demo P(win) 43→50 on breaking news).
- `forecast_registry.js` — read-only race slate from VoteHub /subjects → sim-ready skeletons; Echo enrich hook (18 smoke; 113 live races).
- `forecast_assess.js` — gpt-oss:120b direction judgment (num_predict≥1500 floor); async assessBatch→sync lookup for the reactor (15 smoke; live "union endorses D"→favors A/medium/0.85).

**Bridges (read-only contracts, "never reach past"):**
- `news_feed.js` — the news⇄forecast contract: `events`(corroborated), `momentum`(raw incl. CC volume), `raw`/`layers`/`digest`/`today` (36 smoke; live 151 stories + Trump 138 mentions/89 CC).
- `api_stream` (other context) — fundamentals: `getSnapshot(id)` + `pull()`. 6 datasets seeded live (FRED/Census). Contract: `docs/API_STREAM_TIEIN_HANDOFF.md`.

**The recompute loop (Suite B capstone) — ★ BUILT + wired:**
- `forecast_loop.js` — the whole chain in one call. PURE core `recompute(races, signals, opts)` (react→sim→
  payload, inject now/assessLookup) + LIVE `runOnce(opts)` (slate→signed margins→news→gpt-oss pre-assess→
  react→sim→payload). Signs margins via injected `partyOf` (Echo/FEC map or a label heuristic); un-polled/
  un-attributable races fall back to a neutral PRIOR with wide σ and the run flags `illustrative`. Helpers:
  `computeMargins`, `signMargin`, `buildAssessPairs`, `preAssess`, `slateEntities` (24 smoke, all green).
- **main.js wiring (REBOOT-GATED, uncommitted):** a `FORECAST_LOOP_MS` (30m) cadence block runs `runOnce`
  with live feeds (VoteHub subjects+polls bulk-fetched per poll-type, 538 ratings cached, cloud_logic.ask),
  caches `lastForecast`; the `forecast:balance` IPC serves it + re-sims on a seed override; timers cleared on
  shutdown. Downstream-only — reads connectors/news/cloud, writes nothing.

**Processing + UI:**
- `forecast_service.js` — main-process orchestration: `pollAverageWidget`, `balanceWidget` (illustrative slate — now the pre-first-run fallback), `buildBalancePayload`, `listWidgets` (20 smoke).
- `renderer/forecast.html` + `forecast.js` — **the Forecasting STUDIO** (in My Workspace → Studios): 3-region glass-box — LEFT compact poll rail · CENTER Balance-of-Power (House/Senate meters + majority line + uncertainty band + scenarios) · RIGHT **Work inspector** (variable inputs + live simulator reads + "Re-run sim" seed-jitter). LIVE (screenshot-confirmed reboot). Wired: `forecast:balance`/`poll-average`/`widgets` IPC + `sq.forecast.*`.
- Gate: all forecasting smokes registered in `scripts/run_smokes.js` (10+ entries), green.

## 4. Design LAWS (do not relitigate)
1. **Two engines:** deterministic MATH (forecast numbers never through an LLM; Python sidecar Stan/PyMC later) + gpt-oss:120b for JUDGMENT (structure not numbers; num_predict≥1500).
2. **Downstream-only:** consume Echo/news/API read-only; derive locally; PRODUCE forecast/analysis objects onto the short-term→long-term (24h) memory rail (doc_store.land → promoteDocumentsPass → Echo), same as news evidence docs. NEVER rewrite the registry entities.
3. **Registry = read-only ingest:** races/candidates are Echo objects (race≈event, candidate=person…); forecasting reads/enriches, never proposes. Whitelist caveat MOOT for us.
4. **Calibration is the selection pressure AND guardrail** — no model/perturbation counts until scored (Brier/log/CRPS on 2014–2024). Self-generation without backtest = how gleipnir died.
5. **No fake precision:** perturbation magnitudes are TUNABLE PRIORS, flagged provisional, capped, decayed, audited.
6. **Live-moment priority (Lucas):** highest value = election nights / breaking speeches / press conferences → the reactor's low-latency LIVE MODE off the raw CC stream (react provisionally fast, firm-up on corroboration). `momentum.video_mentions` spike = the detector.
7. **Separate DBs until heavier testing:** volatile working state = forecasting's own store; only curated products memorialized.
8. **Model families for "band of many concepts":** open TS foundation models (Chronos/TimesFM/AutoGluon, all Apache-2.0) = zero-shot generalist; hierarchical reconciliation (Nixtla `hierarchicalforecast`) = parts↔whole coherence.

## 5. PENDING (next builds)
- **✅ DONE — the recompute loop + main.js wiring** (`forecast_loop.js` + the cadence block). Awaiting a REBOOT to go live (main.js changed). Live-mode fast-tick off `detectLive` is a follow-on (the loop already reports `live`/`live_entities`; a shorter interval when live is the next refinement).
- **Party attribution (`partyOf`):** the loop signs margins only when the leader's party is known. The default is a label heuristic — VoteHub race choices are candidate NAMES, so most sign as `prior` today. Wire a candidate→party map (Echo enrichment / FEC) into `runOnce({ partyOf })` to turn priors into real signed margins. **This is what makes the balance real vs illustrative.**
- **Calibration/backtest harness:** score the chain vs 2014–2024 (`poll_538legacy.raw_polls` = poll-vs-actual). Build BEFORE trusting live output.
- **Real seat totals / holdovers:** the sim config's holdovers are 2026 priors; refine from the actual class-of-2026 seat map (which seats are up vs safe).
- **Forecast/analysis object emission** to the 24h memory rail (§4.2 shapes) — gate ON when forecasts are trustworthy.
- **Python sidecar (B0):** for the bespoke Bayesian model + foundation models + Monte Carlo at scale; harvest gleipnir's FRED/BLS/Census `APIClient` + R²-weighted ensemble + horizon-widening fan-chart formula (`docs/GLEIPNIR_SALVAGE.md`).
- **UI tweaks batched (next reboot):** scenario-label wrap FIXED (uncommitted); optional: topbar right-padding, datatable scroll affordance.

## 6. Gotchas / caveats
- Balance margins are **synthetic/illustrative** (labeled) until the recompute loop wires real ones.
- Real-time **market data deferred** (polygon 401 / fmp 403 dead keys) — market-dependent models degrade gracefully.
- `news_feed.digest()` returns 0 until the nightly daily pass writes a `news_days` row (works, no data yet).
- Entity-routing in reactor/news_feed is **string-match**; upgrade path = graph traversal (races+news both Echo events).
- Older/RSS news stories have empty `entity_set` (only video-reconstruction populates entities).
- gpt-oss:120b MUST use num_predict≥1500 (else empty content — starves in `thinking`).
- **Nothing committed** — all forecasting work is working-tree changes in the shared repo (parallel contexts active).

## 7. Related docs
`WORLD_MODEL_FORECAST_BRAINSTORM.md` (vision/scope/decisions) · `POLLING_SOURCE_MAP.md` (538-replacement sources) ·
`RECURSIVE_FORECASTING_RESEARCH.md` (meta-forecaster + hierarchical) · `GLEIPNIR_SALVAGE.md` (port list) ·
`API_STREAM_TIEIN_HANDOFF.md` (fundamentals contract).

## 8. Next actions (ordered)
1. ✅ Recompute loop (`lib/forecast_loop.js`) + main.js cadence wiring + IPC — BUILT, gate green (24 smoke). **REBOOT** to run it live.
2. Post-reboot: watch the `[forecast] recompute:` log line (polled/total races, House/Senate P(D), timing) — confirm the machine runs against live VoteHub + news.
3. Party attribution (`partyOf` candidate→party map) — turns `prior` margins into real signed ones (illustrative → real).
4. Calibration/backtest harness (score vs history).
5. Forecast/analysis object emission to the 24h memory rail.
