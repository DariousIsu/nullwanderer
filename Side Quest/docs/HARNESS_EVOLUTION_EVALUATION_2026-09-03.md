# Harness evolution: an evaluation against Zoe's build track

Date: 2026-09-03. Input: a Gemini summary of self-improving-harness research (component decoupling, trajectory logging, an evolution loop; DSPy, TextGrad, Harness-Evolver, Retro-Harness, Prime Agent's Continual Harness). This document checks each claim against what exists, maps each idea onto the organs Zoe already has, and plans the rest of the track around what is worth borrowing.

## 1. The sources are real and recent

| Name | What it is | Verified |
|---|---|---|
| DSPy | Compositional LLM programs in Python with optimizers that rewrite prompts against a metric | Established |
| TextGrad | Text feedback treated as gradients, back-propagated through a Python agent loop | Established |
| Harness-Evolver | A Claude Code plugin that spawns proposer agents in git worktrees to edit prompts, routing, tools and code, judged through LangSmith datasets and an LLM judge; based on Meta-Harness (Lee et al., 2026) | github.com/raphaelchristi/harness-evolver |
| Retro-Harness (RHO) | Retrospective Harness Optimization: mine past trajectories, re-solve a coreset in parallel, propose harness edits, keep the one the agent's own pairwise self-preference favors; no labeled validation set. SWE-Bench Pro 59% to 78% in one round | arXiv 2606.05922, github.com/wbopan/retro-harness |
| Prime Agent | Prime Intellect, MIT, August 2026. A persistent Python REPL as the one tool; sub-agents as function calls; the Continual Harness exposes prompts, skills, memory and sub-agents as state the agent creates, reads, updates and deletes from its own trajectory, with rollback and a /refine command that applies the smallest relevant edit and records trigger and outcome | github.com/PrimeIntellect-ai/prime-agent, arXiv 2608.23552 |

Two caveats before mapping. Every published result is on coding or puzzle benchmarks with a verifier at the end. Zoe's hardest outcomes, conversation quality and research quality, have no verifier, so the loop can be proven first only on her deterministic lanes. And all five are Python-shaped. Zoe's reply path is JavaScript in Electron; her engine is Python. Nothing here ports whole. The harness law stands: port organs, never the context model.

## 2. What Zoe already has, element by element

**Component decoupling: partial.** Editable data exists for standing instructions (`directives`), proven procedures (`skills`, `procedures`), identity (`self_model`), claims learned wrong (`known_incorrect`), canonical artifacts per subject (`artifact_registry`), and hundreds of meta flags. Code-level self-editing exists as the pen: a proposal edits her own source inside a jailed allowlist, runs in a rehearsal sandbox, passes the 603-suite gate, waits for Lucas's decision through the needs door, lands, and she reboots herself. What is not data: the seat prompt, the per-task prompts in cloud logic (versioned by a `v` number in code), the tool prompts, and the routing nets. A prompt rule change today is a code change with the full code-tier ceremony.

**Trajectory logging: strong, but scattered.** Every structured cloud call lands in `cloud_traces` with input, raw response, parsed value, and valid and accepted flags. Agent events, the omnibus observation bus, the route observations distilled into per-tool health, the stall attribution and profiler rows, the per-generation tee, and Echo's 3.69 million-row `agent_trajectory` with OpenInference columns all exist. What is missing is the join: one record per task that names which components ran and what the outcome was. Outcomes live in needs, known-incorrect rows, pass runs, and deliverable audits, each in its own shape.

**The evolution loop: present in pieces, closed only for code.** End-of-session reflection, the daily deterministic self-audit that mints needs, in-turn metacognition, the pursuit lane that turns a failed gate into a diagnosis brief and a cure attempt, the pen, and the capability-needs door together form a loop. Its gaps against the research:

- No metric for non-code components. The gate scores code. A prompt or routing edit has no deterministic score, so it cannot be optimized, only approved.
- Every landing waits on Lucas. Correct for code. A bottleneck for low-risk data edits such as a skill, a procedure, a memory note, or a prompt rule.
- Failure-triggered, not mined. RHO's value is mining past sessions for recurring failure classes without labels. Zoe's "retest the kind, not the phrase" law and the adversarial back-checks do this by hand.
- No counterfactual replay. Harness-Evolver diagnoses by replaying a trace with one component changed. Zoe's rehearsal replays smokes, not conversations, and cloud replies are not byte-reproducible, so replay can only diff the governed layer.
- No rollback for data-tier edits. Code has git. The tables have no versions.

## 3. What to borrow, and what to leave

Borrow three shapes.

1. **Harness as versioned data with rollback (Prime).** Prompt rules, routing rules, skills, procedures and memory notes become versioned rows with a `harness_edits` ledger recording trigger, edit, outcome, and rollback. Tier the trust: data-tier edits may self-land with automatic rollback on a measured regression; code-tier edits keep the pen and Lucas's decision.
2. **Trajectory mining with self-preference (RHO).** A nightly organ mines cloud traces, agent events, needs, known-incorrect rows and route health for recurring failure classes, proposes one harness edit per class, scores candidates by self-preference over rollouts in the rehearsal sandbox where the lane is deterministic, lands data-tier winners through the ledger, and queues code-tier ones to the pen.
3. **Metric-gated prompts (DSPy's shape).** On the Echo side, where labeled sets already exist (the 16-label retrieval harness that measured a 2.2x MRR lift, dedup adjudication, extraction), run DSPy optimizers offline and land prompt versions through the same ledger. On the Side Quest side, build the eval set from `cloud_traces` itself: accepted and rejected outputs per task version are already labeled. An offline scorer per task then gates a prompt version bump.

Leave three things.

- No rewrite around a persistent Python REPL. The RLM abstraction is Prime Agent's whole architecture, not a component.
- No LangSmith or other hosted judge as a dependency. The gate, the smokes, and the traces are the judge.
- No automatic merge of code. The single-ownership and trust laws stand; self-preference ranks proposals, it does not land them.

## 4. The plan against the remaining track

The track today: the freeze tail (cut 18 measured, 1.8 seconds to 5 milliseconds; the excavate step's synchronous read; the gazetteer walk), the compute-allocation lever, the memory hot-path leg, the search-path leg, and unification stages 4.3, 5 and 6.

| Order | Item | Why here |
|---|---|---|
| 0 | Finish the freeze tail: cut 18, the excavate read, the beats walk | Days of work; every evolution loop runs on the main thread's spare capacity |
| 1 | The allocation lever | The pool starvation defers 40 to 78 percent of background cloud calls; a loop that proposes and scores edits needs those calls |
| 2 | Unification stage 5: one repo, one gate, one pen reaching Echo | This is the Harness-Evolver substrate. Without it no loop can edit both runtimes |
| 3 | New leg A: harness as versioned data with the edits ledger | Turns prompt rules and routing rules into things a loop can edit, score and roll back |
| 4 | New leg B: the trajectory-mining organ | RHO's recipe over stores that already exist; the first automated form of "retest the kind" |
| 5 | New leg C: metric-gated prompts, Echo first | Labeled sets exist there; the Side Quest eval set comes from `cloud_traces` |
| 6 | Memory hot-path leg and search-path leg | The loop's memory writes ride the same heat law; misses fall, tokens per turn fall |

Stages 4.3 and 6 stay where they are. The fleet table is small and closes the model-assignment split; the vocabulary stage waits for the rest.

## 5. How to know it works

- Harness edits landed and rolled back per week, by tier.
- Recurring failure classes found by the mining organ, and how many closed.
- Accepted share per cloud-logic task version, before and after a prompt version.
- Hard-test pass rate by kind.
- Tokens per user turn and cloud calls per turn.
- Stall line unchanged: zero blocks at or above three seconds per generation.

## 6. Code-tier decisions under the auto-mode stipulations

Lucas's question after reading the plan: can the pen's human decisions on code use the same stipulations that Claude Code's auto mode uses? Yes. Auto mode is not judgment, it is a policy with five parts, and the pen already holds most of the parts.

The stipulations, as they apply to a code proposal:

1. **Classify the action.** Reversible and in-scope proceeds. Irreversible, destructive, outward-facing, or a scope change asks. For code: a repair that answers a named failure is in scope; a feature is a scope change.
2. **Allow and deny by pattern.** The pen jail is already the allowlist. Add a deny list of constitutional files that no proposal may touch without a decision: the gate runner, the pen itself, the cycler, the jail, the quota law, security, the credential bridges.
3. **Verify before claiming done.** The gate by exit code, with the proposal's own new pins present in the diff. A change that adds no test does not self-land.
4. **Confirm only what the policy cannot clear.** Everything the classifier does not clear goes to the needs door exactly as today.
5. **Report every action and keep the undo.** Git is the undo. The parlor and the tee already carry the announcement.

The tiers that fall out:

| Tier | Conditions | What happens |
|---|---|---|
| Auto-land | Answers a named failure (a need, a diagnosis brief, a profiler row); touches only jailed paths and no constitutional file; under a size cap (files and lines); adds or extends pins; the full gate is green by exit code; no new dependency, network call, child process, env read, schema change, or data write; under the daily rate cap and cooldown | Lands, announces, self-reboots under the live guard |
| Decide | Anything outside the auto-land conditions: feature-shaped, larger, a deletion, a migration, a prompt that changes her voice, a spend rule, a constitutional file | Waits on Lucas at the needs door, as today |
| Never | The standing laws: pushing Echo, adding everything, secrets, disabling a gate, overriding the pacing law | Refused with the reason |

Two additions make auto-land safe rather than fast. A **post-land watch**: the next generation must boot, answer on the status port, and show no new crash, gate failure, or stall regression inside its first read; on any of those the pen reverts the commit and cycles again, and the revert is announced. A **kill switch**: a meta flag turns auto-land off, the same pattern as the self-reboot switch.

What is missing to build it: a pure policy module that classifies a proposal (paths, size, origin, pins added, constitutional touch, forbidden shapes) into a tier, the auto tier wired into the pen's decide path so a cleared proposal does not wait at the needs door, the post-land watch with the revert, and the rate cap. Everything else, the jail, the rehearsal sandbox, the gate's exit code, the self-reboot with its live guard, git as the undo, and the announcement channel, is already live. The honest trade: a green-but-wrong change can go live for one generation. The mitigations are the gate, the deny list, the size cap, the watch with revert, the rate cap, and the switch.

## 7. Two things established before cut 18

### 7a. Why swarming stopped

Lucas asked why swarming appears not to work any more and whether the merge's agent changes caused it. Read-only on both sides, the answer is the same on both: swarming is not broken code, it is starved and lane-misclassified, and the proximate cause is the merge's one pacing law, stage 4.2.

**The Side Quest partition swarm.** One swarm runs machine-wide. Every swarm since 09-01 released only by the six-hour stall expiry; none converged. Today's swarm on focus 3766, the Missouri officials validation, auto-started at 07:00 with three partition threads that were touched at 07:00 and never again, covering zero of their seven targets. Their passes run as autonomous work, which resolves to the research lane, and the research lane has been closed all day for background compute over the burn-down pace. The quota door confirms it: research and idle refused, directed and interactive open and never pace-throttled. Meanwhile every other focus's auto-swarm is refused as "swarm-live" without a log line, so from the outside swarming simply never happens.

**Echo's delegated agents.** Through 09-01 the delegated agents show zero governor refusals. On 09-02, the evening stage 4 landed, 16 of 79 runs were refused with `governor_refused:app_quota`. Today 9 of 16, including the last three legislative-analyst runs, all triggered from chat. The mechanism: a chat-triggered delegate agent is classed Build by its model slot, the governor maps Build, Maintain and Vet to the research lane and asks the app about that lane, and the app says research is closed. The governor's own log line claims chat is unaffected; the chat class is, but a chat-triggered agent is not chat-classed. Five more failures this week are "database is locked", the audit-log item, and the team supervisor has failed its only run since June.

**Fix shapes, on his word.**

1. Echo: the governor takes the trigger kind. A chat-triggered run asks the directed lane, which is open and floor-gated only. A local commit, never pushed.
2. Side Quest: partition children of a directed parent inherit the parent's lane instead of resolving to research.
3. Side Quest: log the "swarm-live" refusal once per focus, and let a directed request preempt a swarm whose every partition is quota-paused rather than waiting six hours.
4. The allocation lever stays the root cure: the operators' 17 million tokens a day are what close the research lane.

### 7b. Leg D: the correction door

The stated end goal: guide her by correcting her in chat, then have her develop the correction in the existing self-learning lanes. What exists today are three narrow nets. A mid-run correction reshapes the active directed run's facet, orgs and depth. A "no, not that" after a pull-up re-drives the pull-up with the corrected referent. A standing instruction, detected by a conservative regex that needs a persistence marker, a behavioral verb and a pronoun aimed at her, is recorded in the directives table and rendered in full in every chat prompt.

The gaps against the goal:

- A correction phrased without "always" or "never" or "from now on" is lost.
- Directives are read by the chat prompt and by nothing else. The research operator, the self-audit, reflection, the learning lane and the pen never see them, so a correction never becomes a procedure, a skill, a test, or a code need.
- No record of whether a correction held. Nothing re-tests the kind of situation that produced it.
- No versions, no rollback, only retire.

Leg D, as a shape:

1. **Classify the correction** at the chat door into scope, referent, rule, fact, or capability. The first two keep their nets. A rule lands in directives. A fact lands in known-incorrect. A capability lands as a need for the pen.
2. **Ledger every landing** in the harness-edits ledger from leg A, with the turn that caused it, so the correction has provenance and an outcome field.
3. **Feed the lanes.** The operator's brief carries the directives block the chat prompt already carries. The self-audit and reflection read the ledger and promote a directive that recurs into a procedure or a skill. A directive that prompt alone cannot honor mints a need, and the pen takes it under the auto-mode tiers of section 6.
4. **Retest the kind.** Every correction spawns a kind-test in the hard-test suite, so the next situation of that shape is a self-test and the ledger's outcome field fills itself.

Leg D slots between legs A and B in the order of section 4: it needs A's ledger and it feeds B's mining organ with labeled failures, which is exactly the signal RHO lacks.

## Sources

- https://github.com/raphaelchristi/harness-evolver
- https://arxiv.org/abs/2606.05922 and https://github.com/wbopan/retro-harness
- https://github.com/PrimeIntellect-ai/prime-agent and https://arxiv.org/html/2608.23552
- https://lilianweng.github.io/posts/2026-07-04-harness/
- https://arxiv.org/html/2604.25850v1
