# Memory continuity audit — 2026-09-02

Lucas's order after the compact: *"I do need all the memory rechecked for continuity across all
memory schema."* This is the record of that recheck: what was measured, what holds, what does not,
and what the memory-map organ now checks on its own every 15 minutes.

Method: read-only probes (`file:…?mode=ro`, `PRAGMA query_only`) on every SQLite store both sides
hold — 23 files under the Echo data root, 9 under `data/` here — on top of the stage-3 memory map.
Two passes: (1) staging tables with no exit, identity columns, clock formats, files outside the
map; (2) dangling-link rates, name overlap between tiers, column shapes, last-crossed timestamps.
Nothing was written to a live store.

## A. Identity continuity — do the links between stores resolve?

| link | rows | dangling |
|---|---|---|
| sq.graph_relations → sq.graph_entities | 20,734 | 0 |
| sq.graph_citations → sq.graph_sources | 40,094 | 0 |
| sq.monologue.surfaced_as_turn_id → sq.turns | — | 0 |
| sq.documents.promoted_ref (`echo:<id>`) → tenant.documents.id | 12,245 | 0 (and 0 promoted without an address) |
| puller.targets.crm_id → electoral.contact | 955 | 0 (the 09-02 float-string cure, verified live) |
| civic_graph.relations → entities (newest 20k) | 20,000 | 0 |
| civic_graph.entity_facts → entities (newest 20k) | 20,000 | 0 |
| civic_graph.entities.contact_id → electoral.contact (50k) | 50,000 | 0 |
| civic_graph.entities.canonical_id → entities | 13,628 | 0 |
| knowledge_graph.kg_anchor.entity_id → civic_graph.entities | 26,037 | **63** (anchors to pruned/merged entities) |
| knowledge_graph.kg_anchor_quarantine.entity_id → entities | 1,517 | 0 |

Gaps (identity by name only, no key to the other tier):

- `sq.civic_memberships` (16,118 rows): `crm_id` set on **0**, `puller_id` on **0**. The civic roster
  mirror never links a seat-holder to the CRM contact.
- `sq.graph_entities` carries no Echo id. Its `name_key` (bioguide-suffixed for people) matches a
  long-term `entities.name` for 89 of the newest 400 (22%).
- `tenant.entity_proposals`: of the newest 400, 12 (3%) already exist in long-term by name — the
  153,927-row backlog is mostly genuinely new memory waiting on a gate.

## B. Bridge continuity — does memory actually flow?

Alive (the gate fired inside the stall window):

- tenant.entity_proposals → civic_graph.entities: `auto_promotion_log` shows 17,470 lifetime
  entity promotions, last 2026-09-02 23:35; relations 36,914, last 2026-09-03 00:26.
- sq.documents → the vault: promotes ~100/day. But documents land at ~230/day, so the backlog grows
  by ~130/day; 37,168 of 38,724 unpromoted rows are older than 7 days; 29,595 of them are
  `source = legislation`. Alive, under-draining.
- sq.capability_needs (last retired 09-01), sq.code_proposals (last applied 09-02).

Stalled (pending rows, gate quiet past 14 days, or never fired):

- civic_graph.resolution_proposals: 33,308 pending, last applied 08-12 (21.5 days) — the kg-apply
  drain (the park_reasons docket item).
- knowledge_graph.kg_anchor_quarantine 1,517 + kg_anchor_unresolved 1,313: no anchor written
  since 06-18 (76 days).
- tenant.inbox: 11,064 pending, **0 rows ever resolved**. `Store.resolve_inbox_entry` has no
  caller. 10,334 rows are `pass13a:null_chamber_no_keys`, 485 `pass13b:contact_not_projected` —
  pass13 used the inbox as a findings sink and its `target_id` values are contact ids, not
  document ids.
- sq.graph_relations → civic_graph: 20,714 pending; only 20 rows were ever `promoted_up`, all
  created 07-11 → 07-21. `cloud_curator.promoteLocalEdgesUp` has effectively been dead since
  07-21 (the map measures this by proxy — `promoted_up` is a flag with no timestamp).
- sq.absence: 1,598 open since 07-20. **Correction (the cure pass, same night):** the audit read
  `evidence_kind`, which marks the rare evidence-gated promotion to `novalue`; a gap actually closes
  by *deletion* when the metabolism's verification pass returns RESOLVED. The recheck ledger holds
  1,625 RESOLVED absence outcomes, and only 2 of those rows still exist — the pursuit answers at
  16–138 gaps/day while the research lane is open. What is wrong: open gaps still grow (1,468 →
  1,584 over 08-30 → 09-03) because producers mint faster than closes, and since 09-01 the research
  lane has been closed by burn-down pacing, so every pass was skipped — and each skip was counted
  as a failed attempt with an exponential backoff (items at attempts 10–15 that were never
  researched that often). Cure: a quota skip is a *hold* (re-armed 20 min out, attempts untouched),
  and the map's bridge now measures the real exit.

Dead ends (a gate that was designed and never built):

- electoral.`_pending_data_stream_tags`: 23,504 rows. The drain (DATA_HANDOFF_2026-05-25 §11 step
  4: upsert into `entity_streams`, overwrite the primary `data_stream`) has no reader anywhere in
  `echo/`.
- electoral.`clean_review`: 174 rows of operator decisions pending since June.
- electoral.`vetting_findings`: 0 rows, no reviewer organ.

