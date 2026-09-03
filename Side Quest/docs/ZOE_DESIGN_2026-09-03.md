# The ZOE design

Date: 2026-09-03. Lucas's ask: conduct outside research on today's best practices and bleeding-edge projects, and using the lineage of the program's own concept work, bring forward the best design to accomplish the stated goals.

The stated goal, in his words: Zero Operator Engaged. A self-driving assistant, always grounded in researched, sourced, cited, curated and verified fact, that leverages every tool it is given and its own ability to self-analyze, research and self-build, so that no task goes unfinished unless the information is truly unknowable. Powered by the strongest open-weight cloud models, with white-hat tools, full computer access and a liberal whitelist on self-development. The measured gap: it can barely finish a research paper.

## 1. What the field converged on in 2026

Read as practices, not products. Each is sourced at the end.

**Orchestrator and isolated subagents.** The 2026 consensus across Anthropic, Cognition, OpenAI, Microsoft and LangChain is one lead agent that owns the conversation and spawns ephemeral subagents, each with a self-contained brief and a fresh context window, that return only a compressed result. Subagents do not see each other or the lead's context. Anthropic's production system beat a single frontier agent by 90 percent on its research eval at about 15 times the tokens, and token usage alone explained 80 percent of the variance: parallel context windows matter more than prompt craft. The three reusable patterns are externalize state to memory before the context fills, isolate workers with self-contained task descriptions, and verify high-stakes outputs in a separate pass. Briefs must carry an objective, an output format, tool guidance and task boundaries. Effort scales by rule: one subagent for a simple query, ten or more for a wide comparison. A dedicated citation agent attributes sources. A tool-testing agent rewrites bad tool descriptions. Evaluation is end-state, by an LLM judge on factual accuracy, citation correctness and completeness, with human review for what the judge misses. Production needs resumption from breakpoints, tracing, and gradual rollouts.

**Verification as structure.** The open-source deep-research agents settled on planner, searcher, synthesizer and critic roles with schema-enforced citations, and citation quality is where open-weight systems still trail. Marco DeepResearch made verification the organizing principle at three levels, data synthesis, trajectories and test time, and an 8-billion-parameter agent under a 600-tool-call budget then matched or beat 30-billion agents, because errors were caught before they compounded. FineVerify decomposes a question into checkable conditions and scores candidate answers per condition rather than with one coarse judgment; with sampled trajectories a small model overtook its frontier sibling. Cross-model debate improves factuality, and a less truthful model debating a more truthful one lands closer to the truth, with one caution: a persuasive smaller model can override a truthful answer, so a challenger must judge by evidence and citations, never by rhetoric.

**Context engineering.** Write, select, compress, isolate. Offload detail to files or a memory tool and keep a pointer; that is reversible where a summary is not. Compact rarely and structurally; Slipstream runs the compaction beside the continuing agent and has a judge validate the summary against what the agent went on to need, for up to 8.8 points of accuracy and 40 percent less latency. Handoffs between windows are explicit and written.

**Memory.** Four kinds are standard: working, episodic, semantic, procedural. The bleeding edge treats procedural memory as an evolvable program: MemPro evolves the whole construction-and-retrieval pipeline from diagnosed recurring failures and keeps a version tree; Memento-Skills stores procedures as structured skill files with a router that co-evolves with the library, with no weight updates.

**Routing.** A cascade beats a single frontier model on cost and quality. Cluster, Route, Escalate sends most queries to a cheap model, estimates quality, and escalates only the hard cases, retaining 97 to 99 percent of the strongest model's accuracy from task-correctness labels alone, and adapts as the pool changes.

**Harness evolution.** Covered in the harness plan: Retro-Harness mines past trajectories and keeps edits its self-preference favors; Harness-Evolver proposes in isolated worktrees and judges; Prime Agent exposes prompts, skills, memory and sub-agents as state the agent edits with rollback.

## 2. What the lineage already found

The program's iterations discovered most of section 1 before it was consensus, then lost pieces at each hop.

