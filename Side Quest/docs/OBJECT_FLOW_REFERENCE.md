# Object-Flow Reference — liftable code + Echo resolver ground truth

Reference for building the **token-cluster → object** flow (Slice 2 extraction / decomposition, and
Slice 4 overnight reconcile). Captured 2026-07-01 from license-checked source. Companion to
[OBJECT_MEMORY_ARCHITECTURE.md](OBJECT_MEMORY_ARCHITECTURE.md). We LIFT prompts + design, we do NOT
run these runtimes (they drag in Python + a graph DB next to Echo).

Our stack filter: **Node/Electron (JS) + a cloud LLM we prompt + Echo as the KG.** So the value is
(1) directly-portable prompts/schemas, (2) a JS scaffold, (3) a resolve→dedupe→supersede design we
mirror against Echo's own tools.

---

## The three artifacts to base on

### 1. Extraction prompt — Microsoft GraphRAG `GRAPH_EXTRACTION_PROMPT`  (MIT)
- Repo: https://github.com/microsoft/graphrag · file: `packages/graphrag/graphrag/prompts/index/extract_graph.py`
- Pure prompt text → port to a JSON-output cloud-LLM call. Shape (verified):
  - entity record: `("entity"<|><name><|><type><|><description>)`
  - relationship record: `("relationship"<|><source><|><target><|><description><|><strength 1-10>)`
  - records delimited by `##`, terminated with `<|COMPLETE|>`; three worked few-shot examples.
  - **Parameterized on `{entity_types}` + `{input_text}`** → we pass **Echo's** entity/relation types, not Wikidata's.
- **For us:** port to JSON output (drop the `<|>` delimiter format), parameterize on Echo's type list,
  and **fold `intent` + `slots` into the SAME schema** so one round-trip yields `{objects, relations, intent}`.
  This is the heart of the Slice 2 decomposition front door.

### 2. JS scaffold — LangChain.js `LLMGraphTransformer`  (MIT, TypeScript — the only native-Node artifact)
- Repo: https://github.com/langchain-ai/langchainjs-community · file:
  `libs/community/src/experimental/graph_transformers/llm.ts`
