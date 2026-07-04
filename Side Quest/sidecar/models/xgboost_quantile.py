"""xgboost_quantile — the learned QUANTILE model (keithpotz's innovation: median + 95% CI per seat).

What it learns: how a unit's partisan LEAN maps to its actual MARGIN, *and how much that varies*, from real
presidential history (state margins 1976-2024). Three XGBoost quantile regressors (0.025 / 0.5 / 0.975) →
a median prediction with a 95% credible interval. Then applied to each seat via its 538 partisan lean, so
every seat gets a margin DISTRIBUTION, not just a point estimate.

Honest scope: trained on PRESIDENTIAL outcomes (the congressional MEDSL results are guestbook-gated), so the
lean→margin+uncertainty mapping is a transfer. It's a real, backtested model (LOEO RMSE + interval coverage in
diagnostics) and the template — a congressional-trained version slots in identically once that data exists.
Needs the venv (numpy/pandas/xgboost); returns ok:false gracefully if they're absent.
"""
import os
import csv
import time
from .base import Model, result
from .fundamentals import _data_dir, _load_leans, _lean_key


def _load_history(data_dir):
    """MEDSL presidential CSVs → margins{(year,state_po):Dmargin%} + national{year:Dmargin%}."""
    agg = {}
    for fname in ("complete_data.csv", "2024president.csv"):
        path = os.path.join(data_dir, fname)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    y = int(r["year"])
                except (KeyError, ValueError, TypeError):
                    continue
                st, p = r.get("state_po") or "", r.get("party_simplified", "")
                raw = r.get("candidatevotes") or r.get("votes") or "0"
                try:
                    v = int(raw)
                except (ValueError, TypeError):
                    v = 0
                d = agg.setdefault((y, st), {"D": 0, "R": 0, "T": 0})
                if p == "DEMOCRAT":
                    d["D"] += v
                elif p == "REPUBLICAN":
                    d["R"] += v
                try:
                    d["T"] = max(d["T"], int(r.get("totalvotes") or 0))
                except (ValueError, TypeError):
                    pass
    margins, num, den = {}, {}, {}
    for (y, st), d in agg.items():
        tot = d["T"] or (d["D"] + d["R"])
        if tot > 0:
            margins[(y, st)] = (d["D"] - d["R"]) / tot * 100.0
            num[y] = num.get(y, 0) + (d["D"] - d["R"])
            den[y] = den.get(y, 0) + tot
    national = {y: num[y] / den[y] * 100.0 for y in num if den[y] > 0}
    return margins, national


def _training_rows(margins, national):
    """features [prior_lean, national_env] → target margin, for each state-year with prior history."""
    by_state = {}
    for (y, st), m in sorted(margins.items()):
        by_state.setdefault(st, []).append((y, m))
    X, Y, years = [], [], []
    for st, seq in by_state.items():
        for i, (y, m) in enumerate(seq):
            if i == 0:
                continue
            prior = [mm for (_, mm) in seq[:i]]
            X.append([sum(prior) / len(prior), national.get(y, 0.0)])
            Y.append(m)
            years.append(y)
    return X, Y, years


