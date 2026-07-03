# Recursive, Self-Generating Forecasting — Research & Architecture

> **Purpose (Lucas, 2026-07-03):** the API feed lane is landing; **real-time market indicators are deferred**
> (no reliable free/open source — models that hard-depend on live markets are degraded this pass); the salvaged
> **gleipnir models are mostly financial** (limited reuse). So we need (1) research into **non-financial
> forecasting model families** spanning many concept types, and (2) **the math + architecture for recursive,
> self-generating models** — a meta-forecaster that *generates* the right model per forecast concept, rather
> than us hand-coding one model per concept.
>
> **Thesis:** don't build N bespoke models. Build a **model-generating loop** over a substrate of open, general
> tools, with **calibration as the selection pressure**. The reasoning model (gpt-oss:120b) generates model
> *structure*; deterministic engines compute the *numbers*; backtesting decides what survives.

---

## 0. Vision & scope (Lucas, resolved 2026-07-03)

**This suite is pure R&D — real validation is months past launch.** So confidence comes from three loops, not
from waiting: **historical backtests** (2014–2024, truth known today), **upcoming primaries** (resolve in
weeks/months — the fast live loop; metric = *race-call accuracy + calibration*), and **the general** (log
now, score later). All four validation targets are in scope (incl. non-election early). Every forecast is
**stamped + snapshotted at issue time** so it can be scored when truth lands, never rewritten.

**The product = a NEXUS, not a black box.** To predict an outcome there are *hundreds* of data points;
the operator wants **access to every part AND a visualization of how the parts forecast the whole.** So the
core surface is a **compositional forecast graph** (factor → sub-model → outcome, every node showing value /
source / uncertainty / contribution). Visual is **phased: static decomposition first, interactive what-if
fast-follow.**

**v1 election scope = ALL federal + state-executive races nationwide** — every US House / Senate / President
race + Governor / AG / Sec-of-State / etc. → **~500+ races.** This scale is decisive: *you cannot hand-code
500 models* → it **forces the recursive model-GENERATOR** (§2), and it's why the generalist foundation models
(§1) + hierarchical reconciliation (§1a) are load-bearing, not optional.

**Two guard-rails restated:** (a) show all parts for TRANSPARENCY, but **calibration decides predictive
weight** — hundreds of factors ≠ better forecast (spurious precision is the trap); (b) **"why" = driver
correlation + narrative, NOT proven causation** (for AI-sentiment / war-opinion — set this expectation).

**Immediate next build:** generalize the sentiment widget → **search any subject's sentiment** (the on-ramp
that feeds the nexus). Then the calibration/nexus spine. See §3 phases.

## 1a. Parts ↔ wholes = coherent HIERARCHICAL forecasting (the research Lucas asked for)

"Forecast as parts and as wholes" is a named subfield: **hierarchical / coherent forecasting.** Forecast each
level of a hierarchy (elections: nation → region → state → district → precinct; also race-type groupings),
then **RECONCILE** so component forecasts are coherent with the aggregate (state forecasts sum to national).
Open tool: **Nixtla `hierarchicalforecast`** (Apache-2.0, free/local, verified) — bottom-up / top-down /
middle-out / **MinTrace** / ERM reconciliation, with **coherent probabilistic** intervals (Bootstrap /
Normality / PERMBU / Conformal). This is *the* math for the nexus's parts→whole coherence, and the hierarchy
IS the decomposition the visualization navigates. Pairs with the Bayesian hierarchical models (partial
pooling) in §1 — reconciliation makes any set of level-forecasts mutually consistent.

## 1. Non-financial forecasting model families (the toolbox)

A forecast concept maps to a family (or a blend). The band we care about: **vote share, approval/opinion
trends, binary event resolution ("will X by date D"), counts/rates, event cascades, geopolitical/social
dynamics, and generic resolvable questions.**

