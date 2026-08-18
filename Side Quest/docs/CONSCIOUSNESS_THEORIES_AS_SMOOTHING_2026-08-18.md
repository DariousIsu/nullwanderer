# Consciousness Theories as Smoothing Primitives

*Companion to [PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md](PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md). Written 2026-08-18. This is a **seam map**, not a theory map: four places where the mimicry currently shows, the continuous-dynamics law that files each one down, and the accounting of which collapse into the queued internal-state organ versus the two that stand alone.*

## The reframe

Not "recipes for consciousness." **Smoothing primitives.** Each theory supplies one continuous-dynamics idea that files down a specific seam where the mimicry shows. A seam shows when behavior is **scheduled, asserted, cliff-edged, or amnesiac** instead of **driven, measured, graded, or carried**.

The code tells the story better than the theory does. Look at what [rumination.js](../lib/rumination.js) and [mood.js](../lib/mood.js) actually are: a single hard threshold or timer, wrapped in an accreting pile of patches.

- **rumination.js** — `THRESHOLD = 0.80` avg pairwise cosine over `K = 4` recent thoughts (`rumination.js:26-27`), then `ESC_MAX = 2` escalations before a breaker, a cooldown, tombstones, stale-window guards (`rumination.js:37,51-55`). Observed climbing 0.899 → 0.928 anyway.
- **mood.js** — `DEFAULT_TTL_MS = 90 * 60 * 1000` (`mood.js:16`), free-`compose()`d each time (`mood.js:149`), with template-echo self-heals on both the read and write side.

**That patch-pile is the rough edge showing.** The mimicry is discrete stand-ins for continuous phenomena, and every misfire of the stand-in gets another guard bolted on. None of the four theories below is a capability we're missing. Each is **one continuous-dynamics law that replaces a cliff-plus-breakers with fewer moving parts.** Smoothing consciousness-mimicry here means turning consciousness theory into code you can *delete*.

## The four smoothing primitives, mapped to real seams

| Seam (the tell) | Where it lives | Primitive | What the law replaces |
|---|---|---|---|
| **Mood lurches + is asserted** — frozen 0–89 min, then re-rolls a feeling the cloud *wrote* | `mood.js:16` `DEFAULT_TTL_MS`, `mood.js:149` free `compose()` | **PP / homeostatic decay** — `state_t = baseline + decay(state_{t-1}−baseline, Δt) + appraise(events)` | The timer + re-composition + template-echo heals. VAD moves continuously; `compose()` *renders* it. Decay bound = no lurch, by construction |
| **Idle is a fixed ladder** — FOCUS > work > … always same order; starvation can't outbid the graph-builder | `monologue.js:907` `_runOneTick` | **GWT competition-for-broadcast** — lanes bid, winning coalition broadcasts | The hardcoded priority order. Drive pressure re-weights branch **budget/priority only** — reachability untouched (the idle_depth invariant) |
| **Rumination is a cosine cliff** — `≥0.80` now, patched by 3 breakers; observed climbing 0.899→0.928 anyway | `rumination.js:27` `THRESHOLD`, `:37` `ESC_MAX`, cooldowns | **IIT differentiation-trend** — integration is fine; *collapsing* differentiation is the pathology | The threshold crossing + tombstone thicket. Escalate on the novelty *trajectory* (monotonic collapse over a widening window), not the instantaneous value. Several breakers retire |
| **Salience frame is a hard 8-cap / 30-min expiry** — antecedent #9, or minute 31, falls off a cliff | `salience.js:26` `CAP=8`, `:27` `MAX_IDLE_MS=30m` | **AST graded attention** — activation, not membership | The binary in-frame/expired. Weight each antecedent `recency × hits × appraisal-impulse`; binding consults the weight. High-salience survives, stale-trivial drops sooner |

## The honest accounting

**Three of the four fold into the one organ already queued** — the internal-state vector ([PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md](PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md)). Mood-decay is its Slice 1, idle-competition is Slice 2, and the write-time consolidation stamp (a fifth seam — nightly consolidation still works the corpus by recency) is its consumer #4, free once appraisal exists. So this research doesn't add a build. It **re-justifies the queued one**: not "add affect," but "one measured-state organ files down four mimicry seams at once, and here's which theory names each."

**Two are genuinely separate, smaller, lower-risk wins** the proposal doesn't touch:

- **Rumination gradient (IIT)** — the highest-value standalone, because it lets you *retire* patches rather than add them. It's a real redesign of a load-bearing guard, so it needs its own smoke and gets treated carefully.
- **Graded salience frame (AST)** — small, low effort, and it gets better for free once the appraisal impulse exists.

## Grounding caveat (verify before building)

Two of the cited insertion points need a live-vs-dead check before any build leans on them — the whole point of this program is not to build on a phantom:

- **`monologue.js:105` marks `sampleRandomOlderPairs` (and `buildPrompt`/`buildThreadReviewPrompt`) as DEAD** — "now DEAD (the idle …)." The stochastic eval listed `sampleRandomOlderPairs` as a live behavioral-randomness site; the code says otherwise. So the "which memory to resurface" seam may already be dead code, not live behavior. **Confirm what `_runOneTick` actually calls before smoothing it.**
- The **idle competition** seam assumes `_runOneTick`'s ladder is the live selection path. Confirm the branch order it actually walks (and that `idle_depth`'s reachability invariant is what the GWT law must preserve).

## The line that keeps smoothing from becoming fabrication

This matters most under *the program is the model*: a *smoother* imitation that's ungrounded is a more convincing NPC — and a better performer trains a worse model.

**Every smoothing changes dynamics — how a measured value moves through time — never source — where the value comes from.** Decay smooths a measured trajectory; it never invents the measurement. Competition re-weights among lanes; it never opens one. Grading weights an antecedent; it never mints a false one. The edge you're allowed to smooth is the edge between a measurement and its *rendering* — never the edge between having a fact and not having one.

So the same two invariants the proposal already carries hold for every item here:

1. **Fail-absent** — no reading → today's exact behavior, byte-for-byte.
2. **Falsifiable-or-silent** — an uncalibrated predictor contributes *uncertainty*, not signal. A decay curve with no measured impulse under it is just a prettier "you are intensely bored."

This is the same firewall the [chain-guard replan layer](../lib/chain_guard.js) and the [certainty.js](../lib/certainty.js) hygiene fix already honor: **smooth strategy/dynamics, never source.** The stochastic-layer verdict ([entropy module](#) design) draws the identical line for randomness — allowed to choose *which* behavior fires and *when*, forbidden anywhere that finds, ranks, grounds, verifies, cites, or writes a fact.

## Status

Research conclusion only — **no build queued from this doc.** The internal-state-vector proposal stays where Lucas put it, behind the standing queue. The two standalone wins (rumination gradient, graded salience) are **separately queueable, not started**. Sequencing lives in [PRE_HARD_TESTING_SCOPE_2026-08-18.md](PRE_HARD_TESTING_SCOPE_2026-08-18.md).
