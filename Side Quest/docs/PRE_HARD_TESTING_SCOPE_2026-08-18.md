# Pre–Hard-Testing Build Scope

*Written 2026-08-18. The integrated, sequenced scope that must land before the next hard testing rounds. Draws on the live backlog audit (pulled 2026-08-18), the stochastic-layer evaluation workflow, the [smoothing seam-map](CONSCIOUSNESS_THEORIES_AS_SMOOTHING_2026-08-18.md), and Lucas's "no loop without analyze→replan" invariant.*

## Thesis

Two things gate honest hard testing, and both are in this scope before any new capability:

1. **Observability** — you cannot trust an agent you cannot watch. The backlog exists because producers failed *silently*; the same blindness would hide a regression during testing.
2. **Reproducibility** — you cannot hard-test a non-deterministic agent. The `:8767` diff harness must be replayable run-to-run, which the scattered randomness currently erodes.

Everything else (drains, smoothing) sequences behind those two.

## The one governing invariant

Every item here obeys one line, already honored by the two fixes shipped this session:

> **Smooth dynamics and strategy — how a value moves, which approach is tried, when a behavior fires. Never smooth source — where a fact comes from.**

- The [chain-guard replan layer](../lib/chain_guard.js) changes *strategy* (try a different approach), never invents a fact.
- The [certainty.js](../lib/certainty.js) hygiene fix removed a chance-valued *source* from the confidence path.
- The stochastic `entropy` module (Wave 2) is allowed *which/when*, firewalled from *find/rank/ground/verify/cite/write*.
- The [smoothing primitives](CONSCIOUSNESS_THEORIES_AS_SMOOTHING_2026-08-18.md) smooth measured *trajectories*, never the measurement.

## Shipped this session (Wave 0)

| Commit | What | Proof |
|---|---|---|
| `0bf75d5` | Chain-guard replan layer — no retry loop hammers a known failure; refuse exact repeats, analyze→replan each no-progress hop, honest miss only when the full hop budget is spent | Gate 541-green, 31-assert smoke, live-verified (Womack loop gone, grounded answer) |
| `040e35a` | Removed dead chance-valued "source" from the confidence path + firewall lint (`certainty.js` has no `Math.random`) | Gate 541-green, `smoke_certainty` 20/20 |

## The waves

### Wave 1 — Foundation: observability + structural firewall  *(do first)*
The disease behind the backlog **and** the prerequisite for trusting the test rounds.

- **1a. Producer heartbeat / last-write watchdog.** ✅ **SHIPPED `e23d6eb`** — `lib/producer_vitals.js`, interoception for the producer lanes (obs_bus lane `producer` → self_watch; boot-grace, pre-boot-silence-counts, read-failure-is-not-a-stall). Local core watches synthesis + idle-loop liveness; 14-assert smoke, gated. **Two measure-first findings:** synthesis is NOT dark (wrote 8m ago — audit stale), and Echo's `sources` is a **7-row one-time seed** (a 14h burst 54d ago), *not* a continuous lane — watching it would false-alarm. **Echo-side producers DEFERRED, deliberately:** the real Echo failures (15,227 stuck jobs, the growing dedup queue) are **count-shaped, not staleness-shaped** — a separate queue-depth watcher, a different organ; and entity-ingest freshness has no `updated_at` index (a 1.8M-row scan). Not rushed into the staleness watcher.
- **1b. Structural firewall test.** ✅ **SHIPPED `e48ff0e`** — `smoke_epistemic_firewall.js` scans 11 fact-path modules for `Math.random` + any `require('./entropy')`; all already clean, now locked. "Smooth dynamics, never source" is a gate, not a hope.

### Wave 2 — Reproducibility: the governed `entropy` module  ✅ SHIPPED 2026-08-18 (⚠️ reproducibility RE-SCOPED — cloud finding below)
From the stochastic-layer verdict: **adopt, narrow + governed.** The "~94 `Math.random` sites" was a monorepo-grep artifact; the real live behavioral randomness was small (`interests.js`, and the now-**deleted**-because-dead `monologue.js` older-pair pick) plus hardcoded LLM temperatures (0.7–0.95) — governed at the ONE local-model chokepoint rather than chased per-caller.

