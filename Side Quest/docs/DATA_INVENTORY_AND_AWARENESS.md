# Data Inventory & Awareness Audit

**Date:** 2026-07-20. **Question asked:** *"Inventory all systems data for the program and identify what she is and is not aware of vs blind to."*

Every number here was read from the live stores, and every pathway claim was executed, not inferred.

---

## 1. The stores

### 1.1 Local — `data/*.db` (6 live databases, ~1.29 GB)

| DB | Size | Top tables (rows) |
|---|---|---|
| **sq.db** | 982 MB | `route_obs` 661,693 · `kg_observations` 471,925 · `recent_cards` 72,083 · `agent_events` 68,373 · `monologue` 61,946 · `cloud_traces` 28,715 · `graph_sources` 26,700 · `graph_citations` 26,700 · `graph_relations` 15,107 · `graph_entities` 12,776 · `inbound_messages` 11,610 · `turns` 8,733 · `documents` 6,693 · `encounters` 4,767 · `meeting_transcript` 4,178 · `knowledge` 4,147 · `open_threads` 3,503 · `reflections` 1,479 · `commitments` 1,251 · `doc_contacts` 1,129 · `sessions` 657 · `agenda` 185 · `conversation_state` 183 · `open_questions` 115 · `scheduled_tasks` 86 · `absence` 85 · `self_model` 59 · `capability_gaps` 33 · `interests` 15 · `protocols` 14 · `cardinality` 11 · `permissions` 9 |
| **news_bucket.db** | 180 MB | `news_items` 97,957 · `news_story_updates` 48,650 · `news_stories` 32,200 · `news_layers` 607 |
| **puller.db** | 119 MB | `observations` 352,960 · `beliefs` 350,775 · `targets` 238,455 · `pattern_beliefs` 3,452 · `revisions` 497 |
| **api_stream.db** | 6 MB | `api_usage` 3,250 · `bulk_records` 1,930 · `api_cache` 161 |
| **editor.db** | 0.1 MB | `pipeline_documents` 12 · `iterations` 12 · `working_copies` 12 · `check_runs` 9 |
| **canvas_layout.db** | <0.1 MB | `doc_positions` 210 · `positions` 3 |

Plus ~1.1 GB of `sq_backup_*.db` / archive snapshots (not live data).

### 1.2 Echo — the master KB (8 databases)

`get_corpus_inventory` on `civic_graph.db`:

| Table | Rows |
|---|---|
| relations | **8,565,699** |
| audit | 3,005,671 |
| entities | **1,757,702** |
| bills | 1,463,226 |
| donations | 828,222 |
| contacts | 114,692 |
| accounts | 20,815 |
| pass_runs | 24,626 |
| documents | 4,992 |
| polls | 816 |

Attached databases: `main` (civic_graph, 59 tables) · `general` (133) · `electoral` (82 — CRM + polls) · `tenant_rainey` (81) · `skuld` (61 — Saga self-state) · `rainey` (25 — vault index) · `wikipedia` (7) · `tenant_harness` (2).

### 1.3 Non-DB stores

`data/` also holds: `doc_store` bodies, `avatars`, `faces`, `certs`, `exports`, `downloads`, `news_captures`, `elections`, `models`, `reports`, `feeds.json`, `capability_log.json`, plus the workspace at `data/zoe_workspace`.

---

## 2. Awareness pathways

Five tiers, strongest first:

| Tier | Meaning |
|---|---|
| **A — AMBIENT** | In her prompt on *every* turn. She knows it without being asked. |
| **R — RETRIEVED** | Surfaced automatically when the topic matches. Reliable but topic-gated. |
| **Q — REACTIVE** | Only when a question matches a *detector regex*. Miss the phrasing, miss the data. |
| **T — TOOL-ONLY** | Reachable only if the cloud operator chooses to go get it. |
| **X — BLIND** | No pathway exists. |

### 2.1 AMBIENT (ground truth — the `buildChatPrompt` call site, main.js:6309)

