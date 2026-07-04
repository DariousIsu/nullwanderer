# Forecasting Python Sidecar — Design

> 2026-07-03 (Lucas: "100% the only way this has enough computational strength is with a sidecar. we'll need
> to be able to spin several models at the same time"). The sidecar is the **heavy compute layer** — a
> concurrent MODEL POOL that runs many forecasting models in parallel, feeding results back to the live JS
> machine. This is the "nexus of computational models" from the original vision. Env verified: Python 3.13/
> 3.12/3.11 + `uv`, **24 logical cores**.

---

## 1. The split (why a sidecar)
The pros run a **fast serving/reactive layer + a heavy model layer** (see docs/MODEL_METHODOLOGY_RESEARCH.md).
- **JS stays** the live layer: VoteHub/FEC/Echo/news ingestion, the correlated Monte-Carlo for fast what-ifs,
  the reactor, the 30-min cadence, the studio, memory-rail emission. Low-latency, always-on.
- **Python sidecar** is the deep layer: XGBoost fundamentals, dynamic-Bayesian (Stan), SHAP — models that need
  the scientific-Python ecosystem and real CPU. Runs offline/batched, **many models AT ONCE**, feeds results back.
The two meet at a file/JSON contract — the SAME downstream-only pattern `api_stream` uses to feed econ signals.

## 2. The core requirement — a concurrent MODEL POOL
"Spin several models at the same time" = a process pool where each model runs in its own process (models are
CPU-bound → processes, not threads; the GIL makes threads useless here). With 24 cores we can run a dozen+
models concurrently. The orchestrator fans the registered models out to the pool, collects their results, and
ensembles/compares them. Each model is INDEPENDENT and independently visualized (Lucas's "each model = a widget").

```
JS machine ──(job.json: shared inputs + model list)──▶ orchestrator.py
                                                          │  multiprocessing.Pool(N)
                                       ┌──────────────────┼──────────────────┐
                                    model A            model B            model C   … (each its own process)
                                       └──────────────────┼──────────────────┘
                                                     collect ModelResults
                                                     → ensemble (R²-weighted, later)
JS machine ◀──(results.json: per-model results + ensemble + diagnostics)──┘
```

## 3. Contracts (the stable interface)
**Job in** (`job.json`): `{ inputs: {...shared forecast bundle...}, models: ["poll_baseline","fundamentals",…], config: {...} }`
where `inputs` = the data the JS machine already assembles (slate, per-race polls, fundamentals env, historical
results once acquired). **Result out** (`results.json`): `{ ok, wall_ms, ran:[…], results:[ ModelResult ], ensemble }`.

**ModelResult** (every model emits this shape): `{ model, ok, seats:[{seat, margin, lo, hi}], chambers:{house:{pD_control,…}, senate:{…}}, diagnostics:{…}, attributions?:[…SHAP…], elapsed_ms }`.
One shape → the studio renders any model + the ensemble uniformly; the JS balance/sim can consume any model's seats.

**Model interface** (`models/base.py`): a class with `name` + `run(inputs, config) -> ModelResult`. Registered in
`registry.py`. Adding a model = drop a file + register it — nothing else changes (the "widget per model" story).

## 4. Transport + lifecycle (decisions)
- **v1 = spawn-per-run** (main.js spawns `python orchestrator.py` for a forecast batch, reads the results file).
  Simple, robust, crash-isolated, matches the cadence model; no long-running port. Heavy fits (Stan) run on a
  SLOW cadence (hourly/daily), not the 30-min live loop.
- **v2 = persistent FastAPI service** (models stay warm in memory) — the optimization for LIVE MOMENTS
  (election night) where cold-start matters. Same contract; graduate when latency demands it.
- **Env = `uv` venv pinned to Python 3.12** under `sidecar/.venv` (3.13 is too new for some Stan/xgboost wheels).
  A bootstrap (`sidecar/bootstrap`) creates it + installs pinned deps. main.js locates `.venv` python; if absent,
  the sidecar is simply skipped (JS machine degrades gracefully — no hard dependency).
- **Concurrency cap** = `min(len(models), cores-2)` so the pool never starves the app/Electron.

## 5. Integration with the live machine (downstream-only preserved)
- The JS loop assembles `inputs` (it already has slate+polls+fundamentals; adds historical results post-acquisition)
  → spawns the orchestrator on a slow cadence → caches the ModelResults + ensemble.
- The studio gains **per-model widgets** (each model's seats/CIs/attributions) + an ensemble/compare view — the
  glass box across models. The fast JS correlated-sim stays the live what-if layer.
- Trustworthy model outputs emit **forecast/analysis objects to the 24h memory rail** (same gate as everything else).
- The sidecar READS the data the JS machine provides; it never touches Echo/registry directly. No new write paths.

## 6. Model roster (what runs in the pool)
Each is MIT-liftable or already-specced (docs/MODEL_METHODOLOGY_RESEARCH.md):
- `poll_baseline` — weighted poll average → seats (parity check vs the JS poll_average).
- `fundamentals` — Lucas's prior: past-two-election margins + presidential lean + incumbency (→ later XGBoost).
- `xgboost_quantile` — keithpotz-style supervised ML, median + 2.5/97.5 quantiles (95% CI). Needs historical data.
- `bayesian_dynamic` — Economist/Linzer Stan model: fundamentals prior + poll updating + state correlation +
  nonresponse/mode/population corrections. The capstone.
- `shap_explainer` — SHAP attributions over the ML model → the principled per-variable glass box.
- (room for more — the pool scales to the core count.)

## 7. Build phases
0. **Skeleton (stdlib only) — DE-RISK NOW:** orchestrator + model interface + registry + stub models; prove the
   pool runs several models CONCURRENTLY and that Node can spawn it + read results. No heavy deps.
1. **Env bootstrap:** `uv` venv (3.12) + pinned `requirements.txt` (numpy/pandas/scikit-learn/xgboost/shap; cmdstanpy later).
2. **Data acquisition** (shared with Phase-2 coverage): MIT Election Lab historical results + DK pres-by-CD + FRED UMCSENT.
3. **First real model:** `fundamentals` (the coverage prior) → then `xgboost_quantile`.
4. **Wire into main.js** (slow cadence) + per-model studio widgets. Reboot-gated.
5. **SHAP + Bayesian** capstones. **Calibration harness** scores every model (Brier/RMSE) — the selection pressure.
