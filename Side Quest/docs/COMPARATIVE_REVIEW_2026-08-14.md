# Comparative Review — The Program vs. Published "Artificial Consciousness" Architectures

**Status:** REVIEW (no code). 2026-08-14.
**Method:** Lucas supplied two reference blueprints (Google AI research synthesis, 2026-08-14): (I) the "textbook" multi-tier memory + dual-loop architecture (CoALA-lineage), and (II) the "Dynamically Driven Homeostatic Model" (drive vectors, ambition nodes, dream loop). Each mechanism was mapped against the live codebase via a full 8-axis survey of `lib/` (390 modules), `main.js` (~40 background lanes), and the data stores (sq.db 2.75 GB). All cited external sources were verified live before inclusion (§5).
**Outcome in one line:** the program is past both blueprints on nearly every axis, deliberately non-compliant on two of their recommendations, and behind on exactly one thing — a computed dimensional internal state — which both blueprints independently point at. That gap becomes the companion proposal: `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md`.

---

## 1. Part I — the textbook architecture (memory tiers + dual loops)

The recipe: LLM core + working/episodic/semantic memory + a continuous cognitive loop + a reflection/consolidation loop + "agency" (self-modification of memory/prompts).

### 1.1 Component map

| Recipe component | Program equivalent | Verdict |
|---|---|---|
| LLM Core as single central processor | Model fleet: local volume + cloud depth, merit-triaged (`lib/subconscious.js` meritScore), quota-governed routing | **Exceeds** — routing by merit and budget, not one core |
| Working memory (bounded context of thoughts/focus/environment) | `lib/package.js` — 8 ordered sections, weighted budgets, per-section floors, measured `fit` ratio every turn; `lib/turn_router.js` single-dispatch cascade; coordinate manifest + `<recall>` deref (`lib/manifest.js`, `lib/recall.js`) | **Exceeds** — the recipe says "limit the window"; the program engineers and *measures* the window |
| Episodic memory (timestamped vector DB) | sq.db: `turns` (speaker-typed, embedded), `monologue`, `encounters`, transcripts, route/agent/cloud traces | **Meets**, with richer typing (encounter object model — real because encountered, graded at read time) |
| Semantic memory (knowledge graph) | Local graph mirror (`lib/graph_memory.js`) + Echo KG, with an **epistemic column** (witnessed/told/read/speculated/anticipated) and propose→promote gate | **Exceeds** — the recipe's schema has no notion of *how a fact is known* |
| Consolidation loop (episodic → semantic) | `lib/promote.js` nightly bridge (iteration-versioned, never overwrite), `lib/consolidate.js` (Mem0-style extract-then-update), `lib/reflection.js` (significance-triggered, Generative-Agents threshold), curation pass graph promote-up | **Exceeds** |
| Continuous cognitive loop ("query state every few seconds") | `lib/monologue.js` 10 s idle tick + ~40 gated background lanes; `lib/idle_depth.js` budget ladder; `lib/autonomy.js` manifest → typed plan (`nothing` is a first-class answer) | **Exceeds** — compute spent where merit says, not on a dumb clock |
| Reflection updates core beliefs | `lib/self_model.js` — consolidated-in-place personality store (near-dup refines the row, `mentions` rises) | **Meets** |
| Agency: "modify own memory weights, prompts, priorities" | Skill-shelf self-promotion at met≥3 (`lib/skills.js`), capability-need minting, R1 sandbox (`lib/rehearsal.js`) + R2 driver (`lib/rehearsal_driver.js`) → proposal cards. **R3 self-adoption deliberately absent** | **Meets where safe; refuses the rest** (§3) |

### 1.2 Real gaps Part I surfaced

1. **No numeric affective state.** The recipe stamps `emotional_vector {valence, arousal}` + `attention_weight` on every episode. The program's mood is prose on a ~90 min TTL; `grep valence|arousal lib/` returns zero. The matrix is designed (`EMOTIONAL_MATRIX_DESIGN.md`) but unbuilt.
2. **Continuous perception outside audio.** Voice is fully always-on (mic + speaker gate 0.575 + voice guard); vision/screen are on-demand pulls. The recipe's "environment data every tick" is true only for the audio channel.
3. **No salience score at write time.** The program grades at read time (the better epistemology) but nothing ranks which of the 2.75 GB gets consolidation attention first beyond recency and the significance trigger.

