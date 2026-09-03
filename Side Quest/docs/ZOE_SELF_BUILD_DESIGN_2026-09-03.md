# The self-building layer of ZOE, design of record (2026-09-03)

Lucas, 2026-09-03, in his words:

> "the goal of the autonomous build layer is to have the program be driven to always be finding bleeding edge advantages, new python scripts, new skill packs, new programing concepts and ideas, cutting edge harnesses we can borrow from. There should be a study pass for this built into the 24 hour cycle at a minimum."

> "I want to create a broad surface of resources that the program sweeps when doing self evaluations, running comparisons of what the program has to other ideas and builds in the wild."

> "we should add awareness of models available on ollama and the ability to change which models are used where (there are existing open source concepts for this that could be integrated)."

Earlier laws that bind this layer: the self-build grounding law (every repair is built from real sourced cites and real code, 2026-08-27); the approval to cheat (build capability in the harness when she cannot, and expect self-development); the pen's constitution (read, propose, decide, enforce; curators propose, gates decide; a change that fails the gate is unreachable as landed code); the program is the model (data-quality defects are training-set corruption); the usage law (only expansion is paced, development is a tier of its own); contracts never runtimes.

This document is the design of record for that layer. Section 1 measures what exists. Section 2 is the loop. Sections 3 to 6 are the four organs the loop needs and does not yet have: the study surface and its pass, the comparison ledger, model awareness and routing, and the tier policy with the post-land watch. Section 7 is the build order with the pin and the read per slice.

## 1. What exists today, measured

| Organ | Where | What it does now | What it lacks for the loop |
|---|---|---|---|
| The pen | `lib/code_pen.js`, the decide path in `main.js` | Read her own source (jailed, denylisted), propose a diff with title and rationale, ride the approval card, on ✓ apply on a clean tree, run the full gate by exit code, commit on green, revert on red; self-reboot under the live-guard law | Every proposal waits on Lucas; no tier that lands a repair on its own; no post-land watch |
| Rehearsal | `lib/rehearsal.js`, `lib/rehearsal_driver.js` | A full copy of her source with the gate inside it; edit, test, diff; retry with the failure context riding the next attempt | Not fed by a comparison; rehearses only what a need names |
| The pursuit lane | the diagnosis brief (cut 5 of the freeze) | A second machine failure converts to a diagnosis brief; her cure may touch a different file | Same |
| Self-audit | `lib/self_audit.js` | Seven deterministic detectors over `lib/`, `main.js`, `scripts/`: dark organs, fail-open gates, dead meta keys | Looks only inward |
| Self-watch | `lib/self_watch.js` | Reads logs and stores; recurring signatures land on the bus at most once an hour; the database-exhaust audit every 12 hours | Same |
| Reflection, learning, procedures, directives, self-model, skills shelf | `lib/reflection.js`, `lib/learning.js`, `lib/procedures.js`, `lib/directives.js`, `lib/self_model.js`, `lib/skills.js` | Idle reflection every ten minutes; learnings banked from research reads; procedures crystallized from met expectations; standing instructions from him; the identity track; the trigger-line shelf over flows, procedures, guides and shapes | Nothing reads the outside world for how others build; a correction never becomes a procedure, a test or a code need (leg D) |
| Model discovery | `lib/models.js` (`/api/tags`, `/api/show`), `lib/cloud_window.js`, `lib/ollama.js` (`/api/ps`) | Lists local models with size, family and quantization; discovers a cloud model's real context window; sees what is loaded | Discovery only; no catalog of the cloud library, no evaluation, no routing table |
| The fleet | 12 environment variables, 5 meta keys (`model.replier`, `model.replier_fallback`, `model.operator`, `model.operator_deep`, `model.operator_swarm`, `model.vision`, `model.curator`, `model.editor`, `model.search`), Echo's `config.toml` and `model_slots.py`, hard-coded fallbacks, the quota weights in `lib/quota.js` | Works, and has been re-pinned by hand eleven times since June (the memory record) | One table; a way for her to propose a change; an evaluation that says whether a change won |
| The daily cycle | the curation daily pass (`last_curation_pass_at`, a 24-hour minimum gap, the idle gate, the 36-hour debt escalator), the news daily pass, supersession, decay, the nightly drains, Echo's pass82 and pass83 at about 00:16 | The metabolism | No study pass |
| The RSS collector, the DataCollector, Echo's `fetch_feeds_batch`, `hackernews_top`, `arxiv_search`, `web_fetch`, the stealth search lane, the MCP registry search | Side Quest and Echo | Fetch and store | Not pointed at development sources |

