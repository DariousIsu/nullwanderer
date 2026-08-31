# Affect Substrate — Research Report

**Status:** RESEARCH (granted 2026-08-31, run post-compact). Precedes any build.
**Order (Lucas, 2026-08-31, compressed):** feelings, wants, wonder, empathy, fears, dreams — "all of it could be produced procedurally through a series of fast-run python scripts." Extension: "dedicated swarm agents operate targeted python neural tissues… a python script that near-instantly runs a probability matrix for most probable response — make the model weights that would control organic emotion internal to the program; the model translates it."
**Governing law:** deterministic passes produce the affect manifest WITH REASONS; the frontier voice renders feeling FROM it, never invents it. Same subject + same history ⇒ same impression (hard-testable, anti-drift).
**Companions:** `EMOTIONAL_MATRIX_DESIGN.md` (2026-07-10 — the affect half, fully specified) · `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` (the drive half + slice plan) · memory `affect-substrate-theory.md` (the order).

---

## 1. Headline: the substrate already has a beating Slice 0 — and this research found its first disease

This is not a greenfield. The program already designed this twice and built the first slice:

- **`EMOTIONAL_MATRIX_DESIGN.md` (07-10)** specifies exactly what Lucas re-stated on 08-31: a VAD 3-vector as canonical state, a **series of fast calibrated probability predictors** as the update engine (his own phrase, then and now), OCC appraisal as the event→affect mapping, impulse+decay dynamics, and `lib/mood.js` demoted to the render layer. The 08-31 order is the *mandate and extension* of this memo, not a new idea.
- **`lib/internal_state.js` (Slice 0, live since 08-15, ticking in `main.js:5389`)** — THE DARK INSTRUMENT: 4 drives (curiosity/social/energy/progress) computed fresh from exhaust each tick + a VAD vector moved by coded deterministic appraisals of obs_bus events, `state = baseline + decay(prev−baseline, Δt) + impulses`, journaled (ring 300), zero consumers by design.

### 1a. The 51-hour honesty read (this session, journal 2026-08-29 16:44 → 08-31 19:52, 300 entries)

The Slice-0 gate was "48h of journaled trajectories prove the readings honest." The ring now holds ~51h. Verdict — **split**:

| Half | Reading | Verdict |
|---|---|---|
| drives.curiosity | min 0.03 · max 0.75 · mean 0.50 | ALIVE — tracks intake diversity |
| drives.social | min 0.00 · max 0.62 · mean 0.18 | ALIVE — tracks his presence (75m gap → 0.16) |
| drives.energy | min 0.00 · max 0.94 · mean 0.48 | ALIVE — tracked the quota week end-to-end |
| drives.progress | min 0.66 · max 0.86 · mean 0.77 | ALIVE (honestly high — 47/148 threads moved in 48h) |
| vad.v | min 0.25 · max 0.29 (clamp floor 0.25) | **SATURATED — information-free** |
| vad.a | min 0.73 · max 0.75 (clamp ceiling 0.75) | **SATURATED — information-free** |

**The disease: one-signed appraisal.** `appraiseEvents()` knows only two impulses — `need` (+arousal) and machine/db `anomaly` (+arousal, −valence, −dominance). There is **no positive appraisal at all**: a green gate, a paid delivery, a consumed proposal, a curator filing, Lucas showing up — none of it moves valence up. The only upward force is 4h-half-life decay toward baseline, and the system's steady metabolism (needs mint constantly) outruns it. So valence lives pinned at its floor and arousal at its ceiling — precisely the "saturated, information-free reading" the 08-15 recalibration cured once before, recurring one level up. The drive half passes its dark-phase gate; the affect half fails on **input asymmetry, not dynamics**. Cure shape is known and cheap: appraise the wins that already exist in exhaust (obs_bus + product ledger + gate results), with the same dedupe-by-signature rail. This is a Slice-0.5 fix, prerequisite to wiring any consumer.

## 2. What the program already holds (the affect-signal inventory)

