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
- **Phase 1 — highest ROI, no schema change (§3.3). ✅ SHIPPED 2026-06-26.** Two parts landed this session (entity-exact/leaf routing already came with Phase 3): (a) a **relevance floor** on the scored retriever — `retrieveScored` gains `minRelevance` (raw cosine, checked BEFORE the min-max normalize so importance/recency can't promote an off-topic note), the broad chat path passes `minRelevance: 0.35` ([lib/memory.js:304,320](../lib/memory.js), [main.js:1933](../main.js)); when nothing clears the floor she injects *nothing* and answers from the conversation — Self-RAG/Adaptive-RAG "decide whether/how much to retrieve" (2310.11511, 2403.14403). (b) The **recency-gate now runs on EVERY turn**, not just narrow/actionable, so idle musings only ride along if they clear 0.4 cosine to the message ([main.js:1981](../main.js)). *Fixes "wading through all her memory, picking up random stuff."* Offline: `smoke_relevance_floor` 5/5 + `audit_postop` (no-qv path). *Tunable: the 0.35 floor / 0.4 gate are feel-knobs — loosen if she reads sterile.*
- **Phase 1a — working memory (§3.4).** `turns.embedding` + `retrieveTurns` + "earlier in our conversation" block; stopgap `RECENT_TURN_LIMIT` 8→14. *Fixes the Father's-Day recall bug.*
- **Phase 2 — endpoint-not-path for the raw trail (§3.1). ✅ SHIPPED 2026-06-22.** `consolidated`/`distilled_into` columns on `monologue`; `db.markReadingsConsolidated` + an `excludeConsolidated` filter on `getRecentMonologueByType`; `reflection.routeReflection` marks a window's source readings consolidated → the distilled note id once it stores ≥1 knowledge takeaway; the reading-injection callers (chat at main.js + the two idle-material callers) exclude consolidated. Raw rows stay addressable (never deleted). Offline: `smoke_memory_phase2` 9/9.
- **Phase 3 — the hierarchy (§3.2). ✅ SHIPPED 2026-06-22.** `level`('fact'|'topic') + `parent_id` on `knowledge` (+ indexes); `insertKnowledge`/`store` accept them; `db.updateKnowledge` rewrites a note in place (content+embedding+FTS). `storeDeduped` now assigns `parent_id` = nearest topic on ADD and makes a 3-way Mem0 decision on a near-dup (`same`→NOOP, `augment`/`contradict`→UPDATE-in-place merge, `distinct`→ADD sibling) via injectable `relateFn`/`mergeFn` (defaults = one cheap model call each, only at sim≥prefilter). `retrieve` gains `preferLeaf` (leaf-first ordering + topic walk-up when leaf coverage is thin); the narrow chat path passes it. Offline: `smoke_memory_phase3` 12/12.
  *Live-verify (needs a session): narrow-query recall surfaces the specific leaf; a distilled reading stops riding along in recency.*
- **Phase 4 — the offline/batch curator. ✅ SHIPPED 2026-06-26 (the heavy-clustering pieces still aspirational).** The doc flagged RAPTOR/GraphRAG-class work as "viable only as an offline/batch curator job, if ever" — that job now exists: **[lib/cloud_curator.js](../lib/cloud_curator.js)**, run on the **cloud tier** (frontier model via Echo's keychain-hydrated `OLLAMA_API_KEY`, so it never contends with the local 24B). Stages: `preClean` (deterministic quarantine prune — stale focus-tombstones past the 24h spawn-gate window + speculation), `mergeNearDupKnowledge` (Mem0 ADD/UPDATE/DELETE over embedding clusters, 2504.19413), `selfEvolutionMerge` (same, but conservative on the identity track — correctly *keeps* the evolution chain), `adjudicateGraphProposals` (deterministic supersede/stale). Orchestrated by `runDailyPass` (each stage try/catch-isolated, cloud stages fail-safe to no-ops) and a **gated in-app scheduler** ([main.js, "DAILY CURATION PASS"](../main.js)): once per ~20h, only when idle ≥15min, timestamped backups (last 5), and a first-person **perception beat** in the sheep panel. Env: `ZOE_CURATION_ENABLED` + `_MIN_GAP_HRS`/`_IDLE_MIN`/`_CHECK_MIN`. Applied live 2026-06-26: −200 quarantine, −29 near-dup. Offline: `smoke_cloud_curator` 13/13, `smoke_neardup_knowledge` 10/10, `smoke_self_evolution_merge` 9/9, `smoke_graph_adjudicate` 8/8, `smoke_daily_pass` 12/12. *Still aspirational: RAPTOR-tree topic rollups, A-MEM graph walk, Bayesian-surprise salience.*

Each phase needs an app restart to load; batch a phase, restart once, verify against its named bug.

---

## 4b. Shipped beyond the original retrieval scope (2026-06-26)

Subsystems built this session that weren't in the original redesign but belong in the record:

- **Temporal grounding** ([lib/context.js:199](../lib/context.js), awareness block). The local 24B's frozen training prior states stale facts as current ("Biden is president in 2026"). An epistemic anchor pinned high in context tells her her world-knowledge is frozen/out-of-date and to verify time-sensitive facts via tools rather than assert from memory. *Known limit (observed live): a strong parametric prior can still beat in-context evidence — she searched, the correct answer was in her reading, and she reverted. The permanent fix is **self-correction** (below), not a stronger prompt.*
- **Model-call watchdog** ([lib/ollama.js:3](../lib/ollama.js)). `streamChat` aborts on `inactivityMs` (90s no-token) and `complete` on `timeoutMs` (180s); a hung generation self-heals instead of freezing the whole idle loop + chat (observed: a 15-min wedge). `smoke_stream_watchdog` 6/6.
- **Engineering gates** (the "stop hand-patch breakage" foundation). Global crash handlers logging to `data/crash.log` ([main.js:4](../main.js)); `npm test` → curated offline smoke gate ([scripts/run_smokes.js](../scripts/run_smokes.js), 9 suites); `npm run lint` → ESLint `no-use-before-define`/`no-undef` ([eslint.config.js](../eslint.config.js)) — catches the TDZ class that a unit smoke + `node --check` both miss (proven: it flags the exact `qv: userQv` bug pattern).

### Open band-aids → next (lane 3)
- **Self-correction** — now folded into the incremental-KB design below (§4c) as the first slice of *Accrete*. Verify + read-back work (proven live); the break is *trust* (the parametric prior beats in-context evidence).
- **Unbounded-goal guard. ✅ SHIPPED 2026-06-26.** Two mechanisms: (a) **creation guard** — `open_threads.isUnboundedGoal` rejects open-ended goals at extraction (no completion condition → never resolves); (b) **runaway circuit-breaker** — `curator.curateThreads` retires any thread past `MAX_THREAD_ACTIONS` (60) actions without resolving, regardless of recency (catches existing runaways like thread #66's 389 actions, and anything that slips the creation guard). Goal-management: a goal must be terminable (cf. Generative Agents plan horizons, 2304.03442) + a circuit-breaker like the OpenHands stuck-detector. Offline: `smoke_goal_guard` 11/11.

---

## 4c. The incremental knowledge base — Accrete · Consolidate · Iterate (verified-fact slice ✅ BUILT 2026-06-27)

**Vision (Lucas):** she's a small model — treat her like a *second human researcher* who reads a bit each day, files what she learned, and builds on it — NOT a stateless instant-answer engine that re-derives (and re-bloats) everything each time. Knowledge must COMPOUND: learn → file → iterate, never retread.

Three pillars:
- **1. Accrete** — every learning becomes durable structured data, from BOTH her own research AND her conversations with Lucas. Capture generalizes from "facts" → "learnings" (fact | finding | settled view), gated so transient noise isn't stored.
- **2. Consolidate** — the cloud curator keeps the growing base clean (merge near-dups, supersede contradictions, organize). ✅ ALREADY BUILT (Phase 4 curator + the C reconcile stage below).
- **3. Iterate (don't retread)** — before researching X, surface what she ALREADY knows about X + the open gaps, and record each query→finding, so she extends her base instead of starting cold (the 84×-retread / permitting-loop fix). Today only a thin guard exists (`isRepeatOfRecentSearch`, `shouldSuppressSearch`); the strong version injects prior-knowledge-on-topic + gaps into the research turn. **This pillar is what delivers "a real base, not retreading" — and it's the missing one.**

**Self-correction = the first, narrowest slice of Accrete, split by cost/capability:**
- **B — real-time capture (local, cheap, hot-path-safe).** On a time-sensitive factual lookup, one cheap local call extracts the verified atom → store as a knowledge note (`source='verified_fact'`, high importance, provenance = url + "as of &lt;date&gt;"). No heavy reasoning on the live turn.
- **C — daily cloud reconcile (a NEW `runDailyPass` stage).** For each verified fact, the frontier model finds STORED knowledge it contradicts and supersedes/corrects it (Mem0 `contradict → UPDATE`, 2504.19413). NOTE: the stale belief is often a model PRIOR (not stored) → can't be deleted from weights; what wins at inference is B's stored fact surfacing via the relevance floor (§Phase 1) + the temporal-grounding anchor. C cleans up stored notes that propagate the stale assumption.

**Implementation (all six pieces built — [lib/learning.js](../lib/learning.js), the capture/Iterate engine):**
- **Piece 1 (trigger) ✅** — B real-time (local) + C daily-cloud reconcile.
- **Piece 2 (hook point) ✅** — `learning.maybeCaptureVerifiedFact({query,content,urls})` fires beside `graph_extract.maybeIngestReading` at the `runSearch` reading sink ([lib/monologue.js](../lib/monologue.js)) AND the autonomous browser-read / web-read sinks. Fire-and-forget, never rejects into the idle loop.
- **Piece 3 (extraction + garbage-gate) ✅** — **local** model (cheap, always-on, mirrors graph_extract). **Two-stage trigger:** a cheap `looksFactSeeking` pre-gate (interrogative / current-state) → a strict-format model extract (`CLAIM | SUBJECT | AS_OF`). Deterministic gate `parseClaims`: **URL mandatory** (no provenance → not "verified"), no-hedge, no pronoun-lead, length caps, one-fact-per-slug-per-batch. NONE is first-class.
- **Piece 4 (record schema) ✅** — **no migration**; rides the existing `knowledge` table. `source='verified_fact'` (live) / `'verified_fact_superseded'` (retired, addressable). `provenance` JSON = `{url, as_of, subject, subject_key, query, capturedBy}` + `{superseded_by, superseded_ts}` once retired. Two timestamps: `as_of` (claim-true-as-of, drives reconcile) vs `created_ts` (capture time, tiebreak). **Supersede key = `subject_key` slug** (`slugify(subject)`). Realtime dedup is cheap/hot-path-safe (slug+as_of or identical text); supersession is C's job only.
- **Piece 5 (surfacing + boost) ✅** — `retrieveScored` adds `VERIFIED_BONUS` (1.0, source-gated, applied AFTER the relevance floor so it only lifts an already-on-topic fact). `formatForPrompt` renders a distinct `[VERIFIED — as of <date>, source <url>]` line + an explicit "your training is stale, prefer THIS" override — the framing-half that makes the stale prior lose. Hard reserved-slot pin is the documented escalation if the soft boost proves too weak live.
- **Iterate ✅** — `learning.buildPriorKnowledgeBlock(topic)` injected into `buildFocusPrompt` + `buildThreadReviewPrompt` only (never free-association). Reuses `retrieveScored` (floor-gated); verified facts surface first via the boost; frames "build BEYOND these, do not re-derive." Gaps are implicit ("go beyond what you know"); explicit gap-tracking deferred.
- **C reconcile ✅** — `cloud_curator.reconcileVerifiedFacts` (DETERMINISTIC, offline, stored embeddings — no cloud needed): **layer 1** groups by `subject_key` → newest `as_of` wins, supersede rest; **layer 2** semantic backstop over survivors (cosine ≥ 0.9, catches phrasing drift across keys). Same-`as_of` contradictions LEFT live + reported. Wired as a `runDailyPass` stage; `verified_fact(_superseded)` excluded from `mergeNearDupKnowledge` so the two stages never fight.

Gate: smoke_verified_capture / _reconcile / _boost / _iterate_block, all in `npm test` (14 suites green).

**Still open (deferred, tune live):** the general "learning" record beyond verified facts (fact | finding | settled view from conversations); explicit gap-tracking for Iterate; the hard reserved-slot pin; capture from chat turns (not just readings).

Research basis: Mem0 contradict→UPDATE (2504.19413), Self-RAG/Adaptive-RAG (2310.11511 / 2403.14403), HippoRAG don't-delete-sources, the search-path-memory open question (§5), "endpoint not path" (§1).

---

## 4d. Autonomy system + Echo master DB + hardening package (BUILT 2026-06-27→28)

**Goal (Lucas):** a small local model given the right tools/circumstances reaches autonomy of *skill + personality* — pursuing a self-directed agenda, learning the real corpus, going deeper, not circling. Cloud is a **tutor** (rank/verify/synthesize, cold path); local is the lived hot path. Every cloud call is also **training data** for a future custom model.

**Research basis:** intrinsic motivation = reward LEARNING-PROGRESS not raw novelty (Schmidhuber; Oudeyer SAGG-RIAC); OMNI "model-of-interestingness" (2306.01711) as an LLM re-ranker over an LP curriculum; Voyager automatic-curriculum + skill library (2305.16291); Generative-Agents reflection (2304.03442); STORM ask-what-you-don't-know (2402.14207); RAPTOR hierarchical summaries (2401.18059). Anti-fixation guardrails (novelty divisor, ε-floor, share cap) are mandated by the LP-reinforces-a-rut risk.

**Components (all real files):**
- **Cloud broker** [lib/cloud_logic.js](../lib/cloud_logic.js): one door — minimal ID'd input, validate-or-null + one repair, cache, daily budget, `cloud_traces` (cache + audit + training corpus). `model.curator`=`gpt-oss:120b` (free, validated; bigger models are subscription-gated).
- **Interest model** [lib/interests.js](../lib/interests.js) + `interests` table: seeded deep-domain agenda; softmax+ε sampling with a 35% share cap; `reweight` = learning-progress EMA (from banked facts incl. reflection_knowledge) × novelty × cloud interestingness; emergent interests from clustered learning; `maybeSpawnFocus` drives the idle loop from the agenda, not the last conversation.
- **Depth ratchet + meta** [lib/meta.js](../lib/meta.js) + `agenda` table: close answered gap-questions, RAPTOR-lite summarize → `level='topic'` note + mastery, refill STORM-style gap-questions; the idle loop pursues the *specific* gap.
- **Active DB integration** [lib/active_recall.js](../lib/active_recall.js): unified `recall(topic)` across notes + graph + **Echo master DB** (via [lib/echo_suit.js](../lib/echo_suit.js) `recallKnowledge` → `search_knowledge`, the 518-tool engine, reference-not-copy); coverage `rich`/`thin` (gate floor 0.5) drives whether she researches or builds on what she holds.
- **Curator daily pass** [lib/cloud_curator.js](../lib/cloud_curator.js) `runDailyPass`: 7 stages, autonomy-first ordering (quarantine → verified-reconcile → **interests → meta** → near-dup → self-evo → graph) so budget exhaustion starves curation, not the agenda.

**Hardening package (R1–R8, 2026-06-28) — root-level, not symptom patches:**
- R1 tool nav: `echo-find` recipe-aware (`filterRecipes`) + recipe-first binding/fallback in `suitContextBlock`.
- R2 drift: `fireToolFollowup` self-pauses idle for its whole duration (incl. echo-chain) — fixes resume-before-followup at all 28 sites in one place.
- R3 lp cap (`LP_EMA_CAP=4`) / R5 cloud-score authority (low score hard-caps weight ≤1.0).
- R4 quarantine **volume** cap (`TOMBSTONE_KEEP_MAX=600`).
- R6/R7 swirl→iterate: fixation brake now applies INSIDE focuses; on brake/rich-recall → `consolidateAndAdvance` (bank what's known + jump to the next NOVEL agenda gap via `nextNovelGap`).
- R8 identity: `learning.seedIdentityFacts` (canonical name-origin: Zoe Barnes/House of Cards + Lois Lane) seeded as high-importance verified_facts.

Gate: 19 offline-deterministic suites (`npm test`), lint clean. All main-process → load on reboot. **Deferred:** self-correction Part B (in-moment trust — stop reflexive re-verify), hard reserved-slot pin, capture from chat turns, Echo write-tier (propose_* review job).

---

## 4e. Sight, Self-Awareness, and the Front/Cortex split (BUILT 2026-06-28)

Three coupled arcs, all built + smoke-tested into a 33-suite gate (`npm test`), lint clean. **All need a reboot to be fully live** — at the last reboot only the Dans-24b voice swap had landed.

**(a) Behavioral fixes (chat quality).**
- Live-info answering: she searches + answers in one reply (`lib/curiosity.isLiveInfoQuestion`/`deriveLiveQuery` + `seeImage`/`liveLookupAndAnswer` in main.js); `<web-open>` reads+answers inline (no more dead `<web-read/>` hop).
- Favorite/taste consistency: `lib/preferences.js` subject-gated recall + canonical storage ("My favorite X is …") so a pick is recalled, not re-formed; identity never spoken as a taste.
- Personal-fact memory: `lib/personal_facts.js` captures durable facts about Lucas (family/names) to retrievable knowledge + a retrieve-or-admit guard (no fabricated "Kate").
- `---` and bracket-only ("[planning…]") leaked replies are stripped.

**(b) Vision — she SEES, on every surface** (`lib/vision.js`, model `gemma4:31b`, `vision.tier=auto`).
Chat image attachments (vision-in), her own browser `<web-see scroll=… >`, the shared browser `<browse-see>`, the screen `<screen-see>` (Electron desktopCapturer; early SCREEN-SIGHT INTERCEPTOR answers in one fast response), and image files (`<file-read x.png>`). All route through one `seeImage()` helper. Image GENERATION is built but kill-switched OFF (needs a paid key or local ComfyUI — see [[local-image-gen-plan]]).

**(c) Self-awareness — 5 layers** (an accurate, continuous self-model; not phenomenal consciousness): live-state introspection (`lib/self_state.js`), developmental ledger (`lib/self_dev.js`), calibrated metacognition (`lib/metacognition.js` — confident when grounded, admits when not), unified self-narrative (`lib/self_narrative.js`), reset continuity (`lib/reawaken.js`).

**(d) Front/Cortex — Voice local, Cognition cloud** (see `docs/ARCHITECTURE_FRONT_CORTEX.md`, [[front-cortex-architecture]]).
- **Voice = Dans-PersonalityEngine-24b** (`config.frontModel()` ← `ZOE_FRONT_MODEL`); extractions stay on mistral (`config.model()`).
- **Cloud roles** (probe-verified, [[cloud-model-assignments]]): curator/reasoner = `gpt-oss:120b`; editor/search/vision = `gemma4:31b`. Reasoning models hide output in `message.thinking` → give them headroom (num_predict) and `cloud_logic.ask` deps.complete must return `{text,model}`.
- **Context distillation** (`lib/distill.js`): a cloud utility pass distills the firehose → a tight brief the front replies from (adaptive gate, fail-safe to full local).
- **Subconscious = cloud reasoner** (`config.subconsciousModel()` ← `ZOE_SUBCONSCIOUS_MODEL=gpt-oss:120b`; `monologue.generateThought`): her between-turn thinking runs on the cloud for depth (live-proven richer material), fail-safe to local, snap-back interrupts.
- **Echo tool-calling → cloud** (`echo_suit.routeNeed` + `echoCloudRouteEnabled`): `<echo-find>` cloud-routes — Reasoner picks the recipe/tool + writes args, we execute; the conversational front never authors echo-do JSON. Self-heals the connection (don't gate on `echoSuit.connected`).
- **General tool-router** (`lib/tool_router.js`): for a lookup the front didn't reach for and memory can't answer, the cloud decides the surface — web / echo / none. Safe surfaces only (own browser + Echo; NOT shared browser / os_* / email). Live-verified routing (LAMP→echo, prices→web, memory→none).

**Vision→action roadmap** (`docs/VISION_AGENT_RESEARCH.md`, `docs/PHASE1_VERIFIED_ACTION_SPEC.md`, [[vision-agent-roadmap]]): own-browser = full sandbox, everything else auth-gated; P1 (verified action loop) spec'd, not built.

Gate: 33 offline-deterministic suites. Backups taken before every live-DB write (`data/sq_backup_*.db`). **Deferred/next:** reboot to activate the Cortex; then re-test LAMP→Echo + the cloud subconscious; P1 verified-action loop; optional busy-line suppression when only a background thought is in flight.

---

## 5. Open questions for Lucas

- **Search-path memory** (separate from this): cache her own query→landing→useful so she stops re-issuing identical searches, and promote effective query phrasings as `[SKILL]`s. Fits Phase 1–2; do we fold it in or keep it separate?
- **Query classifier**: heuristic-only, or allow one cheap LLM call when ambiguous (latency vs. precision)?
- **Topic notes**: auto-created during reflection, or only minted by the curator once enough facts cluster?

---

*Sources: arXiv 2304.03442, 2310.08560, 2504.19413, 2502.12110, 2401.18059, 2404.16130, 2405.14831, 2502.14802, 2310.11511, 2403.14403; Itti & Baldi 2006; Microsoft GraphRAG docs; sqliteai/sqlite-memory.*
