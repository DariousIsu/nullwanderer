# Autonomous Self-Curating DB — comprehensive build plan (smoke-first)

**Companion to:** `docs/AUTONOMOUS_SELF_CURATING_DB_ARCHITECTURE.md` (the WHY/design). This is the HOW/build-order.
**Status:** Ready to build. As of 2026-07-09 nothing is built beyond design + the re-runnable back-check; the live system is untouched.
**Principle:** heavy smoke testing at EVERY slice — no slice is "done" without a proof gate (CARL rule 4). Cross-repo (Echo + Zoe), reboot-gated, and every Echo schema/graph change is **validated on a COPY of `civic_graph.db` before touching the live 6.9 GB file.**

## Build doctrine (read once)
- **Smoke conventions differ per repo.** Side Quest: `scripts/smoke_*.js` run via `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_x.js`; the offline gate is `npm test` (run_smokes.js) + `npm run lint`. Echo: `.venv` has **no pytest** — validate with standalone `scripts/_scratch_*.py` runners (mirror the pytest harness) run by `.venv/Scripts/python.exe`, plus the `tests/test_*.py` files as source-of-truth specs.
- **Validate-on-copy for the graph:** `cp civic_graph.db /tmp copy` → run the migration/pass → prove invariants → only then schedule the live change behind a reboot.
- **Phased safety (from architecture §7c):** substrate columns (0a) and reader/trigger hardening (0b) are INERT and land first; supersession WRITES (0c) flip on far later behind a flag. Never couple them.
- **Corrected rules that gate slices:** promotion stays operator-gated (no silent auto-promote); supersession is contradiction-gated + valid-time + confidence-gated (NEVER ingest-recency); dedup feeds Echo's existing `resolve/` queue; autonomous merge/supersede must be cycle-preventing at write time; LLM only at the funnel ends (extraction + residue), classical in the middle.
- Each slice below: **Goal · Touches · Smoke (heavy) · Proof gate · Revert · Reboot?**

---

## MILESTONE A — Substrate (Step 0). Additive, inert, safe. Echo-side.

