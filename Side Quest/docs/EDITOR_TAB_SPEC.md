# Editor's Studio — spec (design)

> **Status: DESIGN.** A **STUDIO**: operator-driven, self-contained, programmatic; modeled on the QR studio. No Zoe / no language interaction in the workflow — the cloud model is invoked as a *service behind a button*. Zoe is **aware-only** (holds a memory pointer to it). Built ON Echo's existing `verification_session` spine, extended. See [ZOE_HOST_ARCHITECTURE.md](ZOE_HOST_ARCHITECTURE.md).

## The "Studio" pattern (this is a reusable template)
A studio is a **near-self-contained interface for one mission**, giving Lucas **direct programmatic interaction** — deterministic buttons → backend calls, its own state, its own persistence/log. The cloud model (where needed) is a recipe-locked **service** triggered by a button, returning structured results the UI renders. Studios do NOT route through Zoe's chat or her construct.

This refines the surface taxonomy into three classes:
- **Zoe-operated** (her hands): CRM, KG, Polling, Canvas, Agents — she queries/acts.
- **Studios** (Lucas's hands, self-contained, Zoe aware-only): **Editor**, QR, Hub, Transcription.
- **Ambient/automated** (background, Zoe watches a status line): Maturation/Infra, corpus state.

The Editor is the first studio we spec in full; the workflow + log model below is the template for the rest.

## What it does
An **editorial-QA + document-lifecycle workbench** for a piece of writing (op-ed, briefing, memo). The checks are work Zoe's 24B *can't reliably do* (grounded fact-check, cite-verify, continuity) — so each runs as a **locked recipe executed by a cloud model** (determinism from the recipe, competence from the tier). But the *driving* is Lucas's, by button.

## The operator workflow (the button flow Lucas described)
1. **Start new document** → opens a tracked record (a `verification_session` + a document-lifecycle row).
2. **Load document** — drag-drop and/or click-attach.
3. **Read + interact** — the loaded doc renders in-panel; readable, and editable for corrections.
4. **Run checks** (button) → fires the cloud-model recipes: **citation verification + fact check** (v1; DB-comparison / org-continuity / mechanics-&-AI-leak are later stages).
5. **Results returned** — structured findings render per-claim (claim → evidence → suggested fix).
6. **Act**: make corrections in-panel, OR **issue a report** on the findings.
7. **Iterate**: make changes, or **upload changes from another person** → each becomes an iteration with an **author-tagged change-log entry**.
8. **Certify** (button) → generates the final **certification** + logs a **certification number**.
9. The whole studio is a **log/tracking environment**: every document, iteration, check-run, change, and certification is recorded and reviewable.

## Persistence / the tracking log (what gets stored)
Built on `verification_session` (skuld.db: source_doc, version, `parent_session_id` revision chains, findings, report/certificate doc paths) + a thin **document-lifecycle layer** the studio owns:
- **document** (the work unit) → **iterations** (versions; each with author/submitter + timestamp + source) → **change-log** entries → **check-runs** (which recipe, tier, findings, when) → **certifications** (cert number, doc path, date).
- Everything is queryable for review (the "log tracking environment").

## Zoe's relationship — aware-only (pointer, not participation)
She is **not** in this workflow. All she needs:
- **Knowledge that it exists + is happening** ("the weather-mod op-ed is in the Editor, certified yesterday").
- **Where it lives in memory** — a pointer (which DB/tables + doc paths) so she can answer if Lucas asks ("where's the certified op-ed / what's its cert number?").
No status-feed-into-her-reasoning needed beyond that; this is operator-owned, not ambient-watched.

## Execution model — recipes locked for the cloud tier
Same recipe machinery as the data recipe book, different executor. A check stage = a recipe that locks *which checks, in what order, returning what structured-findings schema*; `run_recipe` gains a `tier`/`executor` field; this studio's buttons call `run_recipe(tier:cloud)`. Determinism from the recipe; competence from the tier. (First real consumer of Category-C model-picking.)

## Gating posture
**Advisory, never auto-reject.** The studio flags; Lucas decides (`accepted`/`revised`). Matches the existing `report_ready → accepted|revised` and "truth/commit authority lives with Lucas + verified layers."

## Reuse vs build
- **Reuse:** `verification_session` state machine + cite-verify + fact-check agents + `compile_verification_report` + `render_citation_certification` (PDF) + `score_text`.
- **Build:** the studio UI (load/read/edit, stage tracker, findings, change-log, certify), the document-lifecycle/log layer, the recipe-locked-cloud `tier` field, author-tagged iteration tracking, cert-number logging. Later: the 3 added check stages (DB-comparison, org-continuity, mechanics/AI-leak).
- **Note — buildable standalone:** because it doesn't depend on Zoe's construct, this studio can be built + tested as a discrete unit (uses the recipe engine + Echo's verification spine), independent of the full Zoe-as-host migration.

## What this teaches the rest of the redesign
1. **Recipes are tier-agnostic** — lock a procedure to any executor (24B for tool-use, cloud for editorial). → `run_recipe` grows `tier`; Category-C becomes real.
2. **The studio pattern is a reusable primitive** — self-contained, programmatic, Zoe-aware-only, own log. QR/Hub/Transcription all fit it.
3. **A studio carries its own lifecycle/log schema** — document→iteration→change-log→certification is a template for any tracked-artifact tool.

## Grounded in the live process (reviewed 2026-06-23)
Reference corpus: `C:\Users\azrae\Documents\Claude\Projects\Citation Verification and Fact Check` (17 cert HTML/PDF pairs + `citation_verification.toml`, run out of a Claude workspace). **Proven floor — standardize + enhance, don't replace.**
- **Process = the TOML, formalized as the locked cloud recipe:** extract citations → `open_access_resolve` → `citation_verify` (direct→Wayback→Google Cache) → web_search/`browse` fallback → `generate_verification_report`. Rubric: Verified ≥0.90 · Partially 0.60–0.89 · Unverified 0.20–0.59 · Contradicted · Inaccessible. Cloud model: `llama-3.1-70b-instruct`.
- **Cert template — canonical sections (standardize):** issued header · title + **author credit** · meta (doc+bytes, scope, method, reporting cutoff, **auditor**, standard) · ruling card (stamp/grade/prose/scoreline) · **Δ-since-prior card (revision audits only)** · KPIs · summary-by-category · per-citation findings · source-strength tiering (A/B/C/D). Drift to fix: optional sections appear inconsistently + prose-heavy → render deterministically from structured findings so every cert is format-identical.
- **Cert-number scheme:** `CFC-YYYY-MM-DD-<rev>` (e.g. `CFC-2026-05-13-A3`); re-audits reference the parent cert id. Standardize into one canonical, collision-free scheme; log every number.

## Decisions (settled 2026-06-23)
1. **Editing = native document creator (option C, broadened)** — a program-wide structured document model + creator (see ZOE_HOST_ARCHITECTURE.md "Native Document Model"), not just in-panel edit. Lets Zoe follow document *construction* as structured deltas, not raw-file ingestion.
2. **Formats: all primary types, READ + WRITE, program-wide** (.docx/.pdf/.md/.txt). Settled for the whole program.
3. **Scope: NOT a reduced MVP.** TOML process is the proven floor; build ALL enhancements now (studio UI + lifecycle log + the 3 added stages + native creator + format I/O + standardized cert).
4. **Author = original author, immutable** through every edit (Lucas editing ≠ changing documented author); **auditor** is a separate tracked role; document→author tied in DB (`citation_facts.author` exists).
5. **Cert numbers:** standardize the `CFC-…` series; log every number in the tracking env.
6. **Zoe pointer:** she gets where it lives (skuld.db `verification_session` + the document store) to answer if asked; not in the loop.

---

## Information architecture — settled 2026-06-23 (requirements pass)

> The studio is **two views**, not one screen. Worked through with Lucas in a slow requirements pass. **Layouts are NOT settled here** — these are requirements; each view's layout gets designed one at a time, separately.

### Template = look-and-feel, NOT a fixed grid
Correction to any earlier "4-zone shell" reading: what carries across workbenches is the **design language** — visual identity, the state-pill idiom, button/panel styling, how findings/statuses render, the typographic + color grammar. A kit of parts. Each workbench composes those parts into whatever layout its *own* mission needs. There is no canonical zone arrangement to reuse.

### View A — the document index (the org's working release index)
- **Scope = a focused lens, not a silo.** Only documents that enter *through the Editor pipeline* are tracked here; they still ingest into the corpus/KG normally. The index links to the real DB record — it doesn't replace it.
- **One row per document (simple stat read):** title · author · cert number · version · last accessed · **publication status**.
- **Publication status is an action:** a **close-out button** pressed when the piece is *actually published* — records the publication and optionally attaches a public copy (URL **or** file, either, optional).
- **It is also the finder.** Eventually every Rainey release flows through here, so fast search is a co-equal primary purpose. **Wired search box + filter facets on author · title · date · status · topics.** Topics ride on subject tags extracted at ingest; search rides on Echo's existing FTS/semantic, scoped to pipeline docs (we do NOT build a new search engine).

### View B — the document view (read-and-correct, viewer-dominant)
- **Read-and-correct ONLY — not an authoring tool.** Minor corrections (spelling, grammar, a line here or there); no substantial rewrites. → This **decouples the Editor from the full native-document-creator stack** (build-step #5 / Tiptap stays a separate, later Canvas concern). The Editor ships without it.
- **Normalize on import.** Whatever format arrives (.docx/.pdf/.md/Google-Doc export) is extracted into **one internal editable working copy**; arrival format is just a per-format *importer* concern (PDF → text-extract, etc.). We never edit the original file in place.
- **Working-copy model is light:** paragraphs/headings/basic inline + **stable anchors** for findings. Each supported format = one importer feeding this model.
- **Findings — linked dual-view:** a findings list beside the doc **and** inline markers in the text (same set; selecting in one highlights the other). Work it document-driven top-to-bottom or list-driven, moment to moment.
- **Explicit resolution tracking:** mark a finding resolved as you fix it; studio tracks "N of M addressed" before re-certify.
- **Re-check = whole-doc re-verify** (a correction can shift another claim's standing); still-flagged findings stay, now-clean ones drop off, resolved-count reflects the latest run.

### View A — layout (settled 2026-06-23)
- **Toggle navigation, not master–detail.** The studio opens on the index (full canvas). "New document" (top-right) opens View B on a load/blank flow; **double-click a row opens View B** on that doc; a back/breadcrumb returns. Each view owns the whole canvas (so View B can dominate).
- **Dense sortable table**, one row per doc. Columns: title · author · cert# · version · last accessed · status. **Clickable headers sort; default resting order = last-accessed desc (recency).**
- **Search + filters** in a bar above the table: wired search box + facet dropdowns (author · date · status · topics).
- **Row interactions:** single-click = expand inline (detail peek); double-click = open the tool.
- **Expanded-row detail (approved):** one-line summary · topic chips · revision/cert history · findings-resolved count · last check-run · import format · actions (Open document · Close out).
- **Status pills (3, single-operator semantics):** `in-process` → `certified` → `published`. Close-out lives in the expanded row (and may also be a status-cell quick action); published rows surface the public-copy link in place of the close-out button.

### View B — layout (settled 2026-06-23)
- **Collapsible right rail, document-dominant.** Document fills the canvas; findings rail on the right toggles open/closed. **Inline markers persist even when the rail is collapsed** (colored underlines never hide a flag — collapsing only reclaims width).
- **Thin top bar:** breadcrumb back to index · doc identity (title/author/rev) · state pill · **"N of M resolved" progress bar** · actions: Run checks · Certify · Publish.
- **Findings — dual-view, linked:** inline markers in the text + cards in the rail are the same set; selecting either rings both (verified linkage). Cards show verdict pill · evidence line · "Suggested fix →" · manual **resolve** checkbox. Verified findings show cite-ready, nothing to do.
- **Readable measure, not full-bleed:** prose column capped at a comfortable line length (~520px) inside the dominant pane — reading/correcting beats edge-to-edge text.
- **Resolution = manual per finding** (or auto on applied suggestion, below); top-bar bar reflects the live count.

### The suggested-replacements drawer (settled 2026-06-23)
- **Full-screen drawer** over the document; collects **every** proposed replacement across all findings in one deliberate review pass (keeps the reading surface clean — the rail only flags).
- **Entry:** rail "Suggested fix →" opens it scrolled to that suggestion; a top-bar "Review suggestions (N)" opens it at the top. "Jump to text" closes back to the inline spot.
- **Per suggestion:** verdict tag · paragraph locator · **before→after diff** · source/rationale · three controls — **Reject** (keep original), **Accept**, **✎ Edit** (tweak the replacement wording before applying).
- **"Apply N accepted"** writes only accepted replacements into the working copy **as a new revision** AND **auto-marks those findings resolved** (one action moves both the version chain and the resolved-count). Rejected ones keep the original and stay unresolved unless hand-fixed.

### Lifecycle = bounded (the Editor is the last QA leg)
The studio sits near the **end** of the publication chain — from the last verified version, publication follows in ~a week. Flow: **load → verify/correct (revisions accrue *within* this cycle) → certify → publish (close-out, terminal).** Because publication ends iteration, version chains never sprawl. **Anything done after publish is a NEW document entry, not a revision** (optionally linked back, but its own row). Normal path is cert → publish, but close-out does not hard-require a cert.