class XGBoostQuantile(Model):
    name = "xgboost_quantile"

    def run(self, inputs, config):
        t0 = time.time()
        try:
            import numpy as np
            import xgboost as xgb
        except Exception as e:
            return result(self.name, [], t0, ok=False, diagnostics={"error": "deps missing (run venv bootstrap): " + str(e)})

        cfg = config or {}
        data_dir = _data_dir(cfg)
        dist, states = _load_leans(data_dir)
        margins, national = _load_history(data_dir)
        X, Y, years = _training_rows(margins, national)
        if len(X) < 50:
            return result(self.name, [], t0, ok=False, diagnostics={"error": "insufficient training data", "rows": len(X)})
        X, Y, years = np.array(X, dtype=float), np.array(Y, dtype=float), np.array(years)

        def fit(alpha, Xt, Yt, n=int(cfg.get("n_estimators", 300))):
            return xgb.XGBRegressor(objective="reg:quantileerror", quantile_alpha=alpha,
                                    n_estimators=n, max_depth=3, learning_rate=0.04, subsample=0.9,
                                    reg_lambda=1.0, verbosity=0).fit(Xt, Yt)

        # LOEO backtest (median model) — RMSE + 95% interval coverage + win Brier/ECE (same metrics as the JS
        # structural backtest, so the learned model is directly comparable to the simple prior).
        from scipy.stats import norm
        se, covered, ntest = 0.0, 0, 0
        win_probs, outcomes = [], []
        for hold in sorted(set(years.tolist())):
            tr = years != hold
            te = years == hold
            if tr.sum() < 30 or te.sum() == 0:
                continue
            m = fit(0.5, X[tr], Y[tr], n=150)
            lo = fit(0.025, X[tr], Y[tr], n=150)
            hi = fit(0.975, X[tr], Y[tr], n=150)
            pm, pl, ph = m.predict(X[te]), lo.predict(X[te]), hi.predict(X[te])
            se += float(np.sum((pm - Y[te]) ** 2))
            covered += int(np.sum((Y[te] >= np.minimum(pl, ph)) & (Y[te] <= np.maximum(pl, ph))))
            ntest += int(te.sum())
            sig = np.maximum((np.maximum(ph, pl) - np.minimum(ph, pl)) / (2 * 1.96), 1e-6)   # CI → implied σ
            win_probs.extend(norm.cdf(pm / sig).tolist())                                      # P(margin > 0)
            outcomes.extend((Y[te] > 0).astype(int).tolist())
        rmse = round((se / ntest) ** 0.5, 2) if ntest else None
        coverage = round(covered / ntest, 3) if ntest else None
        wp, oc = np.array(win_probs), np.array(outcomes)
        brier = round(float(np.mean((wp - oc) ** 2)), 4) if wp.size else None
        ece = None
        if wp.size:
            e = 0.0
            for b in range(5):
                lo_b, hi_b = b / 5.0, (b + 1) / 5.0
                mask = (wp >= lo_b) & (wp <= hi_b if b == 4 else wp < hi_b)
                if mask.sum():
                    e += mask.sum() / wp.size * abs(float(wp[mask].mean()) - float(oc[mask].mean()))
            ece = round(e, 4)

        # production models on all data
        med, lo, hi = fit(0.5, X, Y), fit(0.025, X, Y), fit(0.975, X, Y)
        nat_env = float(cfg.get("national_env", 0.0))   # assumed national environment (D-margin points)
        seats, matched = [], 0
        for r in inputs.get("races", []):
            kind, key = _lean_key(r)
            lean = dist.get(key) if kind == "district" else (states.get(key) if kind == "state" else None)
            if lean is None:
                seats.append({"seat": r.get("seat"), "chamber": r.get("chamber"), "margin": 0.0, "lo": -15.0, "hi": 15.0, "source": "no_lean"})
                continue
            matched += 1
            x = np.array([[lean, nat_env]], dtype=float)
            pm, pl, ph = float(med.predict(x)[0]), float(lo.predict(x)[0]), float(hi.predict(x)[0])
            lo_v, hi_v = min(pl, pm, ph), max(pl, pm, ph)   # guard against quantile crossing
            seats.append({"seat": r.get("seat"), "chamber": r.get("chamber"),
                          "margin": round(pm, 2), "lo": round(lo_v, 2), "hi": round(hi_v, 2), "source": "xgb_quantile"})
        return result(self.name, seats, t0, diagnostics={
            "note": "XGBoost quantile (lean→margin+CI), trained on presidential history",
            "train_rows": len(X), "loeo_rmse": rmse, "interval_coverage_95": coverage,
            "loeo_brier": brier, "loeo_ece": ece,
            "matched": matched, "total": len(seats)})