- Lift: `createSchema` / `createNodeSchema` (build a constrained schema from OUR type list), the
  post-extraction type-filter, and the **coreference clause** in `SYSTEM_PROMPT` ("always use the most
  complete identifier") — the dangling-pronoun fix ("his team" → resolved entity) the research flagged.
- Swap its `withStructuredOutput` for our cloud-LLM call; the schema-building + filtering lift cleanly.

### 3. Resolve → dedupe → supersede — Zep/Graphiti  (Apache-2.0, Python — mirror design + lift prompts)
- Repo: https://github.com/getzep/graphiti
- **3-stage resolution** (`graphiti_core/utils/maintenance/node_operations.py::resolve_extracted_nodes`) — verified:
  1. **Semantic candidate-gen** — `_collect_candidate_nodes` / `_semantic_candidate_search`: cosine
     similarity vs existing nodes, `NODE_DEDUP_COSINE_MIN_SCORE = 0.6`, ≤15 candidates/node.
  2. **Deterministic match** — `_resolve_with_similarity`: normalized string + attribute alignment, no LLM.
  3. **LLM escalation** — `_resolve_with_llm`: only for unresolved nodes; LLM sees the node + its
     candidates + episode CONTEXT → duplicate or genuinely new. (This is the confidence gate + the
     anti-overshadowing mechanism: decide on CONTEXT/TYPE, not name popularity.)
- **NIL schema** (`graphiti_core/prompts/dedupe_nodes.py`) — verbatim:
  ```python
  class NodeDuplicate(BaseModel):
      id: int
      name: str  # most complete/descriptive; no JSON formatting in the name
      duplicate_candidate_id: int  # candidate_id of the matching EXISTING ENTITY, or -1 if no duplicate
  ```
  System directive: *"You are an entity deduplication assistant. NEVER fabricate entity names or mark
  distinct entities as duplicates."* Rules: only merge the SAME real-world object; return `-1` when
  uncertain; never merge "related but distinct" or mere name-similarity. **The `-1` IS our NIL /
  "which one?" branch, verbatim.**
- **Fact supersession** (`graphiti_core/prompts/dedupe_edges.py`): `resolve_edge` returns
  `duplicate_facts[]` AND `contradicted_facts[]` in one call, with an explicit "NEVER mark facts with a
  numeric/date/qualifier difference as duplicates" rule → our supersede step.

### Read-only reference (don't run)
- **ReFinED** (Amazon, Apache-2.0, https://github.com/amazon-science/ReFinED) — scoring = **typing score +
  description/context coherence**, emits **NIL** when nothing matches. The anti-overshadowing philosophy
  to express as a prompt: hand the LLM each candidate's TYPE + DESCRIPTION, let coherence beat name-frequency.
- **Skip:** GENRE/ELQ (non-standard license, dead), spaCy/BLINK (trained-KB pipelines), Rasa/JointBERT
  (trained intent classifiers — intent is just a field in the extraction schema, not a separate lib).

---

## Echo resolver — ground truth (probed 2026-07-01)

The locked decision is "entity resolution/dedup is Echo's job." So we verified what Echo actually does.

### APPLY / commit side — GOOD, keep as-is
- `merge_entities` (`echo/mcp/internal/admin.py`, `echo/graph.py`): **non-destructive** — duplicates get
  `entities.canonical_id -> canonical` + a `SAME_AS` edge (readers follow the alias), backup-gated,
  refuses a cluster the operator previously rejected, returns a `proposal_id` **one-call rollback** handle.
  This already matches Graphiti's non-lossy model. Nothing to change.
- `resolve_entity_conflict`: manual operator reconcile of conflicting AI proposals in `entity_log`.

### DETECTION side — STRING-MATCH ONLY → the upgrade target
- `echo/graph.py::_find_similar` (line ~686) is the entire dedup detector:
  ```python
  sim = SequenceMatcher(None, name.lower(), row["name"].lower()).ratio()   # difflib, stdlib
  # same entity_type filter; keep if best_sim >= similarity_threshold (default 0.85)
  ```
  No embeddings, no context/coherence — **exactly the #1 GraphRAG pitfall** ("string-match dedup →
  coarse, redundant graphs"). It runs at `propose_entity` time to suggest a merge.
- **Echo ALREADY HAS the pieces to fix it:** `echo/embeddings.py` (local ONNX embedder, no torch) +
  entity vectors in `data/foundations/embeddings.db` (used today only for semantic RETRIEVAL /
  `search_entities` hybrid) + `echo/extraction/lightrag_adapter.py` (qwen3-embedding extraction). The
  semantic candidate-gen capability exists; it's just not wired into `_find_similar`.

### DECISION (resolved)
Dedup/resolution upgrade lands **Echo-side**, and it's a WIRING job, not a rewrite — map Graphiti's
3 stages onto Echo's existing parts:
1. **Semantic candidate-gen** — wire Echo's existing entity embeddings into `_find_similar` (cosine over
   the entity vector index) instead of scanning names with difflib.
2. **Deterministic fast-path** — keep the difflib ratio as the cheap high-confidence match (Graphiti Stage 2).
3. **LLM-escalation** — for ambiguous candidates, add an LLM dedup using Graphiti's `dedupe_nodes` NIL
   schema (`duplicate_candidate_id = -1`) → resolves on context/type, not popularity (kills overshadowing).
Keep `merge_entities` as the non-lossy apply. This is Slice 4's concrete spec (overnight reconcile) and
also sharpens Slice 1's resolver NIL branch.

---

## Echo extraction landscape (probed 2026-07-01) — settles Slice 2 build location

Probed Echo's extraction paths to decide reuse-vs-build. Result: **Echo has a DOCUMENT decompose pipeline
(reuse for Slice 3, don't rebuild), but NO conversational/intent front door (Slice 2 = new JS build).**

- `echo/pipelines/decompose.py::decompose_document_sync` — the document decomposition pipeline, fires
  async from `ingest_file` (Huey worker), 4 independent layers: **A** entity proposal
  (`propose_entities_from_text` = GLiNER zero-shot NER + regex co-pass), **B** mention-linking
  (`find_mentions` → `content_document_link` rows = **documents-as-objects `mentions` edges, ALREADY BUILT**),
  **C** doc embeddings index, **D** facts (`echo/pipelines/facts.py`). Entity+mention+facts — **no relation
  extraction between arbitrary entities, no INTENT layer.**
- `propose_entities_from_text` (graph.py:1119) — GLiNER (`gliner_medium-v2.5`, ~440MB, **not installed →
  regex-only today**) + regex for bills/committees/USC-CFR. Entity extraction only.
- `lightrag_adapter.py` — narrower than its docstring: only `classify_relation` (2 KNOWN entities + context
  → ONE predicate from a closed vocab, local `hermes3:8b`). `extract_triples` is documented but **not
  implemented**. Relation TYPING, not entity/utterance extraction.
- **Echo's canonical schema (parameterize the JS extraction prompt on THIS)** — `config.toml [graph]`:
  - `entity_types = [person, organization, place, bill, committee, event, claim, concept, …]`
  - `relation_types = [AMENDS, REPEALS, CORRECTS, INCORPORATES, SUPERSEDES, CITES, APPROPRIATES_TO, …]`
    — **closed + legislative-flavored.** General conversational relations (attends / employs / scheduled_for
    / about) are NOT in it → Slice 2 must extend this vocab (or map free relations onto it).
  - `disambiguation_threshold = 0.85` (the difflib gate).

### DECISION — Slice 2 extraction/decomposition = NEW build, JS/cloud side
Because it is (1) **turn-time + conversational** (Echo's decompose is async doc-ingest), (2) **intent-bearing**
(intent has no home in Echo — it's inherently the assistant side), (3) best done as a **cloud-LLM structured
parse** (GraphRAG prompt), not GLiNER NER. Build it in JS with artifacts #1 (GraphRAG prompt) + #2
(LangChain.js scaffold), **parameterized on Echo's `[graph]` entity_types + relation_types** so output is
Echo-native and resolves cleanly. Extend the relation vocab for general conversational predicates.

### What NOT to rebuild (Echo already has it)
- Documents-as-objects `mentions` edges → `find_mentions`/`content_document_link` (decompose Layer B).
  **Slice 3 leans on this** — `promoteDocumentsPass` → `extract_entities_from_doc` already triggers it.
- Doc entity proposal + facts + embeddings → decompose Layers A/C/D. (Entity proposal quality gated on
  GLiNER install — the queued `task_c8d03940` — else regex-only.)
