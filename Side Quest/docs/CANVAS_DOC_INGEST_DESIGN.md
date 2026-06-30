# Canvas Document Ingest — Design (Echo-backed)

How the Canvas treats a dragged-in document, achieving **persistence**, **no duplication**, **proper DB
storage**, and the **Zoe integration** (full cloud/structured processing + Zoe made aware). Decision
2026-06-29: documents persist in **Echo's master DB** (not a Side-Quest side-DB), addressed by Echo's
numeric **`doc_id`** (the "call number"). Grounded in `echo/store.py` (the `documents` schema) +
`ingest_file` (its own docs: "used by drop-to-open").

Status: DESIGN (Echo-backed). Build after §6 confirms.

---

## 1. Echo already provides most of this (the key realization)

`echo.ingest_file(source_path, project_name=_Inbox, move=false)` IS the drop pipeline:
extract markdown (PyMuPDF4LLM/Docling/MarkItDown by ext) → copy source into `Vault/<project>/sources/`
→ write `Vault/<project>/<slug>.md` + frontmatter → **upsert `documents` row (sha256-idempotent) +
git auto-commit** → returns `{action:'ingested', doc_id, path, project_name, vault_source_path, moved}`.

`documents` schema (`echo/store.py`): `id` (PK = call number), `project_name`, `path` (unique), `title`,
`markdown_current` (extracted body), `frontmatter_json`, **`sha256`** (content dedup), `mtime`,
`ingested_at`, `extraction_method` · `document_versions` (history) · `documents_fts` (search).

So the four goals are **mostly Echo-native**:
- **Persistence** → documents row + Vault file + git + version history (durable across reboots).
- **No duplication** → **NOT native on Echo 3.3.1** (verified — `ingest_file` disambiguates by filename,
  never hashes). WE dedup via a local `sha256 → doc_id` index checked before ingest (§4).
- **Into the DB properly** → the `documents` table; addressable by `doc_id`.
- **Call number** → `doc_id`; `get_document(doc_id, depth=summary|full)` reads it (already used by the
  app's doc Reader / `studio/doc_view.js`).

---

## 2. The drop pipeline (what WE add around Echo)

```
drag file → canvas:drop-doc
  1. INGEST: ingest_file(path, project_name, move=false) → { action, doc_id }
       (Echo extracts + files + upserts sha256-idempotently — dedup + persistence + extraction, native)
  2. CANVAS: emit a block keyed to a DETERMINISTIC tab_key = "doc-<doc_id>"
       (idempotent re-open — a re-drop returns the same doc_id → same tab, never a 2nd copy)
  3. STRUCTURE (caged cloud leaf / Echo): extract_entities_from_doc(doc_id) → entities+relations into
       the KG, linked to the doc; + a summary pass over markdown_current → frontmatter/summary.
  4. ZOE AWARENESS: native via Echo recall (search_documents_semantic / search_knowledge / get_document)
       + ONE local knowledge node {source:'canvas_doc', "DOC-<doc_id>: <title> — <summary>"} so local
       recall + the Tracks registry reach it by call number without an Echo round-trip.
  5. KEEP-STATE: a thin local row (canvas UI state only) — { doc_id, tab_key, kept } — like the existing
       position store. Content lives in Echo; the board's pin/layout is Side-Quest UI state.
```

Steps 3–4 are async + fail-safe (the block renders at step 2; structure/awareness land a moment later).

---

## 3. Persistence + re-hydration
- The durable truth is **Echo** (documents row + Vault + git). The engine's in-memory canvas is just the
  live render and is wiped on reboot.
- **Boot re-hydration:** on boot, re-emit only **kept/pinned** docs to the freshly-empty canvas — by
  reading their `doc_id`s (local keep-state) → `get_document`/`materialize_markdown` → emit (idempotent
  tab_key). Un-kept docs stay in Echo (recall-able by call number) but off the board.

---

## 4. Dedup — OURS (verified 2026-06-29: Echo 3.3.1 does NOT dedup)
Round-trip verification against the app's `:8765` engine found `ingest_file` is **NOT** content-idempotent
on this version — it disambiguates by *filename* (appends `-2/-3`) and never computes `sha256` (the column
is null). So a naive re-drop would make duplicate docs. **We add the dedup:** the keep-state row (§2.5)
carries the file's `sha256`; on drop, hash → look up the local `sha256 → doc_id` index → if present, re-open
that doc's tab (deterministic `tab_key = doc-<doc_id>`) and SKIP the ingest; else `ingest_file` and record
the mapping. (Persistence, extraction, and the `doc_id` call-number ARE native to Echo and verified working.)

---

## 5. The Zoe integration (cloud-process + awareness) — determinism-law
- **Cloud / structured processing** at the caged leaf: Echo's extractor produces `markdown_current`;
  `extract_entities_from_doc` lifts entities/relations into the KG; a reasoner pass yields the summary +
  key points + table digest + citations (full structured, the §6 decision). Dans never writes it.
- **Zoe aware**: the doc is in Echo's master DB → her Echo recall finds it natively; the local knowledge
  node gives immediate local recall + a call-number handle. "what's in DOC-7 / the doc Lucas dropped?"
  → grounded answer through the existing poll/recall path.
- **The ingest IS the Echo write.** A USER dragging a doc is explicit consent → ingest directly (no
  separate propose-gate). The read+propose rule still governs ZOE *autonomously* ingesting something she
  found — that path stays propose-gated.

---

## 6. To confirm before building
1. **Project:** dropped docs land in Echo project `_Inbox` (default holding pen, reclassify later) vs a
   dedicated `Canvas`/`Dropped` project. (Lean: `_Inbox`.)
2. **User-drop ingest = direct (drag = consent); Zoe-autonomous ingest = propose-gated.** Confirm.
3. **Keep-state local** (a thin sq.db row: doc_id, tab_key, kept) for the board's pin/layout, content in
   Echo. Confirm (vs storing the kept-flag in Echo frontmatter).

## 7. Slice plan
- **D1 — ingest + dedup + persistence + canvas:** drop handler → `ingest_file` → emit keyed to `doc-<doc_id>`;
  keep-state row; boot re-hydration of kept docs. (Goals 1–3, mostly via Echo.) The engine round-trip
  verifies live; the deterministic bits (tab_key, keep-state) are offline-smokeable.
- **D2 — structured processing + Zoe awareness:** `extract_entities_from_doc` + the summary leaf + the
  local knowledge node; "processing → ready" state.
- **D3 — later:** a documents lane in the Tracks registry so "DOC-7 / the doc about X" resolves like a
  research Track; reclassify out of `_Inbox`.