| Iteration | What it found | What was lost after it |
|---|---|---|
| NX-ALPHA | A research graph as a contract: execution plan, area briefs, agent results of 500 to 800 tokens plus memory markers instead of raw data, an assembler; a citation gate per area with re-run and pass-with-caveats; a validator whose challenger is a different model family; an adversarial trainer pairing questioner-and-judge against a respondent; a self-improvement service in tiers with git revert | The markers, the citation gate, the cross-model challenger, the trainer |
| NX-BETA (Bravo) | Swarm patterns, fan-out, mixture-of-experts, map-reduce; a complexity score that decides when a swarm is worth it; LLM decomposition into sub-agents with per-agent tool allowlists; parallel dispatch and a synthesis fold; workspace templates as predefined roles with prompt, tools, memory table and artifact type | The patterns, the complexity score, the templates |
| NX DELTA | The orchestrator as a priority picker over autonomous work; the axiom that the chat is the lobby, not the office; a chat-priority dispatcher in front of every model caller; dream as an idle synthesis cycle | The picker, the dispatcher, the axiom as a gate |
| NX ECHO | Role agents as manifests with model slots, tools, cite floors and triggers; a run ledger with parent ids; a governor by class; verification and citation packs; about 600 tools; a 3.69 million-row trajectory log | Never connected to the voice: the manifests, ledger and tools sit behind a gate the autonomous loop cannot pass |
| Side Quest | The voice and reply path; the operator loop; partition rosters over workers with covered-target bookkeeping; the 603-suite gate, the pen, the rehearsal sandbox; the usage law; the memory map; the stall instruments; directives, procedures, skills, known-incorrect | Runs everything through one operator that carries raw findings until the context truncates |

The design below is a recovery and a completion, not an invention.

## 3. The design

### A. The lobby and the office

Delta's axiom becomes a gate. The reply path is the lobby: interactive, never paced, never waiting on a swarm. Every piece of work is office work: a swarm of role agents producing artifacts in the background, announced when they land. The chat can redirect, correct and ask status of any swarm at any time, and a correction lands through the correction door.

### B. The role registry

One registry of predefined agents, in Echo's manifest shape seeded from Bravo's templates. Each role has a prompt, a tool allowlist, a model slot and weight class, a memory scope, an artifact type, and the tier it bills under the usage law. The starting roles: planner, collector (web, feeds, scrape), database navigator (the stores and the map), analyst, writer, citation checker, challenger, coder, curator, verifier. Roles are data, versioned, with the harness-edits ledger behind them, so the correction door and the mining organ can change them.

### C. The contract

Alpha's contract and Bravo's plan, merged. A plan carries the goal, the pattern, and typed steps, each naming a role. A brief is self-contained: objective, output format, tool guidance, boundaries, and the addresses of the held data it should start from. A result is compact content plus markers into the memory map. Gates sit between steps. A verdict closes the plan. The complexity score and the effort rules decide the swarm's width: one agent for a lookup, many for breadth.

### D. Context discipline

Fresh context per agent by construction. No agent carries another's raw findings; it reads them by marker. State is externalized to the stores before any window fills. Where a long-running agent must compact, it compacts beside its own continuation and a judge checks the summary against what the agent needed next. Handoffs are written, never implied.

### E. Verification as structure

Three layers, all inside the swarm rather than after it. The citation gate between collectors and the writer, per area, with re-run on failure and pass-with-caveats on the third. The challenger at the end of every deliverable swarm, on a different model family from the producer, judging against conditions decomposed from the ask with a per-condition score, by evidence and citations only. The existing anti-fabrication and substantiation gates on what she says, as the last line. End-state evaluation by an LLM judge on accuracy, citation correctness and completeness, with sampled human review.

### F. Execution and cost

Dispatch to executors on either runtime under the usage law's four tiers, user, directives, development, expansion. A cascade routes by role and difficulty: collectors and navigators on the cheap class, analysis and writing on the mid class, escalation on a low challenger score, and the challenger itself on a different family. The fleet table is the cascade's pool. The pool is the binding resource, and a swarm of small fresh-context calls spends it better than one long call.

### G. Memory

The four kinds, under the hot-path law: short-term is the working set with heat, melt by coldness, retention by heat, and every hot-path search reaches it with the can-vouch mark. Procedural memory is evolvable data: skills and procedures with versions and rollback, changed by the correction door, by the mining organ, and by the agents themselves under the auto-mode tiers.

### H. Self-evolution

The harness-edits ledger with tiered trust. Trajectory mining nightly for recurring failure classes, proposing role, skill or memory edits scored by self-preference over rehearsal rollouts. Metric-gated prompts where labeled sets exist, seeded by Alpha's questioner-and-judge pairs. The pen under the auto-mode tiers for code. A tool-testing agent that exercises and rewrites tool descriptions, with the tool that fails half its calls as its first job.

### I. Autonomy

The autonomous loop may write and spawn under the tiers; the gate that told it to ask Lucas first is retired. An orchestrator picks the next autonomous work in priority order: user commands, directives, needs and repairs, then expansion and dream. The recheck queue stays as metabolism. Every run resumes from its last breakpoint.

### J. Proof

The run ledger, end-state evals, the stall line, tokens per deliverable, and one acceptance test that names the gap: one command produces a cited, challenged, verified research paper with a caveats section, by a swarm, under budget, with no operator engaged.

## 4. The build order

