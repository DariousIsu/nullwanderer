# Relational Layer — Design Memo

**Status:** DESIGN ONLY (no code). Captured 2026-07-10 during the identity/core-memory work.
**Owner idea (Lucas):** give Zoe the ability to develop long-term **relationships**, **opinions about** people, and **forecasts of behavioral responses** — a subjective layer on top of the objective knowledge graph, piloted with just **her and Lucas**.

---

## 1. The concept, confirmed

A new **"personal" Person object** — Zoe's *subjective* model of a person — that:

- is **keyed to the canonical entity id** in the main DB (the objective spine);
- **inherits the canonical object's EDGES BY REFERENCE** (read-only traversal into the main graph), **not by copy** — so it gets the value/benefit of the real connectivity without duplicating it or risking contamination;
- adds subjective layers stored **only** in the separate subjective DB: observations, opinions/beliefs, behavioral forecasts, relationship state.

**Hard invariants (the whole ballgame):**
1. Facts flow **one-way IN** — clone/refresh from main; the subjective object never *owns* a fact, it *references* one.
2. **Nothing writes back** to the main/factual DBs — enforced in **code**, not convention (no subjective→main write path exists).
3. **Edges by reference, not copy** — the overlay traverses the canonical graph live; it does not materialize a second copy that could drift.
4. An **opinion or forecast is never promoted to a fact** — it is a different epistemic class (see §2). This is the existing "cloud-vouch = collapse" rule applied to inference.

---

## 2. Research grounding (this has real prior art)