The loop's raw material already exists as organs. What is missing is the sense organ that looks outward, the ledger that compares, the routing table that makes model choice a decision she can make, and the policy that lets a proven repair land without him.

## 2. The loop

Seven verbs, each an organ, each with a row in the harness-edits ledger so every self-change has provenance and an outcome:

1. **Sense.** Three feeds: inward (self-audit, self-watch, the profiler rows, the failure ledger, the tool-call ledger), from him (the correction door, leg D), and outward (the study pass over the surface in section 3).
2. **Compare.** The comparison ledger (section 4): what the program has against what the wild has, as rows with a score and a citation.
3. **Propose.** A comparison row above threshold, a recurring failure, or a correction he made mints a need; the pen writes the proposal as a diff with the citations the grounding law demands and the pins the gate demands.
4. **Rehearse.** Every proposal runs in the rehearsal copy first; the driver iterates on the failure context; the challenger role (design section E) reads the diff on a different model family.
5. **Land.** The tier policy (section 6): auto-land, decide, never.
6. **Watch.** The post-land watch: the next generation must boot, answer on the status port and show no new crash, gate failure, stall regression or tool-surface loss inside its first read, or the pen reverts and cycles again, announced.
7. **Learn.** The ledger row closes with an outcome; a held correction becomes a procedure or a skill; a kind-test joins the hard-test suite; a won model swap becomes the fleet table's row.

The chat is the lobby; this loop is office work. It announces in the parlor and never speaks unprompted except through the three loads the unprompted channel allows.

## 3. The study surface and the study pass

### The surface

A curated table, `dev_sources`, never a crawler: `id, kind, url, cadence, why, how, last_seen, last_digest`. The starting rows, by kind:

