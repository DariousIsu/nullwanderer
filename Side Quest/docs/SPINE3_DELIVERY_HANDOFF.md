# Spine 3 (Delivery Binding) — Build Handoff for the Next Context

**Written:** 2026-08-10 (late) · **Branch:** `feature/idle-passive-intelligence` · **HEAD at handoff:** `e45085b` · **Gate:** `npm test` → 385/385 green.

**Read first:** [`docs/DELIVERY_BINDING_SPINE.md`](DELIVERY_BINDING_SPINE.md) is the authoritative spec (R-series / A-series definitions, the disease, the principle, the beta bar). This handoff says **what is done, what remains, and exactly how to build + prove the rest** — it does not restate the spec.

---

## 0. The one-paragraph situation

The census reduced the program to **THREE SPINES** of honesty: **1 Discourse** (carried-salience manifest — built), **2 Verification** (the bidirectional gate — built + live-verified), **3 Delivery** (this track). Spine 3's principle: *a promise is a debt — either the turn pays it (falling through every working path) or it is booked as a tracked commitment and said honestly; a reply may never end on a promise that is neither kept nor tracked.* The **beta bar** (acceptance test) is: **Zoe natively pulls a complete, governance-scoped, source-verified, coverage-honest Louisiana parish roster and hands over an OPENABLE spreadsheet — every blank a VERIFIED "not published," never an un-attempted lookup.** Most of Spine 3 is built and proven; **R4** (swarm) and **A1** (fall-through generalization) are the main remaining organs, plus **R2** (finish) and the one **commissioned "fill LA" run** that formally trips the beta bar.

---

## 1. What is DONE (do not rebuild — extend only)

| Item | What it is | Code | Proof |
|------|-----------|------|-------|
| **Spine 1 — Discourse** | carried-salience manifest (discourse-aware gate + reply-fold) | `lib/salience.js` | live-verified ("his contact info" → binds the right person) |
| **Spine 2 — Verification** | bidirectional gate: `groundAbsence`/`groundFacts`/`groundPrediction` + bounded async verify | `lib/metacognition.js`, `lib/verify_claim.js`, `lib/echo_suit.js` (gather stamps), wired at `main.js _antifabCorrect` | `/antifab` + `/verify` port routes; real `search_lane` discriminated fact-vs-confab |
| **A2 — promise→delivery binding** | detect a delivery-PROMISE at the reply seam → kept-this-turn? → else book on recheck queue + say honestly | `lib/delivery.js` (`detectPromise`, `bookingSubject`), `main.js _bookDeliveryPromises` / `_surfaceOpenPromise` | `smoke_delivery` (18); `/promise` port route live |
| **R6 — spreadsheet OUT + openable check** | styled xlsx writer + reopen-verify (delivered ≠ openable) + CSV fallback | `lib/spreadsheet_out.js` (`deliverSpreadsheet`, `writeXlsx`, `openableCheckXlsx`, `toCsv`) | `smoke_spreadsheet_out` (17); real round-trip proven |
| **R1 — local governing-body source tier** | top-down enumeration FRAME from the bundled national Census county gazetteer | `lib/local_frame.js` (`buildFrame`, `resolveState`), `lib/geo/us_counties_2023.tsv` (3,222 counties) | `smoke_local_frame` (24); LA=64, TX=254, DE=3 |
| **R3 — governance scoping** | body-kind taxonomy + default-hypothesis/known-exception labels + **row-office exclusions** (sheriff/clerk/DA…) | `lib/local_frame.js` (`governanceFor`, `ROW_OFFICES_EXCLUDE`, `STATE_GOV`) | in `smoke_local_frame`; carried into the research prompt |
| **Leaf-fill + roster door** | frame → per-locality `local-roster` recheck tasks (R3-scoped prompt) → coverage-honest assembly → R6 delivery → `fireToolFollowup` | `lib/local_roster.js` (`enqueueState`, `coverage`, `assembleDeliverable`), `lib/recheck_queue.js` (`local-roster` kind: `parseLocalRoster`/`buildPrompt`/`applyOutcome`), `main.js buildLocalRosterDeliverable` + roster case in the artifact-router chain (~10392) | `smoke_local_roster` (23); **live-proven this session** |
| **Roster door reaches its door under discover** | the fix that closed the last open thread — see §2 | `main.js` (5 edits, predicate `_rosterOwns`) | commit `e45085b`; live drive below |
| **R5 / R7** | per-row source-grounded render + de-obfuscation (R5); lead-with-the-honest-ceiling (R7) | Spine-2 instruments | wired/done there |