| Organ | What it computes today | Role in the substrate |
|---|---|---|
| `lib/internal_state.js` | 4 drives + VAD, deterministic, journaled, provenance per reading | **The global state tissue — exists, live, dark** |
| `lib/mood.js` | cloud-composed prose mood (feeling/day/onMind/withUser), 90-min TTL, leads her voice; template-echo self-heal | The designated **render layer** (Slice 1 consumer): renders the vector instead of free-composing |
| `lib/salience.js` | graded attention: `activation = recency-decay × hit-weight × salient-boost`, floor + eviction | A **proven in-house dynamical system** — same math family the impression store needs (decayed, hit-weighted attachment) |
| `lib/interests.js` | weighted interest store: learning-progress reward (Schmidhuber/Oudeyer), seed floor + emergent interests, anti-fixation caps, cloud ranker | **Wants/curiosity tissue, half-built** — persistent weighted "what I care about" |
| `lib/curiosity.js` | regex curiosity/boredom detectors over monologue → self-directed searches | Wonder trigger (language-driven; the gap-driven half is the flare/absence machinery) |
| `lib/preferences.js` | deterministic taste formation: hold-it→speak-it, else form-store-speak | **Preference tissue** — already durable, already deterministic at read time |
| `lib/personal.js` | play/work context mode with auto-expiry | Disposition context the manifest should carry |
| `lib/monologue.js` / `lib/rumination.js` | tensions, circling metrics, reflection | Appraisal inputs (what's been gnawing) |
| `lib/self_model.js` | identity — STABLE, firewalled | **Never written by affect** (the drift lesson; both design docs pin this) |
| absence doctrine (08-31, `lib/cognition.js`) | every DB miss → honest say + enqueued pursuit | The "proactively fill missing spots" half of the order — already live for knowledge; the impression store extends it to feeling |
| `lib/analysis_lane.js` (R3) | throwaway **python** against live DBs, SQLite `mode=ro`, jailed dirs, hard timeout, output cap | **The python-tissue execution substrate already exists** — read-only, write-incapable by construction |

**Key structural fact:** Lucas's "python neural tissues" have a ready home. R3 already runs ephemeral python read-only over sq.db + the Echo graph with the exact safety posture a tissue needs (SQLite-rejected writes, baked-in paths, no secrets, bounded time/output). A scheduled affect pass = an R3-shaped script promoted to a recurring lane, writing its manifest through ONE narrow code-side landing door (the propose→gate pattern, applied to feeling).

## 3. Prior-art survey — existing experimental code

*(Four parallel research passes: MicroPsi · BayesACT/ACT · appraisal engines (OCC/GAMYGDALA/WASABI/FAtiMA/EMA) · PAD/Plutchik/OpenPsi/lexicons. Findings merge here when the passes land.)*

### 3a. MicroPsi / MicroPsi2 (Joscha Bach) — motivation-first architecture — **FIT 5/5: the framing's ancestor**
*(landed — repo cloned, the emotion operator extracted AND executed standalone on Python 3.13 with a 10-line stub: it runs, sane trajectories. Scratchpad `micropsi2/` + extracted papers `agi15_bach.txt`, `aaai2018_scan.txt`)*

**License result: MIT** ("All parts of MicroPsi2 are under MIT license," © 2015 micropsi industries). The framework is dead (Theano-era pins) — but the emotion core is **stdlib-only and 132 lines total**: `micropsi_core/nodenet/stepoperators.py` (`DoernerianEmotionalModulators`, 86 lines) + `micropsi_core/emoexpression.py` (46 lines).

**Mechanism as shipped (exact):** world demands (energy/water/integrity with per-tick decay) → writeable `base_*` scalars (importance/urgency of intentions, active-motive count, **counted expectation successes/failures from script execution** — surprise is literally counted prediction failures) → one step-operator pass → `emo_*` modulators:
- `emo_activation = (Σimportance + Σurgency)/(2·motives+1) + urge_change` · `emo_resolution = 1 − activation` · `emo_selection_threshold = activation`
- `emo_valence = 0.5 − urge_change − Σurges` · pleasure = `gentle_sigmoid` of (expected−unexpected)/10 + satisfaction term
- `emo_competence` = running success ratio with asymmetric divisor (failures hit twice as hard), clamped [0.01, 0.99]

**The readout is the manifest law embodied — labels are DERIVED, never stored:**
```
anger    = (1 − competence) × activation        sadness = (1 − competence) × (1 − activation)
surprise = unexpectedness                        pain    = 1 − integrity
```
Same low-competence state, split by arousal into anger vs sadness — emotion as a *configuration readout* of modulators, with every term traceable to counted events.

**The published model is the better spec (AGI-15 + AAAI-18 tutorial, equations extracted):** N demands each with set-point + personality params `[weight, decay, gain, loss]`; physiological/social/cognitive families — **affiliation (fed by "legitimacy signals" — praise, weighted by source reputation), competence, exploration/uncertainty-reduction, aesthetics**; `urge = |setpoint − value|`, pleasure/pain = the *derivative* of demand levels; decay linear in sigmoid-space; **imagined events move the same needles as real ones** (anticipation/dread for free); marginal-sum (saturating) aggregation → `target_valence/arousal/aggression` (explicitly PAD-mapped); six modulators each with **baseline/range/volatility/duration temperament params** — value chases target at volatility speed, relaxes to baseline over duration (personality = motivation params; temperament = modulation params; Big-Five mappings given). Emotions = named regions of the configuration space, directed emotions = affect + a bound object.

**Portability: re-implement, don't import** — the full published model ≈ **250–450 lines pure-stdlib python**, microsecond ticks; the repo is the reference implementation and test oracle. Caveats: fear is a TODO in shipped code; several magic constants uncalibrated; the temperament layer exists in slides only. The 2019 AGI paper (Bach/Coutinho/Lichtinger) extends exactly this model **for conversational agents** — the closest published precedent for our use case (paywalled, no code).

**Direct mappings to the program:** MicroPsi's demand set is nearly one-to-one with live drives — affiliation ≈ `drives.social`, exploration/uncertainty ≈ `drives.curiosity` + the flare/absence machinery, competence ≈ the missing win/loss ledger (§1a's cure feeds it) — and "legitimacy signals weighted by source reputation" is Lucas's praise/correction channel, named in 2015.

