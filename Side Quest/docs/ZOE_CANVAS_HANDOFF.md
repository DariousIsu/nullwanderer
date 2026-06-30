# Zoe ↔ Canvas — Integration Handoff

For the Zoe-versed context. **The Canvas surface is built; the remaining work is wiring _Zoe's
production_ onto it.** This doc is the single entry point: what the canvas is, the seams to drive it,
the hard rules, and exactly what's left to integrate.

---

## 0. TL;DR / the ask

Zoe's Canvas is Side Quest's **third window** — a full-window, pannable/zoomable freeform whiteboard
where each whole **document** (= one Echo "saga" canvas tab, its blocks rendered as a formatted page)
is a movable/resizable/closable object. It renders Echo's **live in-memory canvas** over HTTP, and a
thin orchestrator seam (`canvasEmit`) already pushes the directed-research deliverable onto it.

**Your job:** route the REST of Zoe's outputs (deliverables, visual aids, dossiers, anything worth
showing) onto the canvas through that seam in the right block types, and do the **chat-pointer swap**
so her chat *points to* the canvas instead of reciting big content. Keep the determinism law intact.

---

## 1. Where it lives (3-window model)

1. **Zoe chat** — `renderer/index.html` + `chat.js` (companion). Has a `◫ canvas` launch button.
2. **My Workspace** — `renderer/workspace.html` (operator-only studios; NOT Zoe).
3. **Zoe's Canvas** — `renderer/canvas.html` + `canvas.js` (NEW). Its own `BrowserWindow`
   (`createCanvasWindow()` in `main.js`), **auto-spawns at launch**, opened via `canvas:open` /
   `sq.openCanvas()`.

---

## 2. THE CRITICAL FACT — where the canvas state lives (read this first)

Verified by reading `echo/saga/canvas_publisher.py` + `echo/http_routes.py`:

- The canvas is an **in-memory store in the engine** (`_TABS` / `_BLOCKS`) + a websocket fan-out on
  `TOPIC_CANVAS`. The engine serves it over **HTTP custom routes**:
  - `GET /canvas` → full snapshot `{tabs:[{tab_key,mode,title,opened_at}], blocks_by_tab:{tab_key:[{block_id,type,data,created_at}]}, locks_by_tab}` (bearer-auth)
  - `GET /events/canvas` → SSE stream (TabOpen/TabClose/BlockAdd/BlockUpdate/…)
- **`tenant_rainey.canvas_blocks` (SQLite) is ONLY written by TENANT processes** — Saga's MAIN
  engine (what this app runs) keeps the canvas in memory and does NOT persist it. So **`db_query` on
  `canvas_blocks` does NOT see the live canvas.** The renderer reads `GET http://127.0.0.1:8765/canvas`
  (base+token captured at boot as `echoHttp` in `main.js`, from `config.toml` `admin_token`).
- Two engines can be live at once (a standalone MCP engine vs the app's spawned engine on `:8765`).
  **The app's engine on `:8765` is authoritative for the canvas** — write AND read it there. (A block
  written to a *different* engine will never show in the app.)

## 3. THE OTHER CRITICAL FACT — valid block types only

`saga_canvas_add_block` validates `block_type` against a fixed `Literal` (in `canvas_publisher.py`).
**Anything else is rejected: `"invalid block_type: <x>"`** — and the tab opens with no block (the
"No content yet" trap we hit). Valid set:

```
heading · paragraph · list · code · table · chart · metric_card · callout · image ·
diagram · knowledge_graph · document_file · browser_snapshot · map · three ·
draft_review · citation · source_card
```

- There is **no `pdf` and no `html`** type. Embedded **PDF** and **rich HTML** (docx) both ride on
  **`document_file`** — `data:{src}` (a `file://` URL → Chromium PDF viewer) OR `data:{html}` (rich
  HTML → sanitized + rendered). This is already how the drop pipeline + renderer handle them.
- block `data` schemas: `heading{level,text}` · `paragraph{markdown}` · `table{headers[],rows[][],caption?}` ·
  `chart{kind,series[],x_key,y_keys[],title?}` · `image{src,alt}` (we use a data URI) ·
  `document_file{src|html, alt?}`.

---

## 4. What the canvas RENDERS today

`studio/canvas_view.js` (pure mapper; `RENDERABLE` set) + `renderer/canvas.js` `blockContent()`:

| Block | Render |
|---|---|
| heading / paragraph | formatted (paragraph = small safe markdown subset) |
| table | HTML table |
| chart | data-table (no charting lib yet — Slice 4) |
| image | `<img>` from data URI |
| document_file (src) | embedded PDF (`<iframe src=file://…>`) |
| document_file (html) | sanitized rich HTML (docx) |
| everything else (diagram/knowledge_graph/map/three/…) | labelled fallback card |

