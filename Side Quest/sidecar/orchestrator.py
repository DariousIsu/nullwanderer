#!/usr/bin/env python3
"""Forecasting sidecar ORCHESTRATOR — runs the model pool CONCURRENTLY.

The heart of "spin several models at the same time": fans the requested models out to a multiprocessing pool
(one process per model — models are CPU-bound, so processes not threads), collects each ModelResult, and builds
an ensemble. Reads a job JSON (file via --job or stdin), writes results JSON (file via --out or stdout).

Contract:
  job  = { "inputs": {...shared bundle...}, "models": ["poll_baseline", ...]|null, "config": {...} }
  out  = { "ok", "wall_ms", "pool", "ran", "results":[ModelResult], "ensemble" }

Windows-safe: spawn start method + a top-level worker + the __main__ guard (required for multiprocessing).
"""
import sys
import os
import json
import time
import argparse
from multiprocessing import Pool, cpu_count

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry  # noqa: E402


def _run_one(args):
    """Top-level worker (picklable): instantiate a model by name and run it. Isolated failure → error result."""
    name, inputs, config = args
    t0 = time.time()
    model_cls = registry.get(name)
    if model_cls is None:
        return {"model": name, "ok": False, "error": "unknown model", "elapsed_ms": 0}
    try:
        return model_cls().run(inputs, config)
    except Exception as e:  # a model crash never takes down the pool
        return {"model": name, "ok": False, "error": str(e), "elapsed_ms": int((time.time() - t0) * 1000)}


def build_ensemble(results):
    """v1 ensemble: per-seat mean margin across the models that ran OK (R²-weighted blend comes later)."""
    ok = [r for r in results if r.get("ok")]
    if not ok:
        return None
    by_seat = {}
    for r in ok:
        for s in r.get("seats", []):
            e = by_seat.setdefault(s["seat"], {"seat": s["seat"], "chamber": s.get("chamber"), "margins": []})
            e["margins"].append(s["margin"])
    seats = [{"seat": e["seat"], "chamber": e["chamber"],
              "margin": round(sum(e["margins"]) / len(e["margins"]), 2), "n_models": len(e["margins"])}
             for e in by_seat.values()]
    return {"method": "mean", "n_models": len(ok), "seats": seats}


def orchestrate(job):
    inputs = job.get("inputs", {}) or {}
    config = job.get("config", {}) or {}
    models = job.get("models") or registry.names()
    pool_n = max(1, min(len(models), max(1, cpu_count() - 2)))   # never starve the app/Electron
    t0 = time.time()
    with Pool(processes=pool_n) as pool:
        results = pool.map(_run_one, [(m, inputs, config) for m in models])
    return {
        "ok": True,
        "wall_ms": int((time.time() - t0) * 1000),
        "pool": pool_n,
        "cores": cpu_count(),
        "ran": models,
        "results": results,
        "ensemble": build_ensemble(results),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", help="path to job JSON (default: stdin)")
    ap.add_argument("--out", help="path to write results JSON (default: stdout)")
    ap.add_argument("--list", action="store_true", help="list registered models and exit")
    a = ap.parse_args()
    if a.list:
        sys.stdout.write(json.dumps({"models": registry.names()}))
        return
    job = json.load(open(a.job, encoding="utf-8")) if a.job else json.load(sys.stdin)
    out = orchestrate(job)
    text = json.dumps(out)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
