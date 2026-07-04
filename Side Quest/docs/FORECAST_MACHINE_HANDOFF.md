# Forecasting Machine — Build Handoff / Status Log

> **Durable state capture, refreshed 2026-07-03 for a context compact.** The forecasting suite = a downstream
> R&D workspace for **world modeling / social forecasting / election prediction**. First target: **2026
> midterms — balance of the House & Senate.** The machine is BUILT, LIVE end-to-end, and **VALIDATED** against
> 48 years of real outcomes. Companion memory: `forecast-suite.md`. Related docs listed in §9.

---

## 1. What it is
A **live, correlated, scenario-generating, self-scoring forecast machine**. It reads structured signals (polls,
FEC, econ fundamentals, news) → per-seat models over the **full 435 House + 100 Senate universe** → a
**correlated Monte-Carlo simulator** rolling seats up into chamber control + joint government scenarios →
reacts to breaking news → and **scores its own trustworthiness** via a calibration harness. Downstream-only:
consumes Echo / news lane / API feed read-only, derives locally, produces forecast/analysis objects.

## 2. The LIVE pipeline (one call: `forecast_loop.runOnce`, main.js 30-min cadence)
```
forecast_registry (VoteHub /subjects → race slate; year+chamber+primary filtered)
  → poll_average (per-race SIGNED margin; candidate_party FEC-signs it; prior fallback)
  → COVERAGE (coverage.js: expand to ALL 435 House + 35 up-Senate seats; 538 lean + incumbency priors;
              polled seats override; not-up Senate → holdover counts) [replaces holdover lumps]
  → FUNDAMENTALS (econ_feed ← api_stream getSnapshot → forecast_fundamentals: national econ lean, uniform)
  → MIDTERM (uniform swing toward out-party; president=Rep 2026 → toward D; tunable prior 2.0)
  → forecast_reactor (news → per-race margin/σ; gpt-oss assess GATED to competitive |margin|≤8 races)
        ← news_feed.events/momentum  +  forecast_assess (gpt-oss:120b direction)
  → forecast_sim (correlated Monte-Carlo → chamber control + seat p10/p90 + govt scenarios)
  → forecast_service.buildBalancePayload → studio (forecast:balance IPC, cached in lastForecast)
```
Parallel: the **Python sidecar** runs heavy models (see §5); the **calibration harness** scores the chain (§6).