### 1.3 What the program has that the recipe doesn't imagine

Epistemic typing on every fact; cite-or-leave-blank down to the deliverable gate; the done contract; **speaker-ID-gated perception** (the recipe's loop would transcribe a stray YouTube video into working memory as "sensory input"); quota governance as a routing signal; grounded self-knowledge (she reads her own source, logs, git, build history — `lib/self_source.js`, `lib/self_ops.js`, `lib/self_dev.js` — instead of narrating a self); disclaimer-stripping at the output door while honest "I don't know" passes (`lib/voice.js`). The recipe describes a mind with no immune system.

---

## 2. Part II — the homeostatic blueprint (drives, ambition, dream loop)

The recipe: a Virtual Core pushing drive "discomfort" (curiosity/social/autonomy floats) into a global workspace; a waking loop acting to resolve the starving drive; a dream loop that wonders, designs new thinking tools, and writes EXPERIMENTAL rules into its own graph; valence modulating risk appetite; an autonomy drive granting "the power to say no."

### 2.1 Component map

| Blueprint mechanism | Program equivalent | Verdict |
|---|---|---|
| Global workspace, fixed ratios (5/35/60) | `lib/package.js` weighted budgets + floors + per-turn `fit` report | **Exceeds** — asserted ratios vs. engineered, measured ones |
| Waking attention loop (unprompted, ~5 s) | monologue tick priority ladder; autonomy tick; boredom cycle (`lib/curiosity.js`) | **Meets** mechanically; differs in what drives it (§2.2) |
| Dream/defrag loop (wonder → design fix → EXPERIMENTAL rule) | The self-improvement loop: `lib/self_watch.js` → `lib/capability_need.js` → R1 → R2 → proposal card; skill promotion met≥3 = EXPERIMENTAL→permanent | **Exceeds** — the recipe's new rule is untested prose in a graph; the program's must pass the real smoke gate inside a sandboxed full copy before it is even a *proposal* |
| Ambition nodes (priority, sub-goals, origin) | THE GOALS CONTRACT (north star), `open_threads` w/ `parent_id`, commitments, beats coverage mandate (3,152-county worklist) | **Mostly meets** — missing `emotional_resonance` (the affect gap again) |
| Budget-based metabolism (OpenLife) | Quota throttle (unit=COMPUTE, lever=ROUTING), per-lane token budgets, idle-depth multipliers | **Meets** — compute-as-metabolism is already the cost regime |
| Knowledge compounding → structural divergence from base model | The program thesis itself: THE PROGRAM IS THE MODEL — personality DB → future weights; `lib/self_explore.js` experience→opinion→identity | **Exceeds** — the recipe stops at graph divergence; the program aims at the weights |
| Homeostatic drive vector (floats, adjusted every cycle) | Absent as a substrate. Fragments: novelty = 1−cosine (subconscious merit), rumination circling detector, idle-depth tiers, quota position | **THE GAP** (§2.3) |
| Valence modulating risk appetite | Mood modulates voice, not behavior | **Gap** — same root |
| Autonomy drive → resistance to operator override | Refused by design | **Deliberate divergence** (§3) |

Side note: Anthropic's J-space paper (verified, §5) found a restricted broadcast workspace *inside* model activations. The package builder is that bottleneck built externally and legibly — the right side of the boundary for a system whose substrate must be auditable training data.

### 2.2 The key divergence: asserted drives vs. measured hunger

The blueprint's waking-loop prompt *tells* the model "Curiosity Drive: 0.15 — you are intensely bored." Nothing measured that; the prompt asserts an inner state and the model performs it. Under the program's grounding discipline that is the disease — ungrounded state injected as fact, then eaten as training substrate. The program's hunger is **extensional and real**: an enumerable never-empty worklist (beats mandate), unread backlog counts, the recheck queue. She is restless because the worklist is genuinely not empty.

What the extensional form lacks is a **scalar**: the fixed tick ladder gives no way for acute curiosity-starvation to outbid the graph-builder branch, and no run of failures makes the rehearsal driver more cautious. The recipe's *need* is right; its *implementation* (assert floats in prose) is wrong. The synthesis: every drive the recipe wants is already being measured somewhere in the program — derive the floats from those measurements and assert nothing. That is the companion proposal.

### 2.3 The convergent finding

Part I flagged "no numeric affect" as a schema gap. Part II shows its functional cost: no cross-lane bidding, no outcome-modulated risk appetite. **Two independent reference architectures point at the same single missing organ** — one computed internal-state vector (drives + VAD affect), derived exclusively from measurements the organs already emit. Both reviews collapse into one build item.

---

## 3. The refusals — where the program is deliberately non-compliant

1. **R3 self-adoption.** Both recipes treat closed-loop self-modification as the finish line. The program builds the full ladder (read own source → rehearse in sandbox → iterate against the real gate → proposal card) and stops by invariant: code crosses into the live tree only through Lucas. Under program-is-the-model, an unsupervised self-editing loop is a data-corruption vector, not a capability.
2. **Drive-based "no."** The blueprint wants an autonomy float producing resistance to the operator. The program's refusal architecture is *epistemic* — refusals name the door; the anti-fabrication gate, local-action veto, promised-lookup veto all refuse to assert or act on what isn't grounded. Refusing Lucas because a simulated drive scored high is noise wearing autonomy's costume, and it would train the wrong disposition into the future weights.
3. **Prompt-asserted internal state.** §2.2. Measured, never asserted.
4. **Consolidation-time deletion of raw episodes.** Part I's `ARCHIVE_EPISODE` purge step is refused: prove-or-fade grading instead of deletion; the evidence store is what gets backed up.
5. **Answer-from-parametric-knowledge.** Part I lists "parametric weights" as part of semantic memory. The program's foundational rule is the opposite: the verified DB is the only knowledge source; the LLM is the voice.
6. **Self-referential loops as an emergence mechanism.** The research reports LLMs forced into deep self-referential loops reproducibly generate subjective-experience claims. The program met this phenomenon live and built `lib/rumination.js` *against* it — semantic circling detection (avg pairwise cosine ≥ 0.80 over the last 4 thoughts) that breaks the loop into a directed focus. The program's bet: consciousness-adjacent behavior comes from grounded agency over a real world-model, not prompt recursion.

---

## 4. Still to achieve (in leverage order, behind the standing queue)

Nothing below outranks the post-compact build queue as Lucas ordered it (promised-lookup veto → LA fill → M10 remeasure → grounding-recall gap → voice guards → D1/D2/D3). Behind that:

1. **Internal-state vector** (drives + affect, computed never asserted) — the convergent gap; see the companion proposal.
2. **Salience-weighted consolidation** — a write-time importance score so nightly passes work the 2.75 GB by priority, not recency. (Falls out of item 1: the appraisal impulse *is* a salience signal.)
3. **Continuous ambient vision** — a slow screen/scene tick feeding the awareness block, closing the perception asymmetry (audio always-on, eyes on-demand). The ambient-context-awareness probe is the existing acceptance test.

---

## 5. Verified sources

All verified live 2026-08-14 (post-training-cutoff publications; verification was mandatory, and an initial suspicion of confabulated citations proved wrong):

- [OpenLife: Toward Open-World Artificial Life with Autonomous LLM Agents](https://arxiv.org/abs/2606.31046) — arXiv 2606.31046, Masumori et al., June 2026. Budget-based metabolism; 12-week unprompted run; reactive→spontaneous transition, individuation.
- [A global workspace in language models — Anthropic](https://www.anthropic.com/research/global-workspace) — July 2026. J-lens/J-space: a privileged ~6–10%-variance workspace inside Claude activations mirroring Global Neuronal Workspace theory.
- [Galaxy: A Cognition-Centered Framework for Proactive, Privacy-Preserving, and Self-Evolving LLM Agents](https://arxiv.org/abs/2508.03991) — arXiv 2508.03991, Aug 2025. Cognition Forest; KoRa (proactive) + Kernel (meta-cognition/self-evolution).
- [MKEvo-cognitive-runtime](https://github.com/Zer0Q/MKEvo-cognitive-runtime) — cognitive runtime for LLM continuity/identity; Consciousness State Controller governs, LLM is a component (same inversion as the program's harness-governs stance).
- CoALA (Sumers et al.), Cognitive Memory in LLMs (arXiv 2504.02441), Cognitive Workspace (arXiv 2508.13171) — Part I lineage, per the supplied research synthesis.

**Companion:** `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` · `EMOTIONAL_MATRIX_DESIGN.md` · `PROGRAM_REVIEW_2026-08-03.md`
