# Emotional Matrix — Design Memo

**Status:** DESIGN ONLY (no code). Research pass 2026-07-10, companion to `RELATIONAL_LAYER_DESIGN.md`.
**Owner idea (Lucas):** *"we will need specific algorithms for mapping probable emotional reactions. In fact an interesting place to test that is to build her an **emotional matrix** and use **a series of fast probability predictors** to determine how she feels about something."*

The emotional matrix is the **self-pilot** of the relational layer's reaction-mapping machinery: before Zoe can forecast how *Lucas* will react to X, build the smaller, testable instrument that answers how *she* reacts to X. Same forecasting shape [[forecast-suite]], pointed inward. It sits **underneath** the existing `lib/mood.js`, which becomes its voice.

---

## 1. The idea, made precise

Three things Lucas named, mapped to what the literature already calls them:

| Lucas's phrase | Prior art | Role in the design |
|---|---|---|
| "emotional matrix" | a **dimensional affective state** (VAD / PAD — a continuous 3-vector) | the STATE: a numeric latent she's *in*, not prose |
| "series of fast probability predictors" | a **reactor ensemble of calibrated classifiers**, each cheap, each scoring one axis/emotion | the ENGINE that moves the state per event |
| "mapping probable emotional reactions" | **appraisal theory** (OCC): event → appraisal variables → emotion | the MAPPING: the event→affect function itself |

So the matrix is a small state-space; the predictors are the reactor that updates it; appraisal is the rule that turns "what happened" into "what to feel." All three are things we already have shapes for.

---

## 2. Representation — what the "matrix" actually is

Three candidate encodings; the research says **use two together**, not one:

