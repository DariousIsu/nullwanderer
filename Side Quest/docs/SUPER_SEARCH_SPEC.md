# Super Search — spec (design)

> **Status: DESIGN + SLICE 1 (card contract + registry skeleton).** A **STUDIO** in the
> "My Workspace" workbench (Window 3), modeled on the Editor. Operator-driven, self-contained,
> programmatic; the cloud/local models are invoked as *services behind the pipeline*, never as the
> orchestrator. See [EDITOR_TAB_SPEC.md](EDITOR_TAB_SPEC.md) for the studio pattern and
> [ZOE_HOST_ARCHITECTURE.md](ZOE_HOST_ARCHITECTURE.md) for the host context.

## What it is
A Google-like **unified search surface** over everything Zoe owns + the live web. One query box →
**two honest lanes** (internal corpus ∣ external web), a **cited "AI overview"** card on top, and an
**ingest loop** that lets a kept external result feed the owned corpus so the next search finds it
internally. Search becomes a way to *grow the brain*, not just look things up.

## The determinism law (why this isn't "ask the LLM")
Workspaces are powerful programs, not chat. Super Search is **one deterministic pathway** with a
**standardized result-card contract**; the model is a **caged component at exactly three leaves**
(plan · re-rank · overview) and nowhere else. Same query → same run shape, every time.

## The one pathway (every run)
1. **Intake** — operator types one query.
2. **Plan** *(caged · local 24B)* → schema-locked `{intent, entities, expanded_terms, internal_targets, external_filters}`. Shapes the query, not the results.
3. **Retrieve — two planes in parallel, fully deterministic:**
   - *Internal* → the **recipe registry** (below): each enabled recipe binds the query to a known owned tool, maps that tool's known result shape → standardized cards, and may **enrich via the atlas join spine**.
   - *External* → `web_search` + `academic_search` → top-N fetched via `web_extract` → cards.
4. **Re-rank** *(caged · local 24B, per lane)* → reorder each lane's candidate set; **cannot add or invent** items; bounded by the deterministic set.
5. **Overview** *(caged · cloud frontier)* → one cited "direct answer" card from the top passages across both lanes. **Cites ≥ 1 or it does not render** (cite_floor law).
6. **Present** — overview on top, internal lane ∣ external lane below; all uniform `ResultCard`s.
7. **Ingest** *(deterministic, gated)* → kept external results → `record_web_source` / `ingest`, **dedup + provenance-tagged + reversible**. The corpus stays clean and auditable.

## The standardized card (the determinism contract)
Every result, internal or external, normalizes to one frozen shape:
```
ResultCard {
  id,       // stable, deterministic: `${source}:${corpus?}:${hash}`
  plane,    // 'internal' | 'external'
  source,   // recipe id: knowledge | entities | contacts | bills | polls | db_query | web | academic
  title,    // derived display title
  snippet,  // cleaned excerpt
  url,       // string | null
  score,    // native retrieval signal, normalized higher = better (pre-rerank)
  rank,      // post-rerank position | null
  enrich,    // spine-joined extras: { corpus, civic_links, party, state, sponsor, ... }
  cite,      // canonical citation handle → feeds overview + cite_floor
  raw_ref    // pointer back to the source row / tool result for drill-in
}
```

## The recipe registry (grounded in the live atlas, 2026-06-24)
Each recipe = `{ id, plane, enabled(plan), run({query,plan,deps}), toCards(rawRows) }`.
Bindings + enrichment come straight from `get_atlas()` / `get_db_map()`:

| Recipe | Binds to (owned tool) | Enrich via spine |
|---|---|---|
| `knowledge` | `search_knowledge(source=…)` — wikipedia / general / rainey FTS5 | `civic_links` → civic entity (kg_anchor) |
| `entities` | `entity_search` FTS5 MATCH / `search_entities` | `entities.contact_id` → contact (party/bio); facts |
| `contacts` | `search_contacts` / `contact_facets` | state-delegation rule (MailingState OR State_Represented) |
| `bills` | `search_bills` / `bill_facets` | `bill_meta.bill_id` → entity; votes |
| `polls` | `search_poll_questions` / `get_poll` | `poll_fielding.entity_id` → entity |
| `db_query` | parameterized SELECT (catch-all over any owned table) | — |
| `web` / `academic` | `web_search` + `web_extract` (external) | — |

## Model split (resolved)
- **Plan + Re-rank → local 24B** (cheap, fast, low-stakes — shape/reorder only).
- **Overview → cloud frontier** (the big judgment; "too big for local"), key inherited from Echo's keychain (`lib/keystore.js`), same as the Editor's cloud classify.

## Build order (frozen slices — same discipline as the Editor harness)
1. ✅ **Card contract + registry skeleton** (one recipe: `knowledge`) — pure, offline smoke (39/39).
2. ✅ **Full internal recipe set** (entities · contacts · bills · polls · db_query) + entities spine join — smoke 39/39.
3. ✅ **External lane** — `web` (Zoe-search primary, engine fallback, web_extract body enrich) + `academic` (keyless) → cards. Smoke 30/30.
4. ✅ **Three caged leaves** — plan (local, schema-bounded targets) · rerank (local, permutation-only) · overview (cloud, cite_floor gate) — pure over injected `complete`. Smoke 30/30.
5. ✅ **Ingest-gated loop** — `save_source` archive + URL-keyed ledger (dedup · provenance · reversible); engine-error → ledger untouched/retryable. Smoke 21/21.
6. **Run orchestrator** — one pathway → standardized run object — smoke. ← *next*
7. **Super Search surface** — rail entry + `<webview>`, wired over IPC → warn-and-restart → live-fire → commit.

Every slice: build → offline smoke → (slice 7) wire IPC → warn-and-restart → live-fire → commit.

## Zoe's relationship — aware-only
Operator-owned studio. Zoe holds a memory pointer (it exists, where its results live), not a
status feed into her reasoning. No Zoe / no chat in the workflow.
