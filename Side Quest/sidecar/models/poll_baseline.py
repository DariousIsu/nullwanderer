"""poll_baseline — passes the per-race poll margin straight through (parity check vs the JS poll_average).

STUB for the skeleton: no heavy deps. Sleeps a configurable delay so the pool's concurrency is observable.
The real version will do a proper weighted aggregation; the CONTRACT (inputs → ModelResult) is what's fixed here.
"""
import time
from .base import Model, result


class PollBaseline(Model):
    name = "poll_baseline"

    def run(self, inputs, config):
        t0 = time.time()
        time.sleep(float((config or {}).get("stub_delay", 0.8)))   # simulate compute (proves parallelism)
        seats = []
        for r in inputs.get("races", []):
            m = float(r.get("poll_margin", r.get("margin", 0.0)))
            seats.append({"seat": r.get("seat") or r.get("id"), "chamber": r.get("chamber"),
                          "margin": round(m, 2), "lo": round(m - 4, 2), "hi": round(m + 4, 2)})
        return result(self.name, seats, t0, diagnostics={"note": "stub: poll margin passthrough", "n": len(seats)})
