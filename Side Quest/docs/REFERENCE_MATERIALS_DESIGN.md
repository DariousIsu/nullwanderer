# In-House Citation Attachment — Design Spec

> **Status: DESIGN ONLY (spec for review). No code yet.** Lets the operator verify a claim against an
> **in-hand / in-house source document** — a real, publicly-available source the web search/fetch ladder just
> can't surface — by attaching it directly to the citation it backs. Companion to the editor studio
> (real-document import + drag-drop shipped, commit `e05ddc0`).

---

## 1. The workflow (Lucas's flow — the whole design)
```
1. DROP the document to verify           → imports (works today)
2. OPEN it → the extractor reads it and LISTS its citations in the findings window   (no checking yet)
3. For a citation you have the source for → click "Attach source" on that citation → upload the in-hand doc
4. RUN CHECKS → each attached citation resolves to ITS uploaded doc (instead of a web search);
   every other citation runs the normal public web ladder. Match + classify judge support as usual.
```
That's it. The operator does the source-matching by hand (attach = the tag), so there's **no embedding index,
no similarity search, no corpus** — the attachment binds to the exact citation by its stable id.

## 2. Why it's tiny
Each extracted citation already has a **stable id** — `verify_extract` emits `uid = <block-anchor>.s<n>`
(e.g. `a3.s0`), and block anchors are stable within a working copy (the doc under verification doesn't change
between runs). So "attach a source to this citation" is an **exact lookup by uid**, fully deterministic. The
extractor also already classifies units by kind (`quote` / `citation` / `numeric` / `claim`) and runs with
**zero model cost**, so listing citations the instant a doc opens is cheap.

## 3. The three moving parts
**a. List citations on open (new).** Today the findings rail is empty until Run checks. Add: on opening a doc
in View B, run `verify_extract.extractUnits(workingCopy)` (deterministic, offline) → list each unit as a
PENDING finding, each with an "Attach source" button. This is just surfacing the extract stage early.

**b. Attach store.** A small `editor_registry` table keyed `(docId, version, uid) → { title, doc_ref, text }`.
"Attach source" uploads/drops an in-hand doc → extract its text via `lib/file_ingest` (the machinery already
shipped — pdf/docx/xlsx text layer + image OCR) → store the row. The uploaded doc also lands in the main DB as
a source (established ingest protocol) for provenance. Attaching binds to the citation's uid; nothing is matched.

**c. Resolve rung 0 = attachment lookup.** `verify_resolve` gains a first rung: if the unit's uid has an
attachment, resolve to its text (`tier:'reference'`, `source_url` = the doc's title/ref), skipping the web
ladder entirely. No attachment → the public ladder runs exactly as today (fail-soft, zero behavior change).
The tag decides *which source*; **classify still judges whether the claim actually follows from it**, so a
wrong attachment is still caught — the operator can't force a false pass.

## 4. Provenance / grading
An attached in-house doc is a **legitimate named source** — it grades like any cited source (no downgrade), and
the certificate cites it by title. `lib/sources.js` treats a `tier:'reference'` resolution as a named-source
citation. A reader of the cert sees exactly which citations rest on which in-house documents.

## 5. Where it plugs in
- `lib/editor_registry.js` — **+attachments table** + CRUD (get by docId+version, upsert, delete).
- `main.js` — **+`editor:list-citations`** (run extract on open) · **+`editor:attach-source`** (extract via
  file_ingest → store → land as source) · **+`editor:detach-source`**. Pass the attachments map into `editor:run-checks`.
- `studio/verify_resolve.js` — **+rung 0** (attachment lookup; injected `opts.attachments[uid]`; ladder untouched).
- `lib/editor_checks.js` — thread the attachments map into `runHarnessChecks` → `resolveOpts`.
- `lib/sources.js` — `reference` tier → named-source citation with the attached doc's title.
- `renderer/editor.{html,js}` — list citations on open; per-citation "Attach source" button (reuses the shipped
  drag/`pathForFile`); show attached state; Run-checks wiring already exists.

## 6. Build slices (deepest-testable first)
- **S0 — attach store + list-citations.** attachments table + `editor:attach-source` (file_ingest extract →
  store) + `editor:list-citations` (extract-on-open). Offline-smoke: extract a fixture doc's citations; attach a
  fixture source to a uid; assert it stores + reads back by uid.
- **S1 — resolve rung 0.** `verify_resolve` attachment rung + thread attachments through the harness.
  Offline-smoke: a unit WITH an attachment resolves `tier:'reference'` from the attached text and NEVER calls
  the web tools; a unit without falls through to the normal ladder.
- **S2 — editor UI.** List citations on open + "Attach source" button/drop per citation + attached-state badge.
  Reboot-gated.
- **S3 — provenance grade.** `reference` tier as a named-source citation in `lib/sources.js` + cert labeling.

## 7. Open questions
- **Re-attach after a run.** Primary flow attaches BEFORE Run checks (one run resolves everything). If a run
  already happened and a citation came back `inaccessible`, attaching then re-running resolves it (attachments
  persist by uid). An inline "re-verify just this one" is a possible polish but not needed for the core flow.
- **Which kinds get an Attach button.** Default: all extracted units (`quote`/`citation`/`numeric`/`claim`).
  Could scope to just `citation`/`quote` if the list feels noisy — cheap to adjust.
