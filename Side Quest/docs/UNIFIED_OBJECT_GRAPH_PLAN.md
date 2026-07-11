# Unified Object Graph — Build Shape (for pressure-testing, not yet a work order)

_2026-07-11. Crystallizes the T1/T2/T3 brainstorm into slices, marks wire-vs-new, and locates the risk. Grounded in the audit (docs/SYSTEM_DATA_FLOW_MAP.md) + four verification sweeps. **Nothing here is started.**_

## North star (the acceptance test)
Two queries exercise all three threads at once:
- **"What happened with Iran today?"** → day summary **plus** resolved tangents (a quote from "Sen X, a LAMP member" surfaces his whole neighborhood), each with a real date and freshness, and any brief Zoe writes lands as its own node.
- **Zoe in a meeting** → every person/place/thing/idea named resolves live to its canonical node with rapid neighborhood recall.

If both work — resolved mentions (T1), correct time + lifecycle (T2), derived nodes left behind (T3) — the vision is realized.

## The unified model, one paragraph
Every object type (person, org, **concept, place, event**, and derived: prediction/dossier) is a first-class citizen. Inbound mentions are **resolved at ingest** to canonical nodes (conservative floor: confident match → link + traverse; miss → held short-term node, never a forced link). Every **time-bearing** thing carries a **world-time** (EST-normalized) separate from its ingest-time, and rides a **lifecycle that flips to _verify_, never to _assert_**. Consumers **read** the shared backbone (parity = live query) and **emit only their own derived nodes** back (with `DERIVED_FROM` edges), never mutating sources.

## Wire-vs-new ledger (the encouraging headline)
**WIRE (exists — connect it):** ANN entry-point resolver (`resolve_entity_entry_point`, Echo) · un-drop news `first_ts`/`last_ts` at promotion · re-verify/decay lane (`decay_pass`) for unconfirmed-past · concept-linking passes (`passNN_concept_to_*`) + give them a cadence (pass_runner D1) · dedup-adjudication machinery for concept consolidation · supersession for reschedule + prediction re-run · `active_recall` for silo reads · anticipated→reconcile primitive (Madeline).
**NEW (build — small surface):** event `occurred_at` + `state` fields · hourly aging sweep · freshness read-time function · `concept` in `doc_decompose` + `INVOKES` linking · `BROADER`/`NARROWER` + a same/broader/narrower judge · curated concept-spine seed · `DERIVED_FROM` edge + an "emit derived object" primitive · forecaster prediction-node emit.

## Slices (dependency + risk order)

**Slice 0 — Resolver spike (de-risk the headline first).**
Wire `resolve_entity_entry_point` into ONE news lane path end-to-end; on a real day's Iran/energy stories, measure: resolve hit-rate, **false-link rate at the conservative floor**, and whether a real "Sen X → LAMP" tangent surfaces. Goal: validate the riskiest assumption cheaply before committing. Wire. Risk: this IS the risk probe. Test: manual + a labeled sample.

**Phase A — Temporal substrate (low risk, foundation). ✅ DONE + LIVE 2026-07-11** (Echo 5e226b3, Zoe 4b11631/d2e15cb/f95ea07; validators 18/18, gate 180; migration confirmed on live civic_graph). A1 event occurred_at/state/tz + news un-drop · A3 aging sweep (catch-up-safe, hourly tick) · A4 continuous freshness fn + wired into the news brief ranker. See [[temporal-substrate]] memory. Original slice text:
A1 event `occurred_at` (world-time) + EST normalization at capture; stop dropping news `first_ts`/`last_ts` at promotion. A2 event `state` enum (scheduled/in-progress/unconfirmed-past/occurred/rescheduled/cancelled). A3 hourly **aging sweep**: `scheduled → unconfirmed-past` on elapsed world-time, offline-gap catch-up via `last_alive_at`, enqueue reconcile into the existing re-verify lane. A4 **freshness = read-time function** in recall ranking (no sweep). Mostly NEW-but-small + WIRE. Risk: LOW. Test: offline state-transition + freshness-curve smokes.

**Phase B — Ingest resolution (highest value).**
B1 resolver into news compression (conservative; hit → link + neighborhood, miss → held). B2 resolver into the meeting loop (real-time; latency-budgeted). B3 `concept` in `doc_decompose` + `INVOKES` edges so articles/people/institutions connect *through* shared subjects. Wire + some New. Risk: MED (false-links; meeting latency). Depends: Slice 0, resolver index freshness.