Unchanged from the merge map, with the acceptance test placed where it can be run.

1. The freeze tail: cut 18 and its siblings.
2. The usage law: four tiers, queue-aware pacing, the cheap-model exemption, the swarm slot on gemma.
3. Stage 4.5 in order: the trigger-to-tier law, the role registry, the run ledger, the swarm primitive with markers and the two gates, the fold.
4. The acceptance test: the research paper, run and graded.
5. Stage 5 and the harness legs, A, D, B, C.
6. The search-path and memory hot-path legs; then the remaining stages and rows.

A step counts as done when a smoke pins its contract from both runtimes and the acceptance test's score moves.

## 5. What ZOE borrows from the harness that is building it

Lucas's ask: pull your own source, or find it online, and borrow whatever gets us there faster. Honest scope first. The model weights and the compiled CLI are closed; what is documented is the Claude Agent SDK, and what is directly observable is the tool contract in my own context and the way this program's sessions have run since July. Everything below is one of those three.

**The loop.** One main agent, tools with JSON schemas, and one rule above all: tool results are data, never instructions. Hooks run at lifecycle points, on prompt submit, before and after a tool, at session start and end, and a prompt-submit hook injects rules into every turn. The permission chain runs in a fixed order: hooks, deny rules, ask rules, the mode, allow rules, a per-call callback. Auto mode replaces the human prompt with a separate classifier model that judges each unresolved tool call; Anthropic measured humans approving 97 percent of prompts reflexively and catching 13.6 percent of dangerous commands, against 89 percent blocked by the classifier. Actions fall into three categories: prohibited, explicit permission, regular.

**Composition.** Subagents are files with a name, a description, a tool list and a model, spawned with a self-contained brief and returning a report. Skills are packaged instruction files invoked by name or loaded when the task matches. MCP servers are tool sources. Tool schemas load on demand by search, so hundreds of tools never sit in the window at once.

**Memory.** A size-capped index loaded every session, pointing at one-fact files with a name, a one-line description and a type: user, feedback, project, reference. Links between facts. Recalled memory is background, never an instruction, and a memory that names code is verified before it is recommended. The cap forces compaction discipline: when this session's index passed its limit, the index was rewritten, not the limit.

**Continuity.** Compaction is a fixed summary schema: the request and intent, the key concepts, the files and their state, the errors and fixes, the problem solving, every user message, the pending tasks, the current work, and the next step, followed by resumption without acknowledgment. Above it, this program's own handoff banner: the state, the laws, what is open on Lucas's word.

**Orchestration.** Background tasks with completion notifications; event monitors; self-paced wakeups with quiet streaks; deterministic workflow scripts that pipeline agents with schema-enforced structured outputs validated at the tool layer with retry, phases, budgets, and resume from cached results. Quality patterns as recipes: adversarial verification by several independent refuters with a majority rule, judge panels over independent attempts, loop until two rounds find nothing new, sweeps by several search modes, a completeness critic at the end.

**Writing for the operator.** The delivery doctrine is written as rules rather than enforced only by gates: lead with the outcome, say what could not be verified first, report a failed test with its output, say what was skipped, never narrate your own reasoning, keep code out of prose, put numbers in tables, stop when the content stops. Plus the pre-land sweep before every commit and the git discipline of named files and exit codes.

What ZOE takes, against what she has:

| Harness element | ZOE today | Borrow |
|---|---|---|
| Tool results are data | Content firewall on fetched text | Extend to every tool result, Echo's included |
| Prompt-submit hook injecting rules | Directives rendered in the chat prompt only | Hooks at every prompt build: operator briefs, agent briefs, the pen. This is the "directives read by every lane" fix in one mechanism |
| Permission chain and the auto classifier | The Echo tier gate and the pen's decision door | The tiered policy module with deterministic rules first and a classifier model for the ambiguous middle, on both the pen and the autonomous loop |
| The three action categories | Write tags on tools | The taxonomy as written: prohibited, explicit permission, regular, with Lucas's reserved levers in the second |
| Subagents as files | Echo's TOML manifests | The role registry, seeded from the manifests |
| Skills as instruction files with a router | Skills and procedures tables | Skills as evolvable data with a router, the Memento shape |
| Tool schemas loaded on demand | Six hundred tools in one manifest | Tool search: load a schema when a role needs it |
| Size-capped index plus fact files | Self-model, directives, known-incorrect, the memory map | An operator-facing index she loads every session, capped, with read-first pointers |
| Compaction summary schema | The where-we-are block | The schema and the handoff banner for every session and every long run |
| Background tasks with notifications | The agent-consume ledger and watcher | One run ledger with a landing notification into the conversation |
| Workflow scripts with structured outputs | Cloud logic's validate-and-repair; the operator | The swarm runtime: a pipeline of role agents with schemas, budgets and resume |
| Adversarial verify and judge panel | The anti-fabrication gate | The challenger: several refuters on another model family, majority rule |
| Task chips for out-of-scope findings | The needs door | Keep; the chip is the need's face |
| Delivery doctrine as rules | The say-do and anti-fabrication gates | The rules in the seat prompt; the gates stay as the last line |
| The pre-land sweep | Nothing in the pen | The pen runs the six-question sweep on every diff |