`turns` · `monologue` · `reflections` · `knowledge` (as readings) · `commitments` · `open_threads` · `protocols` · `inbound_messages` · `conversation_state` · `open_questions` · `self_model` · `personal_facts` · `meta:mood_state` · awareness block (time, session age, downtime, reawaken, self-check, live meeting, live video, **research standing + current work** — added 2026-07-20).

### 2.2 RETRIEVED (topic-triggered, automatic — `lib/active_recall.js`)

- `knowledge` — `memory.retrieveScored`
- `graph_entities` / `graph_relations` — local graph facts
- **Echo civic_graph** — `recallObject` / `recallKnowledge` (the 1.76M-entity KB)
- `documents` / doc_store — `_docRecall`
- **`news_bucket`** — `_newsRecall` → `news_lane.storiesForTopic`
- `turns` — semantic `relevantPastTurns`

### 2.3 REACTIVE (detector-gated)

| Data | Gate |
|---|---|
| operational state + research coverage | `self_state.STATE_RE` / `COVERAGE_RE` |
| **`puller.db`** + electoral CRM + `doc_contacts` | `turnRoute.route === 'contacts'` → `gatherHeldContacts()` |
| `capability_gaps` | capability-proposal block |

### 2.4 TOOL-ONLY

- **All 43 sq.db tables** via the `localdb` operator tool — *verified: no allowlist, arbitrary read-only SELECT.* This covers `route_obs`, `absence`, `cardinality`, `encounters`, `agent_events`, `cloud_traces`, `recent_cards`, `agenda`, `scheduled_tasks`, `email_log`, `sessions`, `interests`, `meeting_transcript`.
- All 8 Echo databases via the `echo` need-router / `db_query`.

### 2.5 BLIND — **verified by execution** *(§2.5 and §3.1/§3.5 FIXED 2026-07-20 — see §6)*

`localdb` binds to `dbLib.getDb()`, which is **sq.db only**. Probed live:

```
REACHABLE  sq.db  open_threads           → 3503
REACHABLE  sq.db  route_obs              → 661693
REACHABLE  sq.db  absence                → 85
BLIND      puller.db targets             → no such table: targets
BLIND      puller.db beliefs             → no such table: beliefs
BLIND      news_bucket news_items        → no such table: news_items
BLIND      api_stream api_usage          → no such table: api_usage
BLIND      editor pipeline_documents     → no such table: pipeline_documents
```

**Five of six local databases are unreachable by SQL.** Their only pathways are the narrow ones above.

---

## 3. The blind spots that matter, ranked

### 3.1 `puller.db` — 942,190 rows behind one regex

352,960 observations + 350,775 beliefs + 238,455 targets — her largest body of *self-gathered* contact research. The **only** read path is `gatherHeldContacts()`, fired when `turnRoute.route === 'contacts'`. Ask about a person any other way and none of it exists. She cannot ask "how many targets have I got emails for?" — there is no SQL path.

*(Known related issue: `gatherHeldContacts` is N+1 — `listBeliefs` per target across 238k targets.)*

### 3.2 `news_bucket` — 97,957 items reachable only by topic

`_newsRecall` retrieves stories *about a topic she is already discussing*. There is no path to the bucket **as a corpus**: "what have I been reading?", "what's the volume on X this week?", "what did I miss?" are unanswerable. The hourly briefing goes to a UI widget, not to her.

### 3.3 She cannot see her own operational history

`route_obs` (661,693 rows), `agent_events` (68,373), `cloud_traces` (28,715) record what she did, what worked, what failed. All are TOOL-ONLY — the operator must think to SQL them. Nothing surfaces "I keep failing at X" or "that lookup has never worked."

### 3.4 The new memory-ecosystem tables are built but not surfaced

