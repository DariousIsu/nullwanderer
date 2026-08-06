# Adaptive Research Design — 2026-08-06

**Author intent: Lucas (dictated live, 2026-08-06, during the Hartfield/Green South run).** This is
the BASE CONTRACT for everything the program does, not a research-lane feature. Target: a research
assistant who works like a scientist crossed with an investigative reporter — and whose output is a
fully sourced, cited, submission-grade research paper, not "a long-winded google search."

## The contract, in order

1. **PREFLIGHT — before any work.** The first step of ANY task is the question: *"Do I know the
   best practices and tools for this project?"* If no →
   a. research the best practices for this class of project (how do professionals do this?),
   b. compare them against ALL available tools (the full Echo catalog + local tools + recipes +
      skills — surveyed, not remembered),
   c. if tools are missing → research, design, and implement them (the rehearsal/tool-build lane)
      BEFORE beginning.
   Only then is the ORIGIN PLAN set — and the plan records its chosen toolkit and method.
2. **THE LIVING PLAN.** Research means learning; learning means the plan is provisional. Every new
   piece of information re-validates three things: is the plan still CORRECT, is it still COMPLETE,
   and are the tools still SUFFICIENT? Scope and toolkit are EXPECTED to change several times in a
   real run (the Chinese-microchips example: a news link to our papers spawns an autonomous task
   that must pick up materials analysis, then economic analysis — different tools mid-run).
3. **SURFACING FOR STEERING.** What she learns mid-run is steering fuel for Lucas. Learnings and
   plan-deltas surface in chat as short "here's what I learned → here's how I'm changing tactics —
   object if wrong" lines. (Today's counterexample: the synthesis minted the Roy Richards
   cross-control hypothesis and silently steered her own passes; Lucas never heard it.)
4. **SCIENTIFIC METHOD + STRAY THREADS.** Questions arise from findings; she goes and answers
   them; answers change tactics. Hypothesis → evidence → revise. A stray thread worth chasing is
   an asset, not scope creep — it gets an open question, a priority, and (if big enough) a
   surfaced proposal.
5. **THE QUANTITATIVE ARSENAL IS A NORMAL MOVE.** Python analysis (analyze_data workbenches),
   probability estimates, and her own forecasting machinery are ROUTINE research steps — base
   rates, magnitude checks, cross-tabs over what she has banked, explicit likelihood statements
   in findings.
6. **THE DELIVERABLE BAR.** A research task runs no-breaks-all-research and ends in a deep
   research paper: structured, complete, every claim sourced and cited, canvas + docx — a paper
   she could put her name on and submit as AI-generated research.

## Measured gaps (live evidence, 2026-08-06)

| # | Gap | Evidence |
|---|-----|----------|
| G1 | **Research lanes exclude the quant tools.** `echo_tier.laneToolNames()`: web lane = browser+web+echo; deep lane = curated READ_TOOLS+recall+echo. `analyze_data`, `forecast_query`, `localdb` are in NEITHER — she never runs python/probabilities because the menu never offers them. | echo_tier.js:256-259; zero analyze_data/forecast calls in the Hartfield run |
| G2 | **No preflight.** intake → classify → generateResearchPlan plans TARGETS, never method or tooling; nothing surveys `get_tool_map`/`list_recipes`/skills; nothing studies best practices; nothing can conclude "a tool is missing — build it first" (rehearsal_write exists but no path reaches it from task intake). | research_plan trace 14:14:16 (targets only) |
| G3 | **The plan is static.** Open questions steer WITHIN the plan; nothing revises objective/approach/toolkit as findings accumulate. | #3710 plan unchanged through the whole run (until manual repair) |
| G4 | **Synthesis terminates inward.** Novel open questions steer passes but are never surfaced to Lucas. | Richards hypothesis: minted 14:24, never spoken |
| G5 | **Words-vs-state drift.** Replies about her own work state aren't read from state. | "same thread, no split" while 3 duplicate threads existed; stale-replay bubble |
| G6 | **Output shape.** Directed deliverables are organized notes/dossiers, not a structured cited paper; the papers/citation machinery (assemble, verify_resolve, citation packs, docx) exists but the research lane doesn't end in it. | directed-#### notes files vs. the bar in §6 |

## The build — five phases, each its own circuit

