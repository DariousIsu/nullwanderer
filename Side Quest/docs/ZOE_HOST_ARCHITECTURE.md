# Zoe-as-Host — Echo Integration Redesign (design doc)

> **Status: DESIGN / decision-pending.** Grounded in a read-only study of both Echo repos
> (`NX ECHO/nx-echo` engine + `NX ECHO/ui` Electron/React UI), 2026-06-23. Supersedes the
> "Zoe wears Echo as a suit over HTTP" attach model. Nothing built yet.

## The goal (Lucas)
Zoe is the **host program**. Her **chat stays its own window**. A **new, clean Echo interface
lives under her** — rebuilt to include **only the proven surfaces** (Echo's current UI is
proving-grounds: proven surfaces tangled with incomplete/legacy ones). Zoe's construct is the
driving intelligence. One app, one supervisor — which kills the launch/reboot/two-supervisor
friction that the attach model generated.

## Non-goal (the trap)
**Do NOT rewrite Echo's ~371 Python MCP tools in JS.** That throws away the data+logic moat and
re-earns every solved bug. Echo's Python engine stays as a **child process Zoe owns**.

---

## What the study found (grounded)

### A. The renderer↔engine seam is FOUR channels, not just MCP
Everything is one Starlette app (FastMCP mounts custom routes beside `/mcp`), so the HTTP side is
**one origin** (`127.0.0.1:8765`). But the UI depends on all of:
1. **MCP JSON-RPC** (`/mcp`) — `ui/src/lib/mcp.ts` (hand-rolled streamable-HTTP, read+write token tiers). Drives the data-browsing surfaces. *This is the part the recipe book / suit already rides.*
2. **Plain REST** (`echo/http_routes.py`, ~90 `@mcp.custom_route`s) — `/saga/*` (chat, operator, proposals, calendar, audit), `/skuld/*` (llm, governor, keys, methodology), `/canvas` snapshot, `/tasks` snapshot, `/health`. **Bypasses MCP.**
3. **SSE streams** — `/events` (stats/inbox/reindex), `/events/canvas` (live canvas blocks), `/events/tasks` (background tasks), and `/saga/chat` itself streams `delta/done/error`.
4. **Electron IPC** — `window.nxecho.*` (~30 channels via `preload.cjs`): infra status/restart, file tree + ingest, library/corpus manager, tenants, kiwix info, cite-capture (CDP). **No MCP equivalents.**

**Implication for the host:** a Zoe host must **proxy all HTTP channels (easy — one origin)** *and*
**re-implement the IPC bridge** (the real work — it backs Infra, Maturation, File/Library, Browser-Cite,
Voice, Hub). MCP-only would get the data browsers but not chat, canvas, tasks, or any sidecar panel.

### B. The launch fleet = 10 supervised processes
`ui/electron/main.cjs` (conductor) + `saga-server.cjs` (supervisor). Engine =
`python -m echo.main serve --transport http --host 127.0.0.1 --port 8765` (cwd = nx-echo, health =
`GET /health`). Sidecars: huey-consumer, pass-worker, orchestrator, livekit (7880), voice-agent,
tenant MCPs, kiwix, aria2, portal (8810). Features:
- Exponential-backoff restart supervisor (5/60s window) — `restart_supervisor.cjs`.
- **External-adoption**: probes the port; adopts a healthy external server instead of spawning (this is the staleness trap we hit — it only checks `http_routes.py` mtime).
- Windows tree-kill (`process-tree.cjs`).
- Per-sidecar disable flags `NX_ECHO_DISABLE_*`.

**Portable vs not:** the spawn/track/killTree/health-poll/backoff **core is plain Node — lifts cleanly
into Zoe's main process.** Electron-specific bits (`BrowserWindow`, `contextBridge`/`ipcMain`,
`webContents` CDP cite-capture, `<webview>`, protocol handlers, `process.resourcesPath` for bundled
binaries) need re-authoring.

