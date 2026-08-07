# Contract Inventory — 2026-08-08 (M6.2)

Every cloud/LLM output consumer, audited: **85 sites — 51 CONTRACTED, 17 PROSE-OK, 17 UNGUARDED.**
`cloud_logic.ask` is fully covered (44/44 pass `validate:`). Every unguarded site is on the
research-deliverable manufacturing line (`runCloudOperator` → notes → `condenseComplete` → section
→ file/canvas) plus the canvas CREATE door (fixed same-day, see below).

## UNGUARDED (the M6.3 work queue, leverage order)

| # | site | purpose | output lands in | missing contract |
|---|------|---------|-----------------|------------------|
| 1 | ~~main.js:4796 create door~~ | canvas CREATE | canvas doc + notes + working stamp | ✅ FIXED 08-08: rejectEditOutput(md, '', order) — narration reject, nothing lands |
| 2 | main.js:15139/15140 | directed organize → section | notes/directed-N.md + canvas | none (empty→raw fallback) |
| 3 | main.js:15463 + 15454/15455 | enrich two-lane merge | enrich deliverable + canvas | none on lanes or merge |
| 4 | main.js:15523 + 15514 | enrich facet organize | deliverable + canvas | parsePass only (non-rejecting) |
| 5 | main.js:15730 + 15712 | topical section under exact heading | briefing + parseSections | heading contract is prompt-only (comment at 15725 documents the exact silent break) |
| 6 | main.js:14126 | paper front matter | dossier md + .docx handoff | len>80 only |
| 7 | main.js:11723 | inquiry touch answer | doc_store.land as document | len>800 only |
| 8 | main.js:5024 | report door compose | notes + canvas | !md.trim() only — needs the narration reject |
| 9 | main.js:11888, 11941 | rehearsal study blocks | need meta + sandbox goal | slice only |
| 10 | main.js:12052 | autonomy move answer | history + procedures.crystallize | verifyExpect judges met/unmet; text unchecked |
| 11 | main.js:1807 | canvas-drop understanding | doc_store understanding | none; recall consumes as grounded |
| 12 | main.js:14927→15040 | deepen pass body | target.raw → synthesis | parsePass extracts, never rejects |
| 13 | lib/byline.js:177 | Substack draft (PUBLIC) | draft → substack_publish recipe | title/body split + len>=40 only |

## Proven contract patterns to apply (pick per site)
1. **Reject-and-leave-untouched** — `canvas_command.rejectEditOutput` (edit + create doors).
2. **Deterministic-oracle patch-back** — `cp.verifyComposition`/`patchMissing` (main.js:14089).
3. **Grammar capture with host vetting** — `cardinality_capture`/`civic_capture.parseCapture`.

## CONTRACTED / PROSE-OK
Full call-site tables live in the 08-08 audit agent transcript; headline: all 44 `ask()` sites
validated; reply/utterance surfaces (17) are prose-by-design behind the tag-stream contract +
leakguard + antifab. Producer split: runCloudOperator 3 contracted / 9 unguarded / 2 prose;
condenseComplete 4 / 8 / 6.