## 3. BUILT + tested inventory (all pure + injected I/O + offline smoke unless noted)
**Signal adapters:** `poll_wikipedia` (38), `poll_votehub` (27; live REST), `poll_538legacy` (20; ratings +
raw_polls backtest data).
**Models / core:** `poll_average` (31), `forecast_sim` (correlated MC; 20), `forecast_reactor` (news→perturb;
assess-gated; 19), `forecast_registry` (slate + isPrimarySubject; 18), `forecast_assess` (gpt-oss:120b,
num_predict≥1500; 15), `forecast_fundamentals` (econ lean; 12).
**Bridges/contracts:** `news_feed` (news⇄forecast; events/momentum; 43), `econ_feed` (api_stream⇄forecast;
FRED level→YoY; 13).
**Party + universe:** `candidate_party` (name→party via FEC; 12), `seat_map` (Echo-native 2026 candidate
universe; 20; NOT wired), `coverage` (full seat universe + 538 lean priors + incumbency + SENATE_2026 class +
parseIncumbents; 20).
**Capstone:** `forecast_loop` (`runOnce` = the whole chain; `recompute` pure core; assess-gate + applyMidterm; 35).
**Processing/UI:** `forecast_service` (payload builders; 20), `renderer/forecast.{html,js}` (3-region studio:
poll rail · balance-of-power · Work inspector with Coverage/Fundamentals/News/Race-ledger/**Model-scores** sections).
**Trust layer:** `calibration` (Brier/logLoss/skill/reliability+ECE/RMSE/coverage/backtestPollAverage; 16),
`backtest` (full-chain LOEO on presidential history + tuneSigma; 10).
**Gate:** `npm test` = 125 offline smokes, ALL GREEN.

## 4. Data (data/elections/, gitignored; reproduced by `sidecar/fetch_data.py`)
- **538 partisan lean** (fivethirtyeight/data, CC-BY): per-district (435) + per-state (50+DC) — the coverage
  prior backbone. `538_partisan_lean_{districts,states}.csv`.
- **MEDSL presidential** (state 1976-2024, via keithpotz MIT repo): `complete_data.csv` + `2024president.csv` —
  the calibration/backtest ground truth + pres-lean.
- **congress-legislators** (unitedstates project, public domain): `legislators-current.json` — 537 current
  members → the incumbency term (House by district, Senate by class-2).
- Live feeds (not files): VoteHub (polls, no auth), FEC (party via api_stream.pull), api_stream (FRED econ),
  news lane (via news_feed).
- **⚠ DATA GAP:** congressional election RESULTS (past House/Senate margins) are NOT freely available — Harvard
  Dataverse MEDSL is guestbook-gated; FEC has no vote tallies (422); OpenElections is per-state/heavy. 538
  partisan lean is the accessible substitute (pre-blended presidential lean). Consequence: congressional-specific
  priors (midterm/incAdv/holdover) can't yet be BACKTESTED — only presidential mechanics are validated.

## 5. The Python sidecar (`sidecar/`, docs/FORECAST_SIDECAR_DESIGN.md)
Heavy compute layer — a concurrent **model POOL** (multiprocessing, cap cores-2; 24 cores here). Contract:
`orchestrator.py` reads a job (stdin) → runs registered models in parallel → ModelResult JSON (stdout).
- **`lib/sidecar.js`** = the JS⇄Python bridge (spawn, pipe job, parse; tries venv→launchers; fail-soft; 9 smoke).
- **venv**: `sidecar/.venv` (uv, Python 3.12; numpy/pandas/scikit-learn/xgboost/scipy; gitignored — recreate via
  `uv venv --python 3.12 .venv && uv pip install -r requirements.txt`).
- **Models**: `poll_baseline`/`uniform_swing` (stubs), `fundamentals` (REAL: 538 lean + incumbency, stdlib),
  `xgboost_quantile` (REAL: 3 quantile regressors, median+95%CI, trained on 612 pres state-years).
- **`selftest.py`** 13/13 (concurrency + contract + real-lean lookup).
- NOT wired into the live loop yet (the JS coverage prior is the live path; sidecar is for heavy/batch models).

## 6. VALIDATION — the machine scores itself (the big result)
**Full-chain backtest** (`lib/backtest.js`, LOEO on 612 real presidential state-elections 1976-2024):
- **Win Brier 0.115, skill +52.6% vs base rate; ECE 0.036 (WELL CALIBRATED — reliability tracks the diagonal:
  p~.50→.45, .71→.66, .92→.94); margin RMSE 10.4; 95% coverage 0.91@σ9, TUNED σ=10 → 0.946.**
- **Poll-aggregation backtest** (538 raw_polls, 20,466 polls/2,466 races): our weighting RMSE 7.89 beats naive
  mean 8.04 (+1.9%) and latest-poll 8.47 (+6.9%).
- **Model comparison** (same 612 elections): STRUCTURAL prior BEATS xgboost on every metric (RMSE 10.36 vs
  12.08, Brier 0.115 vs 0.138, ECE 0.039 vs 0.046, coverage 0.946 vs 0.882) → lean→margin is near-linear; the
  harness kept a fancier model from silently making it worse. Don't use xgboost for this mapping.
- Scores are surfaced in the studio ("Model scores · backtest" section + reliability curve) via the
  `forecast:calibration` IPC.

## 7. Design LAWS (do not relitigate)
1. Two engines: deterministic MATH (numbers never through an LLM) + gpt-oss:120b for JUDGMENT (structure, num_predict≥1500).
2. Downstream-only: read Echo/news/API; derive locally; produce forecast/analysis objects → 24h memory rail (emission still PENDING).
3. Registry = read-only ingest (races/candidates are Echo objects; never proposed).
4. **Calibration is the selection pressure** — nothing counts until scored; it already killed the xgboost mapping.
5. No fake precision: perturbation/midterm/incumbency magnitudes are TUNABLE PRIORS, capped, provisional, audited, calibration-gated.
6. Live-moment priority (Lucas): election nights/speeches → reactor low-latency mode off CC spikes.
7. Separate DBs until heavier testing (isolated stores; only curated products memorialized).
8. Every seat accounted for (full 435+100 universe), individually (per-seat prior/poll) AND as-a-whole (correlated sim).

## 8. PENDING / next (ordered by testability, Lucas's stated priority)
- **REBOOT PENDING**: the studio Model-scores panel (799089a) + the refinements (b11efd7: assess-gate/midterm/
  incumbency) + coverage (649a4d8) are committed but need the app restarted to be fully live. Post-reboot the
  `[forecast]` log shows `coverage 470 seats · midterm +2.0 · N/420 judged`.
- **Congressional outcome data** — the key unlock: a real source for past House/Senate margins (OpenElections
  aggregation is the realistic path) → lets the harness BACKTEST + tune midterm/incAdv/holdover (currently guesses).
- **Apply tuned σ** to the live sim (backtest says σ≈10 for presidential; congressional needs its own).
- **Exact Echo Senate holdover composition** (replace the {A:34,B:31} estimate; seat_map has the data).
- **Bayesian/Stan** sidecar model (Economist/Linzer, MIT-liftable) + SHAP explainability — each scored on arrival.
- **Forecast/analysis object emission** to the 24h memory rail (§7.2 — gate ON when trustworthy).
- Poll-quality pass (VoteHub senate margins skew D — hypothetical/favorability matchups).

## 9. Related docs
`MODEL_METHODOLOGY_RESEARCH.md` (3 real models deep-read: keithpotz XGBoost / TheEconomist Bayesian / 24cast
SHAP; both reference repos MIT) · `FORECAST_SIDECAR_DESIGN.md` (pool architecture) · `WORLD_MODEL_FORECAST_BRAINSTORM.md`
· `POLLING_SOURCE_MAP.md` · `RECURSIVE_FORECASTING_RESEARCH.md` · `GLEIPNIR_SALVAGE.md` · `API_STREAM_TIEIN_HANDOFF.md`.

## 10. Commit trail (this session, on `feature/idle-passive-intelligence`)
7fbbe44 suite+recompute-loop · 95f2ed9 econ fundamentals · 54194c9 FEC party+primary · 8bc6847 glass-box inspector ·
c3fd055 seat_map · 171be21 sidecar Phase-0 · 6327c0e data+fundamentals model · c36a4d1 sidecar bridge ·
252a836 venv+xgboost · 649a4d8 coverage · b11efd7 assess-gate+midterm+incumbency · ee9e799 calibration harness ·
46fffed full-chain backtest · 76b6d61 xgboost-vs-structural · 799089a studio model-scores panel.