| Concept type | Model family | Open tooling (verified free/local) |
|---|---|---|
| **Any numeric series (generalist, zero-shot)** | **Time-series foundation models** — pretrained transformers that forecast arbitrary series with **no per-concept training**, with quantile/uncertainty bands | **Chronos-2** (Amazon, Apache-2.0, 8M–710M, quantile), **TimesFM 2.5** (Google, Apache-2.0, 200M, HF weights, quantile head to 1k horizon), **Lag-Llama**, **Moirai** (Salesforce), **IBM Granite TTM** — all open |
| **Trend + seasonal + level** | Structural time series / state-space (Kalman), ETS, Prophet | statsmodels, **Nixtla statsforecast** (Apache) |
| **Grouped / partial-pooling** (elections by state, cohorts) | **Hierarchical Bayesian** (the Economist election-model pattern) | **PyMC**, **NumPyro**, **Stan** |
| **Binary "will X happen by D"** | Survival / hazard + logistic; time-to-event | **lifelines**, **scikit-survival** (open) |
| **Event cascades / escalation** | Point process / **Hawkes**; self-exciting | tick, statsmodels |
| **Fundamentals → outcome** | Bayesian regression, structural priors + poll update | PyMC / NumPyro |
| **Social / epidemic dynamics** | Agent-based, compartmental (SIR-family), system dynamics | **Mesa** (ABM), EpiModel-style |
| **Novel / one-off questions** | **Reference-class forecasting + base rates** (superforecasting); judgmental aggregation | method; **Metaforecast/Squiggle** (QURI) for composable estimates + market blend |
| **Blend of all of the above** | **Ensembles / stacking / Bayesian model averaging** | **AutoGluon-TimeSeries** (Apache-2.0, AutoML: model-select + ensemble + intervals) |

**Key takeaways for us:**
- **Foundation models are the generalist unlock** — one engine, zero-shot, any series, uncertainty included,
  Apache-licensed, local. This is what makes "a band of many concepts" tractable without hand-building each.
- **Probabilistic programming (PyMC/NumPyro/Stan) is the universal substrate** — *any* concept is expressible
  as a generative model, and it stays deterministic + auditable. This is what an LLM can safely *author into*.
- **AutoGluon-TimeSeries is AutoML-for-forecasting** — automated model search + ensembling + calibrated
  intervals out of the box; a strong "generate + select" layer we don't have to write.
- Everything above is **free / open / local** — no paid feed, consistent with the market-data deferral.

---

## 2. The recursive, self-generating meta-forecaster (the architecture)

"Models that generate models across many concepts" = an **automated forecasting loop**. Six stages; the loop
is stages 2→5 iterating under calibration pressure.

```
①  INTAKE & TYPE   (gpt-oss:120b)  Question → concept type, target quantity, resolution criteria,
                                    horizon, data shape; find the REFERENCE CLASS + base rate.
②  GENERATE SPECS  (hybrid)        candidate model specs:
      • TEMPLATE library (deterministic): instantiate every family whose applicability conditions match
      • LLM-AUTHORED (gpt-oss): for novel concepts, author a model spec / probabilistic-program skeleton
        (family, features, decomposition, priors) — this is where the model SPACE self-extends
③  FIT & SIMULATE  (Python sidecar, deterministic)  fit each candidate (PPL sampling / AutoML /
                                    foundation-model zero-shot) → a PROBABILISTIC forecast (quantiles/draws)
④  BACKTEST & CALIBRATE  (deterministic)  score every candidate on held-out history with PROPER scoring
                                    rules (CRPS for distributions, Brier/log for binary, pinball for
                                    quantiles) + calibration curves. ← the FITNESS FUNCTION
⑤  SELECT / ENSEMBLE / EVOLVE      keep calibrated survivors; blend by skill (inverse-error / BMA / stacking).
                                    Then RECURSE: gpt-oss critiques residuals + miscalibration → a NEW
                                    generation of specs (Bayesian model EXPANSION / evolutionary mutate+
                                    recombine). Stop on calibration plateau or budget.
⑥  PERSIST LINEAGE                 the Question stores its model population + scores + winning blend →
                                    audit trail + a similar future Question WARM-STARTS from prior winners
                                    (self-generation compounds across concepts).
```

