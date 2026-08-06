# Conditional Scenario Engine — Design Spec

> **Status: DESIGN ONLY (spec for review). No code yet.** The plan Lucas asked for before any build.
> Turns the forecasting machine from a nowcast into a **world-model**: name a hypothetical future ("Iran war
> hot on election day", "wildfire brownouts break through the heat"), estimate how it reshapes the race map,
> replay the election under that assumption, and show the delta vs. baseline. Companion to
> `FORECAST_MACHINE_HANDOFF.md` (the live machine this bolts onto).

---

## 1. The gap this closes
The live machine has two things that are NOT conditional-scenario analysis:
- The Monte-Carlo produces statistical **outcome** buckets (who controls each chamber) — not world-states.
- The reactor **reacts to real news** (`news_feed` events perturb races) — but you can't *posit* a future that
  hasn't happened and play it forward.

**What we're building:** the ability to assert a hypothetical shock, propagate it through the race model with
grounded (but honestly-uncertain) magnitudes, and compare the counterfactual forecast against baseline —
including **stacking** several shocks ("Iran war AND brownouts") to waterfall possible futures.

## 2. Core idea — a scenario is an injected hypothetical shock
The reactor already takes an event with a direction + magnitude and perturbs race margin/σ. A scenario is the
same operation with an **asserted** shock instead of a news-lane one. So we reuse the *perturbation primitive*
and add three things it doesn't have: (a) a way to DEFINE the shock, (b) a way to ESTIMATE its race-level
effects from a plain-English description, (c) a COMPARATIVE sim (baseline vs. scenario → delta).

Everything a scenario produces is **isolated and illustrative** — never merged into the live baseline forecast,
never written to the 24h memory rail as fact. It's a what-if lens, and labeled as one.

## 3. The scenario object (schema)
```
Scenario {
  id, name, description,             // "iran-war-hot"; free-text the user typed or picked
  status: 'hypothetical',
  assumptions: {
    intensity: 0..1,                 // how severe (scales magnitude)
    direction_hint?: 'auto' | 'toward_incumbent_party' | 'toward_out_party',
  },
  effects: Effect[],                 // ESTIMATED then FROZEN (audit trail)
  estimated_by: 'gpt-oss:120b', estimated_at, notes
}
Effect {
  selector: { scope: 'national'|'region'|'state'|'seatType', value?, competitiveOnly?: bool },
  margin_delta: number,              // points, signed toward D(+) / R(-)
  sigma_add: number,                 // added per-seat volatility (uncertainty rises under a shock)
  correlation?: { key: string, sigma: number },   // a correlated regional/thematic swing group
  direction_uncertain?: bool,        // true → run BOTH signs (see §6 honesty)
  rationale: string,                 // gpt-oss's reason → glass box
  confidence: 0..1
}
```
Effects are frozen after estimation so a scenario is reproducible and auditable (you can see exactly what
numbers produced a given delta).

## 4. The effect model — description → race deltas
Two stages, split the usual way (model judges, math computes):

**4a. ESTIMATE (gpt-oss:120b, `lib/scenario_estimate.js`, injected `ask`).** Prompt gets: the scenario
description + a compact seat-universe summary (regions, competitive-seat counts, incumbent-party mix) +
historical-analog guidance + a hard instruction to be TWO-SIDED and uncertain on ambiguous shocks. Returns a
JSON `Effect[]` (schema-forced, like `forecast_assess`). Numbers are ESTIMATES treated as wide-σ priors.

**4b. APPLY (pure, `lib/scenario_engine.js`).** Deterministic applicator resolves each effect's selector to the
matching races and adds `margin_delta` / `sigma_add`, attaching a `correlation.key` where present. Pure +
offline-smokeable with hand-written effects — no cloud needed to test the propagation math.

Selector resolution needs a **region tag per seat**, which doesn't exist yet (only the sim's optional
`r.region` knob). Small dependency: a `state → region` map (Census regions) plus named thematic zones
(e.g. `fire-west` = CA/OR/WA/AZ/NV). Lives in `lib/regions.js`.

