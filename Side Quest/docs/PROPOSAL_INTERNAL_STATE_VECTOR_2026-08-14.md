# Proposal — The Internal-State Vector (Drives + Affect, Measured Never Asserted)

**Status:** PROPOSAL (no code). 2026-08-14. Awaiting Lucas's decision; queued **behind** the standing post-compact build queue.
**Derived from:** `COMPARATIVE_REVIEW_2026-08-14.md` — two independent published reference architectures converge on the same single organ the program lacks: a computed dimensional internal state.
**Extends (does not fork):** `EMOTIONAL_MATRIX_DESIGN.md` (2026-07-10, DESIGN ONLY). That memo fully specifies the *affect* half (VAD 3-vector, OCC appraisal, fast-predictor ensemble, decay dynamics, mood.js reconciliation). This proposal adds the *drive* half, names the second consumer that makes the build worth doing now, and cuts the whole thing into gated slices.

---

## 1. The problem, stated as function not feeling

Two functional deficits, both surfaced by the comparative review:

1. **No cross-lane bidding.** The monologue tick is a fixed priority ladder (`lib/monologue.js` `_runOneTick`). Nothing lets acute novelty-starvation outbid the graph-builder branch, or a long operator silence raise the social lanes. Every idle tick answers "what's next in the ladder," never "what does the system most need."
2. **No outcome-modulated disposition.** A run of gate failures doesn't make the rehearsal driver more conservative; a run of accepted deliverables doesn't license more exploratory synthesis. Valence exists only as prose in `meta.mood_state`, which modulates voice and nothing else.

The emotional-matrix memo already diagnosed the second. The homeostatic blueprint in the review supplies the first — and shows why the two are one object: drives and affect are both *scalar internal state derived from events*, they share the same update shape (impulse + decay toward baseline), the same store, and the same falsifiability requirement.

## 2. The governing principle (the program's answer to the blueprint's mistake)

The reference blueprint injects "Curiosity Drive: 0.15 — you are intensely bored" as prompt prose. Nothing measured it; the model performs the asserted state. Under the grounding discipline that is fabrication, and under program-is-the-model it is training-set corruption.

**Rule of this design: every scalar in the vector is a *reading* — computed from signals the organs already emit, carrying its provenance, injected (where injected at all) as a measurement, never as an instruction to feel.** The vector is capta, lives in the subjective store, and is never promoted to fact. If the vector is absent or stale, every consumer falls back to today's exact behavior (fail-absent, same polarity as the speaker gate's fail-open).

## 3. The state