### 3b. BayesACT / Affect Control Theory — the probability-matrix match — **FIT 5/5**
*(landed — the 0.5.1 source was downloaded and inspected file-by-file, session scratchpad `bayesact-0.5.1/`)*

**This is literally the requested shape**: empirically fitted internal weight matrices deterministically compute the feeling — a deflection scalar, per-dimension reasons, a wanted-behavior vector, a named emotion — in microseconds, no LLM anywhere in the loop.

**Mechanism (verified in code + the AIJ paper):**
- Every concept (identity, behavior, emotion word, setting) = an **EPA 3-vector** (evaluation-potency-activity, −4.3…+4.3; EPA ≈ PAD). An interaction state = 9-dim (actor, behavior, object).
- `f` = fundamental (culturally learned sentiment, dictionary lookup) vs `tau` = transient (situational impression). **Impression formation: `tau' = Mᵀ·g(f', tau)`** where `g` = products of state elements (linear + 2-way + 3-way interactions) and **M is a 20×9 plain-text coefficient table (~1.5 KB)** — the whole "probability matrix" is a tiny file.
- **Deflection `D = Σ wᵢ(fᵢ − tauᵢ)²`** = "how wrong does the situation feel," decomposable per role × dimension — free `reasons[]` for the manifest.
- **Wanted behavior** = one 9×9 linear solve — the EPA of the act that would minimize deflection: near-instant "what she's moved to do."
- **Emotion equations** (9×3 table) + a 301-word EPA modifier dictionary label the state with an emotion word by nearest neighbor.
- The Bayes wrapper (particle filter + POMCP planning) exists for unknown identities and action planning — **leave it behind**; the deterministic core is the value.

**Availability / license (the trap and the route around it):**
- Current engine (C, v2.3.8): private repo, email-gated from Hoey. Public python is 0.5.1 — **Python 2.7**, license "research only, do not redistribute."
- **The clean-room route:** **actdata (ahcombs.github.io/actdata) is CC0** — ~30 standardized EPA dictionaries (largest: usfullsurveyor2015 — 929 identities / 814 behaviors / 660 modifiers, means+SDs) + **9 equation sets × 5 equation types**, and **inteRact (MIT, R)** is a pure deterministic reference implementation proving the core ports in a few hundred lines. Build from the CC0 tables with inteRact as reference; never touch the 0.5.1 license.
- Port estimate: **~200–400 lines of python (numpy or stdlib), ~100–150 KB of coefficient/dictionary text.** Nothing on PyPI (all name probes 404).
- Integration caveat: ACT thinks in actor-behavior-object event grammar — a thin adapter labels each conversational event with dictionary terms; actdata's `mostafaviestimates2022` (BERT-estimated EPA for out-of-dictionary words) covers the gap.

**Why it matters for the impression store specifically:** attachment/relational affect falls out natively — hold a fundamental EPA per person (who they are to her), compute deflection when events push the transient around: "Lucas praised the report" and "a stranger deleted her rows" produce different, decomposable, dictionary-grounded feelings about *those people*.