### 1a. The roster-door fix just landed (`e45085b`) — context so you don't re-open it
Intake reads *"build me the Louisiana parish roster as a spreadsheet"* as a **discover assignment**, so the in-turn operator + a standing **generic** focus claimed the turn and it never reached the roster door (reply was a chat *status*, not the file). Fix: one predicate `_rosterOwns` (= `_artifactVerdictEarly.intent === 'roster'`, defined right after `_artifactSessionOwns` ~`main.js:7354`) drives 5 gates so a roster-owned turn stands the generic operator/focus **down** and reaches its door **even under `_discoverAssignment`**. **Only roster** is exempted — `report`/`pullup`/`canvas` stay discover-gated (compose-from-held genuinely preempts a live dossier). The door's own `enqueueState → metabolism` (R3-scoped) is the fill path, so no unscoped pass runs in parallel and pollutes the store. **Live proof:** `[artifact-router] intent=roster` + `[roster-door] LA: assembled 3/64 verified → xlsx (openable) …; queued 64`, no `[operator] directed TASK`, xlsx reopens (64 rows, 3 verified / 61 `(researching)`), 64 tasks due-now, honest 2-message reply.

---

## 2. What REMAINS — the build track

Landing order (from the spec, §4/§81): **A1 → R2 → R4 → the commissioned run.** Each item: build the generic organ, one commit + one smoke, gate stays green, then a live drive.

### ▸ A1 — Fall-through, generalized  *(headline item)*
**Spec (DELIVERY_BINDING_SPINE §3 A1):** the floor pattern *"primary reader fails → try the working alternative → only then report"* lifted out of `excavate` into a small **reusable shape** and applied to the lanes that still lack it — chiefly **video (DOM-captions → `av_transcribe`)**, and any future reader with a known working fallback. Each lane keeps its own instruments; the *pattern* is shared.

**Why it matters:** this is the same disease as the census C4/G6 confabulations and the roster preemption — a reachable answer reported as unreachable because there's no descent to the working path. The web-read floor already landed (`excavate → web_fetch`, commit **`9cbdf83`**) — **that is the pattern to lift**, not re-invent.

**Code anchors:**
- **Lift from:** the `excavate → web_fetch` floor (commit `9cbdf83`; search `main.js`/`lib` for the excavate fall-through).
- **Apply to (targets that follow DOM captions with NO fallback):** `lib/media_cc.js:361` (video captions), `lib/gmeet.js:570` (Google Meet), `lib/teams.js:162` (Teams). The census flagged G3 specifically: DOM-captions fail → never tries `av_transcribe` → **session never terminates** (an unsettled session that leaks into later turns — watch for that too).
- **Reference for how `av_transcribe` is invoked:** `lib/news_lane.js:761` already runs a background `av_transcribe` job for speeches (finds a video URL → transcribe). Reuse that call shape.
- Echo tools available: `av_transcribe`, `av_probe`, `av_download`, `transcription_*` (via ToolSearch / `echoSuit.dispatch`).

**Build shape:** a tiny generic helper (e.g. `lib/fallthrough.js` — `withFallthrough(primary, fallback, {report})` or similar) that runs primary, and on empty/failed result runs the fallback before the lane is allowed to report "couldn't." Then wire the video/meeting caption lanes through it. Keep each lane's own prompt/instruments; share only the descent.

**Prove:** `smoke_fallthrough.js` (pure: a stub primary that fails → asserts the fallback ran → asserts no "couldn't" is reported when the fallback succeeds; fail-open when both fail). Then a **live drive** of a video/caption turn where DOM-captions are empty, watching for the `av_transcribe` descent in the boot log and a settled session (no dangling "let me get that").

---

### ▸ R4 — Swarm roster-mode, un-throttled for a directed completion (C5)  *(headline item)*
**Spec (DELIVERY_BINDING_SPINE table):** *"swarm roster-mode production-grade + un-throttled for a directed completion (C5)."* Today the leaf-fill drains **serially** via the metabolism (`recheck_queue` `local-roster` tasks, cap **12/h** → ~5h for 64 parishes). R4 makes a **directed "fill LA now"** fan the 64 tasks out in **parallel** and run **un-throttled** (a Lucas-commissioned completion opts out of the background research pace-gate; interactive/directed tier, not the 45%-of-pace research tier).

