"""tissues/act_core.py — the ACT CORE: affect-control-theory impression formation, deflection,
optimal behavior, and characteristic emotion — Lucas's "probability matrix" made executable.

Clean-room from the PUBLISHED empirical coefficient tables (actdata, CC0 — us2010 equation set,
usfullsurveyor2015 EPA dictionaries), compiled into data/affect_weights.db by build_weights.py.
The restrictive bayesact-0.5.1 code was never copied; inteRact (MIT) documents the same equations.
Pure stdlib, deterministic, microseconds per call. Every scalar traces to a dictionary word or a
published coefficient row — reasons come free.

The machinery (all 3-vectors are EPA: evaluation, potency, activity, roughly −4.3..+4.3):
  transient(f9)        the 9-dim impression after an Actor-Behavior-Object event:
                       tau'_k = Σ_rows coef[row][k] × Π(selected inputs)   (Z-selector rows)
  deflection(f9,tau9)  Σ (f_k − tau_k)² with the per-slot breakdown — "how wrong it feels", and WHERE
  optimal_behavior(A,O) the behavior EPA that MINIMIZES deflection (the act she's moved toward) —
                       tau is affine in B, so this is a 3×3 least-squares solve, exact
  emotion(I,T)         the characteristic-emotion EPA for identity I in transient state T — the
                       emotionid table makes T affine in the emotion M: T = b(I) + A(I)·M → solve
  nearest(kind,epa)    the closest dictionary word (identity/behavior/modifier) — the label

Gender variants: the tables ship f/m; default 'avg' averages them (the standard means-only collapse).
"""
import math
import os
import sqlite3
import sys

DEFAULT_WEIGHTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "affect_weights.db")


def _open(path):
    uri = "file:" + os.path.abspath(path).replace("\\", "/") + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def _load_table(db, eqn_type, gender):
    """[(selector_digits, [c1..cN])] for one equation table; 'avg' averages the f and m tables."""
    if gender == "avg":
        f = dict(_load_table(db, eqn_type, "f"))
        m = dict(_load_table(db, eqn_type, "m"))
        keys = sorted(set(f) | set(m))
        out = []
        for z in keys:
            a, b = f.get(z), m.get(z)
            if a is None or b is None:
                out.append((z, a or b))
            else:
                out.append((z, [(x + y) / 2 for x, y in zip(a, b)]))
        return out
    rows = db.execute(
        "SELECT z, c FROM act_eqn WHERE eqn_set='us2010' AND eqn_type=? AND gender=? ORDER BY z",
        (eqn_type, gender),
    ).fetchall()
    return [(z[1:], [float(x) for x in c.split()]) for z, c in rows]


def _terms(table, inputs):
    """Evaluate every selector row against `inputs`; yield (product, coeffs, selector)."""
    for sel, coeffs in table:
        prod = 1.0
        for i, d in enumerate(sel):
            if d == "1":
                prod *= inputs[i]
        yield prod, coeffs, sel