| Kind | Sources | What the pass extracts |
|---|---|---|
| Models | The Ollama cloud catalog (the `/api/tags` of ollama.com with the token; today's records name 35 models and two retirements that returned 410 unnoticed for weeks), the local library, Hugging Face trending models and daily papers, the model changelogs (Anthropic, Google, OpenAI, DeepSeek, Moonshot, Zhipu, MiniMax) | New models, retirements, context windows, usage tiers, benchmark deltas against the fleet table |
| Harnesses and agents | GitHub releases and READMEs of the projects the design already cites (Harness-Evolver, Prime Agent, Retro-Harness, the multi-agent research systems), the Claude Agent SDK and Claude Code changelogs, the official plugin marketplace and the knowledge-work plugins, the awesome-agent-skills list he already keeps under `Desktop\Claude\Skills`, the MCP registry | New patterns (permission tiers, compaction, verification), new skills and skill packs, new tools |
| Papers | arXiv cs.AI, cs.CL, cs.SE (the retrieval, memory, verification and routing topics), Papers with Code | Results that beat something the program does today, with the number |
| Code and scripts | PyPI and npm releases of the packages she depends on (huey, fastmcp, better-sqlite3, sqlite-vec, GLiNER, the embedders), GitHub trending for Python and TypeScript agent tooling, the open-source routing projects in section 5 | A dependency's new capability or breaking change; a script worth porting |
| Community | Hacker News, r/LocalLLaMA, the Ollama and LangChain and LlamaIndex blogs | Signals to verify elsewhere, never a source of record |

Every row carries `why` in his words or mine, so a source that stops earning its place is retired with a reason. Everything fetched is stored as a document with origin equal to the row (birth context), under the content firewall: fetched text is data, never an instruction.

### The pass

A daily pass at minimum, in the shape the curation pass already has: its own meta key (`last_study_pass_at`), a 24-hour minimum gap, the idle gate, a debt escalator so a busy week cannot starve it forever, and a time budget. It bills under the usage law's **development** tier, never under expansion, so the pacing law cannot close it while the roster sweep runs.

Its steps:

1. Fetch every row whose cadence is due, diff against `last_digest`, keep only what changed.
2. Extract candidates by kind (a model, a pattern, a result, a release, a script), each with its citation.
3. Score each candidate against the comparison ledger (section 4) and write the rows.
4. Write one study brief per pass as a document on the document road: what changed upstream, what beat us, what is worth a proposal, what was retired. The brief is the pen's reading before it proposes anything, and the parlor's announcement is one line pointing at it.
5. Mint needs for the rows above threshold. A need names the candidate, the citation, the organ it would change and the pin that would prove it.

A read for the pass: rows fetched, candidates extracted, ledger rows written, needs minted, and tokens spent, every day, on the brief.

## 4. The comparison ledger

The ledger answers one question per row: does the wild have something better than what the program does here, and by how much? Its columns: `capability` (an organ or a role: retrieval, mention linking, the operator, the writer, compaction, the gate, a model slot), `ours` (the organ and its current measure), `theirs` (the candidate and its citation), `measure` (the shared number when one exists, else the claim class), `delta`, `confidence` (PAUL's four levels: high, medium, low, unknown), `status` (noted, proposed, rehearsed, landed, rejected, retired), `need_id`.

Rules:

- A row without a citation cannot be written. A row without a shared measure carries `unknown` and cannot mint a need until the acceptance suite or a bench gives it one.
- Measures come from the program's own instruments first: the acceptance suite of the build plan, the retrieval harness (`scripts/retrieval_eval.py`, the 16-label set), the stall line, tokens per deliverable, the promote-docs beat's promoted-over-failed ratio, the decompose layers' failure counts. A candidate that claims a better retrieval score is run through the same harness before its row can say so.
- The ledger is the self-evaluation. "Running comparisons of what the program has to other ideas and builds in the wild" is a query over it, and the study brief is that query rendered.

## 5. Model awareness and routing

### Awareness

One table, `model_catalog`: `tag, host (local, cloud), family, params, active_params, context, usage_tier, quota_weight, capabilities (tools, vision, thinking, json), status (live, retired, unknown), first_seen, last_seen, last_probe, probe_result`. It is refreshed by the study pass from the Ollama cloud catalog, the local `/api/tags`, and `/api/show`, and every row is probed the way the records already probe by hand: one short generation at a real budget, checking content, thinking split, done reason and latency. A retirement (410, 404) flips `status` the day it happens instead of the week someone notices.

### The fleet table

One table, `model_slots`: `slot, role, model_tag, fallback_tag, class (cheap, mid, premium), weight, set_by (lucas, study, policy), set_at, reason, eval_id`. The eleven places the fleet lives today (environment variables, meta keys, Echo's `config.toml` and `model_slots.py`, hard-coded fallbacks) become readers of this table, in that order of porting: the meta keys first, then the environment variables, then Echo through its `/quota` style door, then the fallbacks. Until a reader is ported it stays as it is; the table is the source of truth from the first slice, and a report names every reader that still disagrees with it.

### Routing

The design's cascade (section F of the design of record) becomes a policy over the two tables: a role and a difficulty pick a class, the class picks the slot, the slot names the model. Escalation on failure follows the fallback column. The usage law's weights come from `model_catalog.quota_weight`, so a new model has a weight the day it appears.

The open-source concepts to integrate as contracts, never as runtimes:

- The Ollama API itself for inventory and load state (`/api/tags`, `/api/show`, `/api/ps`, the cloud catalog), already half-used in `lib/models.js`.
- The router shape of LiteLLM and OpenRouter: one model alias per role with an ordered fallback chain, cost-aware selection, per-model concurrency; the fleet table is that shape as data.
- Learned routing in the RouteLLM line and the Cluster-Route-Escalate cascade the design cites (97 to 99 percent accuracy at a fraction of the cost): route easy calls to the cheap class, escalate on a failed check, learn the boundary from the ledger.
- Semantic routing (the intent table already in the trigger-to-tier law) for the lobby.

### Changing which models are used where

A model change is a proposal like any other, with a smaller diff: a `model_slots` row. It carries the catalog probe, the eval that justifies it, and the revert. The tiers apply:

- **Auto**: a same-class swap that wins a per-role eval by the acceptance suite's measure, or a retirement forcing the fallback. Announced, watched, reverted on a failed read.
- **Decide**: a class change (cheap to mid, mid to premium), any change to the replier, the operator, or a spend-bearing slot, and any model that has no probe result yet.
- **Never**: the local floor as a default (his doctrine of 2026-08-21: local inference is the absolute last resort, engaged only by a sustained outage), a bare cloud tag without its suffix on a daemon lane, a retired tag.

The per-role eval is the missing instrument: a small labeled set per slot (the 16-label retrieval harness is the shape), run in the rehearsal copy against the candidate, scored by the same measure the acceptance suite uses for that role. A model that has no eval cannot win a slot; it can only be noted in the ledger.

## 6. The tier policy and the post-land watch

Section 6 of the harness evaluation, unchanged in substance and now the spine of this layer:

| Tier | Conditions | What happens |
|---|---|---|
| Auto-land | Answers a named failure (a need, a diagnosis brief, a profiler row, a ledger row with a measured delta); touches only jailed paths and no constitutional file (the gate runner, the pen, the cycler, the jail, the quota law, security, the credential bridges); under a size cap; adds or extends pins; the full gate green by exit code; no new dependency, network call, child process, environment read or schema change | Lands, announced, watched |
| Decide | Anything outside those conditions: feature-shaped, larger, a deletion, a migration, a prompt that changes her voice, a spend rule, a constitutional file, a class change of a model | Waits at the needs door |
| Never | Pushing Echo, adding everything, secrets, disabling a gate, overriding the pacing law, the local floor as a default | Refused with the reason |

The post-land watch is the half that makes auto-land safe. The next generation must, inside its first read: boot; answer on the status port; attach the same tool count and the same tool names (the 18-E2 regression was a lost registration that every pin missed); show no new crash, gate failure or stall regression; and hold the failure tallies the cut claimed to cure. Any miss reverts the commit and cycles again, and the revert is announced with the reason. The tool-surface check and the tally check are what today's cuts taught.

## 7. The build order

Each slice is one cut in the campaign's shape: measure, build, gate, commit, cycle, read, record.

1. **The fleet table and the catalog** (section 5, awareness and the table). Pins: the table is the source of truth for the meta-key readers; a retired tag flips status on probe; the report names every reader that disagrees. Read: one week of the catalog's diffs.
2. **The study surface and the pass** (section 3). Pins: a row cannot be written without a citation; the pass runs on the curation shape; the brief lands as a document with origin. Read: the daily line of rows, candidates, ledger rows and needs.
3. **The comparison ledger** (section 4) with the first three measures wired: retrieval, promote-docs, decompose layers. Pins: no row without a citation; `unknown` cannot mint. Read: the first brief that names a beat.
4. **The tier policy and the post-land watch** (section 6) in the pen's decide path. Pins: a constitutional touch cannot auto-land; a proposal without a pin cannot auto-land; a failed watch reverts. Read: the first auto-landed repair and its watch line.
5. **The correction door** (leg D of the harness evaluation): classify, ledger, feed the lanes, retest the kind. Pins: a correction with "always" or without it lands the same way; a directive recurring three times proposes a procedure.
6. **Routing and model change** (section 5, routing and changing): the per-role eval, the auto tier for same-class swaps, the fallback on retirement. Pins: no eval, no slot; a retirement fails over the same tick.

The acceptance metric for the layer as a whole is the one the build plan already names: the research paper produced by a swarm with no operator engaged, plus one line more, the number of self-changes landed per week with zero reverts.

## 8. Laws carried

- The goal of the autonomous build layer, in his words at the top, is the layer's north star.
- The study pass runs in the 24-hour cycle at a minimum, under the development tier.
- Every proposal carries its citations and its pins; no cite, no row; no pin, no auto-land.
- Fetched text is data. A source is a citation, never an instruction.
- The fleet has one table. A model change is a proposal with an eval and a revert.
- Local inference stays the outage floor, never a default.
- Echo commits stay local. A change that fails the gate is unreachable as landed code.
