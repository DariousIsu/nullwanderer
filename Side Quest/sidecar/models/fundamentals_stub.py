"""fundamentals — the prior model (Lucas's spec: past-two-election margins + presidential lean + incumbency).

STUB for the skeleton — computes a trivial lean from inputs so the harness is exercised end-to-end. The real
version (Phase 2/3) ingests MIT Election Lab historical results + DK pres-by-CD and graduates to XGBoost.
"""
import time
from .base import Model, result


class FundamentalsStub(Model):
    name = "fundamentals"

    def run(self, inputs, config):
        t0 = time.time()
        time.sleep(float((config or {}).get("stub_delay", 0.8)))
        seats = []
        for r in inputs.get("races", []):
            # placeholder blend: presidential lean + a small incumbency nudge
            pres = float(r.get("pres_lean", 0.0))
            inc = {"A": 2.0, "B": -2.0}.get(r.get("incumbent_party"), 0.0)
            m = pres + inc
            seats.append({"seat": r.get("seat") or r.get("id"), "chamber": r.get("chamber"),
                          "margin": round(m, 2), "lo": round(m - 7, 2), "hi": round(m + 7, 2)})
        return result(self.name, seats, t0, diagnostics={"note": "stub: pres_lean + incumbency", "n": len(seats)})