### A0 — Clean the deck (reconcile this session's uncommitted work)
- **Goal:** land on a coherent base before building. Retract the Zoe `main.js` autonomous promote trigger (violates Echo's operator gate — **done during compaction cleanup**); reconcile Echo `promote_tenant_proposals` (this session) with the pre-existing `promote_proposals_bulk` (`graph.py:646`) — keep ONE (bulk exists; my fn adds relation promotion + queue counts → fold relation-promotion into bulk OR keep mine and deprecate bulk); KEEP `graph_walk.js` grade-confidence forwarding.
- **Smoke:** Side Quest `npm test` green + `npm run lint` clean; Echo `test_proposals_kappa_c.py` + the standalone promote validator pass.
- **Proof:** no regressions vs current smoke suite. **Revert:** trivial (uncommitted). **Reboot:** no.

### A1 — Bi-temporal + provenance columns on `civic_graph.relations` (Phase 0a)
- **Goal:** the substrate everything needs. New `echo/reconcile/schema.py` `ensure_schema()`: idempotent `_ensure_columns` adds `valid_from, valid_to, tx_from, tx_to, superseded_by, supersedes`; create `relation_supersession` (mirror `memory_supersession` + before/after state per §7b audit note); partial live index `WHERE tx_to IS NULL AND deleted=0`. Backfill `tx_from=valid_from=created_at`, `tx_to=NULL`. Per-edge **source-set** provenance shape (open decision §8) landed here too.
- **Smoke (heavy):** (1) `ensure_schema` idempotent — run 2×, columns appear once, no error. (2) On a **copy**: `COUNT(*)` identical pre/post; `query_graph`/`kg_neighborhood` output on 20 sample entities **byte-identical** pre/post (columns inert). (3) Backfill: 100% live rows `tx_from=created_at, tx_to IS NULL`. (4) `entities.degree` distribution identical. (5) `propose_relation` INSERT still succeeds (named columns).
- **Proof:** empty diff on the 20-entity `query_graph` sample + identical COUNT + identical degree. **Revert:** leave inert columns (cost nothing). **Reboot:** Echo restart to load schema.

### A2 — Reader + trigger hardening for `tx_to` (Phase 0b, still inert)
- **Goal:** make every reader + the degree cache supersession-aware WHILE nothing writes `tx_to` yet (no-op refactor).
- **Touches (all from the blast-radius map):** `+ AND tx_to IS NULL` on `graph.py` (kg_neighborhood/graph_overview/query_graph/list_relation_types), `kg_query.py`, `bills.py`+`bill_meta.py` caches, `research_assistant.py` (10 packs), `nl/retrieval.py`, `ppr/adjacency.py`, `resolve/apply.py` external_degree, ETL find-or-create probes; **degree triggers** `store.py:1194-1227` (add an `AFTER UPDATE OF tx_to` trigger that −1s on NULL→non-NULL, or gate the insert trigger on `tx_to IS NULL`) + the degree backfill query; Zoe `echo_suit.relatedEntities` + `idle_anchors.js:146`.
- **Smoke (heavy, TWO modes):** (a) **NO-OP proof** — with zero superseded rows, every hardened reader returns identical output vs A1 (diff empty). (b) **SYNTHETIC-superseded proof** — on a copy, inject one edge with `tx_to` set → confirm EACH hardened reader hides it AND the degree trigger decremented both endpoints AND `bill_meta`/`external_degree` recompute excludes it.
- **Proof:** (a) empty diffs; (b) per-reader exclusion table + correct degree deltas. **Revert:** readers ignoring `tx_to` = today's behavior. **Reboot:** Echo restart.

---

## MILESTONE B — Landing (Step 1). Make growth real, operator-gated.

### B1 — Grade-confidence forwarding + operator-gated promotion
- **Goal:** proposals carry real confidence and actually land via the operator gate. Keep `graph_walk.js` forwarding (done). Promotion = κ.C ProposalsPanel and/or an OPERATOR-invoked bulk-promote (NOT autonomous). Decide backlog (~4.8k queued): surface for review vs one-time operator bulk-promote at a chosen floor.
- **Smoke:** `propose_*` carries grade confidence (proven this session — re-assert); operator promote lands to `civic_graph`; `scripts/audit_growth_backcheck.js` shows **landed relations > 0, attributable** (not just `refresh:*`).
- **Proof:** back-check landing reconciliation flips FAIL→OK on the graph-walk feed. **Reboot:** Zoe + Echo.

### B2 — Objective metric + proposal-queue enrichment
- **Goal:** turn the back-check into the loop's objective; make the review queue fast (rank + LLM rationale per §7d back-end).
- **Smoke:** back-check emits the metric set; queue renders with confidence + rationale; `smoke_*` for the enrichment path. **Proof:** queue sample with calibrated confidence + one-line LLM rationale each.

---

## MILESTONE C — Confidence (Step 2). Zoe lane + classical. Depends on A1 provenance.

### C1 — Provenance source-SET + valid-time extraction (LLM front)
- **Goal:** LLM extraction emits `{source_set[], url, source_date, valid_time}`; persist per-edge source set. **Valid-time from prose is the key enabler for Step 3.**
- **Smoke:** on fixtures, extraction pulls valid-time ("became CEO in 2023" → 2023); source-set persisted + queryable; back-check grounding-integrity rises. **Proof:** N sample facts each carry ≥1 source + a valid-time where stated.

### C2 — Corroboration counting + independence/copy-detection (DuckDB)
- **Goal:** DuckDB pass counts INDEPENDENT sources per fact; collapse domain/near-dup mirror clusters to one.
- **Smoke:** a Wikipedia+3-mirror fixture collapses to corroboration=1 (not 4); independent-source fixture counts correctly. **Proof:** the mirror-cluster test.

### C3 — Calibrated, corroboration-sensitive confidence (reuse Brier/ECE)
- **Goal:** replace the fixed cap with a calibrated score that RISES with independent corroboration (probabilistic/GBM; reuse the forecast Brier/ECE harness). Derive A–E from calibrated thresholds.
- **Smoke:** confidence increases monotonically with independent corroboration on fixtures; Brier/ECE on a verified-fact holdout beat the fixed-0.8 baseline. **Proof:** calibration curve + ECE number.

### C4 — Confidence decay + re-verify queue
- **Goal:** per-predicate half-life (title/role fast, birthplace slow); decayed-below-floor → auto re-verify queue.
- **Smoke:** decay applied per predicate on fixtures; decayed facts land in the re-verify queue. **Proof:** predicate-specific decay curves.

---

## MILESTONE D — Reconciliation (Step 3). LAST. Proposal-first, then activate.

### D1 — Semantic dedup: Splink + DuckDB → `resolution_proposals` (proposal-only)
- **Goal:** project entities → tabular (name/type/aliases/external_ids/key-facts), run Splink (Fellegi-Sunter, unsupervised, on DuckDB) → match probabilities → write candidates into Echo's EXISTING `resolution_proposals` (reuse `resolve/store.create_proposals`). Operator decides. **Cycle guard: a merge must never set `canonical_id` to something that resolves back to self.**
- **Smoke (heavy):** Splink precision/recall on a labeled dedup fixture; candidates land in `resolution_proposals` (not auto-applied); **merge-cycle prevention test** (attempt A→B then B→A → rejected); reverse/reject path works. **Proof:** the cycle-prevention test + a candidate batch in the queue. **Reboot:** Echo.

### D2 — Supersession candidate generation (contradiction + valid-time + confidence-gated)
- **Goal:** functional-predicate deterministic subset (`HAS_CEO`/`HAS_CHAIR`/`SUBSIDIARY_OF`) on **valid-time overlap** + a **confidence floor**; free-text predicates via LLM semantic contradiction check on classical-surfaced same-entity-pair candidates only. **Proposal-first.** Lineage cycle guard (no A supersedes B while B supersedes A).
- **Smoke (heavy):** functional conflict detected on **valid-time overlap, NOT `created_at`**; **the anti-pattern test — a late-arriving OLD fact (newer `created_at`, older valid-time) does NOT supersede the newer truth**; below-floor confidence → proposal, never silent overwrite; lineage-cycle write rejected. **Proof:** the late-arriving-fact test is the gate.

### D3 — Activate supersession writes (Phase 0c, behind a flag)
- **Goal:** flip writes on; A2's triggers/readers now exercised live.
- **Smoke (heaviest, on a copy first):** end-to-end — propose a contradicting functional edge → old edge expired (`tx_to` set, `valid_to` = new fact's valid_from) → EVERY hardened reader hides it → degree correct on both endpoints → `relation_supersession` audit row written with before/after → **rollback** (`UPDATE … SET tx_to=NULL`) restores the prior state exactly. **Proof:** the full round-trip + rollback on a copy, then live behind the flag with the back-check watching degree drift. **Reboot:** Echo, flag off by default.

---

## MILESTONE E — Adjacent axes (from architecture §7b)

### E1 — Objective→keep/discard loop
- **Goal:** wire the back-check + Brier/ECE into a per-cycle "did quality improve? keep : revert/flag" decision (autoresearch pattern). **Smoke:** a degrading synthetic cycle triggers revert/flag.

### E2 — Procedural/skill memory curation (the second axis)
- **Goal:** apply the reflect→extract→curate-via-delta loop (ACE/Hermes) to `self_model`/`self_dev`/`protocols`/`learning`. **Smoke:** a failure trace yields a curated skill delta (not a full rewrite); no context-collapse on repeated cycles.

### E3 — Visualization / the sell (KG panel)
- **Goal:** `include_superseded` view mode on `query_graph`/`kg_neighborhood` (precedent: Zoe local `neighbors({includeSuperseded})`); a `kg:curation-move` broadcast mirroring `kg:focus-move`; confidence styling; provenance/time-travel on hover. **Smoke:** panel renders a supersession expiring + a merge collapsing on a scripted curation replay. **Proof:** the curation-replay demo.

---

## MILESTONE F — Autonomous fast-ingest + grounded builder + Puller integration (Step 4)
**Premise (Lucas 2026-07-09):** the operator gate becomes **additive, not blocking** — multi-pass GROUNDED verification replaces per-item approval; the human supplies *labels* (bounce reports, verified test lists) and *watches*. Research-grounded (3 web threads 2026-07-09: bounce/DSN formats; Clay/Apollo/Hunter/MDM enrichment; Snorkel/OpenRefine/human-on-the-loop UX). **Anti-collapse invariant holds:** model-vs-model agreement is NOT verification — every auto-promote needs an EXTERNAL anchor (civic = QID/verified web citation; person = CRM match for *identity* — each attribute still needs its own citation).

**Core engine (headless):** ONE queue (all feeds' short-term observations incl. Puller discoveries) → ONE **chunked drain worker** (drain-until-empty, bounded chunks — Lucas #2). Per item: verification stack **identity → grounding/citation → consistency → corroboration/confidence** → **three-way outcome** (= MDM three-way match): **PROMOTE** (clears bar; auto, reversible, logged) · **RESEARCH** (short→enrich→re-judge; Lucas #3) · **PARK** (held lower-certainty candidate + exception tray; never a block). **Belief = per-attribute** `{value, source, method(sourced|pattern|inferred), confidence, first_seen, last_verified, supporting_obs[], revisions[]}`; confidence = authority × verify-recency × corroboration, **age-decayed** (Hunter bands: >90 SMTP-verified <30d · 70–90 likely-unverified · <70 guess). **Survivorship** (recency×authority×completeness) picks the surfacing facet; **CRM pinned system-of-record, READ-ONLY** (discovered facet references `crm_id`, never overwrites).

### F1 — Identity trust (the Tracy fix). FIRST — gates everything.
- **Goal:** **mint-reluctance** (a first-name/descriptor-only mention never mints a durable entity → bind-or-hold-provisional); **contextual identity** (resolve a descriptor/partial against meeting-attendees + roles + co-occurrence, not string similarity); **attractor-guard** (a provisional entity can't be the canonical target for future ambiguous mentions until confirmed). Person path = Puller `targets`/CRM resolution + these guards (its `confidence` = identity confidence); civic path = QID. **Smoke:** the Tracy Bromley scenario — "Tracy the finance lady" binds to the CRM contact, does NOT mint a new object, and a later bare "Tracy" does NOT bind to a provisional attractor.

### F2 — Grounded auto-promote lane + chunked drainer.
- **Goal:** the 3-band decision (promote/research/park) with **no human gate**, on the chunked drain-until-empty worker; wire `ground.py` adjudicate + citation-verify to the real cloud + `web_fetch`; every promotion **reversible + logged** (`audit_fix_log` sibling). Convert Puller `revisions` gate → **3-band reversible** (high-conf flips auto-apply reversibly; uncertain → exception tray). **Smoke:** a high-conf verified item auto-promotes + reverts cleanly; an unverifiable one parks; no ungrounded apply slips through.

### F3 — Research-to-close-the-gap (Lucas #3).
- **Goal:** for the RESEARCH bucket, diagnose the gap (corroboration / identity / citation) → bounded targeted research → re-judge. **Fact/news arm** = web_search/research-track (independent EXTERNAL sources only — not model re-assertion). **Person/org arm = Puller ENRICH waterfall** (sourced-first → pattern-guess + SMTP-verify; **catch-all domains flagged unverifiable + confidence-capped**). Bounded retries + cooldown (no re-research thrash), token/API budgeted, async (`puller_walk` picks up flagged items under its sector/TTL guards). **Smoke:** a 1-source news item gains an independent corroboration → crosses the bar; a catch-all email guess is capped, not promoted.

### F4 — Feedback normalizer + Puller window/drop-zone (the additive human).
- **Goal (normalizer):** format-agnostic bounce/test-list ingest → normalized `{recipient, basic_code, enhanced_code, class∈{hard,soft,block,complaint,success,unknown}, ts, diagnostic, source}`. **Detection ladder:** MIME-sniff (RFC 3464 DSN / RFC 5965 ARF) → ESP JSON fingerprint (SES `bounceType`, SendGrid `sg_event_id`, Mailgun `severity`, Postmark `RecordType`) → fuzzy CSV header map → free-text regex. **Enhanced-status class digit = master arbiter** (5 hard / 4 soft / 2 success), ESP-vocab + keyword fallback. **Suppression list ≠ validity belief** (separate concerns). Beta update on the per-domain `pattern_beliefs`: hard-bounce `β+`, success `α+`, soft/block/complaint `~0`; **test-list weighted > opportunistic bounces** (controlled probe = ground truth).
- **Goal (workspace):** **WINDOW** (read-only: pulse strip · confidence histogram + 7-day trend = the drift-tell · recent-decisions feed w/ citation-chain + one-click revert · exception tray [optional attention] · alert rail). **DROP-ZONE** (upload → auto-classify batch type `hard_negative | ground_truth_positive | correction+merge` → **diff preview → one Commit** → batch history w/ **Revert-batch**; OpenRefine-style reversible operation log). **Labels are evidence the engine reconciles, NOT overrides; batch-atomic + reversible; operator notified, never required** (human-on-the-loop). **Smoke:** each of the 4 bounce shapes normalizes to the right class; a bounce batch drops the domain-pattern posterior + suppresses the addresses; Revert-batch restores prior state.

### F5 — Certainty unification.
- **Goal:** ONE truth model — Puller `beliefs.confidence`/`supporting_obs` ↔ KG `confidence_model`/`corroboration` (unify the math: Hunter-style scoring + MDM survivorship); route Puller `revisions` through the shared **supersession** path (a belief flip = a D2 replacement). **Smoke:** a person-email belief and a civic-relation confidence compute via the same calibrated model; a Puller revision emits a supersession candidate.

**Guards (cross-slice):** suppression ≠ validity; only hard-bounce + successful-send move the validity posterior (soft/block/complaint ~neutral); catch-all domains capped; **automation-bias/silent-drift → PUSH alerts** (confidence-distribution drift, reversal-rate spike, auditor auto-off), not dashboards-you-must-check; CRM read-only always; every promotion/merge/label-batch reversible. **Puller seam:** F1 person-identity + F3 person-arm + F4 workspace + F5 = the reserved Puller design session, specced here.

---

## Cross-cutting (every relevant slice)
- **Cycle-safety:** read = recursive CTE (SQLite/DuckDB) + visited-set + depth cap, never Python-stack recursion; write = cycle-prevention on autonomous merge/supersede (D1/D2). Echo already does this in `query_graph`/`resolve/canonical.py` — inherit it.
- **Anti-drift (architecture §6):** external anchor (never let self-inferred displace verified), bounded per-predicate candidate budgets, periodic full refresh, per-predicate precision + diversity watch.
- **Reboot discipline:** build+test+commit each slice, then ASK Lucas to reboot (renderer/main reboot-gated; interrupts his live companion).

## Open decisions that gate specific slices (from architecture §8)
- A1: per-edge source-set provenance shape; whether `entity_facts` also gets bi-temporal.
- A0/B1: reconcile `promote_tenant_proposals` vs `promote_proposals_bulk`; backlog handling.
- D1/D2: functional-predicate allowlist finalization (needs `CIVIC_TAXONOMY.md`); Cultivator vs Skuld ownership of the reconciliation passes.

## Milestone F resolved decisions (Lucas 2026-07-09)
- **Operator gate → additive, not blocking.** Reverses the "operator-gated by charter" stance: multi-pass grounded verification + external-citation anchor replaces per-item approval; human = label-supplier + watcher (human-on-the-loop).
- **Backlog = new inflow.** One chunked drain worker, drain-until-empty; no special-casing the pile-up.
- **Short-of-bar items get RESEARCHED before parking** (not left for the periodic cleans); bounded + external-anchored.
- **Drainer reads only emitted observations**, not `puller.db` directly — Puller stays the person/org working-store; a belief that clears the bar emits a cited observation into the shared substrate. Single promotion path.
- **CRM anchors identity, not every attribute**; CRM stays read-only (system-of-record); discovered data is a certainty-scored facet.
- **Certainty unified** (F5), not mapped at a boundary — one calibrated model.

## Sequencing summary
A0 (clean) → **A1 · A2 (inert substrate + hardening — the safe foundation)** → B1 · B2 (landing, operator-gated) → C1–C4 (provenance/corroboration/calibration/decay) → D1 · D2 · D3 (dedup, supersession candidates, then activate) → E1–E3 (objective loop, procedural memory, visualization) → **F1 (identity trust — the Tracy fix, gates everything) → F2 (gate-less grounded auto-promote + chunked drainer) → F3 (research-to-close-the-gap) → F4 (bounce/test-list normalizer + Puller window/drop-zone) → F5 (certainty unification)**. Growth-visible wins early (B1); destructive/curation power lands mid (D3, flagged, on a copy); the gate-less fast-ingest + Puller integration lands last (F), on top of the D-lane pieces already built. F4's normalizer is standalone/low-risk (can land parallel-early).