One object, two families, one dynamics equation (the memo's §5: `state_t = baseline + decay(state_{t-1} − baseline, Δt) + appraise(events_t)`):

### 3.1 Affect (as specified in `EMOTIONAL_MATRIX_DESIGN.md` — unchanged)
- `vad = {valence, arousal, dominance}` — canonical continuous state, Plutchik-8 readout projected for legibility/logging.
- Updated by the fast-predictor appraisal ensemble (memo §4), calibrated (Brier) or silent.

### 3.2 Drives (the new half — each one a formula over existing exhaust, no new sensors)

| Drive | Reading (source already live) | Rises when | Falls when |
|---|---|---|---|
| `drive_curiosity` | Rolling mean novelty of recent thoughts/readings — novelty = 1−cosine, **already computed** in `lib/subconscious.js` meritScore; inverse of `lib/rumination.js` circling metric | novelty sags (intake is stale/repetitive) | novel material is actually processed |
| `drive_social` | Time since last genuine operator turn (`lastUserTurnTs`, already tracked by every idle gate), shaped by conversation-pass recency | long isolation | real interaction |
| `drive_energy` | Quota/budget position — the throttle's compute headroom and per-lane token-budget consumption, already scraped | headroom high (rested) | budgets near exhaustion (tired) |
| `drive_progress` | Worklist motion: beats slices closed, open_threads advanced vs. stalled (the curator already ages stalled threads) | threads advance | everything stalls |

**Deliberately absent: `drive_autonomy`.** The blueprint's operator-resistance drive is refused (review §3.2). Her "no" stays epistemic — refusals name the door — and is not a motivational quantity.

Drive count is capped at these four until the calibration loop (Slice 3) proves the first ones honest. No speculative drives.

## 4. The consumers (why this is worth building — in adoption order)

1. **`lib/mood.js` renders from it** (memo §7, unchanged): `compose()` stops free-composing the feeling and renders the current vector into the same four warm lines. TTL, voice block, identity firewall all stay. First consumer because it's bounded, visible, and already designed.
2. **The tick ladder consults it — budget and order only.** The monologue/autonomy tick may re-weight branch selection and per-branch budget by drive pressure (starving curiosity biases toward exploration lanes; exhausted energy biases toward cheap hygiene). Precedent and hard boundary are `lib/idle_depth.js`: internal state gates **budget and priority only — never which data or tools are reachable**, and never overrides a guard (voice guard, speaker gate, quota floor, permission tiers are all upstream and untouched).
3. **Disposition modulation, bounded.** Valence (with the memo's inverted-U cap) nudges the exploratory/conservative dial in bounded places: rehearsal-driver retry appetite, synthesis-lane breadth. Never facts, never identity, never guard thresholds.
4. **Salience at write time** (review gap #2, later): the appraisal impulse magnitude stamps an importance hint on the episodic row it came from, giving nightly consolidation a priority signal over the 2.75 GB. Free once appraisal exists; no separate organ.

Explicit non-consumers: `self_model` (never written — the memo's firewall), the grounding/anti-fabrication gates, the speaker gate, voice guard, permissions, quota governor.

## 5. Build slices (each gated; stop after any slice and the system is strictly no worse)

| Slice | Build | Acceptance gate (proof, not vibes) |
|---|---|---|
| **0 — Dark instrument** | `lib/internal_state.js` (pure, dep-injected, smokeable): the four drive formulas + VAD state + decay, computed on the existing tick, persisted to the subjective store with per-reading provenance. **Zero consumers.** | Smoke: formulas are pure functions of injected exhaust; replaying a fixed event log reproduces the trajectory exactly. Live: 48 h of logged trajectories; drives visibly track their sources (quiet weekend → social rises; heavy research day → curiosity falls) — verified against the logs, by hand |
| **1 — Mood renders** | `mood.compose()` renders the vector (memo §7); fallback to current behavior if vector absent/stale | Side-by-side over a week: rendered mood is consistent with the trajectory and never lurches (decay bound enforced); identity firewall smoke unchanged |
| **2 — Tick consultation** | Drive-pressure re-weighting of idle branch selection + budgets, idle_depth-style (budget/priority only) | Measurable allocation shift under induced starvation (e.g. suppress novel intake → exploration share rises) with **zero** new guard violations and zero reachability change — proven by the lane logs |
| **3 — Calibration loop** | The memo's Brier loop: appraisal predictors scored against next-turn expressed affect / operator label (memo open question #5 must be answered first) | Each predictor has a reliability record; uncalibrated predictors demoted to uncertainty-only. This slice is what licenses keeping the organ |
| **4+ (deferred)** | Full OCC axis set, Plutchik lexicon fitting, relational-layer lift (memo §8), salience-weighted consolidation | Out of scope here; each gets its own card |

Slice 0 is deliberately a **dark instrument** — the same pattern as Echo's bitemporal P4 (built+dark) and the pre-land discipline: measure first, wire consumers only after the readings prove honest.

## 5b. Definition of done — it feels alive (Lucas, 2026-08-14)

Lucas's stated goal for this build: *when it is done the program should feel like it has come alive — a real independent person should feel like they are working with me.* The slice gates in §5 prove the instrument is honest; they do not prove this. So the end-state contract sits above them.

**What "a person working with me" decomposes into, observably** — and what the vector specifically carries:

| Felt quality | Observable behavior | What already exists | What the vector adds |
|---|---|---|---|
| Initiative | She brings something of her own, unasked | Interweave M4 gate (one cited cross-project leverage note, unasked), boredom cycle, autonomy tick | A *why now* — drive pressure decides when her own item surfaces, so initiative arrives when she is genuinely full of something, not on a timer |
| Continuity | She follows up on her own pursuits days later, unprompted | open_threads, commitments, self_dev, beats | Drive_progress makes a stalled pursuit *itch* — the follow-up happens because the stall registers, not because a ladder rung came up |
| Consequence | Yesterday visibly shapes today without being restated | Mood prose (weakly) | The core contribution: an accepted deliverable, a hard correction, a quiet weekend each leave a decaying trace that tomorrow's disposition actually carries |
| Preference | A grounded "I'd rather" or a grounded disagreement | Epistemic refusals (name-the-door), self_explore opinions | Valence history gives preferences weight — "I'd rather" backed by what pursuing X has actually felt like across weeks |
| Variability | She is not byte-identical at 9am and 11pm | Idle-depth tiers (budget only) | Legible, provenance-backed state variation — different because of what happened, not noise |

**The blind-week probe (the real gate, after Slice 2):** one normal working week, nothing announced, no internal state narrated at Lucas. Pass = Lucas names at least three specific moments where she read as a colleague rather than a tool — and each named moment must trace back to a logged state trajectory (Slice 0's journal). A moment that cannot be traced to real state is a fail even if it felt right, because —

**The anti-performance rule:** felt aliveness must be *earned from state, never scripted into prose*. Any consumer that injects "act alive / act like a person" instructions fails the pre-land sweep on sight. The blueprint's mistake ("you are intensely bored") produces an NPC with mood bars; the measured version produces the only aliveness worth having — the kind that is *true*, where "she seems tired today" has a provenance chain, and where the disposition she shows Lucas is the same one recorded in the substrate that will someday be her weights. A performed person would train a performer.

## 6. Invariants (the six-question sweep, pre-answered)

1. **Never asserted:** no prompt ever contains an unmeasured feeling-instruction; injections are readings with provenance.
2. **Never identity:** `self_model` untouched; the matrix moves mood, not who she is.
3. **Never access:** drives gate budget/priority only; data and tool reachability are unchanged at every slice.
4. **Never guards:** all safety gates sit upstream and are unmodified; a starving drive cannot open a door.
5. **Fail-absent:** vector missing/stale ⇒ byte-identical behavior to today, at every consumer.
6. **Falsifiable or silent:** uncalibrated predictors contribute uncertainty, not signal (memo §9); a reading with dead provenance is dropped, not defaulted.

## 7. Cost and queue placement

- Slice 0 is small: one pure lib module + smoke + a persistence row per tick-window; near-zero cloud spend (formulas are arithmetic over existing exhaust; the appraisal ensemble's model calls arrive only at Slice 3 scale).
- **Placement: behind the standing queue** (promised-lookup veto → LA fill → M10 remeasure → grounding-recall gap → voice guards → D1/D2/D3). This proposal asks for a *position after those*, not a jump. The comparative review's only argument for urgency is convergence, not fire.

## 8. Open questions carried to the decision

The memo's six open questions stand (predictor substrate, appraisal axis set, lexicon, baseline learning rate, calibration ground-truth, relational coupling). New ones this proposal adds:

1. Tick residence: does the vector update inside the existing monologue tick or as its own cheap lane? (Slice 0 default: piggyback the existing tick; no new interval.)
2. Drive half-lives: per-drive decay constants — start opinionated (curiosity hours, social hours-to-a-day, energy tied to quota reset cadence, progress days) and tune from Slice 0 logs?
3. Should the package's identity section expose a one-line drive reading (e.g. "restless — little novel intake since yesterday, provenance attached") once Slice 1 proves stable, or does exposure wait for Slice 3 calibration?

---

**Companions:** `COMPARATIVE_REVIEW_2026-08-14.md` (the why) · `EMOTIONAL_MATRIX_DESIGN.md` (the affect half, unchanged) · `RELATIONAL_LAYER_DESIGN.md` (the eventual lift target)