### C. The Saga seat is genuinely pluggable
- `echo/saga/brain.py::build_saga_agent()` is a **kwargs factory** (model, prompt, base_url, prefer_cloud…), not a singleton.
- `/saga/chat` (`http_routes.py`) is the loop: build agent → `astream_text` → SSE `delta/done`.
- `tool_router.build_saga_chat_app()` shapes the tool surface (~72 visible / ~371 permitted per turn).
- `orchestrator/run.py` is a **separate** autonomous LangGraph supervisor (60s observe→plan→dispatch→await→record) — distinct from the chat brain.

**Three ways Zoe can take the seat:** (1) inject persona via `system_prompt` (cheapest), (2) swap the brain at `astream_text` keeping the SSE contract, or (3) **bypass `/saga/chat` entirely — Zoe owns the conversation in her own window and drives MCP tools directly** (cleanest; matches "Echo = the surface Zoe drives"). Since Zoe keeps her own chat window, **(3) is the natural fit.**

### D. UI: cherry-pick the proven generation
Echo's UI carries **two generations**. Port the newer `components/**/*Surface.tsx` set; **drop** the legacy `src/panels/*` Dockview residue and the acknowledged-placeholder `MissionControl`.
- **PROVEN, MCP-backed (port first):** Library, KnowledgeGraph, Reader, Rolodex (~39k contacts), Legislation (~1.46M bills), Polling, AgentsSurface, TranscriptionStudio, QrStudio.
- **PROVEN but sidecar/IPC-coupled (port later — they gate on the IPC bridge):** Canvas (+15 block renderers — the most complex), Infrastructure, MaturationChamber, Browser (kiwix+CDP), Voice (livekit), Hub (webview+portal:8810).
- **SKIP:** MissionControl (placeholder), legacy `FleetPanel`/`AgentInboxPanel`/`JobsPanel`/`Lamp`/old `Polling*` (superseded by Surfaces).

---

## THE decision that sets the cost: stack for the new Echo UI
**DECIDED 2026-06-23 → React for the Echo sub-UI; Zoe's chat stays its own plain-HTML/JS window.**
**REFINED 2026-06-23 after research (→ Option R′):** research flagged *live re-hosting* of Echo's React UI as RISKY (micro-frontend version-lockstep + upstream-tracking tax; LSP's lesson is "protocol carries DATA, not UI" — the host owns its rendering; no precedent for re-hosting a distinct product's UI subset). **R′ = Zoe owns her own React UI and renders Echo's DATA over the protocol; the proven Echo `*Surface.tsx` components are a STARTING COPY she adopts into her own repo and owns — NOT a live dependency she tracks.** Keeps the ~1:1 head-start, drops the coupling. (See Research Verification below.)

The UI rebuild is the dominant cost, and it hinges entirely on **what stack Zoe's embedded Echo UI uses**:

- **Option R — adopt React for the Echo sub-UI (RECOMMENDED).** Echo's proven surfaces are already
  polished React. If Zoe's Echo-panel UI is React, most Surfaces port **near 1:1** (lift the proven
  components, drop the legacy ones, repoint at the proxied origin). This is what makes Lucas's "a lot
  of the port is 1:1" *true* for the UI too. Zoe's **chat stays its own window in its current
  plain-HTML/JS** — only the embedded Echo surface adopts React. Cost: stand up a React/Vite build for
  one window; reuse Echo's components + Zustand stores + SSE/MCP clients largely verbatim.
- **Option V — rebuild every surface in Zoe's plain HTML/JS.** Stack-consistent with her chat, but it's
  a from-scratch reimplementation of 6+ polished React surfaces + the Canvas block system. The study
  rates this "medium-high to high" per surface — the death-march path. Not recommended.

**Recommendation: Option R.** It's the difference between "move proven components" and "reimplement
them," and it directly honors the 1:1 hope without the trap.

---

