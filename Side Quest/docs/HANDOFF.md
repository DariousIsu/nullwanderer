# Handoff — Research/Deliverable Engine → Canvas context

Full handoff (2026-06-29). The directed-research / deliverable engine + the post-reboot fixes are
committed and gate-green; the canvas context now owns continued work on both engine and canvas. This
doc is the single entry point.

## Base
- **Branch:** `feature/idle-passive-intelligence`
- **Commit:** `34b31e1` — "checkpoint — directed-research engine + status/canvas integration + accumulated suites"
- **Gate:** `npm test` → **45 suites green** (offline; `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/run_smokes.js`). `npm run lint` clean on touched files.
- **Working tree:** clean under `Side Quest/`. (Parent-repo `../NX-ALPHA` / `../Dead files` deletions are pre-existing + unrelated; intentionally not in this commit.)
- ⚠ **NEEDS REBOOT:** every engine change below is staged in code but only activates on the next app restart.

## What's committed (engine)
The **overnight directed-research engine** (`main.js` + `lib/focus.js` + new `lib/research.js` + `lib/condense.js`):
- Chat task → **standing focus** (`focus.setFromDirective`, overnight caps) → driven by `runDirectedResearchPass` (in `main.js`): **depth-first** — deepen ONE org across passes (overview → staff → contacts → positions → funding) until saturated / cap / diminishing returns, then a **cloud ORGANIZE pass** (reasoner) writes one clean dossier section. End-of-run **condense** (`condenseRun`, map-reduce) → final dossier + recall node + `research.last_dossier`.
- **Expand** ("go deeper on X") and **mid-run clarification** ("find ≥50, easy contacts") fold into subsequent passes (`research.buildGuidanceBlock`).
- **Status path** (`statusReport` + `_isStatusReq`): "how's it going / what's the list" → frontier reasoner over the real state + **deterministic covered-list** (no model) so it can't confabulate/omit.
- **Fixes this session:** date RAG over-refusal carve-out (`metacognition.DATETIME_SELF_RE`); busy-line spam removed; `num_ctx` pinned 8192 (no Dans runner-reload VRAM thrash); **directive-bracket leak strip** (`_DIRSIG` in the `sayStripped` chain — the 24B was echoing injected `[…]` directives); `open_page` operator tool (use a site fully vs re-search); grounding hardening (no initials/placeholders → "not found", leaked-JSON strip in `research.parsePass`).

Engine internals + decisions are logged in the memory note `cloud-operator-and-integrity.md`.

## Live-run state (as of handoff)
- Active directed focus **#2027**, ~320 ticks, **18 orgs** covered (Heritage, CEI, AEI, Cato, Heartland, Hoover, Manhattan, R Street, Aii, Goldwater, ClearPath, Hudson, Center for Industrial Progress, Claremont, IER, Conservative Energy Network, Fraser, Cicero). Deliverable: `data/zoe_workspace/notes/directed-2027.md`.
- ⚠ #2027 carries a **truncated goal** (created under old code, severed at 240 chars) AND predates the live-status/leak fixes. **Recommended after reboot: stop #2027, re-assign the full task** ("≥50 right-of-center policy/energy/AI/infrastructure think tanks — who runs them, what they work on, easy public contacts"). Clarifications then fold in live.
- First 3 dossier sections (Heritage/CEI/AEI) are pre-reboot mixed-format + one leaked JSON blob; the end-of-run **condense reformats them** on close.

## Open engine-side work the canvas context now owns
1. **Canvas wiring (Slice 2/3)** — `docs/ZOE_CANVAS_INTEGRATION.md` is the spec. Add `canvasEmit` at two seams (`runDirectedResearchPass` per-org block; `condenseRun` final deliverable + count), and the **chat-pointer swap** at the `_isStatusReq`/status + directed-setup seams (replace full-list injection with a short "it's in the Canvas tab" pointer; keep the deterministic covered-list + `_DIRSIG` strip). Build with smokes against the real `saga_canvas_*` API, not blind.
2. **Correction-purge guard** — long-standing green-lit item, never built: when Lucas contradicts a stored fact, supersede it (tombstone-not-delete, conservative matching, strong tests). See `cloud-operator-and-integrity.md`.
3. **Quality follow-ups** (from the deep audit): contact-retrieval reliability (some orgs end "not found" despite public contacts — `open_page` steer should help, verify live); a dedicated **fact-check QA pass** (only a sample was web-verified; Heritage real, Goldwater initials were placeholders).

## Constraints (do not break)
- **Heavy non-public-info tools stay OFF the automatic/autonomous track** (millions of tokens) — public web + her browser + Echo read-only only.
- Outbound **email send OFF** (`ZOE_EMAIL_SEND_ENABLED=1` to re-enable); **image-gen OFF**.
- **Determinism-law:** orchestrator = the Zoe program; generation only at caged cloud leaves (`condenseComplete` reasoner, professional register); **Dans (local 24b) never writes a deliverable/canvas block** — chat pointer only.
- `OLLAMA_API_KEY` lives only in OS keychain / process memory — never shell/.env/logs.

## Test / run
- Gate: `npm test` (or the electron-as-node smoke runner). Add a smoke for any new pure logic; the engine's pure brains (`lib/research.js`, `lib/condense.js`, `lib/operator.js`, `lib/metacognition.js`, `lib/focus.js`) are fully offline-tested.
- Live DB audit (read-only): open `data/sq.db` with `better-sqlite3 {readonly:true}` and read `focus_state` + `focus.<id>.covered/.target/.file/.clarifications` + `research.last_dossier`.
