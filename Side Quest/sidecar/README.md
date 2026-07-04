# Forecasting Python Sidecar

The **heavy compute layer** for the forecasting suite — a concurrent MODEL POOL that runs many forecasting
models in parallel and feeds results back to the live JS machine. Design: [../docs/FORECAST_SIDECAR_DESIGN.md](../docs/FORECAST_SIDECAR_DESIGN.md).
Why a sidecar + the model roster: [../docs/MODEL_METHODOLOGY_RESEARCH.md](../docs/MODEL_METHODOLOGY_RESEARCH.md).

## Status
**Phase 0 — skeleton (stdlib only, no deps).** The orchestrator + model interface + registry + 3 stub models +
self-test are live and proven: the pool runs models concurrently and Node (Electron) can spawn it and read
results. Real models (XGBoost fundamentals, Bayesian/Stan, SHAP) slot into this proven harness next.

## Run
```bash
python orchestrator.py --list                    # registered models
python orchestrator.py --job job.json --out out.json   # run the pool
python selftest.py                               # dependency-free self-test (exit 0 = pass)
```
The JS machine spawns `orchestrator.py` with a job on its cadence and reads the results (crash-isolated,
process-per-model). No long-running server in v1 (a persistent FastAPI service is the live-moment optimization).

## Contract
- **job.json** — `{ "inputs": {...shared bundle: races/polls/fundamentals/history...}, "models": [names]|null, "config": {...} }`
- **results** — `{ ok, wall_ms, pool, cores, ran, results:[ModelResult], ensemble }`
- **ModelResult** — `{ model, ok, seats:[{seat,chamber,margin,lo,hi}], chambers:{house,senate}, diagnostics, attributions?, elapsed_ms }`

## Add a model
1. Drop `models/<name>.py` with a `Model` subclass (`name` + `run(inputs, config) -> result(...)`).
2. Register it in `registry.py`.
That's it — the orchestrator, ensemble, and studio treat every model uniformly ("each model = a widget").

## Real models — env bootstrap (Phase 1+)
The stub skeleton needs nothing. For the real models, create the venv with `uv` on Python 3.12
(3.13 lacks some Stan/xgboost wheels):
```bash
uv venv --python 3.12 .venv
uv pip install -r requirements.txt
```
main.js locates `.venv` python; if absent, the sidecar is skipped and the JS machine degrades gracefully.

## Layout
```
sidecar/
├── orchestrator.py     # runs the model pool concurrently (multiprocessing); job in → results out
├── registry.py         # name → Model class
├── selftest.py         # stdlib self-test (concurrency + contract + ensemble)
├── requirements.txt    # deps for the REAL models (skeleton needs none)
└── models/
    ├── base.py             # Model interface + ModelResult helpers
    ├── poll_baseline.py    # stub — poll-margin passthrough
    ├── uniform_swing.py    # stub — base + national swing
    └── fundamentals.py*    # stub — pres_lean + incumbency (→ real prior: past-two elections + XGBoost)
```