## UI Port Manifest — surfaces to keep / rework / build (Lucas, 2026-06-23)
**Two classes of surface (this drives Zoe's self-model + perception):**
- **Operated** — she queries/acts through them (her hands).
- **Ambient/automated** — run themselves on set tasks; Zoe has *awareness + knows the material being worked on*, but does NOT drive the mechanics (Lucas: "no need to burden Zoe with the process; she should just know it's happening and what the material is"). These are background senses, not hands.

**EXACT copy (do not rework):**
- **QR Studio** — live QR codes in production for events; port verbatim (qr_* tools + qr_slug/qr_scan). Risk if reworked = breaking active codes.

**Keep + rework:**
- **Knowledge Graph** [operated] — port; heavy graphical cleanup + a better/fresher update method (current render is stale vs. work done).
- **Legislation** [operated] — port; UI overhaul.
- **CRM** (Echo's "Rolodex") [operated] — port; UI overhaul.
- **Polling** [operated] — keep; clean + expand + better integrate.
- **Files & Reader** [operated + ambient state] — consolidate Echo's **Library + Reader + downloads/corpus state** into ONE surface; clean, streamline, proper Zoe access. ("Library swept into the file-reading rework.")
- **Transcript Studio** [operated; fed by her meeting engine] — must keep; **integrate Zoe's gmeet caption capture → into transcription studio** (don't forget this wire).

**Keep + merge:**
- **Hub Studio + QR Studio** → likely one combined "studio" for simplicity (QR content stays exact).
- **Maturation Chamber + Infrastructure** [ambient] → paired ops/fleet surface.
- **Civic Coverage** → tuck into **Map or CRM, whichever fits cleanest** (decide at build), clean up heavily.
- **Map** [operated] → keep, good as-is. It's a real, standalone panel (not a canvas block).

**New build:**
- **Editor's tab** [AMBIENT/automated] — born from citation-verify + fact-check tools (`delegate_to_citation_verifier`/`fact_checker`/`rainey_*`/`rainey_compile_verification_report`). EXTEND to: (a) **DB comparison** — draft claims vs our KG/records; (b) **org continuity** — prior org writing on the same topic (search vault/deliverables) → consistency check; (c) **mechanics** — grammar/spelling + AI-leak / voice-leak checks (Echo already voice-leak-validates renders). Pattern: a **deterministic editorial-QA pipeline over a piece of writing**; Zoe is *aware* (knows "the op-ed on X is in QA" + what it is) but doesn't run each check. Needs development.

**Givens (confirmed keep — Lucas's explicit list was the non-obvious decisions; the "it's a given" baseline features carry by default):**
- **Canvas** [operated + bidirectional] — the shared deliverable surface where Editor's-tab output + her renders land (the "shared table").
- **Agents** [operated] — her delegation workforce (fleet / inbox / schedule); how heavy work leaves the 24B's plate.
- Plus other baseline features not separately enumerated (chat is already its own window; status/health, proposals/approvals, calendar, etc. ride along as givens unless flagged for cut).

**Manifest status: COMPLETE.** Surface audit at build time will (a) confirm each component's files, (b) place Civic Coverage (Map vs CRM), (c) enumerate any remaining givens.

## Proposed architecture (Option R′ — THREE-WINDOW model)
Three windows = three **relationship modes** (hers / ours / his) — the interaction taxonomy made physical:
```
Zoe Lane (Electron host)
├─ Window 1 · ZOE (chat) ....... HERS — voice + monologue, plain-HTML/JS; the construct = the operator
├─ Window 2 · CANVAS (shared) .. OURS — co-authoring (Gemini-style) + deliverables; BOTH write here
├─ Window 3 · MY WORKSPACE ..... HIS — operator surfaces: data browsers (CRM/KG/Polling/Legislation/Map/Files)
│                                 + studios (Editor/QR/Hub/Transcription) + ops (Infra/Maturation/Agents); Zoe AWARE-ONLY
├─ Host supervisor ............. lifts Echo's spawn/track/killTree/backoff core → owns the Python fleet
│    └─ child: python -m echo.main serve (8765) + sidecars (huey/worker/orch/livekit/voice/portal/kiwix/aria2)
├─ Channel layer ............... proxy MCP + REST(/saga,/skuld,/canvas,/tasks) + SSE(/events*); internal bridge = contextBridge IPC
└─ Zoe drives MCP directly + co-authors on Canvas; queries the DATA behind My-Workspace surfaces (doesn't "use" them)
```
**Zoe across the three:** she IS window 1; she CO-AUTHORS in window 2; she is AWARE-OF + QUERIES-THE-DATA-BEHIND window 3. This collapses the old "Zoe-operated surfaces" class cleanly — she never operates surfaces in a window; she queries MCP and **renders results onto the shared Canvas**, where she and Lucas meet. Studios stay operator-only.
Implementation: 3 BrowserWindows (research-blessed multi-window); Zoe-chat can sit slim/persistent on a side monitor. *(Open: 3 OS windows vs. 3 dockable zones in one shell — lean 3 windows for multi-monitor.)*

## Staging (each step de-risks the next)
1. **Lifecycle absorption first.** Zoe's host spawns + supervises the Python engine (+sidecars) as
   children. **This alone kills the launch/reboot/two-supervisor pain and proves the host model** —
   smallest viable step, immediate payoff. (Echo's own Electron app retires once this works.)
2. **Channel layer.** Proxy the HTTP origin (MCP+REST+SSE) + stand up the IPC bridge replacement.
3. **Embedded Echo UI, surface-by-surface (proven only).** Start with the pure-MCP/REST Surfaces
   (Library, Rolodex, Legislation, Polling, KG, Reader, Agents), then the SSE/IPC-coupled ones
   (Canvas, Infra, Browser, Voice, Hub) once the bridge is in.
4. **Saga seat = Zoe's construct.** She already drives MCP (recipes) and owns chat; formalize her as
   the operator; decide orchestrator (keep Echo's autonomous loop, or fold into her subconscious tick).

## What transfers 1:1 (keep)
Python engine + ~371 MCP tools + all SQLite DBs; `lib/mcp.ts` MCP client; the SSE clients
(`useSSE`/`useCanvasStream`/`useTaskStream`) + `saga-client`; the recipe book (the validated
navigation layer — proven this session); the supervisor core (plain Node).

## Native Document Model & Creator (program-wide primitive — "C", 2026-06-23)
A **structured document substrate + creator**, shared across the program (not one surface). Documents become **first-class objects**, not file blobs. Decided program-wide: **read + write all primary types** (.docx/.pdf/.md/.txt). This underpins the Editor studio, general authoring, Canvas/deliverable renders, and any tracked-artifact tool — and it's what lets **Zoe follow a document's construction as structured deltas instead of being fed the raw file**.

**The object model (DB-backed):**
- `document(id, title, author_id [IMMUTABLE], project, doc_type, status, created_at, …)` — author fixed for life; document↔author tied for deep tracking.
- `iteration(doc_id, version, change_author, source[native|upload], change_summary, content_ref, ts)` — the version chain + change log (Lucas's edits and others' uploads both spawn iterations; author never changes).
- **structured content** = sections/blocks (headings, paras, footnotes, citations) — so it's perceivable, diffable, and exportable.

**Fidelity strategy (the key engineering fork — recommend HYBRID):**
- **Natively-created docs → full structured model** (compose in-app section/block; Zoe follows construction completely).
- **Imported docs (.docx/.pdf) → keep the ORIGINAL file canonical + a parsed structured *view*** for Zoe + the checks. Edits export new versions, but the original is preserved (lossless). Rationale: lossless round-trip of .docx footnotes/styles is genuinely hard (the cert corpus is footnote-heavy .docx) — don't risk mangling a submission; overlay structure onto the canonical file.
- Format I/O layer: import/export .docx/.pdf/.md/.txt ↔ model (docx + pdf round-trip is the real work; md/txt trivial).

**Zoe-follows-along:** because a document is a structured object with versioned deltas, she perceives "section 3 added / intro revised / citation FN7 added" as **structured events + current outline** — proprioception applied to documents, no raw-file ingestion. She can follow ANY document's course (incl. her own byline drafts) this way.

**Consumers:** Editor studio (the doc under QA), Canvas (renders document/deliverable objects), saga/vault render tools (produce document objects), general authoring.

**Editor architecture (DECIDED):** a **WYSIWYG word-processor / spreadsheet feel ON TOP of a structured block/grid model underneath** — the standard modern-editor pattern (ProseMirror/Tiptap/Lexical for prose; a grid/cell model for sheets). One substrate, two faces: the human rich view and Zoe's structured/diffable view are the SAME document, rendered for different eyes (the pixels-vs-data asymmetry resolved at the document level). Leverages Echo's existing Canvas block model (~15 block types) — a rich-text block rides that substrate. *(Spreadsheet editing = grid + formulas is a heavier, separable add vs. prose; confirm prose-first vs. both-now.)*

**Interaction mode is by SURFACE, not global (DECIDED):**
- **Studios (Editor, etc.) — Zoe does NOT write.** Operator-only; she's aware-only. The controlled workbench.
- **Canvas / doc work beyond the studios — collaborative co-authoring, Gemini-style.** She helps word things, drafts, suggests edits; Lucas + Zoe work the document live. This is the shared table — and where Zoe's own byline writing lives.

Same document model under both; only the interaction mode changes. **Fidelity hybrid: BLESSED** (native = full structured model; imported = canonical file + structured overlay).

## Document stack — chosen libraries (research 2026-06-23, license-cleared, cited)
All MIT/Apache/BSD — **no GPL/AGPL/SSPL/commercial in the critical path** (Lucas's hard filter).
| Layer | Pick | License |
|---|---|---|
| Rich-text editor | **Tiptap** (on ProseMirror) — JSON node tree via `getJSON()`; footnotes/citations as first-class nodes; Yjs collab | MIT |
| Doc diff / AI suggestions | **prosemirror-changeset + Decorations** wired to OUR model (build, not Tiptap Pro) | MIT |
| Spreadsheet | **Jspreadsheet CE v4** (built-in formula engine) default; **Univer** (Apache) if full Excel needed | MIT / Apache-2.0 |
| .docx read | **mammoth** (→ structured view; lossy by design) | BSD-2 |
| .docx write | **docx** (dolanmiu, v9.7.1) — `FootnoteReferenceRun` first-class | MIT |
| .pdf read | **pdfjs-dist** (layout-aware extraction) | Apache-2.0 |
| .pdf generate | **Electron `webContents.printToPDF`** (built-in; same Chromium as Puppeteer, no extra dep) | built-in |
| Collab backend | **Yjs + Hocuspocus** | MIT |

**Research VALIDATED our design choices:**
- **Hybrid fidelity is the research-recommended docx approach** — there is NO lossless read→edit→write in pure Node; the recommendation is exactly "keep original canonical + structured overlay." Our blessed hybrid is correct.
- **"Rich feel over block model" = Tiptap/ProseMirror JSON tree** — and `prosemirror-changeset` distills edits into added/deleted spans → **this IS how Zoe perceives doc deltas** (her structured view; the AI-suggestion layer is the same primitive).
- **Cert HTML→PDF needs no new dep** — `printToPDF` (built-in) matches Puppeteer fidelity; the existing cert pipeline maps straight onto it.

**Two picks to confirm (clear recommendations):** (a) spreadsheet = **Jspreadsheet CE (MIT)** to start, Univer later if outgrown — **avoid Handsontable** (commercial-only) + AG-Grid-Community has no formulas; (b) AI co-author layer = **build on MIT ProseMirror changeset wired to our own model**, NOT Tiptap Pro AI ($149+/mo, private registry) — fits local-first + license-clean.

**Top risks:** (1) spreadsheet-lib licensing (don't default into Handsontable/Univer-Pro); (2) docx round-trip fidelity (mitigated by the hybrid); (3) AI-suggestion layer = build (MIT, more eng) vs buy (Tiptap Pro, recurring cost) — recommend build.

## Research verification (2026-06-23, cited)
Adversarial multi-source pass on the load-bearing assumptions. Verdicts:
- **Host supervises Python fleet — SOUND** (VS Code/LSP precedent). Caveat: Windows has no graceful kill + `child.kill()` doesn't kill the tree + PyInstaller `--onefile` spawns 2 procs → MUST use `taskkill /T /F` tree-kill held in `will-quit` (Echo's `process-tree.cjs` already does this). Highest-probability operational failure if naive.
- **Multi-stack BrowserWindows — SOUND-WITH-CAVEATS.** Vite `base:'./'` for `file://`; main is sole cross-window state authority; per-window preload + contextBridge.
- **MCP Streamable HTTP + SSE — SOUND-WITH-CAVEATS.** Streamable HTTP is the current transport (HTTP+SSE deprecated 2025-03-26). Only risk: our Node layer buffering/compressing the stream — exclude SSE routes from compression, never set Content-Length, pass through Last-Event-ID/MCP-Session-Id.
- **Embed backend as child — SOUND; re-host its UI subset — RISKY** (→ drove Option R′). LSP works because protocol carries data not UI; re-hosting a distinct product's UI = version lockstep + upstream tax; no precedent found.
- **Internal bridge as localhost REST — CONTRADICTED** (→ use contextBridge IPC). DNS-rebinding + CSRF + Zoom CVE-2019-13450.
- **24B operator via recipes — SOUND-WITH-CAVEATS.** Validated by Voyager (skill library, no fine-tune). MANDATORY: retrieval-gate tools to ≤~30/step (RAG-MCP: 13.6% all-in-context vs 43% retrieved). Unmitigated risk: multi-turn collapse (even GPT-4o <50% on τ-bench) → deterministic recipes + validators + retry loops; minimize free-form planning. (Voyager ran on GPT-4 — mechanism transfers, headroom doesn't.)

**Top risks to engineer against:** (1) Windows process-tree teardown; (2) keep internal bridge on IPC not REST; (3) UI coupling → own the rendering (R′); (4) 24B multi-turn drift → lean on deterministic recipes + retrieval-gating; (5) SSE-through-Node buffering.
*Thin-evidence flags:* no source tested a literal 24B Ollama as a persistent 500-tool operator (extrapolated from 7B–70B + GPT-4 Voyager); some tool-count-degradation figures are 2026 preprint-grade.

## Open items
- **⭐ MEMORY UNIFICATION (don't forget — load-bearing design topic).** Work out how Zoe's memory (sq.db: monologue/reflections/knowledge/episodic) interacts with Echo's knowledge stores (civic_graph, the knowledge graph, the Rainey vault, knowledge nodes). **Principle (Lucas): all research Zoe does should grow the TOTAL knowledge base, and she should treat the total KB as HER knowledge** — one shared memory, not a silo + an external DB she queries. Implications to resolve: where new research lands (Echo KG/vault vs sq.db), how her episodic/reflective layer composes with Echo's grounded KG, dedup/provenance, and her retrieval reading across both as one. Ties to the earlier "Zoe becomes Saga / saga.db" thread + the grounding work in [[project-zoe-memory-grounding]].
- **Port confirmed: 8765.** (saga-server.cjs's `8766` is only a config-missing fallback; the live stack
  + UI prod default + everything we hit this session is `:8765`.)
- Does Zoe adopt React only for the Echo window, or eventually unify her chat into React too? (Start: Echo-window-only.)
- Orchestrator: keep Echo's autonomous LangGraph loop, or replace with Zoe's subconscious tick? (Defer; it's standalone.)
- IPC bridge surface: **DECIDED → contextBridge IPC, NOT localhost REST.** Research contradicted REST for an internal control plane (DNS-rebinding + CSRF + the Zoom CVE-2019-13450 precedent: a desktop app's localhost server was reachable by any website). Consuming Echo's OWN :8765 surface stays HTTP (with Host allow-list + admin token) — that's separate from Zoe's internal ~30-channel bridge, which goes over IPC.
