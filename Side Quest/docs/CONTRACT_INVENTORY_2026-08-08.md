# Contract Inventory — 2026-08-08 (M6.2)

Every cloud/LLM output consumer, audited: **85 sites — 51 CONTRACTED, 17 PROSE-OK, 17 UNGUARDED.**
`cloud_logic.ask` is fully covered (44/44 pass `validate:`). Every unguarded site is on the
research-deliverable manufacturing line (`runCloudOperator` → notes → `condenseComplete` → section
→ file/canvas) plus the canvas CREATE door (fixed same-day, see below).

**STATUS 08-08 end of night: 11 of 13 queue rows CLOSED.** Remaining open: #10 (autonomy move
answer — needs a crystallize-side contract shape, not a regex) and #12 (deepen raw notes —
open-by-design; all its deliverable-landing consumers are contracted).

## UNGUARDED (the M6.3 work queue, leverage order)

| # | site | purpose | output lands in | missing contract |
|---|------|---------|-----------------|------------------|
| 1 | ~~main.js:4796 create door~~ | canvas CREATE | canvas doc + notes + working stamp | ✅ FIXED 08-08: rejectEditOutput(md, '', order) — narration reject, nothing lands |
| 2 | ~~directed organize → section~~ | directed organize → section | notes/directed-N.md + canvas | ✅ FIXED 08-08 (5ff637e): isNarration → raw-body fallback (now ~15270) |
| 3 | ~~enrich two-lane merge~~ | enrich two-lane merge | enrich deliverable + canvas | ✅ FIXED 08-08 (5ff637e): isNarration → raw lane text lands (now ~15598) |
| 4 | ~~enrich facet organize~~ | enrich facet organize | deliverable + canvas | ✅ FIXED 08-08 (5ff637e): isNarration → raw-body fallback (now ~15660) |
| 5 | ~~topical section~~ | topical section under exact heading | briefing + parseSections | ✅ FIXED 08-08 (5ff637e): isNarration reject + deterministic heading patch-back (now ~15876) |
| 6 | ~~main.js:14126 paper front matter~~ | paper front matter | dossier md + .docx handoff | ✅ FIXED 08-08: isNarration reject → honest dossier-shape fallback + warn log |
| 7 | ~~main.js:11723 inquiry touch answer~~ | inquiry touch answer | doc_store.land as document | ✅ FIXED 08-08: isNarration → doc landing withheld (write-back still proceeds), logged |
| 8 | ~~report door compose~~ | report door compose | notes + canvas | ✅ FIXED 08-08 (9c78319): isNarration reject + token-search fallback + outcome logging (now ~5062) |
| 9 | ~~main.js:11888, 11941 rehearsal study~~ | rehearsal study blocks | need meta + sandbox goal | ✅ FIXED 08-08: study = narration OR zero source URLs (the prompt's own demand) → honest "opening unstudied" path; rehearse-research answer narration → empty finding |
| 10 | main.js:12052 | autonomy move answer | history + procedures.crystallize | OPEN (considered 08-08): a move answer's GENRE is first-person work narration — isNarration would false-positive on legitimate outcome reports. Needs a different contract shape (crystallize-side vetting), not a regex here. |
| 11 | ~~main.js:1807 canvas-drop understanding~~ | canvas-drop understanding | doc_store understanding | ✅ FIXED 08-08: isNarration → understanding dropped, raw doc stands (same path as cloud-down) |
| 12 | main.js:14927→15040 | deepen pass body | target.raw → synthesis | OPEN-BY-DESIGN (reviewed 08-08): the raw notes stream is prose-tolerant intermediate; every consumer that lands a deliverable from it (organizers, synthesis, report) is now contracted. Guarding the stream itself would entangle progress/strike accounting. |
| 13 | ~~lib/byline.js:177 Substack draft~~ | Substack draft (PUBLIC) | draft → substack_publish recipe | ✅ FIXED 08-08: rejectDraft contract (deliberation via isDeliberation — NOT full isNarration, essays are legitimately first-person — + AI-boilerplate + prompt-echo + thin) at WRITE, rechecked at PUBLISH (bad file → back to write, recipe never runs) |

## Proven contract patterns to apply (pick per site)
1. **Reject-and-leave-untouched** — `canvas_command.rejectEditOutput` (edit + create doors).
2. **Deterministic-oracle patch-back** — `cp.verifyComposition`/`patchMissing` (main.js:14089).
3. **Grammar capture with host vetting** — `cardinality_capture`/`civic_capture.parseCapture`.

## CONTRACTED / PROSE-OK
Full call-site tables live in the 08-08 audit agent transcript; headline: all 44 `ask()` sites
validated; reply/utterance surfaces (17) are prose-by-design behind the tag-stream contract +
leakguard + antifab. Producer split: runCloudOperator 3 contracted / 9 unguarded / 2 prose;
condenseComplete 4 / 8 / 6.
