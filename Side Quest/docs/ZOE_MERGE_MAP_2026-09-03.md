# The ZOE merge map

Date: 2026-09-03. Lucas's law, verbatim: "All aspects of both sides need to be merged or the final ZOE program won't work." This document is the complete map that law demands. One row per aspect. Each row names what Side Quest holds, what Echo holds, the one contract that merges them, the stage that owns it, and where it stands. The standing rule from the unification plan still holds: contracts merge, runtimes do not. JavaScript keeps the surface and the reply path, Python keeps data and models. A row is merged when both runtimes read and write the same contract, not when one is rewritten in the other's language.

Inventory the map is drawn from: Side Quest has 458 library modules, about 29 native operator tools, and 603 gated smokes. Echo has 36 packages, 19 agent manifests, about 600 MCP tools, 68 registered passes with 9 de-registered, and a 3.69 million-row trajectory log.

## The map

| # | Aspect | Side Quest holds | Echo holds | The one contract | Stage | Status |
|---|---|---|---|---|---|---|
| 1 | Config and fleet | config.js, .env, `model.*` meta | config.toml, `[llm.models]`, `[llm.roles]`, `manifest` | Echo's manifest is the one authority; the app consumes it | 1 | Live |
| 2 | Process supervision | engineSupervisor, boot cycler, self-reboot, live guard | orchestrator, scheduler, worker sidecars, huey | One supervisor with readiness, heartbeat, restart; a death is detected and announced | 2 | Live, one gap: p267 died at 10:45 with no detection |
| 3 | Memory stores and tiers | sq.db plus 8 sibling stores, all short-term | 17 stores across civic_graph, electoral, saga, general_knowledge, corpus | One memory map; tier registries on both sides; the hot-path law: heat, melt by coldness, retention by heat | 3 | 3.0 to 3.2 live; heat leg designed |
| 4 | Promotion bridges | documents, relations, entity proposals crossing up | staging tables crossing into the graph | Every staging table has a built gate and a measured backlog | 3 | Live; backlog 265k; 2 dead ends, 3 stalled |
| 5 | Object identity and graph | graph_entities with no Echo id | entities, relations, kg anchors | One identity space; a Side Quest object carries its Echo id or a reason it has none | 3.4 | Not started |
| 6 | Search and retrieval | documents_fts, knowledge vectors, localdb door, work coordinates | entity_search FTS5, hybrid ANN, staging read, search_knowledge, db_query | One search contract: every hot-path tool reaches short-term with the can-vouch mark; the map is the router's index; hot statements measured by statement | Search-path leg | Designed |
| 7 | Conversation and reply | runChatTurn, intent pass, cognition, the operator | Saga chat, nl, curator sessions | One reply path. Side Quest is the voice; Saga chat becomes a tool and a delegate, never a second brain | 6 | De facto; Saga chat still exists |
| 8 | Tool surface | about 29 native tools, Echo's tools through echo_suit with a tier gate | about 600 MCP tools tagged read, write, spawn | One tool registry with one tier policy, the auto-mode stipulations applied to tools | Tools row, new | Partial |
| 9 | Agents | none as a registry; workers and operators are lanes | 19 manifests, agent_runs, triggers, governor classes | One agent registry with trigger to tier mapping; one run ledger with parent and child | 4.5, new | Not started |
| 10 | Swarms and parallelism | partition swarm over background workers, one at a time | team_spawn, sequential and dead since June; spawn_workflow, unused; llm swarm, a three-way step runner | One swarm primitive: partitions of a roster dispatched to executors, where an executor is a Side Quest worker or an Echo agent; results fold to one place | 4.5, new | Not started |
| 11 | Scheduling, organs and passes | autonomy tick, 10 and 15-minute beats, the beat scheduler, promote beats | orchestrator cycles, scheduler and worker, passes registry | One organ registry with cadence, lane and last-run, both sides' organs in one table the status vector reads | Organs row, new | Partial: engine status reaches the vector |
| 12 | Quota and pacing | the quota law and gate | governor classes asking the app | One pacing law on four tiers: user, directives, development, expansion; only expansion paced, only when work is queued above it | 4.2 plus the usage law | Live but wrong; redesign designed |
| 13 | Model routing | `model.*` roles and lane models | model slots per agent | One fleet table both sides read | 4.3 | Not started |
| 14 | Spend ledger | usage_meter, cloud_traces | agent_trajectory token columns | One ledger; Echo's spend folds into the app's meter | 4.1 | Live |
| 15 | Observability | tee, obs_bus, route_health, stall attribution and profiler, status vector, memory map | logs, trajectory log, observability package, audit table | One event bus and one health vector; Echo organ events land on obs_bus | Observability row, new | Partial |
| 16 | Self-improvement | pen, rehearsal, the gate, self-audit, pursuit, self-reboot | code-reviewer agent, workflows, pytest | One repo, one gate, one pen reaching Echo; code-tier decisions under the auto-mode tiers | 5 | Not started |
| 17 | Learning and correction | directives, known_incorrect, procedures, skills, self_model, learning, reflection | methodology, maturation, cultivator | The correction door and the harness-edits ledger; directives read by every lane, not only the chat prompt | Leg D, leg A | Designed |
| 18 | Trajectory logging | cloud_traces, agent_events, obs_events | agent_trajectory with OpenInference columns | One trajectory contract: a per-task record joining components to outcome; the mining organ's input | Leg B | Designed |
| 19 | Deliverables and documents | documents store, product ledger, artifact registry, editor pipeline, canvas | vault, saga canvas and renderers, deliverables, hub | One artifact registry; one canvas; one document identity with lineage | Documents row, new | Partial: the canvas is shared |
| 20 | Surfaces and senses | voice, calendar bridge, inbox, meeting scribe, stealth browser, screen | voice, transcription, calendar, google auth, browser tools, os | One owner per sense; Side Quest owns the operator-facing senses, Echo owns capture organs; both through one auth bridge | Surfaces row, new | Partial: auth bridges live |
| 21 | Secrets and keys | keystore bridge to Echo | api_keys, secrets, keychain | Echo's resolver is the one authority | 1 | Live |
| 22 | Security and permissions | echo tier policy, content firewall | enforcement, os permissions | One tier policy and one firewall | Tools row | Partial |
| 23 | Data lanes and ingest | news lane, puller, api stream, feeds, decomposition sweep | ingestion, refresh sources, extraction, pipelines, corpora | One ingest registry on the expansion tier | Organs row | Partial |
| 24 | Verification and citation | anti-fabrication gate, corroboration, substantiation | verification, citation packs, cite floor | One substantiation grade; unknown never vouches on either side | Verification row, new | Partial |
| 25 | Repo, gate and pen | one repo, 603 smokes, pen jail | one mirror, pytest, no pen | Stage 5 | 5 | Not started |
| 26 | Name and vocabulary | Zoe | Saga, Skuld, Rainey, tenant | One name, one operator record, one seat prompt | 6 | Not started |