**Phase C — Concept taxonomy (growth).**
C1 seed your tracked subjects (AI Arms Race, Permitting Reform, Bioengineering, Weather Modification) as `NARROWER` children under Echo's existing 648 broad concepts. C2 `BROADER`/`NARROWER` + a concept-reconciliation pass = `run_dedup_adjudication` with a same/broader/narrower judge (consolidate emergent → parents). C3 cadence the concept passes (pass_runner). Wire + some New. Risk: LOW-MED (judge quality). Depends: B3.

**Phase D — Derived-node emission (integration).**
D1 `DERIVED_FROM` edge + an emit-derived-object primitive (read backbone, write only the new node + provenance, never touch sources). D2 forecaster emits **prediction nodes** = anticipated events (world-time = resolution date) that ride Phase-A lifecycle → reconcile → calibration trail. D3 route Editor/Forecast/Puller/News to read the backbone via `active_recall` (parity = live query). Wire + some New. Risk: LOW-MED (prediction re-run = supersede, not append). Depends: Phase A.

## Risks / assumptions to pressure-test BEFORE committing
1. **Resolver index freshness.** `resolve_entity_entry_point` is only as good as the entity ANN index (`build_entity_ann_index`). Is it built + maintained as the 1.75M-entity graph grows, or does it go stale? If unmaintained, resolution silently degrades. **(Prereq check.)**
2. **False-link rate at the conservative floor.** The entire "tangent" value depends on resolving to the *right* node. Unmeasured. Slice 0 must quantify it before we trust auto-surfaced tangents.
3. **Meeting real-time latency.** Resolving every mention live during a call — is the ANN lookup fast enough at conversational pace, or do we need a warm cache / async surface?
4. **News resolve throughput/cost.** Many mentions × many stories/hour through the resolver — throughput and token/compute budget.
5. **Concept explosion vs consolidation cadence.** Your own point: emergent concepts must consolidate faster than they're minted. The consolidation pass must be cadenced and keep up — otherwise the taxonomy silts up.
6. **EST + "today" ambiguity.** Sources span time zones; "today" in a headline is publisher-local. World-time capture needs a normalization discipline, not just a tag.
7. **Prediction re-run churn.** Hourly forecast must supersede (one live prediction + trail), not spawn 24 nodes/day.

## Prereq checks — ANSWERED 2026-07-11 (two moved the plan)

1. **ANN index: built, but NO refresh cadence → will rot.** Index exists (`data/ann/entity_dedup/v1/`), built 2026-07-10 01:16 over 1,733,186 entities. Graph is now 1,747,133 (newest entity: today) — **~14k entities (0.8%) added since, invisible to the resolver.** `build_entity_ann_index` is called **only** via the MCP tool — no Huey periodic, no registry pass rebuilds it — and the loaded index is rebuild-only/process-cached (a rebuild takes effect only after `reset_resolver_cache()` or a new process). **→ NEW PREREQ SLICE (below): schedule the rebuild.** Without it, Phase B can't resolve to freshly-minted nodes — including the very entities news ingest creates (chicken-and-egg).
2. **Concept passes: worse than idle — structurally excluded.** `registry.yaml` = 74 passes `cadence:null`, exactly **1** `daily`. The `passNN_concept_to_*` family (e.g. `pass49_concept_to_bill`) is not only `cadence:null` but **`class: build`**, and the pass runner excludes build-class from auto-dispatch by default. So concept growth is **fully dormant** — the 648 concepts + 185k edges were a one-time build. **→ Phase C is bigger than "flip cadence": it must also enable build-class dispatch (or add a dedicated concept-growth trigger).**
3. **Resolver floor: ours to set. ✓ No work.** `resolve_entity_entry_point` returns `{matches:[{id,name,type,degree,sim}], indexed}` and takes `min_sim` (default 0.80). Conservative floor = pass a high `min_sim` + filter on `sim`; `indexed:false` → graceful string-match fallback.

## NEW — Prereq Slice (before Phase B): ANN index refresh cadence
Schedule `build_entity_ann_index` (Huey periodic — nightly or 6h) + `reset_resolver_cache()` so the resolver sees new entities. Small WIRE (the primitives exist; just needs a periodic + cache reset). **This is now the first thing to build** — Phase B's resolution silently degrades without it. Ties to spec item D1 (cadence the pass runner) — same class of fix.

## Sequence recommendation (updated)
Prereq (ANN index refresh) → Slice 0 (resolver spike) → Phase A (safe foundation) → Phase B (the unlock) → C (now includes enabling build-class passes) → D. The "next event" traversal and forecaster-as-timed-object fall out of A+B, not separate builds.
