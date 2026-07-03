# Gleipnir Salvage — what to port from the failed prototype

> **Source:** `C:\Users\azrae\Desktop\gleipnir-backend` — a defunct Python **economic/market** forecasting
> system (never worked end-to-end). Mined 2026-07-03 for reusable tools/models/formulas for our election-
> forecasting suite. This is a **harvest list**, not a build — port these when we reach the relevant slice.
>
> **Headline caveat (important):** gleipnir's `config.json` advertises a 100-trial ensemble optimizer,
> ARIMA/LSTM/transformer models, Bayesian updating, and Monte Carlo — **none of it is implemented in code**
> (confirmed tree-wide). It's an aspirational config over a thin sklearn core. So we harvest the few *real*
> formulas + the data-source tooling and **build the sophisticated parts fresh** (as already planned).

---

## Tier 1 — port these (real, clean, directly useful)

### A. Data-source tools → the FUNDAMENTALS lane (Python sidecar)
Best implementation: an `APIClient` base (`economic_dashboard.py:34-65`) — in-memory cache + 1s/endpoint
rate-limit; every source normalized to `{value, date, series_id, source}`. Lift the base + subclasses into
the sidecar, swap hardcoded keys → `os.environ`, **add retry/backoff (it has none)**.

| Source | Endpoint | Auth (env) | Series / data | Priority |
|---|---|---|---|---|
| **FRED** ⭐ | `api.stlouisfed.org/fred/series/observations` | `api_key` = `FRED_API_KEY` | GDP, UNRATE, CPIAUCSL, FEDFUNDS, PAYEMS, GS10/GS2, INDPRO, UMCSENT, HOUST, RSAFS | highest |
| **BLS** | `api.bls.gov/publicAPI/v2/timeseries/data/` | `registrationkey` in body = `BLS_API_KEY` | LNS14000000 (unemp), CES0000000001 (nonfarm), LNS12300000 (participation), LNS13008397 (emp-pop) | high |
| **Census** | `api.census.gov/{year}/{dataset}` | `key` = `CENSUS_API_KEY` | ACS5 B01003_001E (pop), B25077_001E (home value), B19013_001E (median income); **`for=state:*` geo-sliceable** | high (district-level) |
| **BEA** | `apps.bea.gov/api/data` | `UserID` = `BEA_API_KEY` | NIPA GDP (A191RC) / personal income (A065RC) — FRED cross-check | medium |
| Polygon | `api.polygon.io/v2/aggs/.../prev` | key (hardcoded → move to env) | SPY/QQQ/DIA/IWM market indices | low (elections) |
| NewsAPI | `newsapi.org/v2/everything` | key (hardcoded) | — we already have news adapters | skip |

- **Also copy:** the `ECONOMIC_INDICATORS` registry schema (`real_api_manager.py:259-337`) — `series →
  {SeriesID, Source, Category, Frequency, Description}` — to drive the fundamentals lane declaratively.
- **Reusable formula:** CPIAUCSL **YoY inflation** = current vs value 12 rows back (`real_api_manager.py:65-77`).
- Fits the [[pluggable adapter]] pattern: each of these = one `tier:'free'` fundamentals adapter (all free, key-gated).

### B. R²-weighted ensemble blend + floor → our ENSEMBLE model ⭐
`enhanced_ai_system.py:805-812`:
```python
weights = {name: max(0.1, scores['r2']) for name, scores in model_scores.items()}
norm = {n: w/sum(weights.values()) for n, w in weights.items()}
ensemble_pred = Σ norm[n] * pred[n]
```
**Skill-weighted average with a floor.** For us: weight = each source's (poll-avg / market / fundamentals /
Bayesian) **track-record accuracy or inverse-error**, `max(0.1, …)` so a bad backtest window can't zero a
source, normalize to 1, blend. This is the concrete recipe for the ensemble-blend model (brief §2.B.5).

### C. Horizon-widening uncertainty band → FAN CHARTS ⭐
`ai_economic_forecasting_system.py:317-320`:
```python
uncertainty = base * (1 + i * 0.1)        # i = steps ahead → band widens with horizon
lower, upper = value - 1.96*uncertainty, value + 1.96*uncertainty
```
Exactly the fan-chart requirement (uncertainty grows with forecast distance). Copy the `(1 + i·step)`
widening; drive `base` off **ensemble disagreement / backtest RMSE**, not a flat %. (A simpler RMSE Gaussian
band lives at `enhanced_ai_system.py:847`.) This gives the UI's uncertainty-viz its first real bands.

### D. Versioned model storage → the multi-model `Prediction` object skeleton
`fix_model_storage.py`: `models/{id}/{id}_v{semver}.pkl` + a dict `{metadata{name,version,created,params},
performance_metrics}` + a scanned `model_registry.json`. Copy the **layout** (per-model dir, semver in
filename, sidecar `_info.json`, central registry) for how the `Prediction` object holds N model outputs +
their track records. Ignore its dummy-weight fabrication (a repair stub).

### E. Small formulas worth lifting
- **Z-score shock detection** (`comprehensive_economic_ai_v5.py:1262`): `z=abs((v−mean)/std)`, flag `z>2.5`,
  `severity=min(1, z/5)` → **poll-movement surprise / outlier detection** (a poll that jumps abnormally).
- **Exponential decay kernel** (`v5.py:1037`): `exp(-i/(duration·0.3))` → event-impact / recency decay.
- **Rolling z-normalization** (`v5.py:1077`): `(v − rollmean(252)) / rollstd(252)`.
- **Weighted composite index** (`v5.py:1204`): normalize each indicator to 0–100, `Σ(score·weight)` → label.

---

## Tier 2 — do NOT chase (config shells / dead ends)
`ensemble_optimization` (100 trials), ARIMA/LSTM/transformer, Bayesian, Monte Carlo, walk-forward, Brier,
calibration curves — **advertised in config, zero implementation.** Build these fresh (Stan/PyMC/Prophet in
the sidecar per the locked plan). The heavy torch/tensorflow trees are vendored dead weight.

## The meta-lesson (why gleipnir failed — our anti-pattern checklist)
It died from: **config-advertised sophistication with no implementation**, a dozen near-duplicate files
(`*_dashboard_*`, `enhanced_ai_*`, `ultimate_ai_*`, `gleipnir_*`), heavy deps (torch/TF) with no working
spine, and an empty `cache/` (the persistence it configured was never built). Our discipline — pure tested
libs, real-data proof each slice, no dep we don't use — is the direct antidote. Keep it.

---

*Prepared 2026-07-03 from two focused mining passes. Companion to `docs/WORLD_MODEL_FORECAST_BRAINSTORM.md`
(§2 model layer, §4 fundamentals) + `docs/POLLING_SOURCE_MAP.md`.*