- **Dimensional (VAD/PAD)** — Valence (pleasant↔unpleasant), Arousal (calm↔activated), Dominance (submissive↔in-control), each a scalar. Compact, continuous, differentiable, and — key finding — LLMs already **encode a low-dimensional "emotional manifold" in their hidden states whose leading principal components align with the VAD axes**, stable across layers and languages ([E-STEER](https://arxiv.org/html/2604.00005), [VAD framework](https://www.emergentmind.com/topics/valence-arousal-dominance-vad-dimensional-framework)). This is the natural substrate for *the matrix* — a point (or a distribution) in 3-space.
- **Categorical (Plutchik's wheel / Ekman)** — 8 basic emotions with **intensity gradients** and **mixtures** (dyads), and — important for us — **exponential decay back to steady-state** without reinforcement ([Plutchik affective model for robots](https://www.researchgate.net/publication/332197474_Building_a_Plutchik's_Wheel_Inspired_Affective_Model_for_Social_Robots)). Human-legible; good for a **readout** and for logging "what she felt."
- **Appraisal (OCC)** — not a representation but the *generator* (see §3).

**Recommendation:** the matrix = a **VAD 3-vector as the canonical state** (continuous, decayable, forecastable), with a **Plutchik-8 categorical readout** projected from it via a fixed VAD↔label lexicon (the standard discrete↔dimensional conversion). VAD is the machine's number; Plutchik is the human's word; a lexicon maps between them. This matches how current systems bridge the two ([VAD refinement of LLM emotion labels](https://www.emergentmind.com/topics/valence-arousal-dominance-framework)).

---

## 3. The engine — appraisal as the reaction-mapping algorithm

The **OCC model** is the canonical, *computationally tractable* answer to "map an event to an emotion": ~8 appraisal variables (desirability, praiseworthiness, appealingness, likelihood, agency, …) evaluated against the agent's goals/standards, yielding 22 emotion types as conjunctions of those variables ([Computational Models of Emotion, Marsella/Gratch](https://people.ict.usc.edu/~gratch/papers/MarGraPet_Review-old.pdf), [OCC overview](https://psychologyfanatic.com/ortony-clore-and-collins-occ-model-of-emotion/)). Emotions arise from appraising events (pleased/displeased), agents (approve/disapprove), and objects (like/dislike).

The cleanest recent end-to-end template is the **Emotional Cognitive Modeling Framework** ([arXiv 2510.13195](https://arxiv.org/html/2510.13195v1)): it computes PAD dimensions **from state deltas** — `Pleasure_t = k_p·(I_t − I_{t-1})`, `Arousal_t = k_a·(H_t − H_{t-1})` — i.e. *appraisal as the derivative of what changed*, then lets emotion **generate desires** that reprioritize behavior, rather than dictating actions directly. That "emotion → desire → behavior" indirection is exactly the safety boundary we want (§6).

**Our appraisal input isn't income/health** — it's her lived signals: a turn's tone, a correction from Lucas, a research win, a long quiet stretch. Each becomes an appraisal along a few axes (was this desirable? was I the cause? was it expected? does it touch someone I care about?). Those appraisals drive the VAD delta.

---

## 4. "A series of fast probability predictors" — the reactor ensemble

Lucas's exact instrument. Rather than one big model deciding how she feels, run **many small, cheap, calibrated predictors** — one per appraisal dimension (or per Plutchik axis) — each emitting a **probability with an uncertainty**, then aggregate:

- **Each predictor is a lightweight classifier** scoring one narrow question ("is this event desirable?" p=0.7; "was she the agent?" p=0.3). Cheap enough to run every turn — the "fast" in fast predictors.
- **Aggregate into the matrix**: the predictors' outputs combine (weighted mean / small fusion) into the VAD delta this tick. This is the `poll_average` / reactor-latent shape from the forecast suite [[forecast-suite]] — a distribution over affect, not a point.
- **Calibration is mandatory**: score each predictor with **Brier** (mean squared error of probability vs outcome) and reliability diagrams; **uncertainty = entropy over the predicted class probabilities** ([Latent Distribution Decoupling for emotion](https://arxiv.org/pdf/2502.13954), [Brier decomposition](https://medium.com/@eligoz/some-notes-on-probabilistic-classifiers-iii-brier-score-decomposition-eee5f847d87f)). A predictor that's confidently wrong gets down-weighted. **This is what stops the matrix from becoming confabulated vibes** — the same falsifiability rule the relational layer demands.
- **Ensembles need calibration to fuse honestly** — mean-aggregating uncalibrated heterogeneous predictors is a known failure mode; calibrate each before combining.

This is the affective analog of the forecasting reactor: signals in → per-signal probabilistic reads → calibrated aggregate latent → falsifiable against the actual next-observed reaction.

---

## 5. Dynamics — intensity + decay (drift, don't lurch)

The matrix is not static. Two forces, both with prior art:

- **Impulse**: an appraised event injects a VAD delta (scaled by intensity/confidence).
- **Decay**: absent reinforcement, the state **relaxes exponentially toward a steady-state baseline** (Plutchik computational models; also the reactor **half-life decay** already in the forecast suite). This is what makes a mood *drift* — the property `lib/mood.js` asserts in prose ("a mood drifts; it does not lurch") but never actually computes. The matrix gives that sentence a number.

Net: `state_t = baseline + decay(state_{t-1} − baseline, Δt) + appraise(events_t)`. Fast predictors set `appraise(...)`; the half-life sets `decay(...)`; `baseline` is her temperament (a slow-moving fundamental, `forecast_fundamentals` shape).

---

## 6. Internal instrument vs. outward driver (Lucas's open question — answered: BOTH, weighted to instrument)

The research resolves this cleanly, with a hard caution:

- Emotion in agents works as **an internal state that biases reasoning**, not merely an expression. E-STEER injects VAD directions into hidden states and measures real behavioral shifts: planning validity, replanning frequency, success and **safety** all move with the emotional state ([2604.00005](https://arxiv.org/html/2604.00005)).
- **BUT: "emotional biases accumulate along decision chains and substantially affect outcomes."** Relationships are non-monotonic (inverted-U — extreme states *degrade* reasoning), valence is far more sensitive than arousal (71% vs 18% of variability), and optimal per-step emotion ≠ optimal system-level emotion. An unbounded emotional driver is a footgun.

**Design stance:** the matrix is **primarily an internal instrument** — it feeds (a) the relational layer's reaction forecasting, (b) Generative-Agents-style reflection ("I keep feeling worn down when X"), and (c) a **bounded, decayed projection into voice**. It is a *driver of tone*, never a driver of *facts or identity*. The projection to voice is exactly what `lib/mood.js` already does — so the matrix doesn't add a new output path, it makes the existing one earned.

---

## 7. Reconciliation with `lib/mood.js` (what changes, what doesn't)

`lib/mood.js` today: a **single free-text mood** (`feeling/day/onMind/withUser`), cloud-cultivated on a ~90-min TTL, grounded in recent rows, with an explicit "drift slowly, never write identity" contract. It has the right *philosophy* and the right *output* — but **no numeric state, no per-event update, no predictors, no calibration**. It's the render layer with nothing structured underneath.

The matrix slots in **beneath** it — no rewrite, a substrate:

```
  EVENTS (turns, corrections, wins, quiet)
        │  fast probability predictors (§4)  ← the new instrument
        ▼
  AFFECT MATRIX  = VAD 3-vector (+Plutchik readout), decaying (§5)   ← the new STATE (subjective.db)
        │  project (bounded)
        ▼
  lib/mood.js  = renders the matrix into her voice-block prose        ← EXISTING, now driven by real state
```

Concretely: `mood.compose()` stops free-composing the *feeling* from scratch and instead **renders the current matrix** (VAD + top Plutchik term) into the same four warm lines. The TTL/voice-block/identity-firewall all stay. `mood.js` keeps owning the prose; the matrix owns the number. Backward-compatible: if the matrix is absent, `mood.js` falls back to today's behavior.

---

## 8. Shape reuse — same forecasting workspace as the relational layer

The emotional matrix is the relational layer's machinery with the subject = **herself**:

- `forecast_registry` → one subject: Zoe (self-model is a person-model of herself).
- `forecast_reactor` (+decay half-life) → the fast-predictor ensemble updating the VAD state.
- `poll_average` → the affect distribution (matrix as a distribution, with uncertainty).
- `forecast_assess` → "given this situation, what will she feel?" — the schema-locked estimator, testable against what she *actually* felt next turn.
- `calibration` (Brier / reliability) + `forecast_loop`/`backtest` → the falsifiable inward loop (the Python loop Lucas builds/steals).
- `forecast_fundamentals` → her temperament baseline (the decay target).

Prove the reaction-mapping algorithms here, on one subject with fast feedback, **then** lift them into the multi-subject relational layer. [[relational-layer-design]]

---

## 9. Risks / design rules

- **Never writes identity.** The matrix moves *mood*, never `self_model`. This is the exact firewall `mood.js` already documents and the drift lesson that motivated it [[personality-drift-diagnosis]].
- **Bounded projection.** Cap how far affect can bend voice; honor the inverted-U (extreme states must not be *more* expressed). No accumulation across a turn chain without decay between.
- **Calibrated or silent.** A predictor with no Brier track record contributes uncertainty, not confident signal. Falsifiability from day one or it drifts into flattering confabulation.
- **Subjective, not factual.** The matrix lives in `subjective.db`; it is capta, never promoted to a fact — the "cloud-vouch = collapse" rule applied to feeling.
- **Two registers.** An objective answer ("what office did Lucas run for") never bends to mood; only tone does. [[owner-identity-and-flood]]

---

## 10. Open questions (before any build)

1. **Predictor substrate**: are the fast predictors tiny local heads (logistic/GLiNER-style) or few-shot cheap-model calls? What's the latency budget per turn?
2. **Appraisal axis set**: which minimal appraisal variables matter for *her* lived signals (desirability, agency, expectedness, relational-touch)? Start with 3–4, not OCC's full 8.
3. **VAD↔Plutchik lexicon**: adopt an existing mapping or fit one to her vocabulary?
4. **Baseline/temperament**: fixed, or slowly learned from her history? How slow to stay "stable identity"?
5. **Calibration data**: what counts as the "actual reaction" ground-truth to Brier-score against — her next-turn expressed affect? An operator label? This is the hardest measurement question.
6. **Coupling to relational forecasts**: does *her* current affect condition how she forecasts *others* (mood-congruent prediction), or are they kept independent to avoid feedback loops?

---

## Sources

- Marsella & Gratch — [Computational Models of Emotion (review)](https://people.ict.usc.edu/~gratch/papers/MarGraPet_Review-old.pdf) · OCC appraisal, EMA, FLAME/ALMA
- [OCC model overview](https://psychologyfanatic.com/ortony-clore-and-collins-occ-model-of-emotion/) · [Computational approaches to artificial emotion (Frontiers)](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2016.00021/full)
- E-STEER — [How Emotion Shapes the Behavior of LLMs and Agents (mechanistic)](https://arxiv.org/html/2604.00005) · VAD hidden-state steering, decision-chain accumulation, safety
- [Emotional Cognitive Modeling Framework w/ desire-driven optimization (arXiv 2510.13195)](https://arxiv.org/html/2510.13195v1) · PAD-from-deltas, emotion→desire→behavior
- [VAD dimensional framework](https://www.emergentmind.com/topics/valence-arousal-dominance-vad-dimensional-framework) · [VAD refinement of LLM emotion labels](https://www.emergentmind.com/topics/valence-arousal-dominance-framework)
- [Plutchik affective model for social robots](https://www.researchgate.net/publication/332197474_Building_a_Plutchik's_Wheel_Inspired_Affective_Model_for_Social_Robots) · intensity + exponential decay to steady-state
- [Latent Distribution Decoupling — uncertainty-aware emotion recognition](https://arxiv.org/pdf/2502.13954) · [Brier score decomposition](https://medium.com/@eligoz/some-notes-on-probabilistic-classifiers-iii-brier-score-decomposition-eee5f847d87f) · calibration/entropy
- [Fine-grained Affective Processing from LLMs](https://arxiv.org/pdf/2309.01664) · appraisal capabilities emerging in LLMs