### Objective vs subjective = **data vs capta** (the separation, formally named)
Provenance-enhanced knowledge graphs distinguish **data** (observer-independent facts) from **capta** (claims, interpretations, hypotheses made by a cognitive agent). The **DEC framework** (Doxastic–Epistemic–Conjectural) and "Subjective Knowledge Graphs" formalize exactly our split: canonical facts vs per-agent belief layers, separated by provenance + modal qualifiers (which agent believes what, with what confidence, on what evidence), so the subjective overlay **never corrupts canonical truth**. → Our main DB = data; the relational layer = Zoe's capta, provenance-linked back to the data it references.
Sources: [Provenance-Enhanced Statements in KGs](https://arxiv.org/html/2606.15246) · [Subjective Knowledge Graphs](https://www.researchgate.net/publication/356710196_Introducing_Subjective_Knowledge_Graphs) · [Epistemology layers for agentic memory](https://volodymyrpavlyshyn.medium.com/context-graphs-and-data-traces-building-epistemology-layers-for-agentic-memory-64ee876c846f) · [Eywa: provenance-grounded long-term memory](https://arxiv.org/pdf/2605.30771)

### Observations → opinions via **reflection** (the engine)
Stanford's **Generative Agents** (Smallville, Park et al. 2023): a **memory stream** of raw observations, periodically **clustered into higher-order REFLECTIONS** — the mechanism that turns "what I saw" into "what I think" — retrieved by **recency × relevance × importance** to drive behavior. Agents formed relationships and coordinated *emergently*, with no explicit instruction. → This is our observation→opinion loop; reflection is how a pile of interactions becomes an opinion/relationship.
Sources: [Generative Agents (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) · [paper PDF](https://3dvar.com/Park2023Generative.pdf) · [memory-stream & reflection overview](https://www.subodhjena.com/blog/generative-agents-memory-stanford)

### Forecasting = **theory-of-mind user modeling** (and where you're at the frontier)
ToM = maintaining a **latent belief over what a person prefers and will do next**, used to plan responses; **persistent memory is the enabling factor** for emergent ToM. **Important:** most persona approaches treat a person as *static/slowly-changing priors* and do **not** model how behavior **evolves across events over time** — that is explicitly called an **emerging research area**. → The behavior-*evolution* forecasting Lucas wants is genuinely novel; it's the hardest and most differentiating piece.
Sources: [Persistent memory & user profiles for long-term interaction](https://www.researchgate.net/publication/396373172_Enabling_Personalized_Long-term_Interactions_in_LLM-based_Agents_through_Persistent_Memory_and_User_Profiles) · [Emergent ToM in LLM agents](https://arxiv.org/pdf/2604.04157) · [TWICE — temporal evolution of user behavior](https://arxiv.org/pdf/2602.22222) · [MemGPT/Letta core memory (Human/Persona blocks)](https://www.letta.com/blog/memory-blocks/)

---

## 3. Architecture sketch — a FORECASTING MACHINE per person (NOT a belief-revision engine)

**The right shape is the forecasting workspace, not the Puller** (Lucas, 2026-07-10). The Puller *converges on one true value* (the person's real email) via belief flips — wrong here. A relational model instead holds a **distributional, temporal, calibrated** estimate of who someone is and how they'll behave. Each forecasting module maps to a person-model component:

```
subjective.db  (separate SQLite, like the forecast stores)

  SUBJECT REGISTRY    (forecast_registry shape) — the roster of person-subjects modeled, each keyed to a
                      canonical main-DB id; the object's edges are traversed BY REFERENCE (never copied).

  SIGNALS → REACTOR   (forecast_reactor shape, incl. recency DECAY / half-life) — observations & interactions
                      flow in as timestamped SIGNALS that update the person's latent state, weighted by recency.
                      Signal kinds: speech pattern · comm style · like · dislike · stance · interaction moment.

  LATENT PROFILE      (poll_average / reactor-latent shape) — the person as an evolving DISTRIBUTION with
                      uncertainty, not point facts: traits, preferences, relationship/trust, opinions.

  ESTIMATOR / ASSESS  (forecast_assess shape — buildAssessInput → schema-validated) — the cloud model takes
                      (situation/event + person) → a VALIDATED probabilistic FORECAST of behavioral response
                      ("how will Lucas react to X").

  CALIBRATION         (calibration shape — Brier / reliability / interval-coverage / backtest) — forecast →
                      observe the ACTUAL reaction → score → revise. Keeps opinions/forecasts FALSIFIABLE, not
                      flattering vibes.

  FUNDAMENTALS        (forecast_fundamentals shape) — baseline priors about the person, under the live signals.
```

**Two loops:**
- **Reflection loop** (observations → opinions): cluster + synthesize raw signals into higher-order reads, à la Generative Agents — feeds the latent profile.
- **Forecast/calibration loop** (forecast → observe → Brier-score → revise): the `forecast_loop` / `backtest` analog. This is the **Python loop to build/steal** (Lucas).

---

## 4. Reuse — the FORECASTING WORKSPACE is the template (not the Puller)
- **`forecast_registry`** → the person-subject roster (canonical-id-keyed).
- **`forecast_reactor`** (with `decay` half-life) → observations as decaying signals updating latent state.
- **`forecast_assess`** (schema-locked cloud estimator) → validated behavioral forecasts.
- **`calibration`** (Brier / reliability / interval-coverage) + **`forecast_loop`/`backtest`** → the falsifiable outcome loop (the Python loop Lucas will build/steal).
- **`poll_average`** → the distributional latent-profile aggregation.
- **Object-memory + core-memory blocks** → the subjective profile *feeds* the Human/Owner block in the prompt. [[owner-identity-and-flood]]

> NOTE: the **Puller's converge-on-one-value belief engine is the WRONG shape** here — a relationship/forecast is a distribution over time, not a single truth to lock onto. Recorded so we don't reach for it again. [[forecast-suite]]

---

## 5. Sequencing (and the tie to current work)
- The **Owner core-memory block** (the paused identity fix) should be built as **person-model v0** — the first brick, forward-compatible with this layer, *not* a throwaway card.
- Then: subjective.db schema → observation capture (from chat/meetings) → reflection loop → calibration loop.
- **Pilot scope:** Zoe's model of Lucas + Zoe's model of herself (the self-model is already a person-model of herself — unify under the same shape).
- **First testbed — the EMOTIONAL MATRIX** (`docs/EMOTIONAL_MATRIX_DESIGN.md`, Lucas 2026-07-10): before forecasting how *Lucas* reacts, build the smaller instrument for how *she* reacts — the same reaction-mapping machinery (appraisal → fast calibrated predictors → VAD/PAD affect state → falsifiable calibration loop) pointed inward, sitting beneath `lib/mood.js` (which becomes its voice). Prove the algorithms on one subject with fast feedback, then lift into the multi-subject relational layer.

---

## 6. Risks / design rules
- **One-way boundary in CODE** (no subjective→main write path). The single most important invariant.
- **Opinion must never override grounded fact** — register separation: the objective answer ("what office did Lucas run for") comes from data; the subjective read ("he'll probably push back") is clearly capta.
- **Forecasts must be falsifiable** — wire the outcome/calibration loop from day one or it drifts into flattering confabulation.
- **Personality-drift caution** — an autonomous subjective layer once colonized her identity; keep it downstream, bounded, and never self-reinforcing without evidence. [[personality-drift-diagnosis]]

---

## 7. Open questions (need more research before build)
1. **Overlay mechanism:** how the subjective object traverses the main graph's edges *live and read-only* (DuckDB ATTACH? id-ref + join at read time? a view?). Must be by-reference, refreshable, non-duplicating.
2. **Reflection cadence + importance scoring** for *interpersonal* observations (Generative Agents scored importance 1–10 via self-assessment; what's the right signal here?).
3. **Temporal behavior-evolution forecasting** — the frontier piece; how to model change-over-time, not a static prior (TWICE-style event-driven).
4. **Prompt integration:** how the subjective layer surfaces in a turn *without* overriding objective answers (two registers).