### 3c. Appraisal engines — OCC, GAMYGDALA, WASABI, FAtiMA, EMA
*(landed — mechanisms extracted verbatim from source, not papers)*

**GAMYGDALA — FIT 5/5, and a stdlib-only python port already exists** (`langerv/gamygdala`, MIT, active Oct 2024, ~44 KB, zero deps beyond time/math/threading; low-star, so diff-audit against the JS original before trusting). The core math:
- A Belief = {likelihood, causalAgent, affectedGoals[], congruences[]}; per goal: utility [−1,1], likelihood [0,1].
- `deltaLikelihood` from the belief update; **`intensity = |utility × deltaLikelihood|`** — zero intensity mints no emotion.
- Emotion selection by (utility sign × likelihood position): mid-likelihood → hope/fear; confirmed → joy/distress (+satisfaction/fears-confirmed if unexpected); disconfirmed → disappointment/relief.
- **Social emotions via relations** (like [−1,1]): happy-for / resentment / pity / gloating by sign pair; agent-directed gratitude/anger with `intensity = |utility × deltaLikelihood × like|` — per-person feeling falls out of the same table.
- Read-time squash `gain·I/(gain·I+1)`; exponential wall-clock decay, prune below 0.001. No mood baseline (everything decays to zero) — which is exactly what WASABI/ALMA supply.

**WASABI — FIT 4/5, the dynamics substrate** (C++ frozen 2013; port ≈ 150–250 LOC, zero deps). The whole appraisal interface is ONE signed scalar impulse; then 50 Hz Euler physics on three scalars:
- spring pulls emotion `x` to 0 (`Fx = −xTens·x`, mass 1000); spring pulls mood `y` to `prevalence`; **the coupling term `y += x·(slope/100)/mass` leaks emotion spikes into slow mood**; boredom `z` drifts down when quiet; anti-oscillation snap at zero-crossing.
- PAD mapping: `P = (x+y)/2 · A = |x|+z · D = cognition-set`; named emotions = PAD-space vertices activated by distance ramp.
- Caveat: xTens/yTens/slope defaults live in config (`init.emo_dyn`), not the constructor — pull thesis values at port time.

