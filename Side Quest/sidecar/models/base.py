"""Model interface + ModelResult helpers for the forecasting sidecar pool.

Every model emits the SAME ModelResult shape so the orchestrator, the ensemble, and the studio can treat any
model uniformly (Lucas: "each model = a widget"). A model is a class with a `name` and `run(inputs, config)`.
"""
import time


def chamber_summary(seats, chamber):
    ch = [s for s in seats if s.get("chamber") == chamber]
    if not ch:
        return None
    a_lead = sum(1 for s in ch if s.get("margin", 0) > 0)
    return {
        "n_races": len(ch),
        "a_leading": a_lead,           # races where party A (Dem) leads
        "pD_lead_frac": round(a_lead / len(ch), 3),   # placeholder; a real model returns a control probability
    }


def result(name, seats, t0, diagnostics=None, attributions=None, ok=True):
    """Build the standard ModelResult envelope."""
    return {
        "model": name,
        "ok": ok,
        "seats": seats,   # [{seat, chamber, margin, lo, hi}]
        "chambers": {"house": chamber_summary(seats, "house"), "senate": chamber_summary(seats, "senate")},
        "diagnostics": diagnostics or {},
        "attributions": attributions,   # SHAP-style per-variable attributions (later); None for now
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


class Model:
    name = "base"

    def run(self, inputs, config):
        raise NotImplementedError