**SHIPPED + pushed + live-verified** (origin/feature/idle-passive-intelligence):
- `552ba69` **2a/2b** `lib/entropy.js` — seedable splitmix64, independent per-lane sub-streams (a draw in one lane can't shift another), named distributions (pick/int/bernoulli/jitter/epsilonGreedy/softmax), 3 modes (prod/seeded/deterministic), a `stream()` rng drop-in, a `temperature()` lever, a capped decision journal. `smoke_entropy` 42/42.
- `55517fd` **2c-migrate** interests → `interests.topic` / `interests.spawn` lanes (injectable-rng contract preserved); deleted the dead `sampleRandomOlderPairs`; `smoke_entropy_firewall` scans all 408 lib modules for a real `Math.random(` call, only 3 documented non-behavioral utils allowlisted (run-id / retry-jitter / image-seed). 7/7.
- `6ec0b49` **2c-chokepoint** `ollama.streamChat` → `_govern`: temperature → 0 (greedy) in deterministic mode + a fixed replayable seed in the test modes; **prod is a true no-op** (proven across all streamChat-using suites); the fact path (`completeDetailed`, temp 0 already) untouched, so entropy never governs a judgement. 11/11.
- **LIVE DRILL — CORRECTED finding (the first drill tested the WRONG model).** The reply is written by `cloud_logic.streamCloud` → `ollama.streamChat` (a CLOUD frontier model, resolved `deepseek-v4-pro:0813` via `ollama.com`), NOT the local model. `_govern` correctly set `{"temperature":0,"seed":…}` on the cloud request — but two runs at temp 0 + a fixed seed returned **different** sentences (138 vs 148 chars). **The cloud provider does NOT decode deterministically at temp 0 + seed — byte-identical reproducibility is UNAVAILABLE for the real reply chain.** (The local `gemma4:12b` fallback IS byte-identical at temp 0, but it never writes replies — that proof is moot.) **Consequence:** hard testing cannot byte-diff a turn. It must diff the GOVERNED layer — behavioral draws (pinned by entropy), route, tool-call sequence, grounded FACTS — and tolerate cloud prose variance. Wave 2's real win: the CONTROLLABLE variance (which behavior/when + the local path) is reproducible and the seed is logged; the cloud prose was never controllable. The prod boot still logs its crypto seed once (`[entropy] mode=prod seed=0x… — replay`).

- **2a. `lib/entropy.js`** — one seedable PRNG (in-repo, no dep), named distributions (`pick`/`epsilonGreedy`/`softmax`/`bernoulli`/`jitter`), a **required `lane`** per call, per-lane sub-streams (`splitmix64(seed ^ fnv(lane))`) so adding a draw in one lane can't shift another's sequence, and a structured log line per sampled decision. **Effort M · blast med.**
- **2b. Boot seed + two test modes.** Prod reads `ZOE_ENTROPY_SEED`, else draws crypto-random and **logs it once** (any session replayable post-hoc). `ZOE_ENTROPY_MODE=deterministic` collapses expressive variance for byte-comparable grounding drills; `=seeded` keeps real sampling but reproducible for behavioral drills. **Effort S · blast low.**
- **2c. Migrate existing sites, all-or-nothing per lane** + a lint forbidding new `Math.random` in the behavioral surface (allowlist the non-behavioral utils: temp-filename/run-id, ollama/vision jitter). **Effort M · blast med · verify:** same `:8767` turn twice under a pinned seed is byte-identical.

> Consolidation is the safe core — it adds **zero** new stochastic decision points. The one genuinely new draw (an idle-lane mixture) is **in scope** (Lucas 08-18), sequenced *after* cleanup and behind the proven `interests.js` slice.

### Wave 3 — The replan audit (Lucas's invariant, generalized)
`chain_guard` is instance #1. Audit every other retry loop for the analyze→replan layer; add it where a loop can re-hammer a known failure:

- the operator tool loop, the roster swarm, the research/adaptive loops, the fetch-escalation lane.
**Effort M · blast med · verify:** per-loop smoke asserting a repeated-failure input replans rather than repeats.

### Wave 4 — Restore dark producers, then drain the backlog
Producers first (so drains don't re-accumulate), then the piles.

- **4a. Subconscious synthesis + self-dialogue lanes** — ⚠️ **UPDATE (Wave-1 heartbeat, live 2026-08-18): synthesis is NOT dark — it wrote 8 min ago.** The audit's "dark 48d" was a stale point-in-time memory. This narrows 4a to *confirm-and-close* synthesis and verify `self_q`/`self_a` self-dialogue separately. **Effort S · blast low.**
- **4b. Drain + wire the queues** (each: fix the producer/consumer, *then* drain): entity-resolution adjudication (34,162) + link-grounding (10,232); surface the 160 finished deliverables + add the store-init guard that blocks a research run when the store is down; triage the 58 never-run passes (wanted vs dead) and fix/de-register the 4 broken ones; the Echo pass-fleet + identity crosswalk graded-wave repair (carve aftermath — **DO NOT mass-repoint**); restart the news/source lane (206 refs, 54d stale) and drain the decompose/contacts backlogs. **Effort L–XL · blast med–high · verify:** live count deltas + the heartbeat staying green.

### Wave 5 — Smoothing organ (in scope, behind Waves 1–2)
Per the [seam-map](CONSCIOUSNESS_THEORIES_AS_SMOOTHING_2026-08-18.md): the internal-state-vector organ (mood-decay Slice 1, idle-competition Slice 2) absorbs three seams; the two standalone wins (rumination gradient, graded salience) are separately queueable. **In scope (Lucas 08-18), behind Waves 1–2** — it's behavior change, so it must ride observability + reproducibility to be measured and replayed. Verify the `monologue.js:105` dead-code caveat first.

## Cleanup clusters → wave map

| Cluster (live count) | Root | Wave | Effort | Blast |
|---|---|---|---|---|
| Producer-failure blindness | no last-write watchdog | 1a | M | low |
| Synthesis measured ALIVE 08-18 (heartbeat); verify self-dialogue | stale audit → confirm-and-close | 4a | S | low |
| Entity-resolution + link queues (34,162 + 10,232) | adjudication/grounding never drains | 4b | L | med |
| Unsurfaced deliverables (160) + store-uninitialized | **discard tainted** (Lucas 08-18) + surface clean; add store-init guard | 4b | M | low |
| Saga passes (58 never-run + 4 broken) | **dead-post-carve → de-register/archive** (Lucas 08-18); fix/drop the 4 broken | 4b | S | low |
| Echo fleet + crosswalk frozen (carve) | husk-DB repoint; 97,630 unlinked | 4b | XL | high |
| News/source frozen (206, 54d) + decompose/contacts | arrival-path coupling; lane stopped | 4b | L | med |

## Decisions (RESOLVED — Lucas 2026-08-18)

1. **Wave 5 (smoothing organ)** — **build, behind Waves 1–2.** In scope; sequenced after observability + reproducibility so it's measurable and replayable.
2. **The 58 never-run passes** — **treat as dead-post-carve.** De-register / archive; do not run. Wave 4b for this cluster is cleanup, not execute.
3. **Echo graded-wave repair** — **agreed.** Proceed with the graded-wave crosswalk/Puller recovery (never a mass-repoint).
4. **The 160 finished briefs** — **discard the store-tainted ones**, surface only the clean.
5. **The idle-mixture stochastic draw** — **in scope** (the one genuinely new draw, behind the proven `interests.js` slice per W2).

Next build item: **Wave 1 — the producer heartbeat** (foundation for all of it).

## Testing sequence (honors "cleanup lands before hard testing")

1. Wave 1 live: heartbeat surfaces the real stalls; firewall test green.
2. Wave 2 live: **the reply chain is CLOUD-written and NOT byte-reproducible** — `streamCloud` resolved `deepseek-v4-pro:0813` and returned different output twice at the governed temp 0 + seed. Byte-identical turn diffing is OFF the table (a cloud-provider property, not a Wave-2 defect). Reproducible hard testing diffs the GOVERNED layer — behavioral draws (entropy-pinned) + route + tool-call sequence + grounded facts — and tolerates prose variance. (The local model IS byte-identical at temp 0, but it's the failure fallback, not the reply writer — a resident local model means a cloud call failed, so "no local model.") **Also a methodology note:** a two-reboot `:8767` diff is separately confounded by persistent conversation state (boot A's turn lands in `sq.db` before boot B fires) + the 120s active-window.
3. Wave 3 live: each audited loop replans on a repeated-failure drill.
4. Wave 4 live: heartbeat stays green as producers restart; count deltas confirm drains.
5. Only then — the hard testing rounds, now reproducible and observable.
