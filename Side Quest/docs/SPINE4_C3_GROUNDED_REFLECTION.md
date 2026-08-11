# Spine 4 · C3 — Grounded Reflection (spec)

**Written:** 2026-08-10 (sole-builder session). **Authority:** `INTEGRATED_BUILD_TRACK_2026-08-10.md` §C3 + §1 (the "Honest Lying" constraint, arXiv:2605.29463). **Status:** FOUNDATION built + gate-green; the live-loop orchestration is the remaining step (below).

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

## REMAINING — the live-loop orchestration (the delicate step, do carefully)
Wire `maybeSignificanceReflect` to actually pull + reflect over documents:
1. Read a doc cursor `last_significance_doc_id`; `recentDocs = db.getReflectionWorthyDocuments({sinceId, minImportance:6, limit:5})`.
2. **MIN_ITEMS across both:** fire when `recent.length + recentDocs.length ≥ MIN_ITEMS_FOR_SIGNIFICANCE` (currently thoughts-only). ⚠GUARD the empty-`recent` case — the current code does `recent[recent.length-1].id` for the cursor; only advance the monologue cursor when `recent.length`.
3. **Prompt:** add a "recently landed material" section (`title` + `understanding`, capped) alongside the thought lines, so the model synthesizes over both.
4. **Grounding:** `routeReflection(raw, recent, { extraUrls: recentDocs.map(d=>d.origin).filter(Boolean) })` — doc-derived takeaways become grounded facts (correct: documents are external material).
5. **Advance** `last_significance_doc_id` to the newest reflected doc id (`recentDocs[0].id`, the query is DESC).
6. Keep every existing guard: RRR loop-guard, the firewall, the decay-on-too-little path.

**Acceptance (two-sided, live):** (a) a window with real landed deliverables/meeting notes synthesizes an episode-cited belief; (b) a window whose takeaways aren't supported (own-thought-only, no docs/readings) writes NO fact (stays speculation), and `self_model` is unchanged. RRR stays low (no near-duplicate belief). This is the C3 completion drive.