**FAtiMA-Toolkit — FIT 4/5, the best-engineered intensity math to steal** (C#, Apache 2.0, active 2024). Full 22-emotion OCC derivation table from appraisal variables in [−10,10]; then per-emotion lifecycle:
- threshold subtraction at birth; **exact half-life exponential decay** (`I = I₀·e^(λ·Decay·Δtick)`, λ from a configured half-life);
- **log-sum-exp reinforcement** on repeat stimuli (`I = ln(e^P + e^p)`) — repeated events add diminishingly, the natural cure for the §1a saturation class of disease;
- a mood scalar [−10,10] fed by emotion valence × influence factor, its own half-life, and congruent-mood amplification of new emotions.

**Dead ends, confirmed:** EMA (Gratch/Marsella) — no code was ever released (PsychSim is the nearest lineage, un-extractable); Soar/ACT-R emotion modules — papers only; EMgine — design docs, near-zero code; no mature standalone python OCC engine exists beyond the GAMYGDALA port.

**The pass's recommended composite (~600 LOC, dependency-free, fully deterministic):** GAMYGDALA appraisal core (event+goal → named emotion + intensity + traceable (belief, goal, deltaLikelihood) reason) → signed intensities as WASABI impulses → x/y/z mood dynamics — with FAtiMA's half-life decay + log-sum-exp reinforcement replacing GAMYGDALA's bare exponential. Every emotion instance carries its cause; the LLM translates.

### 3d. PAD dynamics, Plutchik models, OpenPsi, and affect lexicons (the candidate internal weights)
*(landed — 22 findings, all primary pages verified; full table in the sweep transcript)*

**The weights exist as files.** Lucas's "make the model weights that would control organic emotion internal to the program" has a literal answer — human-normed affect lexicons, plain TSV/CSV, loadable into sq.db as tables:

| Lexicon | Content | License | Direct download |
|---|---|---|---|
| **NRC VAD v2.1** (Mar 2025) | **55k+ terms × real-valued valence/arousal/dominance in [0,1]** (`term<TAB>v<TAB>a<TAB>d`) | free for non-commercial research; **no redistribution** (bundle locally, never republish); commercial = nominal NRC fee | saifmohammad.com/WebDocs/Lexicons/NRC-VAD-Lexicon-v2.1.zip |
| **NRC EmoLex** | 14,182 terms × binary Plutchik-8 + pos/neg (categorical color: wonder ≈ anticipation+surprise+joy) | same NRC terms | .../NRC-Emotion-Lexicon.zip |
| **Warriner et al.** | 13,915 lemmas, 1-9 V/A/D human ratings + SDs — independent cross-check for NRC | CC BY-NC-ND 3.0 | raw.githubusercontent.com/JULIELab/XANEW/master/Ratings_Warriner_et_al.csv |
| **VADER** | ~7.5k valence-rated tokens + 5 negation/amplifier rules | **MIT — code AND lexicon** (the only fully license-clean one) | github.com/cjhutto/vaderSentiment |
| SenticNet 8 | 400k concepts, affective KB | murky (non-commercial free, informal terms) | skip for now |

A private local research program qualifies for the NRC terms; the rail is **never `git push` the lexicon files** (local bundle only — same posture as the Echo mirror).

**The reference pass already exists in python:** **EmotionDynamics (github.com/Priya22/EmotionDynamics)** — pure-python, lexicon-driven, fully deterministic: rolling word-windows over ordered utterances → per-window mean VAD → **Utterance Emotion Dynamics metrics: home base, variability, rise rate, recovery rate per speaker**. This is the closest existing thing to the planned tissue: steal the code AND the metric vocabulary (home base ≈ temperament baseline; rise/recovery = mood dynamics *measured, never asserted*).

**The dynamics math, portable as ~100 lines of numpy (port math, never code):**
- **WASABI** (Becker-Asano, C++ frozen 2013, LGPL): stimuli → "emotional impulses" driving a spring-damper x/y (emotion/mood) system mapped into PAD space; distance-to-anchor triggers named emotions; boredom drifts on idle. Every equation + constant is in the thesis (becker-asano.de/Becker-Asano_WASABI_Thesis.pdf).
- **ALMA** (Gebhard, AAMAS'05): personality (Big Five) → a **default PAD mood point**; mood is exponentially pulled back to that personality anchor at distance-dependent speed; OCC events push it. The pull-to-personality-baseline mechanic = temperament/attachment anchor, directly.
- **OpenPsi** (OpenCog; cleanest restatement = MIT `hyperon-openpsi`): demand nodes with current-vs-desired value, **urge = gv − dgv**, urge-weighted action selection. Concept ports in ~200 lines; the original Scheme/C++ does not.
- **emotion-engine** (pioneerjeff-labs, 2025-26, MIT): persistent PAD + decay-to-baseline + a slow **trust** variable + JSON state contract — philosophy inverted from ours ("LLM decides, engine remembers") but the decay/trust bookkeeping is liftable.

**Appraisal-with-reasons, smallest real engine:** **GAMYGDALA** (broekens/gamygdala, **MIT, one JS file**): agents own goals with utilities; events carry beliefs (likelihood × goal-congruence); engine deterministically emits OCC emotions with intensity + decay, **including relational emotions (pity, anger-at) via agent-agent relations** — and every emotion traces to a (goal, belief, likelihood-delta) triple, which IS the manifest's `reasons[]` field. Python port ≈ one day.

**The map:** survey "Start Your EM(otion En)gine" (arXiv 2307.10031, 2023) catalogs the whole engine landscape. Fringe idea bank: HELT (arXiv 2605.13858, 2026) — six hormone variables with per-hormone decay (dopamine/serotonin/cortisol-style), a hormone-decay state design worth remembering.

**Sweep's top-3 ranking:** (1) NRC VAD + EmoLex as weights with EmotionDynamics as the reference pass — covers valence/arousal nearly off the shelf; (2) WASABI dynamics + ALMA pull-back as the mood-inertia/temperament layer; (3) GAMYGDALA for appraisal-with-reasons. Runners-up: ACT EPA dictionaries + deflection (relational affect, §3b), MicroPsi urge/modulator math (wonder-as-certainty-drive, §3a).

## 4. The per-subject IMPRESSION schema (finalized against the survey)

The global vector answers "how is she." The order's larger half is "how does she feel **about X**" — a per-subject impression, computed, cached, decayed:

```
impression(subject) = {
  valence       // signed, decayed sum of appraised encounter impulses (FAtiMA-style half-life;
                //   log-sum-exp reinforcement so repeats add diminishingly — the anti-saturation rail)
  arousal       // |recent impulses| × recency envelope — how activating the subject currently is
  attachment    // GAMYGDALA-style relation value in [−1,1], grown from encounter_frequency ×
                //   orbit_distance(owner-world) × valence_history; ALMA-style: acts as the subject's
                //   personal mood ANCHOR (a loved subject's baseline is warm, not neutral)
  epa           // optional EPA 3-vector: the subject's FUNDAMENTAL from actdata dictionary terms
                //   (identity words) — enables ACT deflection ("they acted off-character" as a feeling)
  wonder        // knowledge_gap (coverage vs. touch count, absence-pursuit hits) × salience
                //   — MicroPsi's exploration/uncertainty urge, per-subject
  want_links    // open pursuits/interests referencing the subject (interests table + pursuit queue)
  fear_links    // negative-consequence associations (guarded; sparse by design)
  reasons[]     // MANDATORY provenance — every number names the encounters/appraisals that made it
                //   (GAMYGDALA's (goal, belief, deltaLikelihood) triple is the reference shape)
}
```

All inputs already exist as exhaust: encounter rows, owner-world orbit, appraised impulses (post-§1a-cure), interest weights, absence-pursuit queue. Deterministic SQL/python; decay computed **lazy-on-read** (store impulse log + last-computed state; no sweep over thousands of subjects); injected as a compact manifest block beside the coordinates. Relational emotions come free from the GAMYGDALA table: an event that hurts a subject she's attached to yields pity; one that helps a disliked namesake-spammer yields the other column.

## 5. Synthesis — the recommended architecture (what the survey + inventory compose into)

Four layers, each deterministic, each carrying reasons; the frontier voice touches only the last:

| Layer | What | Source | Status |
|---|---|---|---|
| **L0 — weights** | NRC VAD v2.1 (55k×3) + EmoLex (14k×8) + actdata EPA dictionaries & equation tables (CC0) + Warriner cross-check, loaded as sq.db tables. **Local bundle only — NRC terms forbid redistribution: never `git push` the lexicon files** (same rail as the Echo mirror). | §3d, §3b | data exists; needs download + land |
| **L1 — global state tissue** | `internal_state.js` drives + VAD. Cure the §1a one-signed appraisal (B0); later upgrade the flat decay to WASABI two-layer dynamics (emotion x drags mood y via the slope coupling; ALMA personality anchor as the decay target). | exists + §3c math | LIVE dark; B0 = first build |
| **L2 — appraisal tissue** (python #1) | Clean-room GAMYGDALA-shape core (~300–600 LOC stdlib): goals = her real pursuits/interests with utilities; events = exhaust; out = named emotions + intensity + (goal, belief, delta) reasons. MicroPsi demand/competence math feeds the appraisal variables; FAtiMA half-life + log-sum-exp for the lifecycle. Runs in the R3 posture (SQLite `mode=ro`, jailed, capped). | §3c + §3a | build |
| **L3 — impression tissue** (python #2) | The §4 schema per subject; EPA fundamentals + deflection for relational feeling; one narrow code-side landing door for manifests (propose→gate, applied to feeling). | §3b + §4 | build |
| **L4 — translation** | Manifest block beside the coordinates; `mood.js` renders the vector (the 08-14 proposal's Slice 1); the frontier voice translates. **Anti-performance rule stands: felt aliveness earned from state, never scripted into prose.** | exists | wire after B0 proves honest |

The swarm-tissue fit: each tissue is an independent deterministic pass — the global tick stays in-process JS (cheap, already live); the python tissues run as R3-shaped lanes, parallelizable per subject (the fan's shape), each emitting a manifest with reasons. **Reference implementations live in this session's scratchpad** (micropsi2 clone + executed operator; bayesact-0.5.1 source) — session-temporary; re-clone from the §3 URLs at build time, and use them as **test oracles**: our clean-room ports must reproduce their trajectories on fixed inputs.

## 6. Build slices proposed (each gated; stop anywhere and the system is no worse)

| Slice | Build | Evidence/gate |
|---|---|---|
| **B0 — appraisal symmetry** — ✅ **BUILT 08-31 night** (gate 590 green) | `win` kind appraised (+v +d, small +a) in `internal_state` v3 (MODEL_VERSION 3 — the saturated v2 journal restarts clean); emitted from `recheck_queue.complete()` (pursuit-resolved = the universal satisfaction signal; defer is the failure path so `done` is honestly a win) + the road registered-delivery site. Deliberately NOT emitted: `_markRunConsumed` (deposit ≠ delivery) and operator turns (test-port turns are indistinguishable from real ones at the intake — a real-turn discriminator must come first). 8 new pins. | the 51h saturation read (§1a); remaining proof = a fresh dark window showing v/a alive off the clamps (watch item) |
| **B1 — weights land** — ✅ **BUILT 08-31 night** (downloads authorized by Lucas) | `data/affect_weights.db` compiled by [tissues/build_weights.py](../tissues/build_weights.py): **54,801 VAD terms** (⚠ v2.1 is SIGNED [−1,1], not v1's [0,1]) + 13,872 EmoLex tags + 13,915 Warriner + 2,403 EPA concepts + 48 ACT equation rows. Sources in git-ignored `data/lexicons/` (NRC never redistributed); actdata CC0; MIT reference code vendored in `tissues/vendor/` (micropsi2 core + langerv gamygdala port — the port's own test RUNS end-to-end incl. decay). | row counts + known-word spot checks all green (love +, dread −, abandon→fear, hero high-E, 9-coeff constant row) |
| **B2 — appraisal tissue** — ✅ **BUILT 08-31 night** | [tissues/tissue_appraisal.py](../tissues/tissue_appraisal.py): obs wins/needs/stress + his turns + her intake, lexicon-read → instances with MANDATORY reasons (GAMYGDALA shape) → FAtiMA half-life decay → WASABI-lite x/y mood with the coupling slope. Per-pass impulse **soft-squashed** (`raw/(1+|raw|)`) — the v2 saturation lesson applied on day one, pinned. Driver [lib/affect_tissues.js](../lib/affect_tissues.js) rides the existing 10-min tick: due-gated 30 min, idle-gated, sequential, below-normal priority, 60s hard timeout, kill switch `swarm.tissues`. DARK — manifests in `data/affect/`, zero consumers. | smoke_affect_tissues (33 pins): replay determinism byte-for-byte, decay, cursor rail, **the RO rail (fixture db hash unchanged across five passes)** |
| **B3 — impression tissue** — ✅ **BUILT 08-31 night** | [tissues/tissue_impression.py](../tissues/tissue_impression.py): §4 schema v1 over owner-world subjects — valence (7-day-half-life encounter decay), arousal (48h envelope), attachment (tanh(log1p(n))×orbit×valence-lean), wonder (recency×(1−summary richness)), reasons mandatory. **Word-boundary matching** (Alicia ≠ Alice — the single-token disease pinned here too). Pure function of (db, now) — no state file. | same smoke: determinism byte-for-byte + reasons pins; manifest injection (the landing door into her context) is B4-adjacent, NOT yet wired |
| **B4 — mood renders the manifests** — ✅ **BUILT 08-31 night** | `affect_tissues.manifestLine()` — top named feelings WITH their trimmed reasons + the closest-subject impression, provenance-stamped ("computed Nm ago by the affect tissues"), staleness-gated at 45 min — joins `mood.compose`'s existing MEASURED STATE block beside the internal-state readings line (`_measured`). Same contract as Slice 1: measurements to be felt, never performed; manifest absent/stale → null → byte-identical prompt. (The vector-side render was already live since 08-20; B4 adds the tissue half.) | smoke_affect_tissues B4 block + smoke_mood B4 pins (both lines together / either alone / full fail-absent) |
| **End gate** | the blind-week probe (proposal §5b) — unannounced week; Lucas names ≥3 colleague-moments, each traceable to a logged trajectory | the "feels alive" contract |

## 7. Open questions / asks

1. **B1 needs his word:** downloading NRC-VAD-Lexicon-v2.1.zip + NRC-Emotion-Lexicon.zip (saifmohammad.com, ~few MB each) + the Warriner CSV + actdata tables — file downloads wait for an explicit OK.
2. The two design docs' calibration questions stand (Brier ground truth for appraisal predictors — hardest unsolved measurement; the §3c engines are rule-calibrated, not learned, which sidesteps it for v1).
3. Empathy stays research-grade (other-state modeling — the relational layer's territory; ACT deflection is the nearest computable proxy). Imagination = recombination sampling over the graph (R3 lane) — separate card.
4. THE FAN (multi-vector concurrent retrieval) is the sibling directive — assess after this lands; the tissue lanes are already fan-shaped.
