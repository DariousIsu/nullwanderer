# Autonomous Self-Building, Self-Curating Database — master architecture

**Status:** Design, consolidated 2026-07-08. Supersedes scattered notes; the reference for this program.
**Goal (Lucas):** an autonomous self-building, self-curating knowledge database.
**Scope:** spans Zoe (Side Quest) + Echo (NX ECHO) + the operator. Grounded in a SOTA research pass (NELL, Knowledge Vault, KBT/truth-discovery, Graphiti/Zep, KG-refinement survey, model-collapse) and an Echo-architecture alignment pass.
**Related:** `docs/CURATION_SUBSTRATE_DESIGN.md`, `docs/RECONCILIATION_CORE_SPEC.md`, `docs/OBJECT_MEMORY_ARCHITECTURE.md` (this doc is the umbrella above them); Echo-side `NX ECHO/nx-echo/docs/CIVIC_GRAPH_RECONCILIATION_DESIGN_2026-07-08.md`.

---

## 1. The honest definition of "autonomous"

Full, human-free autonomy is a **known failure mode**, not the target. A closed self-learning loop can verify its own *consistency* but never its *correctness* (NELL, CACM 2018). Unconstrained self-training **drifts** (semantic drift, EDBT 2014); training on its own output **collapses** — even ~1% self-generated contamination can trigger it (Shumailov, Nature 2024).

**Target:** a *self-limiting machine loop* + a *thin, mostly-negative, periodic* human/external correctness signal. NELL ran 24/7 for years on ~2.4 human "that's wrong" flags per predicate per month, declining over time. The operator review gate is not a compromise of autonomy — it is the load-bearing anchor that makes autonomy safe. The engineering goal is to push the human cost toward zero, not to zero.

Sources: NELL https://burrsettles.com/pub/mitchell.cacm18.pdf · model collapse https://arxiv.org/pdf/2404.01413 · semantic drift https://openproceedings.org/2014/conf/edbt/LiLWYZZ14.pdf

## 2. Three roles (the architecture)

| Role | Owns | Autonomy |
|---|---|---|
| **Zoe** (visiting LLM on the Rainey tenant MCP) | *Propose* candidate nodes/edges into tenant staging; *enrich* the queue (corroboration scores, calibrated confidence, contradiction flags) | Fully autonomous |
| **Echo Cultivator / Skuld** (the curator) | Civic-graph reconciliation: supersession candidates, semantic-dedup candidates → the existing `resolve/` queue, re-verification ("Vet") | Autonomous, Echo-side |
| **Operator** (Lucas) | The promote/reject/merge **gate** (κ.C ProposalsPanel + `resolve/` decide) | Thin, mostly-negative |

Locked Echo invariants this respects: civic_graph is a read-only *foundation* from a tenant's view; promotion is operator-gated at every layer (Option B / κ.C panel / Skuld charter: "no silent auto-promotion"). Zoe never writes the shared graph directly; it proposes + enriches.

## 3. Current state (from the audit)

- **Architecture** — staging → operator-gated promotion → believed tier. **Correct / SOTA-shaped.** Not a reinvented wheel.
- **Curation engine** — roughly "append-only, pre-2014 constant-confidence extractor."
- Built-but-dormant assets to activate (not greenfield): temporal columns on the memory tier (`echo/memory/bitemporal.py`), `reconcile.js` / `RECONCILIATION_CORE_SPEC`, the puller belief-revision engine (never fires), the forecast **Brier/ECE calibration harness**, Echo's `resolve/` entity-resolution queue, near-dup cosine merge in `cloud_curator`.
- The landing gap (root cause): Zoe's proposals piled up unpromoted in `tenant_rainey.*_proposals` because the operator gate wasn't being used — not because a promoter was missing. See `growth-audit-landing-gap` memory.

## 4. Substrate decision (locked 2026-07-08)

**Stay on SQLite; use `sqlite-vec` for vector similarity.** Rationale: Echo is deeply SQLite-native (attach-based foundations, 6.9 GB `civic_graph.db`) and already embeds in-SQLite. `pgvector` is Postgres-only, so adopting it means migrating the whole graph — out of proportion for a single-operator local system. Revisit Postgres+pgvector only if (a) continuous concurrent autonomous writes hit SQLite's single-writer ceiling, or (b) vector search at 1.7M-entity scale outgrows `sqlite-vec`. NeurDB / MindsDB automate a *different axis* (engine self-tuning / federated query), not knowledge curation — not substrates for this goal.

## 4b. Curation compute + entity-resolution stack (non-LLM; 2026-07-08)