---

## 5. The DRIVE seam (how content gets onto the canvas) — ALREADY WIRED

`main.js`:
```
async function canvasEmit({ focusId, title, tabMode, blockType, data })
```
- Opens a tab (deterministic key `directed-<focusId>` via `studio/canvas_emit.tabKeyForFocus`, idempotent
  re-open) then `saga_canvas_add_block`, both through the **Echo suit** (`echoSuit` → the app's engine).
- **Fully fail-safe**: a canvas error never breaks the loop. The deliverable FILES remain the durable
  artifact; the canvas is the live render.
- Pure payload builders in `studio/canvas_emit.js` (`orgSectionBlock`, `dossierBlock`, `countHeading`,
  `mode`, `tabKeyForFocus`, `tabTitleForGoal`).

**Already emitting:** the overnight directed-research engine —
- `runDirectedResearchPass()` (main.js ~4274) → one RESEARCH paragraph block per organization as it
  saturates (live "show her work"). The section is written by the **cloud reasoner**
  (`condenseComplete(buildOrganizeTargetPrompt)`).
- `condenseRun()` (main.js ~4092) → on wrap, `lib/assemble` does a **lossless deterministic stitch**
  of every `## <org>` section from the run file; the reasoner writes ONLY a summary+gaps wrapper
  (`buildWrapperPrompt`) — so the model can't drop/round orgs. Then `canvasEmit` → count heading +
  full dossier (DOC tab).

Live-verified: a real org section (Alignment Research Center) rendered on the canvas as the run produced it.

**Chat already POINTS at the canvas (the swap is BUILT, not pending).** A deterministic interface-poll
router routes deliverable queries (main.js ~2620–2683):
- `lib/track` — the research deliverable as a queryable index+document (exact count/list/facet/sample/status; kills confab/rounding).
- `lib/poll` — picks which registered source answers (prefers deterministic/grounded).
- `lib/canvas_route.routeDeliverable()` — decides **canvas** (chat = short pointer, no recitation) /
  **ask** ("Canvas or here?") / **chat** (short answers stay). Dans voices only the pointer/short answer.
- "wrap up / finalize" (main.js ~2559) → background `condenseRun` (→canvas) + a grounded-count pointer.
- `lib/activity` — "what are you doing right now" answered from the live lane snapshot.

---

## 6. THE DETERMINISM LAW (do not break)

- **Caged cloud leaves generate canvas content** (the organize/condense reasoner — professional
  register). **Dans (local 24B) NEVER writes a canvas block** — chat pointer only.
- The orchestrator (the Zoe program / deterministic control flow) decides WHEN to emit; generation
  happens only at the caged leaves; deterministic transforms (the `canvas_emit` / `canvas_view` /
  `sheet_view` builders) are pure + unit-tested.
- Heavy non-public tools stay OFF the automatic track. Outbound email + image-gen stay OFF.

---

## 7. WHAT'S LEFT TO INTEGRATE (your work)

The directed-research pathway is fully tied in (production → canvas; chat → pointer). The remaining
work is **widening** that to the rest of Zoe's production and adding the renderers for richer blocks.

1. **Route Zoe's OTHER outputs → canvas.** Today ONLY directed-research emits (`canvasEmit` keyed by
   `focusId`). Other production currently lands in files / KB / chat, not the canvas:
   - `saga_render_*` deliverables (executive_briefing / op_ed / quick_hit / verification / citation_pack /
     draft_review) — emit as `document_file` (rich) or `draft_review`/typed blocks.
   - autonomous byline posts (`lib/byline` → `notes/byline_*.md`); high-value operator results /
     subconscious syntheses worth showing.
   - **Generalize `canvasEmit`'s tab key**: it's currently `directed-<focusId>`. Non-focus deliverables
     need their own deterministic key scheme (e.g. `deliverable-<id>`) so re-emits update, not duplicate.
2. **Visual-aid blocks + renderers (Slice 4).** The flagship is the "interconnectedness via shared
   personnel" `knowledge_graph` (orgs+people nodes, shared-staff edges) the integration spec calls for.
   These are valid engine block types but the Side-Quest renderer FALLS BACK for them today — build real
   renderers in `studio/canvas_view.js` + `renderer/canvas.js` for `chart` (force-graph is already a
   dep; or SVG), `knowledge_graph`, `diagram`, `map`. The orchestrator decides "make a KG now"; a caged
   cloud leaf produces the node/edge JSON (determinism law).