**Do NOT build a new swarm from scratch — extend the existing one:**
- **`swarm on <X>` verb** already exists (research-allocation S5) — `main.js:6314` region: `startSwarm({target, requestedBy})`, `releaseSwarm(...)`, `swarm status`, `_loadSchedState().swarm`. It surges background workers onto **one beat's partitions in parallel** and folds each dossier as it lands. Swarm-quieting is at `main.js:4792` (only swarm threads announce while a swarm is out).
- **Existing roster beats:** `county-commissions-fl`, `county-commissions-ak`, `state-legislature-tx` etc. run as autonomic partition beats (see `sched.autonomic` meta). A stuck `county-commissions-la` partition is called out at `main.js:4800` — study why, it's a real failure mode.
- **Parallel agent primitive:** `spawn_agent_async` (Echo), and the review fan-out pattern `startReviewFanout` / `_reviewFanoutTick` / `lib/review_fanout.js` (shards work across delegates, joins, delivers unprompted). That join-and-deliver shape is the model for a roster swarm's convergence.

**Build shape:** teach `startSwarm` a **roster mode** that targets a state's `local-roster` recheck tasks (the door already enqueues them, R3-scoped) instead of a beat's partitions — fan `min(workers, remaining)` in parallel, each running the existing `recheck_queue.buildPrompt({kind:'local-roster'})` prompt, `applyOutcome` writing to `civic_store` as each converges, and the coverage re-assembling into the same xlsx as fills land. For a **directed** completion, run on the interactive/`directed` spend tier (see the SPEND TIER note ~`main.js:11529`) so it is **not** deferred by the idle/research quota gate. Respect the existing swarm-quieting + release semantics.

**Guardrails (do not regress):** the whole point of R3 is that the fill is **scoped** (sheriff/DA/clerk excluded) — every swarm worker MUST use the `local-roster` prompt, never a generic directed pass (that was the pollution risk closed in `e45085b`). Un-throttling is **only** for an explicit directed completion; background swarms stay pace-gated. Watch quota: `get_quota_summary` / the boot-log `[quota]` lines — a 64-parish live swarm is real compute.

**Prove:** `smoke_local_roster.js` extension or a new `smoke_swarm_roster.js` (pure: N tasks + a mock worker → asserts parallel dispatch, per-task R3 prompt, convergence writes, coverage re-count). Then a **live drive**: `"swarm on the Louisiana parish roster"` (or the commissioned-fill phrasing) → watch `[swarm] roster …` fan-out logs, `civic_store` filling, coverage climbing past 3/64, and the xlsx re-assembling. **This is also what makes the commissioned run practical** (serial 12/h is too slow to demo).

---

### ▸ R2 — completeness + trust gate (finish it)
**Spec:** *"an INDEPENDENT denominator, serve-vs-rebuild decision."* The **denominator** half is done (`buildFrame(state).count` is independent of what research found; `coverage()` measures `filled/denominator`). The remaining half is the **serve-vs-rebuild decision** as an explicit organ: when a roster is asked for and a prior product exists, decide *serve the held artifact* vs *rebuild* (the product-ledger pull-up gate does this for products generally — `lib/product_ledger`, `presentHeldProduct` — check whether roster deliverables route through it or need their own thin decision). Likely small; verify what's already covered before building.

**Prove:** a smoke asserting: held-and-fresh → serve; stale/absent → rebuild; and the denominator is always the frame count, never the found count.

---

### ▸ The commissioned "fill LA" run — the beta acceptance test
Once R4 makes the fill fast, run the real thing end-to-end in **one commissioned turn** and confirm the **beta bar**: a complete, governance-scoped, source-verified, coverage-honest LA parish roster handed over as an OPENABLE spreadsheet, **every blank a VERIFIED "not published," not an un-attempted lookup.** When that holds, all three spines are proven and beta is real. Capture the drive (logs + the xlsx round-trip) as the acceptance record and update the memory pin `program-census-plan.md`.

---

## 3. Operational playbook (learned this session — saves you the rediscovery)