`absence` (85) — her three-valued known-unknowns. `cardinality` (11). `encounters` (4,767). All TOOL-ONLY. Specifically: **`curiosity.js` still picks what to wonder about by regex-matching her own monologue**, while 85 structured genuine gaps sit unread. (`absence` was empty yesterday; it is populating now.)

### 3.5 `api_stream` / `editor` — no pathway at all

`api_usage` 3,250, `bulk_records` 1,930, `pipeline_documents` 12, `certificates` 1. Pipeline and UI only. She cannot report on her own API consumption or on documents in the verification pipeline.

---

## 4. The shape of the problem

Her awareness is **inverted relative to volume**. Ranked by rows:

| Store | Rows | Tier |
|---|---|---|
| Echo relations/entities | 10.3 M | R |
| sq.db `route_obs` | 662 K | T |
| puller.db | 942 K | Q (one regex) |
| news_bucket | 179 K | R (topic only) |
| sq.db `turns`/`monologue` | 71 K | **A** |
| `self_model` | 59 | **A** |

**The things she carries ambiently are the smallest stores; the largest are behind the narrowest gates.** That is defensible for prompt economy — but it means her *sense of herself* is built from ~71K rows of conversation while ~1.9M rows of her own research are reachable only by a deliberate act, and 5 of 6 local databases cannot be queried at all.

---

## 5. Recommended order

1. **Give `localdb` the other databases** (ATTACH read-only, or a second tool). Single highest-leverage change: turns 4 blind stores into TOOL-ONLY. Cheap, no prompt cost.
2. **Wire `absence.openGaps()` into `curiosity.js`** — her curiosity is language-driven while a structured gap list goes unread. See `personality-memory-ecosystem-fit`.
3. **A corpus-scale line in the awareness block** — "what I know" as scale (Echo entity count, news volume, contacts held), the counterpart to the standing line already added.
4. **Un-gate puller from the contacts route** — either fold it into `active_recall` or expose it to `localdb` (1).
5. **Self-history introspection** — a bounded read over `route_obs`/`agent_events` so "what have I been failing at?" is answerable.

Items 1 and 4 are the same fix. Item 3 is the natural extension of the ambient standing work.

---

## 6. ✅ Item 1 (and 4) — DONE, 2026-07-20

`lib/localdb.js` now opens a dedicated **read-only** connection and ATTACHes the other four
databases under aliases. Verified live:

```
attached: news, puller, api, editor
REACHABLE  puller.targets               → 238475
REACHABLE  puller.beliefs               → 350802
REACHABLE  news.news_items              → 97998
REACHABLE  api.api_usage                → 3250
REACHABLE  editor.pipeline_documents    → 12
```

The question that previously had **no path at all** now answers:
`SELECT COUNT(*) FROM puller.targets t WHERE EXISTS (SELECT 1 FROM puller.beliefs b WHERE b.target_id=t.id AND b.type='email')`
→ **40,944 of 238,475 targets carry an email belief.**

`inventory()` went 43 → 67 tables and reports attached tables **qualified** (`puller.targets`), so
the map doubles as the syntax hint. The operator's tool spec now documents the aliases — without
that it would never have used them.

**Why a separate connection rather than ATTACH onto the app's handle:** those files have their own
live writers (news_store, puller_db, api_store, editor_registry). All five databases are in WAL
(verified), so a dedicated reader never blocks a writer. It is also defence in depth — the existing
`stmt.readonly` check stays, but the connection itself now cannot write. If the read-only connection
cannot be opened, `query()` falls back to the app handle, so this is never *worse* than sq.db-only.

Write safety is regression-tested across every attached database (`scripts/smoke_localdb_attach.js`,
28 assertions): DELETE/UPDATE/INSERT/DROP/CREATE/ATTACH/PRAGMA all refused, multi-statement
smuggling rejected, and the data verified intact afterwards.

**Still open:** items 2, 3, 5. Note §3.1's N+1 in `gatherHeldContacts` is unchanged — but that path
now has a SQL alternative, which is the cheaper way to answer aggregate contact questions.