Bias correction: the curation layers (Steps 2–3) do **not** need to be LLM/embedding-heavy. Entity resolution on messy, mismatched records is a mature, *non-LLM*, GPU-free, explainable discipline — cheaper and more auditable, which suits a self-limiting autonomous loop. Adopt:

- **DuckDB (MIT) as the analytical/curation compute engine.** `ATTACH`es and reads the 6.9 GB SQLite `civic_graph` **in place** — SQLite stays system-of-record; DuckDB runs the heavy batch passes (dedup candidate generation, corroboration counting, staleness scans) out-of-core without Python round-trips. Has an HNSW **VSS** extension (`vss_join` fuzzy joins) — a third in-stack vector option alongside `sqlite-vec` (softens the §4 fork; decide at Step 3 by benchmark). Caveat: VSS HNSW persistence is experimental — use for read-heavy curation passes, not the transactional store.
- **Splink (MIT) for entity resolution (Step 3).** Probabilistic record linkage (Fellegi–Sunter + EM), **unsupervised** (no labels), runs **on DuckDB** on a laptop, no GPU; ~7M records deduped in ~2 min; outputs a **match probability per pair** with blocking. Projects entities → tabular (name/type/aliases/external_ids/key-facts), links, and feeds **probabilistic candidates into Echo's existing `resolve/` `resolution_proposals` queue** — complementing (not replacing) Echo's deterministic strong-id/name tier, filling the fuzzy + org/bill/concept gap. Operator still decides; merges stay reversible.
- **Probabilistic / gradient-boosted confidence (Step 2).** Learn a **calibrated** fact/match probability from provenance features (independent-source count, source trust, extractor) — Knowledge-Vault-style supervised fusion; Splink's Fellegi–Sunter weights are the unsupervised analog. Preferred over a hand-rolled corroboration formula.
- **Rejected/deferred:** Zingg (needs labels, Spark-only, **AGPL** — licensing conflict); GNN/PyTorch Geometric for link-prediction/completion (GPU + training + opacity — future, not near-term); bare MLP (gradient boosting dominates on messy tabular).
- **Cross-area:** the same DuckDB+Splink+probabilistic-confidence stack directly serves the **discovery/Puller** side (12k person records + mismatched bulk sheets = record-linkage territory) and its belief scoring.

Sources: Splink https://github.com/moj-analytical-services/splink · fast dedup https://www.robinlinacre.com/fast_deduplication/ · DuckDB VSS https://duckdb.org/docs/current/core_extensions/vss

## 5. Dependency-ordered roadmap (the corrected sequence)

Order is load-bearing: each step is a prerequisite for the next. Building refinement (Step 3) first, on fixed single-source confidence, "merges distinct entities and expires correct facts as readily as it fixes errors" (KG-refinement survey; Paulheim: *refinement presupposes construction*).

