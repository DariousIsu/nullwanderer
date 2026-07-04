#!/usr/bin/env python3
"""Dependency-free self-test for the sidecar skeleton. Run: python selftest.py  (exit 0 = pass).

Proves: models register, the pool runs them CONCURRENTLY (wall << sum of per-model times), every model emits the
ModelResult contract, and the ensemble blends per-seat. No third-party deps — runs on any Python 3.x.
"""
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry
import orchestrator

JOB = {
    "models": ["poll_baseline", "uniform_swing", "fundamentals"],
    "config": {"stub_delay": 0.5, "national_swing": -0.17},
    "inputs": {"races": [
        {"seat": "S-AZ", "chamber": "senate", "poll_margin": 1.2, "base": 1.2, "pres_lean": -3, "incumbent_party": "B"},
        {"seat": "S-TX", "chamber": "senate", "poll_margin": 0.6, "base": 0.6, "pres_lean": -8, "incumbent_party": "B"},
        {"seat": "H-CA-22", "chamber": "house", "poll_margin": -0.2, "base": -0.2, "pres_lean": 2, "incumbent_party": "B"},
    ]},
}

pass_n = 0
fail_n = 0


def ok(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  PASS " + name)
    else:
        fail_n += 1
        print("  FAIL " + name + (" - " + detail if detail else ""))


def main():
    ok("registry lists the 3 models", set(registry.names()) == {"poll_baseline", "uniform_swing", "fundamentals"})

    out = orchestrator.orchestrate(JOB)
    ok("orchestrate ok", out["ok"] is True)
    ok("all models ran + returned ok", len(out["results"]) == 3 and all(r["ok"] for r in out["results"]))

    # concurrency: 3 models x 0.5s each. parallel wall must be well under the 1.5s sequential sum.
    n_models = len(JOB["models"])
    ok("pool ran CONCURRENTLY (wall < sequential sum)", out["wall_ms"] < 0.5 * n_models * 1000 * 0.8,
       "wall=%dms vs sequential~%dms" % (out["wall_ms"], int(0.5 * n_models * 1000)))
    ok("pool sized to models, capped by cores", 1 <= out["pool"] <= out["cores"])

    # ModelResult contract on every model
    for r in out["results"]:
        ok("%s emits contract (seats+chambers+elapsed)" % r["model"],
           isinstance(r.get("seats"), list) and "chambers" in r and "elapsed_ms" in r)

    # models genuinely differ (poll_baseline sees Senate D-leaning; fundamentals sees it R after pres+incumbency)
    pb = next(r for r in out["results"] if r["model"] == "poll_baseline")
    fx = next(r for r in out["results"] if r["model"] == "fundamentals")
    ok("models produce distinct views (not identical)", pb["chambers"]["senate"] != fx["chambers"]["senate"])

    # ensemble blends per seat across models
    ens = out["ensemble"]
    ok("ensemble covers all seats, n_models=3 each", ens and len(ens["seats"]) == 3 and all(s["n_models"] == 3 for s in ens["seats"]))

    print("\n%s - %d passed, %d failed  (pool=%d/%d cores, wall=%dms)" %
          ("PASS" if fail_n == 0 else "FAIL", pass_n, fail_n, out["pool"], out["cores"], out["wall_ms"]))
    sys.exit(0 if fail_n == 0 else 1)


if __name__ == "__main__":
    main()