Unmeasured, honestly: civic_graph.link_candidates (9,967 pending) has statuses `pending|rejected`
only — a grounded candidate leaves no timestamp, so the map cannot say when the gate last fired.
tenant.`pruned_entity_proposals` (133,209) is reclassified as a **log**: every row is decided
(`pruned_at` set); it was never a backlog.

## B2. The shell race — caught live by the organ on its first boot

Three minutes into boot_p248 the map warned: `civic_graph.inbox: looks like staging but is
undeclared inside a long-term store`. There had been no such table an hour earlier. A probe found
seven tenant-local tables (documents, projects, inbox, links, document_versions,
cross_project_usage, plus audit) inside the long-term file, all empty, and six minutes later they
were gone. Cause: `Store.__init__` defaulted to `create_local_tables=True`, and every caller that
opened the foundation file without saying otherwise — the pass-worker's decompose job
(`echo/jobs.py`), the portal, the crawler, the nl CLI — recreated the 17 tenant-local tables as
empty shells; the union mount's ghost-drop removed them later. In that window an unqualified read
could resolve to the empty shell (the "silent-0 ghost-drop race" the store's own comments name).

Cure (Echo, local commit): the default now follows the file — `civic_graph.db` never gets local
tables unless a caller asks explicitly; tenant and standalone stores keep the full schema. The map
declares the 17 names as **shells** in civic_graph: present = named in `continuity.shells`
(the race is open), rows in one = a re-aim warning, absent = no drift.

## C. Files outside the map

Found and now declared: the tenant's sibling stores — `mcps/rainey/capture.db` (16 MB, the
maturation capture tape), `mcps/rainey/vault/index.db` (64 MB, the vault FTS index),
`mcps/rainey/embeddings_docs.db` (1.6 MB, last written 06-11), and the harness tenant's copies.

Phantoms (0-byte files — a lane once opened a store at a path that is not a store):
`data/civic_graph.db` (07-30), `data/sq.db` (07-31), `data/tenant_rainey.sqlite` (08-12), and
`data/tenant_rainey.db` (the declared mothball; expected). Their mtimes are weeks old: relics of
mis-aims already cured, not live bugs. Deleting them is his call.

Here: `sq_eloise_archive_20260618_201852.db` (6.3 MB) is a dated archive, declared as such; the
`*_profile/first_party_sets.db` files are Chromium profile state, skipped by rule.

## D. Clocks

- Side Quest: epoch **milliseconds** on every store.
- Echo: epoch **seconds** (civic_graph, electoral, tenant, saga verified on the newest row of
  every identity table); knowledge_graph: ISO-naive text (`2026-06-18T22:30:00`).
- knowledge_graph.`kg_node.captured_at` holds the corpus release label (`courtlistener_2026-03-31`
  × 8.0M, `wikipedia_en_all_maxi_2026-02` × 2.3M, …), not a time — a misnamed column.
- The map's own `at`: milliseconds on the Side Quest half, seconds on the Echo half; the merged
  map stamps milliseconds.

## E. Two memories of one thing

Same concept, two tables, no bridge between them:

- `sq.self_model` (88 rows: her traits and insights) vs `saga.self_model` (6 key/value rows: the
  supervisor's own state). Same name, different things.
- `sq.knowledge` (7,303) vs `saga.memory_facts` (6).
- `sq.turns` (15,020) / `sq.monologue` (86,725) vs `saga.episodic_memory` (37) /
  `saga.session_summary` (3).

The saga side is vestigial — the Echo supervisor's own memory, barely written since the
unification. Folding or renaming is stage-3.3 territory and his call.

## F. What the organ now checks on its own

`nx-echo memory-map` and `lib/memory_tiers` (merged by `lib/memory_map`, refreshed every 15 min,
on the status line and behind the state door):

- a declared staging table with no promotion bridge → **warning** (a new staging table cannot slip
  in without a named exit; `built: false` names a designed-but-unbuilt one)
- every bridge carries `built`, `last_crossed`, `last_measured`; pending rows whose gate has not
  fired in `STALL_DAYS` (14), or ever where a timestamp exists, are **stalled**; a gate never built
  is a **dead end**; a `last` query that cannot run is *unmeasured*, never "never crossed"
- every SQLite file under the data root that no registry names → **warning**; 0-byte files are
  listed as **phantoms**; dated archives are declared
- each store declares its **clock**
- the status line reads `… · continuity: N dead end(s), M stalled bridge(s) · K store(s) outside the map`

## G. Open decisions

1. tenant.inbox — build the resolver organ for the pass13 findings, or reclassify the inbox as a
   findings log (its rows point at contacts, not documents).
2. `_pending_data_stream_tags` — build the designed drain into `entity_streams`, or drop the table.
3. `clean_review` — 174 operator decisions; route them to his card.
4. kg_anchor — 63 anchors to pruned entities: re-point through the canonical map or drop them
   (a live-DB write).
5. civic_memberships — resolve seat-holders to CRM contacts (the roster organ should fill `crm_id`).
6. Mine to cure, his word on priority: `promoteLocalEdgesUp` dead since 07-21; the absence pursuit
   that never lands evidence; the documents promote pass under-draining (+130/day).
7. saga.self_model → rename (supervisor_state) and fold the vestigial saga memory into the one
   memory.
8. The three 0-byte phantoms — delete (his word).
