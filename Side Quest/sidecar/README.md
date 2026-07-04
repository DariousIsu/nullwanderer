# Forecasting Python Sidecar

The **heavy compute layer** for the forecasting suite — a concurrent MODEL POOL that runs many forecasting
models in parallel and feeds results back to the live JS machine. Design: [../docs/FORECAST_SIDECAR_DESIGN.md](../docs/FORECAST_SIDECAR_DESIGN.md).
Why a sidecar + the model roster: [../docs/MODEL_METHODOLOGY_RESEARCH.md](../docs/MODEL_METHODOLOGY_RESEARCH.md).

## Status
**Phase 0 skeleton + first REAL model (stdlib only, no heavy deps).** The orchestrator + model interface +
registry + self-test run the pool concurrently and Node (Electron) can spawn it and read results. The
`fundamentals` model is REAL — it reads 538 partisan-lean data (via `fetch_data.py`) → per-seat prior margins
for the whole seat universe (AZ Senate R-5, CA-22 D+8, NY-14 D+59). `poll_baseline`/`uniform_swing` remain
stubs. XGBoost/SHAP/Bayesian slot in next (they need the venv).

## Data
```bash
python fetch_data.py        # downloads reference datasets into ../data/elections/ (idempotent; --force to refresh)
```
Sources (free/unrestricted, no Harvard Dataverse guestbook): **538 partisan lean** (CC-BY, per-district +
per-state Cook-PVI-style lean — the coverage-prior backbone) + **MEDSL presidential** (MIT, state results
1976-2024, via keithpotz). `data/` is gitignored, so `fetch_data.py` is the reproducible source of record.

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
├── fetch_data.py       # downloads reference datasets → ../data/elections/ (stdlib)
├── selftest.py         # stdlib self-test (concurrency + contract + ensemble + real-lean lookup)
├── requirements.txt    # deps for the heavy models (skeleton + fundamentals need none)
└── models/
    ├── base.py             # Model interface + ModelResult helpers
    ├── poll_baseline.py    # stub — poll-margin passthrough
    ├── uniform_swing.py    # stub — base + national swing
    └── fundamentals.py     # REAL — 538 partisan lean + incumbency → per-seat prior (→ XGBoost upgrade later)
```