class ActCore:
    def __init__(self, weights_path=DEFAULT_WEIGHTS, gender="avg"):
        self._db = _open(weights_path)
        self.impression = _load_table(self._db, "impressionabo", gender)
        self.emotionid = _load_table(self._db, "emotionid", gender)

    # ── dictionary ──────────────────────────────────────────────────────────────────────────────
    def epa(self, kind, term):
        r = self._db.execute("SELECT e, p, a FROM epa WHERE kind=? AND term=?",
                             (kind, str(term).strip().lower())).fetchone()
        return list(r) if r else None

    def nearest(self, kind, epa3, limit=1):
        rows = self._db.execute("SELECT term, e, p, a FROM epa WHERE kind=?", (kind,)).fetchall()
        scored = sorted(rows, key=lambda r: (r[1] - epa3[0]) ** 2 + (r[2] - epa3[1]) ** 2 + (r[3] - epa3[2]) ** 2)
        out = [(t, round(math.sqrt((e - epa3[0]) ** 2 + (p - epa3[1]) ** 2 + (a - epa3[2]) ** 2), 3))
               for t, e, p, a in scored[:limit]]
        return out[0] if limit == 1 else out

    # ── impression formation ────────────────────────────────────────────────────────────────────
    def transient(self, f9):
        """f9 = [Ae,Ap,Aa,Be,Bp,Ba,Oe,Op,Oa] fundamentals → the post-event transient (9)."""
        tau = [0.0] * 9
        for prod, coeffs, _sel in _terms(self.impression, f9):
            for k in range(9):
                tau[k] += prod * coeffs[k]
        return tau

    SLOTS = ("Ae", "Ap", "Aa", "Be", "Bp", "Ba", "Oe", "Op", "Oa")

    def deflection(self, f9, tau9):
        """Total deflection + the per-slot breakdown (the reasons)."""
        per = {}
        total = 0.0
        for k, name in enumerate(self.SLOTS):
            d = (f9[k] - tau9[k]) ** 2
            per[name] = round(d, 3)
            total += d
        return round(total, 3), per

    def event(self, actor, behavior, obj):
        """Convenience: dictionary words in → transient, deflection, per-slot, with reasons."""
        A = self.epa("identity", actor)
        B = self.epa("behavior", behavior)
        O = self.epa("identity", obj)
        if not (A and B and O):
            missing = [w for w, v in ((actor, A), (behavior, B), (obj, O)) if not v]
            return {"ok": False, "why": f"not in the dictionary: {', '.join(missing)}"}
        f9 = A + B + O
        tau = self.transient(f9)
        total, per = self.deflection(f9, tau)
        return {"ok": True, "f": f9, "tau": [round(x, 3) for x in tau], "deflection": total,
                "per_slot": per,
                "reason": f"{actor} [{A[0]},{A[1]},{A[2]}] {behavior} [{B[0]},{B[1]},{B[2]}] "
                          f"{obj} [{O[0]},{O[1]},{O[2]}] → deflection {total} (us2010 equations)"}

    # ── optimal (deflection-minimizing) behavior — exact least-squares, stdlib ──────────────────
    def optimal_behavior(self, actor_f3, object_f3):
        """The behavior EPA that minimizes deflection for actor/object fundamentals: tau is affine
        in B, f_B = B itself, so D(B) is quadratic → normal equations, 3×3, exact."""
        def tau_of(B):
            return self.transient(list(actor_f3) + list(B) + list(object_f3))
        t0 = tau_of([0.0, 0.0, 0.0])
        cols = []
        for j in range(3):
            unit = [0.0, 0.0, 0.0]
            unit[j] = 1.0
            cols.append([a - b for a, b in zip(tau_of(unit), t0)])   # ∂tau/∂B_j
        # residual rows: f_k(B) − tau_k(B) = (fconst_k + fB_k·B) − (t0_k + T_k·B)
        # stack M·B ≈ y  where M[k][j] = fB_k[j] − T[k][j],  y[k] = t0_k − fconst_k
        M, y = [], []
        for k in range(9):
            fB = [1.0 if (3 + j) == k else 0.0 for j in range(3)]   # f_B slots carry B itself
            fconst = (list(actor_f3) + [0, 0, 0] + list(object_f3))[k]
            M.append([fB[j] - cols[j][k] for j in range(3)])
            y.append(t0[k] - fconst)
        # normal equations: (MᵀM)·B = Mᵀy — 3×3 Gaussian elimination
        A3 = [[sum(M[k][i] * M[k][j] for k in range(9)) for j in range(3)] for i in range(3)]
        b3 = [sum(M[k][i] * y[k] for k in range(9)) for i in range(3)]
        return _solve3(A3, b3)

    # ── characteristic emotion ──────────────────────────────────────────────────────────────────
    def emotion(self, identity_f3, transient_i3):
        """Solve the emotionid equations for the emotion EPA M such that (M ⊗ I) ≈ T.
        Inputs to the table: [Me,Mp,Ma, Ie,Ip,Ia]; T is affine in M → 3×3 solve."""
        def t_of(Mv):
            out = [0.0, 0.0, 0.0]
            for prod, coeffs, _sel in _terms(self.emotionid, list(Mv) + list(identity_f3)):
                for k in range(3):
                    out[k] += prod * coeffs[k]
            return out
        b0 = t_of([0.0, 0.0, 0.0])
        cols = []
        for j in range(3):
            unit = [0.0, 0.0, 0.0]
            unit[j] = 1.0
            cols.append([a - b for a, b in zip(t_of(unit), b0)])
        A3 = [[cols[j][k] for j in range(3)] for k in range(3)]
        b3 = [transient_i3[k] - b0[k] for k in range(3)]
        return _solve3(A3, b3)

    def emotion_word(self, identity_f3, transient_i3):
        M = self.emotion(identity_f3, transient_i3)
        word, dist = self.nearest("modifier", M)
        return {"epa": [round(x, 3) for x in M], "word": word, "dist": dist}

    def close(self):
        self._db.close()


def _solve3(A, b):
    """3×3 Gaussian elimination with partial pivoting; raises on a singular system."""
    m = [row[:] + [bv] for row, bv in zip(A, b)]
    for i in range(3):
        p = max(range(i, 3), key=lambda r: abs(m[r][i]))
        if abs(m[p][i]) < 1e-12:
            raise ValueError("singular system")
        m[i], m[p] = m[p], m[i]
        for r in range(3):
            if r != i:
                fac = m[r][i] / m[i][i]
                for c in range(i, 4):
                    m[r][c] -= fac * m[i][c]
    return [m[i][3] / m[i][i] for i in range(3)]


def main():
    import argparse
    try:
        sys.stdout.reconfigure(encoding="utf-8")   # Windows cp1252 console vs '→' (the utf-8 law)
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="ACT core probe: actor-behavior-object → feeling")
    ap.add_argument("--actor", required=True)
    ap.add_argument("--behavior", required=True)
    ap.add_argument("--object", required=True)
    ap.add_argument("--weights", default=DEFAULT_WEIGHTS)
    args = ap.parse_args()
    core = ActCore(args.weights)
    ev = core.event(args.actor, args.behavior, args.object)
    if not ev["ok"]:
        print(ev["why"])
        return 1
    print(ev["reason"])
    worst = sorted(ev["per_slot"].items(), key=lambda kv: -kv[1])[:3]
    print("strain:", ", ".join(f"{k} {v}" for k, v in worst))
    A = core.epa("identity", args.actor)
    emo = core.emotion_word(A, ev["tau"][0:3])
    print(f"the {args.actor} would feel: {emo['word']} (EPA {emo['epa']}, dist {emo['dist']})")
    wb = core.optimal_behavior(A, core.epa("identity", args.object))
    word, dist = core.nearest("behavior", wb)
    print(f"the deflection-minimizing next act: {word} (EPA {[round(x,2) for x in wb]}, dist {dist})")
    core.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
