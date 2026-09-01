"""uniform_swing — applies a national swing to each race's base margin (the simplest structural model).

STUB for the skeleton. Demonstrates a model that reads `config` (the national environment) as well as `inputs`.
"""
import time
from .base import Model, result


class UniformSwing(Model):
    name = "uniform_swing"

    def run(self, inputs, config):
        t0 = time.time()
        cfg = config or {}
        time.sleep(float(cfg.get("stub_delay", 0.0)))   # default 0 — see poll_baseline (selftest passes it explicitly)
        swing = float(cfg.get("national_swing", 0.0))   # e.g. the fundamentals/env lean
        seats = []
        for r in inputs.get("races", []):
            base = float(r.get("base", r.get("margin", 0.0)))
            m = base + swing
            seats.append({"seat": r.get("seat") or r.get("id"), "chamber": r.get("chamber"),
                          "margin": round(m, 2), "lo": round(m - 5, 2), "hi": round(m + 5, 2)})
        return result(self.name, seats, t0, diagnostics={"note": "stub: base + national swing", "swing": swing})