Rows 9 and 10 are the answer to the question that produced this map: there was no plan for the agents or the swarms. Rows 6, 8, 11, 15, 17, 18, 19, 20, 23 and 24 were likewise not stages. Every one of them now is.

## Stage 4.5: one agent registry, one swarm

What exists. Echo's agents are 19 TOML manifests with a model slot, tools, a cite floor and triggers; runs land in agent_runs with a parent id; the governor classes them Build, Maintain, Vet or chat; team_spawn is a star topology dispatched sequentially and has failed its only run since June; spawn_workflow has never run. Side Quest's parallelism is the partition swarm: a focus's remaining targets split round-robin across the background workers, one swarm machine-wide, released on convergence or a six-hour stall; her autonomous loop is barred from spawning any Echo agent by the tier gate, so only Lucas's chat can delegate.

The contract, in five parts.

1. **One registry.** Every agent and every worker kind on both sides is a row: name, purpose, executor (Echo agent or Side Quest worker), model slot, weight class, tools, trigger kinds, and the tier it bills under the usage law. Echo's manifests are the seed; Side Quest's worker kinds join as rows.
2. **One trigger-to-tier law.** A trigger kind maps to a tier: chat and directed to user or directives, scheduled to expansion, pen to development. The governor and the app's gate read the same table, so a chat-triggered delegate is never paced as research again.
3. **One run ledger.** Side Quest's partition threads become child runs of a parent, in the same shape as Echo's agent_runs with parent_run_id. The ledger is what the status vector, the swarm chip, and the mining organ read.
4. **One swarm primitive.** A swarm is a partition of a roster dispatched to executors. An executor is whichever registry row fits the partition's goal: an Echo agent for Echo-native work such as bills and contacts, a Side Quest worker for web research. Partitions inherit the parent's tier. A directed request may preempt a quota-paused swarm; the swarm-live refusal is logged. Echo's team supervisor and workflow door become executors of this primitive rather than a second swarm.
5. **One fold.** A run's output lands where a partition's does today: covered targets, the dossier, the agent-consume ledger. One consume path, so a delegate's answer reaches the conversation the same way a partition's does.

Order inside the stage: the trigger-to-tier law first, since it is one table and unblocks the delegates immediately; then the registry; then the run ledger; then partitions-as-executors; then the fold.

## The order of the whole

0. The freeze tail: cut 18 and its siblings.
1. The usage law: four tiers, queue-aware pacing, the cheap-model exemption.
2. Stage 4.5: agents and swarms, in the order above.
3. Stage 5: one repo, one gate, one pen; the auto-mode tiers on code.
4. Leg A, leg D, leg B, leg C: the harness as data, the correction door, trajectory mining, metric-gated prompts.
5. The search-path leg and the memory hot-path leg.
6. Stages 3.3, 3.4 and 4.3: the audit log, the identity space, the fleet table.
7. The new rows: observability, organs, documents, surfaces, verification.
8. Stage 6: one name.

## How to know a row is merged

A row is merged when both runtimes read and write the same contract and a smoke on the gate pins it from both sides: a Side Quest smoke reads what Echo wrote, an Echo test reads what Side Quest wrote. Until both pins exist the row stays partial, whatever the code says.
