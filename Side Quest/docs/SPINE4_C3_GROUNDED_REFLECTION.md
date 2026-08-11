# Spine 4 · C3 — Grounded Reflection (spec)

**Written:** 2026-08-10 (sole-builder session). **Authority:** `INTEGRATED_BUILD_TRACK_2026-08-10.md` §C3 + §1 (the "Honest Lying" constraint, arXiv:2605.29463). **Status:** COMPLETE — foundation + live-loop orchestration both built, gate-green (`smoke_c3_reflection` 21/21). See "DONE" below.

## The goal
Make the significance reflection (`lib/reflection.js` `maybeSignificanceReflect`) synthesize over the **landed high-importance documents** C2 now pressures on — not just the thought/reading stream — so a day of landing deliverables and meeting notes produces episode-cited beliefs. Built to the §1 constraint: **grounded (cited external anchors) + programmatic inputs + RRR monitor + two-sided acceptance (decline unsupported generalizations).**

## What already exists (do NOT rebuild — the existing-organ finding)
`reflection.js` already carries most of the §1 constraint:
- **Grounding gate** (`routeReflection`): a KNOWLEDGE/SKILL takeaway distilled purely from own thoughts (no external anchor) is **SPECULATION** → gated to a graph proposal (`graphMem.recordEntity`, `epistemic:'speculated'`), never written as a retrievable fact. Only externally-anchored takeaways become facts. *This is the two-sided acceptance.*
- **RRR monitor:** `selfRep.isSemanticRepeat` drops a near-duplicate reflection (the "frozen memory" defense).
- **Identity firewall:** `[SELF]`→self_model (genuine traits only), `[INTEREST]`→curiosity note (never identity) — the drift-audit fix.
- **Provenance:** refIds (monologue) + urls, reference-not-copy.
- **Significance trigger (Park):** `reflection_importance_accum ≥ 150`, fed by thought/reading importance; C2 now also feeds it document importance (value-triaged).

## Built this session (C3 foundation — gate-green, `smoke_c3_reflection` 11/11)
1. **`db.getReflectionWorthyDocuments({sinceId, minImportance=6, limit=5})`** — the synthesis input: un-reflected (id > cursor) high-importance landed docs, newest first, lightweight rows (title + understanding + origin, not full body).
2. **`reflection.isGrounded(sourceRows, extraUrls)`** (pure, exported) — the grounding decision: a reading, a sourceRow url, OR a landed doc's origin (`extraUrls`) → grounded; own-thoughts-only → not. `routeReflection` now uses it.
3. **`routeReflection(..., {extraUrls})`** — documents ground reflection via their **origins passed as `extraUrls`**, NOT as sourceRows.

## The pitfall this design avoids (why extraUrls, not sourceRows)
Putting documents into `sourceRows` would corrupt two monologue-keyed mechanisms: the **provenance** block hardcodes `refTable:'monologue'` and logs `sourceRows` ids (a doc id under monologue = wrong), and **`markReadingsConsolidated`** marks `sourceRows.filter(type==='reading')` ids as consolidated monologue readings (a doc id → wrong row). Passing doc origins as `extraUrls` gives grounding + provenance-urls **without** touching the monologue refIds/markReadings paths.

## DONE — the live-loop orchestration (built, `maybeSignificanceReflect` in lib/reflection.js)
1. Reads a doc cursor `last_significance_doc_id`; `recentDocs = db.getReflectionWorthyDocuments({ sinceId, minImportance:6, limit:5 })`.
2. **MIN_ITEMS across both:** fires when `recent.length + recentDocs.length ≥ MIN_ITEMS_FOR_SIGNIFICANCE`. The empty-`recent` case is GUARDED by an `advanceCursors()` helper that only touches the monologue cursor when `recent.length` (docs-only windows would otherwise throw on `recent[len-1].id`). Applied at all three exit paths (taggedCount-0, dup, success); the decay path deliberately leaves both cursors so the material is retried.
3. **Prompt:** a "recently landed material" section (`title` + `understanding`, capped) is folded in alongside the thought lines via `streamParts` (either section may be empty).
4. **Grounding:** `routeReflection(raw, recent, { extraUrls: recentDocs.map(d=>d.origin).filter(Boolean) })` — doc-derived takeaways become grounded facts (documents are external material).
5. **Advances** `last_significance_doc_id` to `recentDocs[0].id` (the query is DESC → newest).
6. Every existing guard kept: RRR loop-guard, the SELF/INTEREST firewall, the decay-on-too-little path.

**Acceptance — proven in `smoke_c3_reflection` (21/21):** (a) full loop with empty thought-stream + grounded landed docs → a grounded FACT (storeDeduped called), a reflection note written, doc cursor advanced, monologue cursor untouched, accum reset, no throw; (b) the firewall — own-thought-only takeaway with no external anchor → SPECULATION (gated proposal), never a fact. The two-sided acceptance holds.

## ⚠ Test-environment gotcha (why the smoke stubs `memory.embed`/`storeDeduped`)
The grounded fact WRITE goes through `memory.storeDeduped` → the WASM embed WORKER (`lib/embed_worker.js`). That worker is `w.unref()`'d (memory.js:69) so it NEVER keeps the process alive — correct for the app (the main loop stays alive on timers/IPC), but in a bare standalone smoke that only `await`s an embed, the loop drains and the process exits 0 *before the worker replies* (silent, mid-embed). This is why embed-dependent standalone smokes (`smoke_reflection_router`, `smoke_reflection_delaunder`) are NOT in the gate allowlist and hang if run bare. `smoke_c3_reflection` stays gate-safe by stubbing `memory.embed`→null and `memory.storeDeduped`→`{action:'add'}`, isolating the C3 ROUTING contract from the embedder — matching run_smokes' "stub embedder" rule (run_smokes.js:280).