**Gate / running Node against native modules:**
- Full gate: `npm test` (385 suites at handoff). One smoke: `node scripts/smoke_x.js` for pure smokes.
- Anything that loads the DB / `better-sqlite3` must run under **Electron's ABI**, not system node:
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe your_script.js` — and `require()` SQ libs by **absolute path** (the script's cwd differs). System `node` gives `NODE_MODULE_VERSION` mismatch.

**Reboot recipe (per-session grant + LIVE-GUARD required):**
1. Live-guard: `curl -s http://127.0.0.1:8767/status` → require `inFlight:false` AND `lastUserTurnAgoMs > 180000` (>3min). ⚠️ **Check the actual `turns` table for recent `speaker='user'` rows — a live human in the Zoe app resets this and their session owns the pipeline; do not reboot/drive over them.**
2. Find root PID: the `electron.exe` whose `ParentProcessId` is **not** an electron.exe (`Get-CimInstance Win32_Process -Filter "Name='electron.exe'"`). `taskkill /PID <root> /T /F`.
3. Relaunch **visible** (NOT hidden): `Start-Process electron.exe -ArgumentList "." -WorkingDirectory "<SQ>" -RedirectStandardOutput boot.log -RedirectStandardError boot.log.err`.
4. Confirm a **healthy** boot from `boot.log`: `engine failed`=0, 3 `[engine] sidecar … spawned`, echo :8765 serves, `metabolism armed`. (Pre-compact the engine crashed with `[main] engine failed` — always verify.)
5. ⚠️ venv has 2 `python.exe` (Echo engine) — **do not kill them**; only electron.

**Driving live turns through the inside-access port (`127.0.0.1:8767`, `lib/test_port.js`, localhost-only, `ZOE_TEST_PORT=0` disables):**
- `POST /turn {"text":"…","settleMs":22000,"maxMs":130000}` drives the REAL pipeline. Debug routes: `/antifab`, `/verify`, `/promise`, `/local-roster` (each with actions), `GET /status`.
- ⚠️ **An injected `POST /turn` INSERTS a `speaker='user'` row**, so it self-trips the port's own 120s `ACTIVE_WINDOW_MS` guard — **one drive per ~2 minutes.**
- ⚠️ **The Bash tool caps at 120s**, shorter than a `curl -m 150`. When a drive out-runs it, do **NOT** re-drive (that injects a duplicate turn) — read the app's **stdout boot log** for the door/router logs (`[artifact-router]`, `[roster-door]`, `[operator]`, `[one-voice]`), and query the DB (`turns`, `recheck_queue`, `civic_store`) for the results.

**Git (STRICT):**
- Repo root is **Desktop** (SQ is a subfolder; paths show as `Side Quest/…` and sibling dirs `NX-ALPHA/`, `Dead files/` etc. carry unrelated changes). 🚨 **NEVER `git add -A`** — stage **named SQ files only** (`git add "Side Quest/lib/x.js"`; from cwd `git add lib/x.js` resolves correctly). Confirm with `git diff --cached --name-only` before every commit.
- Branch `feature/idle-passive-intelligence` → GitHub `DariousIsu/nullwanderer` (push OK, but only when Lucas asks).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- The parish deliverable artifacts (`Louisiana_Parish_Leadership.*`) are **Lucas's outputs — do not commit them.** `data/` is gitignored (bundled data lives in `lib/geo/`).

**Discipline (inherited, non-negotiable):** fail-open / never a false scold; regex **finds** candidates, **structure** decides; build the generic organ before the specific instrument; each step its own commit + smoke; gate stays green; validate with a **live drive + DB proof**, never assume a non-firing gate is a passing one.

---

## 4. File map (Spine 3)

```
docs/DELIVERY_BINDING_SPINE.md      spec (authority)
docs/BIDIRECTIONAL_VERIFICATION_GATE.md   Spine 2 spec
lib/delivery.js                     A2 promise detector
lib/local_frame.js                  R1 frame + R3 scoping + resolveState
lib/local_roster.js                 leaf-fill: enqueueState / coverage / assembleDeliverable
lib/spreadsheet_out.js              R6 xlsx OUT + openable check + CSV fallback
lib/recheck_queue.js                metabolism worklist; 'local-roster' kind (buildPrompt/parse/applyOutcome)
lib/geo/us_counties_2023.tsv        bundled national denominator (3,222 counties)
lib/verify_claim.js                 Spine 2 bounded verify (reused by delivery honesty)
main.js  ~7354                       _rosterOwns predicate (fix e45085b)
main.js  ~6314                       swarm-on-command verb (R4 foundation)
main.js  ~8555 / ~8613               in-turn operator gate / standing-focus gate
main.js  ~10392                      roster case in the artifact-router chain
lib/media_cc.js:361 / gmeet.js:570 / teams.js:162   A1 targets (caption lanes)
lib/news_lane.js:761                 av_transcribe invocation reference
lib/review_fanout.js                 join-and-deliver fan-out pattern (R4 reference)
scripts/smoke_*                      one smoke per organ (see table §1)
```

**Memory pin to update as you go:** `program-census-plan.md` (the governing plan; its top block is the live state). Absolute-date anything you add.