## 5. Correlation — how a shock moves races TOGETHER
Geographically- or thematically-scoped shocks get a **correlated swing group** via the sim's existing
`regionSigma` + `r.region` mechanism (defined but currently off). The wildfire case: tag the 5 western states
`fire-west`, apply a competence/incumbent-punishment `margin_delta`, and set a `correlation` so those seats
swing together each iteration (a real regional event isn't independent across districts). National shocks
(Iran war) ride the existing `nationalSigma` plus an added national swing component.

## 6. Comparative sim + honesty rails
**Run:** `forecast_sim.simulate` on the baseline races, then again on the scenario-applied races (same seed →
the delta is the scenario's effect, not sim noise). Output the DIFFERENCE.

**Delta payload** (`forecast_service.buildScenarioDelta`): Δ P(D control) per chamber · Δ seat mean/band ·
the list of seats that FLIP (with before/after margins) · Δ probability of each of the 4 control scenarios.

**Waterfall:** apply scenarios in sequence, emit the cumulative delta after each — "possible futures" stacked.

**Honesty (non-negotiable, same laws as the rest of the machine):**
- **Two-sided direction.** Genuinely ambiguous shocks (rally-round-flag vs. war-fatigue) run BOTH signs and
  show a RANGE, never a single confident number. `direction_uncertain` forces this.
- Magnitudes **capped, provisional, audited** — every effect's `rationale` + `confidence` surface in the glass box.
- Scenario runs are **labeled hypothetical**, isolated from the baseline, never memorialized as fact.
- We can't backtest a hypothetical, but we CAN **bound magnitudes against historical analogs** (rally effects,
  disaster-incumbent penalties) drawn from real data — Slice 4.

## 7. Where it plugs into the existing machine
- `lib/scenario_engine.js` — schema + PURE applicator + comparative runner. **New.**
- `lib/scenario_estimate.js` — gpt-oss effect estimator (injected `ask`). **New.**
- `lib/regions.js` — state→region + named zones. **New (small).**
- `lib/forecast_sim.js` — already supports `regionSigma` + `r.region`; no change or minor.
- `lib/forecast_loop.js` — add `runScenario(baselineRaces, scenario, cfg)` (pure core + a live wrapper);
  baseline recompute is untouched.
- `lib/forecast_service.js` — add `buildScenarioDelta(base, scenario)` alongside `buildBalancePayload`.
- `renderer/forecast.{html,js}` — a scenario drawer (type/pick a future → live map delta). **Reboot-gated.**

## 8. Build slices (ordered for DEEPEST testing first — Lucas's principle)
- **Slice 0 — propagation core (no cloud).** Scenario schema + pure applicator + `lib/regions.js` +
  comparative sim + `buildScenarioDelta`. Prove the whole baseline→shock→delta math with HAND-WRITTEN effects.
  Fully offline-smoked. *This is the deepest-testable piece and it needs zero model dependency.*
- **Slice 1 — gpt-oss estimator.** Description → `Effect[]` JSON (injected `ask`, offline-smoked with a mocked
  ask). Now you can type a scenario and it fills in the effects.
- **Slice 2 — correlation + waterfall.** Named zones, correlated regional swing, sequential stacking of shocks.
- **Slice 3 — studio drawer.** The glass-box UI: type/pick a future, see the race-map delta live. Reboot-gated.
- **Slice 4 — magnitude grounding.** Historical-analog bounds (rally / disaster-penalty effects from real data)
  as sanity caps on estimated magnitudes.

## 9. Worked examples
- **"Iran war hot during voting"** → national scope, `direction_uncertain` (rally-toward-R vs. fatigue-toward-D,
  shown as a range), `sigma_add` everywhere (volatility up), extra weight on competitive incumbent-president-party
  seats. Output: a band on P(D House), not a point.
- **"Wildfire brownouts break through the heat"** → `region: fire-west` (CA/OR/WA/AZ/NV), competence/incumbent-
  punishment `margin_delta`, a `correlation.key = fire-west` swing group, magnitude scaled by how many
  competitive seats sit in the zone. Output: which western seats move and the chamber-control delta.
- **Stacked** → apply both; waterfall the cumulative delta.

## 10. Open questions / risks
- **Magnitude legitimacy.** Estimated effects are the weakest link (no backtest for hypotheticals). Mitigation:
  two-sided ranges + historical-analog caps (Slice 4) + loud "illustrative" labeling. Never sell a point estimate.
- **Region taxonomy.** Census regions are clean for geography; thematic zones (fire-west, oil-patch, rust-belt)
  are editorial — keep them a small, named, auditable map, not model-invented per run.
- **Scope creep into agent-driven scenario discovery** (Zoe proposing her own what-ifs) — explicitly OUT of this
  spec; this is operator-driven what-if analysis first.
```
```
