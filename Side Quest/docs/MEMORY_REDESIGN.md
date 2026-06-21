# Side Quest — Memory & Retrieval Redesign

**Goal:** make Zoe's long-term memory obey two principles Lucas articulated:

1. **Endpoint, not path.** Once a line of inquiry is refined into a durable fact, recall loads the *distilled fact* + a *pointer* back to its source trail — never re-loads the journey (searches, intermediate page-reads, dead ends).
2. **Scoped retrieval.** A narrow question (one specific bill) surfaces the precise *leaf* node, not everything she knows about the broad topic.

Status: **design only.** No code changed. Grounded in primary sources (below); verification pass in the deep-research was rate-limited, but the cited mechanisms are canonical.

---

## 1. Where we are today (what already helps vs. what leaks)

**Already good:**
- `memory.js` `retrieve(query,{k:4})` is hybrid **semantic (bge-small cosine) + keyword (FTS5/BM25)** fused with **reciprocal-rank fusion**, sliced to **K=4**. It does *not* load everything — it loads ~4 chunks, and the FTS half gives named-entity (bill #) an exact-match boost.
- `reflection.js` already distills `[KNOWLEDGE]/[SKILL]` takeaways and writes a **provenance marker** (`refIds`, `urls`, "distilled from recent thoughts/readings") — reference, not copy. This is half of "endpoint-not-path" already.
- `reflection.js` fires on **accumulated salience** (sum of importance ≥ 150) — the Generative Agents trigger.
- `nearestKnowledge()` finds the closest existing note (A-MEM-style neighbor) — half of linking.
- `curator.js` runs periodic deterministic hygiene.

**What leaks (the "loads everything" feeling):**
- **Recency-based context, not relevance-based.** `buildChatPrompt` injects *recent readings* and *recent thoughts* by recency, **regardless of the question**. Ask a narrow bill question right after she browsed permitting broadly → the broad material rides along. *This is the #1 bloat vector — not the K=4 retriever.*
- **Flat store, no general↔specific tier.** Nothing lets retrieval *prefer the leaf*; if only broad notes exist, a narrow query returns 4 broadly-similar notes (topic flood within K).
- **Accretion, not merge.** `storeDeduped` NOOPs an exact near-dup but never **UPDATEs/merges**; overlapping notes about one topic pile up at one granularity.
- **Raw path stays first-class.** A distilled reading's raw blob still lives in `monologue` and can still be injected; the path is never demoted to pointer-only.

---

## 2. Grounded mechanisms (primary sources)

| Principle | Mechanism | Source |
|---|---|---|
| Salience-triggered consolidation | reflection fires when Σ importance ≥ threshold (150) | Generative Agents — arXiv:2304.03442 |
| Endpoint + provenance | reflection nodes **cite** the lower-level memories they came from ("trees of reflections") | 2304.03442 |
| Write-time salience score | LLM rates poignancy 1–10 at write | 2304.03442 |
| Tiered memory, path paged out | OS-style fast in-context tier + slow external store, recall via pointer | MemGPT — arXiv:2310.08560 |
| Merge not accrete | per-fact **ADD / UPDATE / DELETE / NOOP** vs. existing similar memory | Mem0 — arXiv:2504.19413 |
| Endpoint retrieval | answer from distilled store via top-s similarity, never re-inject raw transcript | 2504.19413 |
| Atomic note schema | content, ts, keywords, tags, context-desc, embedding, **links** | A-MEM — arXiv:2502.12110 |
| Cheap linking | cosine-NN prune → **one** small LLM call to confirm related (not O(N)) | 2502.12110 |
| Merge-in-place | "memory evolution" rewrites related notes when a new one arrives | 2502.12110 |
| Multi-level summary tree | recursive embed→cluster→summarize; retrieve at multiple abstraction levels | RAPTOR — arXiv:2401.18059 |
| Narrow(local) vs broad(global) routing | entity graph + community summaries; bottom-up answer for global Qs | GraphRAG — arXiv:2404.16130 |
| Keep source addressable | **don't** over-summarize; summary noise hurts QA → reference the source passage | HippoRAG 2 — arXiv:2502.14802 |
| Decide *whether/how much* to retrieve | adaptive retrieval by query complexity | Self-RAG 2310.11511, Adaptive-RAG 2403.14403 |
| Surprise as salience | Bayesian surprise (KL between prior/posterior) | Itti & Baldi (NIPS'06) |

**Flagged aspirational (need bigger/cloud model or training, NOT now):**
- Full RAPTOR tree / GraphRAG Leiden communities — clustering + many summary LLM calls per build; too heavy for the 24B per-turn. Viable only as an **offline/batch curator** job, if ever.
- Self-RAG's trained reflection tokens — needs fine-tuning; we approximate in-context.
- HippoRAG Personalized-PageRank graph — doable but heavier; defer.

---

## 3. Recommended architecture for this stack

Single 24B (Mistral-Small-3.2) + better-sqlite3 + FTS5 + bge-small CPU embeddings + RRF. No fine-tuning.

### 3.1 Data model (additive — no rebuild)

- `knowledge`: add
  - `level TEXT` — `'fact'` (leaf, specific) | `'topic'` (rolled-up summary). Default `'fact'`.
  - `parent_id INTEGER` — FK to the `'topic'` note this fact sits under (nullable).
  - (already has provenance markers — keep.)
- `monologue` (readings): add
  - `consolidated INTEGER DEFAULT 0` — set to 1 once distilled into a knowledge note.
  - `distilled_into INTEGER` — the knowledge id that captured it (the pointer).
- *(optional, Phase 4)* `note_links(from_id, to_id, kind)` for A-MEM associative links.

### 3.2 When each process fires

- **Reading insert (web-read):** unchanged — raw, "hot", injectable *while fresh*.
- **Reflection (Σ importance ≥ 150, already):** for each distilled `[KNOWLEDGE]` takeaway, run a **Mem0 decision** against `nearestKnowledge`:
  - no similar note → **ADD** as `level='fact'`, `parent_id` = nearest `'topic'` (or null).
  - near-dup/augmenting → **UPDATE** the existing note in place (merge), don't add.
  - contradicts → **UPDATE** (supersede) and keep old as provenance.
  - Then mark the source readings `consolidated=1, distilled_into=<note id>`.
- **Curator (periodic, already runs):**
  - **Demote**: `consolidated=1` readings are excluded from recency injection (pointer stays; raw stays addressable per HippoRAG-2 — we *don't* delete the source).
  - **Merge siblings**: collapse near-dup `'fact'` notes under the same `parent_id` (Mem0 UPDATE/DELETE).
  - *(Phase 4)* **Topic rollup**: when a `parent_id` has many facts, one LLM call refreshes the `'topic'` summary (RAPTOR-lite, count-gated).

### 3.3 Retrieval (the chat-answer path)

1. **Classify the query** (cheap heuristic; 1 LLM call only if ambiguous):
   - *narrow/factual* — named entity (Cap-Case multiword, bill pattern, quoted string), or "what/who/when is X".
   - *broad/exploratory* — "tell me about", "themes", "overview", "what do you know about".
2. **Scope by class:**
   - narrow → **entity-exact**: FTS/BM25 dominant + filter to `level='fact'` (**leaf-preference**); **K=1–3**. Walk *up* to the `'topic'` parent only if leaf coverage is thin.
   - broad → hybrid RRF as today + include the `'topic'` node; **K=6–8**.
3. **Relevance-gate the recency blocks** (the key fix): only inject a recent reading/thought if its embedding similarity to the *current query* clears a threshold (or it's already in the retrieved top-K). Idle loop (no query) keeps recency as-is.
4. **Assemble:** persona (always) + scoped retrieval + relevance-gated recency. The raw path is **never** injected unless explicitly traversed via a provenance pointer.

---

### 3.4 Working memory — episodic conversation recall (the Father's-Day recall bug)

**Problem observed:** the chat prompt carries only `RECENT_TURN_LIMIT = 8` turns (4 exchanges), and **`turns` are never embedded or retrieved** — only `knowledge`/`self_model`/`monologue` are. So a casual chat fact ("my Father's Day plans") falls out of the 8-turn window and becomes unrecallable; she diverts to a tool (calendar) instead. Reflection won't save it either — it's significance-gated for durable takeaways, not chit-chat.

**Fix — make the conversation itself retrievable (the knowledge retriever, pointed at turns):**
- Data model: `turns` gets an `embedding` column (bge-small, computed on insert; backfill optional).
- New `retrieveTurns(query, k≈3)`: hybrid semantic + FTS over `turns`, scoped to the current session (optionally recent sessions), returning matches **outside** the recency window.
- `buildChatPrompt` gains an *"earlier in our conversation…"* block — the top relevant past turns, deduped against the 8-turn recency window. This is what lets her answer "what did we say earlier about X."
- Cheap stopgap shipped alongside: bump `RECENT_TURN_LIMIT` 8 → ~14 (more working memory now; the retriever is the durable fix).

### 3.5 Perspective normalization — stop turning the user's items into her own (the "call my father" quirk)

**Problem observed:** open thread [101] stored the request **first-person verbatim** ("remind me to call my father"), and scheduled task [18] became self-addressed ("Call your father"), duplicating the correct [17] ("Remind Lucas to call his father"). On re-read the model reads "me/my" as **itself** and adopts Lucas's personal items. `commitments.js` already avoids this (its prompt says "third person"); `open_threads.js` and the scheduler note composer do **not**.

**Fix — resolve perspective at every USER→store boundary:**
- Add to the open-threads extractor + scheduler-note composer (mirroring commitments): *the user's "I/me/my" = Lucas/his; phrase stored items as work YOU do for Lucas, referring to him in third person; never store his personal items as your own. e.g. "remind me to call my father" → "remind Lucas to call his father."*
- Tighten the goal filter so a **dated one-shot reminder** routes to scheduling only, not a standing thread (thread [101] was a false positive — its own HARD RULE already excludes one-shot directives).
- This is a **correctness fix, low-risk, no schema change** — can ship first.

---

## 4. Phasing (smallest viable first)

- **Phase 0 — correctness, ship first (§3.5).** Perspective normalization in `open_threads.js` + scheduler note composer; tighten the one-shot→thread filter; verify `commitments` resolves possessives too. Clean the two stale artifacts (drop self-task [18], resolve thread [101]). No schema change.
- **Phase 1 — highest ROI, no schema change (§3.3).** Relevance-gate the recency blocks on the chat path + query-class → dynamic-K + entity-exact routing on the existing retriever. *Fixes "loads everything on a narrow question."*
- **Phase 1a — working memory (§3.4).** `turns.embedding` + `retrieveTurns` + "earlier in our conversation" block; stopgap `RECENT_TURN_LIMIT` 8→14. *Fixes the Father's-Day recall bug.*
- **Phase 2 — endpoint-not-path for the raw trail (§3.1).** `consolidated`/`distilled_into` flags on readings; exclude consolidated readings from injection (pointer remains).
- **Phase 3 — the hierarchy (§3.2).** `level` + `parent_id` on knowledge; Mem0 UPDATE/merge in reflection; leaf-preference retrieval + walk-up.
- **Phase 4 — aspirational.** RAPTOR-lite topic rollups (offline curator), A-MEM associative graph walk, learned/Self-RAG routing, Bayesian-surprise salience.

Each phase needs an app restart to load; batch a phase, restart once, verify against its named bug.

---

## 5. Open questions for Lucas

- **Search-path memory** (separate from this): cache her own query→landing→useful so she stops re-issuing identical searches, and promote effective query phrasings as `[SKILL]`s. Fits Phase 1–2; do we fold it in or keep it separate?
- **Query classifier**: heuristic-only, or allow one cheap LLM call when ambiguous (latency vs. precision)?
- **Topic notes**: auto-created during reflection, or only minted by the curator once enough facts cluster?

---

*Sources: arXiv 2304.03442, 2310.08560, 2504.19413, 2502.12110, 2401.18059, 2404.16130, 2405.14831, 2502.14802, 2310.11511, 2403.14403; Itti & Baldi 2006; Microsoft GraphRAG docs; sqliteai/sqlite-memory.*