3. **Live updates (polish).** Renderer currently polls (`Refresh`/retry). Subscribe to
   `GET /events/canvas` (SSE) so blocks appear in real time as Zoe emits.
4. **Her-controlled spatial placement (deferred — engine change).** Side Quest auto-places + the operator
   drags (persisted locally). For Zoe to *choose* coordinates, `canvas_publisher` blocks would need
   x/y/w/h — a cross-repo NX-ECHO change.

DONE (do not rebuild): the chat-pointer swap (`lib/canvas_route` + `lib/poll` + `lib/track`), the
wrap-up→condense→canvas flow, the lossless-stitch dossier (`lib/assemble`), and grounded status answers.

---

## 8. Side-Quest-owned pieces you'll touch / can rely on

- **Layout store** — `lib/canvas_layout.js` (`data/canvas_layout.db`): per-document `x,y,w,h,hidden,minimized`,
  keyed by `doc_key` (= tab_key). Pure placement math in `studio/canvas_layout.js` (`autoPlace`). This is
  operator UI state; never sent anywhere. You generally won't touch it — it's the spatial layer.
- **Drop ingest** — `main.js` `canvas:drop-doc` reuses `lib/doc_extract` (docx→mammoth HTML, pdf→`file://`
  embed, md/txt direct) + `studio/sheet_view` (csv/tsv/xlsx→`table`) + `exceljs`. Images → data-URI `image`.
- **IPC surface** (`preload.js` → `window.sq.canvas.*`): `getAll`, `listTabs`, `getTab`, `setDocPos`,
  `updateDoc`, `resetLayout`, `dropDoc`; `sq.openCanvas`; `sq.pathForFile` (Electron `webUtils`). Read path
  helper in `main.js` = `canvasSnapshot()` (GET /canvas) + `canvas:get-all` maps to view shapes.

---

## 9. How to verify (the pattern that actually proves it)

- The canvas is the **app engine's** in-memory store. To prove a write/render round-trip WITHOUT an OS
  drag: use the MCP client against `:8765` to `saga_canvas_open_tab` + `saga_canvas_add_block`, then
  `GET :8765/canvas` and confirm the block is in `blocks_by_tab`. (See the engine-B probe pattern used
  during the build — `lib/echo.fromEnv({url:'http://127.0.0.1:8765/mcp/', token})`, token from
  `config.toml admin_token`.)
- **Always confirm the block actually lands in the snapshot** — an invalid `block_type` returns ok=false
  and leaves an empty tab. (This bit us; don't trust "I added it," verify the snapshot.)
- Offline pure smokes (run with `node` or `ELECTRON_RUN_AS_NODE=1 electron`): `smoke_canvas_view`,
  `smoke_canvas_emit`, `smoke_canvas_layout`, `smoke_canvas_layout_db`, `smoke_sheet_view`. These are
  the studio-surface family — they are NOT in `scripts/run_smokes.js` (that's the engine/memory gate);
  run them standalone.
- Judge Zoe's live state by `electron` process count + port `8765` listening — **NOT** the `npm start`
  exit code (the wrapper detaches and reports 255 even when the app is fine).

---

## 10. Commit / working-tree state (as of handoff)

- Committed (swept into the concurrent session's history; HEAD around `60ff86a`): the **engine-side
  wiring** — `main.js` (`canvasEmit`, the two research seams, `canvasSnapshot`/`echoHttp`, `canvas:*`
  IPC incl. `drop-doc`/`get-all`/`update-doc`, `createCanvasWindow` + auto-spawn), `studio/canvas_emit.js`,
  `renderer/index.html` + `chat.js` (launch button). Slice 0/1 in `f5568b3` / `c7a9cf6`.
- **Uncommitted on disk** (the freeform UI rework — verify with `git status`): `renderer/canvas.{html,js}`
  (full freeform board), `preload.js`, `studio/canvas_view.js` (image/pdf/html/document_file),
  `studio/canvas_layout.js`, `studio/sheet_view.js`, `lib/canvas_layout.js`, the new smokes,
  `package.json` (+`exceljs`). All pure logic green; eslint 0 errors. Lucas was mid-eyeball of
  drag-drop rich rendering (PDF embed + docx HTML via `document_file`) when this handoff was cut.

## 11. Don't-break checklist

- Read the live canvas via `GET :8765/canvas` (NOT `db_query` on `canvas_blocks`).
- Only emit **valid engine `block_type`s** (§3); PDF/rich-HTML → `document_file`.
- Determinism law (§6): caged leaves generate; Dans never writes a block.
- Deterministic tab keys per logical doc (idempotent re-open) so emits update, not duplicate.
- The deliverable FILES stay the durable artifact; canvas is the live render. Layout is local-only.