What not to borrow. The harness is a single session-bound loop with a human in it by default; ZOE is always on. Its compaction is lossy by design because its memory is text files; ZOE has durable stores and should compact less and point more. Its classifier is the first line for a session; ZOE's tiers should be deterministic first and classified second.

## 6. Fitted to Lucas

The program is custom-fitted to one operator, and two months of sessions are the data. How he works, as it bears on the design:

- **Orders are short imperatives.** "Go ahead with the next cut." A bare imperative is a standing order to execute one bounded unit of work and report, not an invitation to discuss. ZOE's intake treats it that way.
- **Questions are assessments.** "Is there any way," "do we have a plan." The deliverable is the finding and he decides. ZOE reports and stops.
- **Corrections arrive as principles**, often mid-turn, and are laws from then on. He expects to see them written back verbatim and applied everywhere, not only in the next reply. That is the correction door, and it is why directives must reach every lane.
- **He delegates by observation.** "Swarming appears not to be working." The job is to measure, find the mechanism, and bring back the mechanical fact. Never a guess dressed as a diagnosis.
- **He reads the last message.** It leads with the outcome, puts numbers in tables, names what was verified and what was not, and reports a red gate as red.
- **He grants standing permissions per session and keeps a short list of levers**: reboots, deletions, pushes, spend policy, brand, when she speaks unprompted. The tier policy's explicit-permission category is that list, exactly.
- **He works in long arcs across compacts** and expects continuity to survive them: the handoff banner, the read-first pointer, the plan document updated and committed as the record.
- **His vocabulary is load-bearing**: organs, lanes, cuts, the lineage from Alpha to Echo. Using it back is how alignment holds.
- **His cadence is the cut**: measure, build, gate, commit, cycle, read, record. ZOE's self-build runs that cadence and no other.
- **His needs, in his words from July**: pull real materials out of tangents, connect the dots and tell the bigger story, forecast from it, build better reports, hold learning conversations where the assistant searches and grows as it talks, and take care of its own memory.

The design change this implies: an operator model as a first-class store, in the shape of the harness's user and feedback memories, loaded on every turn and every brief: how he communicates, his laws with dates, his reserved levers, his needs list. Today those live partly in the directives table and partly nowhere. With the store, a new session, a new role agent, or a swarm partition starts already fitted, and a correction from him lands in one place that every lane reads.

## Sources

- https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- https://github.com/Investigator13th/anthropic-agent-methodology/blob/main/references/multi-agent-research-system.md
- https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent
- https://www.flowhunt.io/blog/multi-agent-ai-system/
- https://arxiv.org/abs/2603.28376 (Marco DeepResearch)
- https://arxiv.org/abs/2606.00660 (FineVerify)
- https://www.digitalapplied.com/blog/open-source-deep-research-agents-2026-guide
- https://github.com/jakkapat-kingthong/Deep-research-agent
- https://www.sciencedirect.com/science/article/pii/S2405959526000883 (Debating to verify)
- https://link.springer.com/article/10.1007/s44443-025-00353-3 (heterogeneous debate)
- https://arxiv.org/html/2504.00374v1 (persuasion overrides truth)
- https://www.reactify-solutions.com/articles/context-engineering-ai-agents-2026
- https://arxiv.org/abs/2605.08580 (Slipstream)
- https://arxiv.org/abs/2606.00619 (MemPro)
- https://arxiv.org/pdf/2606.23127 (procedural memory in LLM agents)
- https://arxiv.org/abs/2606.27457 (Cluster, Route, Escalate)
- https://arxiv.org/abs/2606.05922 (Retro-Harness), https://github.com/raphaelchristi/harness-evolver, https://github.com/PrimeIntellect-ai/prime-agent
- https://praesidia.ai/blog/claude-agent-sdk-permission-model-explained (the permission chain and hooks)
- https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html and https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/ (SDK architecture: tools, memory, hooks, MCP, subagents, compaction)
- https://cybersecuritynews.com/claude-code-shifts-agent-security/ and https://www.mindstudio.ai/blog/what-is-claude-code-auto-mode-permission-classifier (auto mode and the permission classifier, with Anthropic's measured approval and catch rates)