### The load-bearing principles (and the anti-pattern guard)
- **The LLM generates STRUCTURE, never numbers.** gpt-oss authors specs, decompositions, reference classes,
  and critiques; the deterministic engines fit and compute. (The division we already locked.)
- **Calibration is the selection pressure — and the guardrail.** Self-generation *without* backtesting is
  exactly how gleipnir died (advertised sophistication, zero validation). Every generated model must EARN its
  place by proper-scoring-rule performance on held-out data. No model enters the blend unscored. This is what
  keeps a "self-generating" system from producing confident garbage.
- **Probabilistic programming is the safe target of generation.** The LLM emits PPL specs into PyMC/NumPyro —
  a constrained, auditable, samplable substrate — not free-form code or raw numbers.
- **Graceful signal degradation.** A missing feed (real-time markets) simply drops that member from the
  ensemble (the `max(0.1, skill)` floor + renormalize handles it); models are built to run on *available*
  data, never to require all of it. → market-dependent concepts are lower-fidelity this pass, not broken.
- **Warm-start across concepts** is the "recursive self-generating" compounding: winning structures for one
  concept seed the generator for related ones, so the system gets better at generating models over time.

---

## 3. Phased build plan (calibration BEFORE self-generation)

The correct order puts the guardrail first — we earn the right to auto-generate by being able to score.

- **P0 (have):** poll-average = one hand-built model (the baseline member for election/approval concepts).
- **P1 — the spine:** the `Question`/`Prediction` object + a **model REGISTRY** (template families as pluggable
  entries) + the **backtest/calibration harness** (CRPS/Brier/log/pinball + calibration curves) driven by the
  538-legacy `raw_polls` (poll-vs-actual) we already ingest. *Pure, testable, needs no market data.* **Build first.**
- **P2 — the generalist:** wire a foundation model (**Chronos-2** or **TimesFM**) in the Python sidecar → an
  instant zero-shot probabilistic baseline for *any* series. First real fan-chart bands.
- **P3 — AutoML select:** **AutoGluon-TimeSeries** over the template families per concept → generate+select+
  ensemble automatically, scored by P1's harness.
- **P4 — LLM spec generator:** gpt-oss authors PPL model specs for novel concepts (the true self-extension of
  the model space), fit in the sidecar, scored by P1.
- **P5 — the recursion:** the critique→regenerate loop (Bayesian model expansion / evolutionary search) +
  lineage persistence + cross-concept warm-start. This is the full "recursive self-generating" system.

Each phase is independently useful and independently validated — no phase advertises capability it hasn't
proven (the gleipnir lesson, enforced structurally).

---

## 4. Reconciliation with the current build + directives

- **API feed landing** → downstream models consume the shared feed; **we ingest nothing raw here** (the
  connectors that stay are poll-specific origin; generic macro/market data reads from upstream).
- **Real-time market indicators deferred** → no financial/market-sentiment member this pass; the ensemble's
  graceful-degradation handles the absent signal; those concepts are lower-fidelity until a reliable feed
  exists. Flag, don't fake.
- **gleipnir mostly financial** → we keep only the generic math already salvaged (R²-weighted blend + floor,
  horizon-widening bands, z-score shock, storage layout); the financial models don't transfer. This research
  is the non-financial replacement.
- **Python sidecar (B0) is now decisively load-bearing** — Chronos / TimesFM / AutoGluon / PyMC / NumPyro /
  lifelines are ALL Python. The whole generate→fit→score→evolve stack lives there. gpt-oss:120b (num_predict
  ≥1500) is the reasoning/authoring layer above it.
- **Widget-per-model UI** extends naturally: each concept's forecast is a widget; the meta-forecaster's own
  widget shows the *generated model population + their calibration scores + the winning blend* (the lineage) —
  a distinctive visual that makes the self-generation legible.

---

*Prepared 2026-07-03. Foundation-model availability/licenses verified live (Chronos-2, TimesFM 2.5,
AutoGluon-TimeSeries — all Apache-2.0, local, probabilistic). Companion to
`docs/WORLD_MODEL_FORECAST_BRAINSTORM.md` + `docs/GLEIPNIR_SALVAGE.md`. Research + design — no code yet.*