### Step 0 — Provenance + bi-temporal substrate  ·  build first · additive · non-destructive
The foundation everything downstream needs. Nothing — corroboration, decay, supersession, retraction — is expressible without it.
- Add to civic `relations` (mirror `echo/memory/schema.py`): `valid_from/valid_to` (world time), `tx_from/tx_to` (system time), `superseded_by/supersedes` lineage, a `relation_supersession` audit log, and a partial live-row index. Backfill `tx_from=valid_from=created_at`.
- Provenance as a per-edge **source SET** (which source(s)+URL+extractor+timestamp), not a single `proposed_by` string — corroboration is a count over independent sources, so the set must exist first.
- **No supersession logic yet.** Just the substrate (phase 0a) + the inert reader/trigger hardening (phase 0b, per §7c) so Step 3 activation is later safe. The degree triggers (`store.py:1194-1227`) + the ~7 `deleted=0`-only reader groups get `AND tx_to IS NULL` while nothing yet writes `tx_to` — a calm no-op refactor.
- Home: Echo (civic_graph is Echo's). Apply via review-before-execute migration; validate on a copy of the 6.9 GB DB. **Never couple 0a/0b with supersession writes (0c/Step 3).**
- Sources: bitemporal `echo/memory/bitemporal.py`; Graphiti https://arxiv.org/html/2501.13956v1 ; uncertainty/provenance survey https://arxiv.org/html/2405.16929v2

### Step 1 — Growth / landing loop  ·  operator-gated
Make proposal→promote reliably add *correct* facts. Promotion stays operator-gated (κ.C panel). Zoe's job here: forward the gate's grade-confidence on `propose_*` (DONE, uncommitted) and surface/rank the queue so review is fast. Do **not** autonomously promote (retract the earlier Zoe-side auto-promote trigger — it violates the locked gate + duplicates Echo's `promote_proposals_bulk`).

### Step 2 — Multi-source corroboration + calibrated confidence  ·  Zoe's lane · on the Step-0 substrate
Replace the fixed cap. Confidence must **rise with independent corroboration** (Knowledge Vault / truth-discovery) — the opposite of the puller send-safety model where "corroboration never exceeds the cap." Guard the **echo-chamber failure**: dedup sources by domain/near-duplicate so Wikipedia + its mirrors count as **one** source (naive voting is wrong ~30% of the time). Calibrate the number (Platt/temperature) against verified facts — reuse the forecast **Brier/ECE** harness; derive A–E grades from calibrated thresholds, not by hand. Add per-predicate confidence **decay** (title/role rots fast; birthplace doesn't) → decayed facts auto-queue for re-verify.
- Sources: KV https://www.cs.ubc.ca/~murphyk/papers/kv-kdd14.pdf · KBT https://www.vldb.org/pvldb/vol8/p938-dong.pdf · calibration https://arxiv.org/abs/1706.04599

### Step 3 — Supersession + semantic dedup (reconciliation)  ·  LAST · depends on 0,1,2
- **Supersession is contradiction-gated, not clock-gated.** Only when two edges genuinely conflict (schema cardinality-overlap for functional predicates; LLM/semantic check for free-text) do we act. Decide on **valid-time** (close the old edge's `valid_to` at the new fact's `valid_from`), tie-break by **justification/confidence — never `created_at`**. **Confidence-gated:** a well-corroborated fact may auto-supersede; a single-source/low-confidence claim is recorded as a **competing proposal**, never a silent overwrite. Functional predicates (one-CEO: `HAS_CEO`/`HAS_CHAIR`/`SUBSIDIARY_OF`) are the only near-deterministic case — and still on valid-time overlap + a confidence floor. **`created_at`/ingest-recency is for audit only** (a late-arriving old fact must never clobber a newer truth).
- **Dedup:** embedding (`sqlite-vec`) + FTS candidate generation, extended beyond person to org/bill/concept, feeding Echo's **existing `resolve/` `resolution_proposals`** queue (do not build a rival merger). Operator decides; merges stay reversible aliases.
- Home: Echo Cultivator/Skuld tasks, budget-bounded per predicate/cycle, **proposal-first**.
- Sources: Graphiti invalidation https://arxiv.org/html/2501.13956v1 · TMS/least-justified retraction https://en.wikipedia.org/wiki/Truth_maintenance_systems · KG-refinement survey https://www.semantic-web-journal.net/system/files/swj1167.pdf

## 6. Cross-cutting guardrails (anti-drift, from the research)

- **External anchor / never self-cannibalize** — keep a persistent core of source-verified facts and always accumulate self-inferred beliefs *alongside* it, never replacing (collapse antidote; even 1% self-generated contamination is dangerous).
- **Ontology constraints, esp. mutual exclusion** — NELL's highest-value anti-drift device (manufactures negative evidence for free). Type + subset/superset + disjointness as soft/penalized constraints.
- **Bounded candidate budgets** per predicate per cycle (tractability + stops one over-broad pattern mass-injecting drift).
- **Periodic full refresh** alongside incremental (incremental community/aggregate structure drifts from a true recompute — both Graphiti and GraphRAG concede this).
- **Watch slow-then-sudden failure** — track per-predicate precision + diversity over time, not just aggregate accuracy; drift/collapse look benign for many iterations then accelerate.
- **Copy/independence detection** on every corroboration count (mirrors ≠ independent sources).
- **Recursive/hierarchical traversal safety (already house style — inherit it).** Echo already does self-referential traversal correctly: `query_graph` (`graph.py:352`) uses `WITH RECURSIVE` + a `seen` visited-set + a hop cap; canonical/merge resolution (`resolve/canonical.py:66`) is `_MAX_DEPTH=8`-capped and `apply.py` flattens chains. The reconciliation adds three new chained structures that MUST inherit this: (1) **supersession lineage** (`superseded_by/supersedes`) — keep flat (point to current-live), never form a lineage cycle; (2) **SAME_AS/canonical merge chains** under autonomous Splink-fed volume — the one genuinely NEW guard: an autonomous merge must refuse to set `canonical_id` to anything that resolves back to itself (merge-cycle = brick-the-graph); (3) **functional hierarchies** (`SUBSIDIARY_OF`/`PARENT_OF`/`LOCATED_IN`) — rollup queries need their own cycle guard. Rules: **read side = recursive CTE (SQLite/DuckDB) + visited-set + depth cap, never Python-stack recursion** (blows the 1000-frame limit at our scale); **write side = cycle-prevention at write time on autonomous supersede/merge** (a safety requirement, not a nicety).

## 7. Operator gate + supporting tooling

The gate already exists (Echo κ.C ProposalsPanel + `resolve/` decide). Governance-tool patterns (Bytebase review-before-execute; Atlas/OpenMetadata lineage) validate this shape — borrow the review-before-execute discipline for schema migrations (Step 0). A SQLite GUI (DbGate / Beekeeper / DB Browser) is useful *supporting* tooling for operator inspection/review of `civic_graph.db`, not architectural.

## 7b. Completeness check & adjacent curation axes (2026-07-08 seed sweep)

A sweep of adjacent systems (ACE, mem0, Hermes-agent, autoresearch, Go audit-log tooling) mostly **validated** the plan (we are not reinventing: mem0's ADD/UPDATE/supersede memory ops = Echo's bitemporal memory tier; Hermes' cron + subagent-spawn = our scheduler/idle loop; autoresearch's markdown-steering = our `focus.*.md`). It surfaced three additions:

1. **Procedural/skill memory is a SECOND self-curating store — same discipline (was under-covered).** The KG is not the only thing that must self-curate. Zoe's *how-I-work* memory (`self_model`, `self_dev`, `protocols`, `learning`, `reflection`) needs the same loop: **reflect from failure traces → extract a reusable lesson → curate (add/refine/prune) via incremental DELTA update, never full rewrite.** ACE (Reflector + curated Skillbook) and Hermes (self-improving skills) both center on this, and the delta-not-rewrite rule is the anti-**context-collapse** discipline — the same model-collapse failure mode (§1, §6) applied to procedural memory. **Directly relevant to long-run projects** (versioned, reusable strategies that survive across runs). Apply §6 guardrails (curate-don't-accumulate, bounded budgets, external anchor) to this axis too.
2. **Close the objective→keep/discard loop.** The autonomous loop should *optimize against a measurable quality objective and act*, not just monitor (autoresearch: metric → keep/revert per iteration). Wire the existing signals — the forecast **Brier/ECE** harness + the back-check's landing/novelty/cost numbers (`scripts/audit_growth_backcheck.js`) — into an explicit per-cycle "did quality improve? keep : revert/flag" decision. Without a closed objective, an autonomous curator can drift while looking busy.
3. **Audit rigor on the Step-0 logs.** Established audit-log pattern = append-only + structured **before/after state** + actor→action binding (optionally hash-chained/signed). Our `relation_supersession` log has actor/reason/lineage; cheap add = capture **before/after** in the event. Cryptographic tamper-evidence is overkill for a single-operator local system — noted, not built.

## 7c. Ecosystem fit, blast radius & phased rollout (2026-07-08 two-repo map)

**Fit:** the bi-temporal pattern is already native to BOTH sides — Echo runs it on `memory_facts` (`echo/memory/bitemporal.py`; `operator.py:47` calls the current hack a "stand-in for full bi-temporal supersession"), and Zoe's local `sq.db` graph already has `valid_from/valid_to` + a live-only reader (`smoke_graph_phase4`). Step 0 extends a proven convention to the one table lacking it. Zoe writes Echo only via `propose_*` into tenant staging (operator-gated); nothing writes `civic_graph.relations` directly except promotion + ETL refresh.

**Blast radius is bounded, enumerated, Echo-side, and all one-line fixes** — the risk is NOT the columns (inert/additive/reversible; precedent: `relation_metadata` added post-hoc; no `SELECT *`/positional INSERT anywhere) but ACTIVATING supersession WRITES:
1. **Degree cache = sharpest break** (`store.py:1194-1227`): triggers key on `deleted`, never `tx_to`; supersession is `UPDATE tx_to` (not delete) → no trigger fires → **double-counted degree** → corrupted `graph_overview` ranking, no self-heal. Must fix triggers in the same change.
2. **~7 reader groups filter only `deleted=0`** → surface stale edges: `graph.py` (kg_neighborhood/graph_overview/query_graph/list_relation_types), `kg_query.py`, `bills.py`+`bill_meta.py`, `research_assistant.py` (10 packs), `nl/retrieval.py`, `ppr/adjacency.py`, `resolve/apply.py external_degree`. Each needs `AND tx_to IS NULL`. Plus ETL find-or-create probes (else refresh stops healing superseded facts).
3. **Zoe side: exactly one query** — `echo_suit.relatedEntities` → `cognition.js` "currently holds…" — behavioral (stale role voiced), not a crash; fix = the temporal predicate Zoe already uses locally, or Echo filters server-side (then Zoe needs zero changes).

**Phased rollout (decouple substrate from activation — this is what makes it low-risk to revert):**
- **0a** add columns + backfill (`tx_from=valid_from=created_at`, `tx_to=NULL`) — inert, reversible, zero behavior change.
- **0b** harden degree triggers + the ~7 reader filters + counter caches — still inert (nothing sets `tx_to`), a calm no-op refactor.
- **0c (= Step 3, much later)** flip supersession writes on, behind a flag, validated on a DB copy.
The only dangerous path is flipping writes before 0b. Revert: columns are inert (leave them); supersession is supersede-not-delete (no data destroyed) → rollback = reopen `tx_to` windows or ignore `tx_to` in readers. Splink/DuckDB add zero to this risk (read-only).

## 7d. LLM × classical division of labor (the funnel)

Marriage, not replacement — LLM at the two ends where it's irreplaceable, classical in the high-volume middle (KV + Graphiti architecture). Sequence unchanged; this defines WHO does each stage.
- **Front — LLM-led growth / new-entry research (already is):** read web/docs/conversation → structured candidate facts. **Key enhancement: extract VALID-TIME from source prose** ("became CEO in 2023") — only the LLM can, and Step-3 supersession *needs* valid-time. Emit first-class provenance (source set + URL + date).
- **Middle — classical mass (cheap/deterministic/calibrated/auditable, no per-row LLM):** Splink pairwise match-probabilities (blocking + Fellegi-Sunter); DuckDB corroboration counting + analytical passes; probabilistic/GBM calibrated confidence.
- **Back — LLM only on the residue + semantic tasks classical can't:** adjudicate Splink's ambiguous middle band only (tiny fraction) + canonical name/summary on merge (Graphiti); semantic contradiction check only on classical-surfaced same-entity-pair candidates (never whole-graph); summarize the proposal queue with rationale so the operator gate is fast.
- **Compounding:** better extraction → better scoring → smaller LLM residue → faster gate. LLM also improves the classical models (Splink blocking rules, active-learning labels, ACE reflector over curation failures).
- **Anti-pattern:** never LLM-judge every pair (slow, uncalibrated, unauditable — defeats cost + audit discipline).

## 7e. Visualization / demo surface (the KG panel)

The KG panel (`renderer/kg.js` + `studio/kg_view.js`; Follow via the `kg:focus-move` broadcast) is the primary *beneficiary* of this work — it shifts from animating *growth intent* (today it follows the walk, which lands nothing) to showing real **construction + curation**:
- **Construction** becomes real once landing is fixed (Step 1): nodes/edges actually appear in `civic_graph`.
- **Curation** becomes visible: edges **expire** on supersession (`kg_view.js:27` already has a `SUPERSEDES` category), duplicate nodes **merge** (Splink match → `resolve/`), confidence **firms up** as corroboration accrues (style by calibrated confidence).
- **Provenance + time-travel:** Step-0 source-set + bi-temporal fields → hover shows sources/valid-time/supersession history; render the graph "as of" a past date (Echo memory tier has `recall_as_of`/`recall_world_at`).

Small additive enablers (all with precedent): (1) an **`include_superseded` view mode** on `query_graph`/`kg_neighborhood` — Zoe's local graph already has `neighbors({includeSuperseded})`; without it the server-side supersession filter (§7c) hides curation from the panel. (2) a **`kg:curation-move` broadcast** mirroring the existing `kg:focus-move` so Follow tracks curation passes, not just the walk. (3) confidence styling. Honest caveat: curation runs in **bursts** (hourly-ish Cultivator passes), so the strong demo is a curation **highlight/replay** ("what it corrected/merged overnight"), not a constant animation.

## 8. Status & open decisions

- **DONE (uncommitted, reboot-gated):** Zoe grade-confidence forwarding on `propose_*`; Echo `promote_tenant_proposals` (overlaps existing `promote_proposals_bulk` — reconcile, don't duplicate).
- **RETRACT:** the Zoe-side autonomous promotion trigger in `main.js` (violates the operator-gate invariant).
- **NEXT:** Step 0 substrate (Echo-side, additive schema).
- **Open:** functional-predicate allowlist (needs `CIVIC_TAXONOMY.md`); source-set provenance schema shape; whether `entity_facts` gets bi-temporal too; Cultivator vs Skuld ownership of the reconciliation tasks; backlog handling (~4.8k queued proposals — surface via κ.C panel vs operator bulk-promote).
