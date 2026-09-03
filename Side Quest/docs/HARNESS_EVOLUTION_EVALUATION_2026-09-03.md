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

## Sources

- https://github.com/raphaelchristi/harness-evolver
- https://arxiv.org/abs/2606.05922 and https://github.com/wbopan/retro-harness
- https://github.com/PrimeIntellect-ai/prime-agent and https://arxiv.org/html/2608.23552
- https://lilianweng.github.io/posts/2026-07-04-harness/
- https://arxiv.org/html/2604.25850v1