**P0 — PREFLIGHT (the universal step-0).** New `lib/research_preflight.js` driven from task intake
(and autonomous task seeds): (a) competence probe — "do I hold best practices + a proven recipe
for this class?" (skills shelf + recipe registry + self-assessment); (b) STUDY step — bounded web
research on how this class of project is done well, cited; (c) TOOL SURVEY — `get_tool_map`
(intent buckets) + local operator menu + `list_recipes`/skills, scored against the project's
needs; (d) GAP VERDICT — missing capability → the tool-build path (research → design →
`rehearsal_write` a tools/*.py + smoke → gate → operator-approved adoption), BLOCKING the run
start unless Lucas waives; (e) the origin plan records method + toolkit + the preflight's citations.
*Proof gate: a fresh research task's plan names its method, its chosen tools (≥1 non-obvious), and
its study sources — before the first pass runs.*

**P1 — THE LIVING PLAN (replan hook).** In the directed loop: every synthesis event (and every N
touches), a bounded REVALIDATE step reads accumulated findings + the plan and answers the three
questions (correct? complete? tools sufficient?). Output is a PLAN DELTA (versioned:
`focus.<id>.plan_rev++`, old plans retained) — scope adds, target adds/drops, toolkit changes,
method pivots. Tool-insufficiency verdicts route to P0's gap path mid-run.
*Proof gate: a run whose findings invalidate its opening assumption visibly mutates its plan
(plan_rev ≥ 2) and the next passes use the new tactics.*

**P2 — STEERING SURFACES (the outward wire).** Plan deltas + novel open questions on USER-origin
threads go through the yours-lane utterance path as one-liners: what changed, why, what she'll do
differently, "object if wrong." Governor-paced, never a flood (batch per synthesis event).
*Proof gate: the next Richards-class hypothesis appears in chat within a minute of being minted.*

**P3 — QUANT MOVES (arm the lanes).** `laneToolNames('deep')` gains `analyze_data`, `localdb`,
`forecast_query` (+ lane-spec lines teaching WHEN: cross-tab what's banked, base rates, explicit
probability statements in findings); plan templates for entity/topical/forecast kinds each name at
least one quantitative sub-question; recipes for the common moves (donor cross-tab, grant-flow
aggregation, probability-of-connection) go on the shelf.
*Proof gate: a real research run executes ≥1 analyze_data workbench pass and ≥1 explicit
probability/forecast statement that survives into the deliverable, cited to its computation.*

**P4 — PAPER-GRADE ASSEMBLY.** Convergence stops emitting "organized notes" and runs the paper
pipeline: structure (abstract/findings/evidence/methodology/open questions) → every claim carries
its citation (verify_resolve on the load-bearing ones) → canvas doc + branded docx via the
existing editor/papers machinery → the completion announcement links it.
*Proof gate: a completed research task ends in a docx+canvas paper where a spot-check of 10 claims
finds 10 citations that resolve.*

**P4b — RE-ENTRY AUDIT (Lucas, 2026-08-06 evening — the acceptance test for the whole build).**
Pointing her at an EXISTING deliverable must enter through JUDGMENT, not accretion: when a run
adopts a base document (the living-document match, or an explicit "finish/fix this doc"), the
FIRST pass audits it against the P4 bar — completeness vs. its own stated objective, depth per
section, citation coverage, quantitative content — and the gap list BECOMES the origin plan's
targets/facets. She should conclude on her own that the document is flawed, say so (P2 wire), and
work the gaps. *Proof gate (the whole-build acceptance test): re-pointing her at the Hartfield/
Green South doc produces (1) an honest audit naming its shallowness, (2) a gap-driven plan, and
(3) a finished, cited, quantified revision of the SAME document.*

**G5 (state-grounded replies) rides M2.2**: package's plan/self slots carry a live read of
thread/focus state on any turn whose reply would claim work-state.

## Order + dependencies

P3 is one sitting (menu + spec lines + templates) and pays immediately. P2 is small and pays
immediately. P1 depends on nothing but touches the directed loop's core. P0 is the largest new
organ; its tool-BUILD path reuses the rehearsal lane end-to-end. P4 reuses the papers machinery.
Recommended: **P3 → P2 → P1 → P0 → P4**, each with its smoke + live circuit proof before the next.

Method rules from BUILD_PLAN_2026-08-03 bind throughout (circuit-proving, no naked constants,
donor-grounded, measure first, named files only).
