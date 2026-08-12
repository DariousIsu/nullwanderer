# Codebase Review — 2026-08-12 (session-arc audit)

**Scope:** completion, accuracy, wiring, function across the full program with focus on the session arc (`a671b8f`→`8698385`, Spines 1–4 + org lane + meeting lane + gate). **Method:** 8 parallel read-only subsystem reviewers → cross-dimension dedup → adversarial verification of every high-severity finding (each verifier instructed to REFUTE; default-refute if unproven). **Outcome:** 60 raw → 55 distinct findings; **6/6 verified highs CONFIRMED, 0 refuted**; 1 high unverified (over cap, trivially checkable); 25 medium; 23 low. ~2M tokens, 400 tool reads, no file modified.

**HEAD at review:** `8698385` · gate 396/396 (see F7: really 395 unique) · app live on boot_p11.

---

## 1. Verdict in one paragraph

The **organs are sound; the diseases live in the wiring.** Every pure-lib subsystem reviewed (router cascade, quota core, canvas emit, Spine-4 chain, org-lane provenance, fallthrough, scribe finalize) matches its contract and its smokes — the stale-assert sweep found **zero** stale assertions in 5 sampled suites. But all six confirmed highs are seam defects: a spend-tier label read from global state, a block-id reused across tabs, a lane that bypasses the scoring door, a promise that never settles, a deps-default pointing at the wrong surface, an optional prefix in a polarity regex. **Zero smokes load main.js** — and the last three live incidents (needsExternal gap, C4 over-firing, dropped leave) were all main.js seam bugs. The gate proves the organs; the diseases have moved to where the gate cannot see.

---

## 2. CONFIRMED HIGH (all adversarially verified)

### H1 — One oversized org page permanently kills the entire subconscious
`lib/monologue.js:2502` (org lane). The 4MB truncation branch in `_fetchOrgPage` destroys the socket without settling its promise; the inactivity timer dies with the socket; no `close` handler, no resolve. `org_walk` bare-awaits it; the tick's `inFlight` latch never releases → **the whole subconscious is dead until app restart**. Verifier **reproduced empirically** against a local >4MB stream (hung forever). *Fix:* resolve with the buffered text on the truncation branch + `r.on('close')` settle + an outer `Promise.race` deadline in `_fetchOrgPageWithFallback`.

### H2 — Background passes self-label 'directed' and escape the pace governor
`main.js:11752` (quota). The autonomous lane default keys on **global** `_userDirectedActive()`, not the identity of the run. The autonomy tick explicitly coexists with a directed focus — so its inquiry/move/dig passes inherit `'directed'` whenever Lucas has a standing focus (which persists for days) and, post-`cf2b5ef`, become **fully pace-exempt**. **This is a major contributor to the 300–516k/hr hot burn — it was NOT all "by design."** *Fix:* autonomous callers default `'research'` (moves: `'idle'`); the directed driver passes `lane:'directed'` derived from the focus it drives.

### H3 — The document SPLIT claims success, does nothing live, and guts the source doc via the mirror
`main.js:5254` (canvas). Split copies reuse **source block_ids**; the session-global `_canvasBlocks` Set (tab-blind) routes every copy to `update_block` on a tab that never had the block → engine silently no-ops (returns `{ok:true}` unconditionally) → **split docs render empty while chat claims success**. The durable mirror's block_id-PK upsert converts copy into **MOVE** — the source doc is gutted. Lucas's "split auto-completed on reboot" = the boot replay materializing the mis-moved mirror rows, not a resume path. *Fix:* mint destination-namespaced block ids (ADD branch fires, mirror copies) + decide source-doc fate explicitly. **Data repair:** inspect doc #3792's block state.

### H4 — forceLeave checks the wrong surface: the c056db7 incident is still unfixed in production
`lib/gmeet.js:472` (meeting). `forceLeave` defaults to Playwright deps and never consults `gmeet_host`, but **every production meeting is canvas-hosted** (`startCanvasMeeting` sets `gmeet_host='canvas'`). On exactly the motivating incident it queries the idle Playwright browser → `not-in-call` → **drops the user-prompted leave again**, with a falsely reassuring log. The smoke injects deps, so the gate can't see it. *Fix:* host-aware deps selection (mirror `monologue.js:960`) + a no-injected-deps canvas smoke.

### H5 — She hangs up when Lucas is the one leaving
`lib/meeting_leave.js:39` (meeting). The second-person prefix in `LEAVE_ORDER` is **optional**, so first-person statements fire 'ordered': *"I have to leave the meeting early"*, *"I need to leave, keep taking notes for me"*, even *"…but you stay."* All three reproduce on trace; the smoke has zero first-person cases. Irreversible action on the most natural real-world phrasing of the lane's core use case. *Fix:* first-person-subject veto ahead of LEAVE_ORDER + "you stay / keep taking notes" as stay cues + smoke phrasings.

### H6 — The meeting lane bypasses the importance door: C2's flagship source contributes zero pressure
`lib/meeting_lane.js:67` (Spine 4). Meeting notes + transcripts land via raw `db.insertDocument` → `importance=null`, no `reflection_importance_accum` bump, invisible to C3's doc window — falsifying the module header and the C2 contract. Same class (lower volume): paste-intake (`main.js:6190`, also no dedup), `web_page` (`lib/web.js`), `scripts/research_org.js`. *Fix:* route through `doc_store.land` (extend for parentId) + sweep the stragglers.

### H7 (unverified — over verify cap, trivially checkable) — The 08-11 live fix's regression suite is not in the gate
`scripts/run_smokes.js` does not register `smoke_meeting_scribe.js`, which carries the regression asserts for the finalize re-entrancy incident (`5c6ba20`). The gate cannot go red if that live-proven fix regresses. *Fix:* one line.

---

## 3. Medium band — the ones that matter most (of 25)

| # | Where | Defect |
|---|---|---|
| M1 | `main.js:8766` | **Operator fires but returns empty → silent fall-through to answer-from-training** (cloud down / leaked-JSON / failed force-final), after an "on it" busy line; metacognition's general-exemption is exactly the net that stands down there. The principle's remaining leak. |
| M2 | `main.js:7523` | Router's control/correction/docqa tier is **dead at the live call site** (flags computed ~500 lines after the route; never passed). Routes still work via flags, but the router log lies and the cascade's top tier is decorative. |
| M3 | `main.js:5491` + `15786` | Boot replay assumes a blank engine board but boots **adopt** surviving engines → duplicate-inflation of every block; plus the pre-replay mint race. Same root as H3 (add-vs-update on a pre-assigned id is NOT harmless). |
| M4 | `main.js:6475` | Commissioned roster swarm claims `'interactive'` (bypasses even the 97% reserve); honest tier is `'directed'`. |
| M5 | `main.js:14750` | `condenseComplete` (~19 sites incl. autonomous research organize/merge/enrich on the 120B) passes **no lane** → defaults 'interactive' → bypasses the quota gate entirely. |
| M6 | `scripts/run_smokes.js:510` | The exit-0 "fourth dialect" fallback is the ONLY thing counting ~23 gated suites green; an assert-free early exit counts as PASS. |
| M7 | `lib/monologue.js:2523` + `2563` | Org lane: ≥400 error body can pass `verifyPage` on domain-echo → lands as the org's official site, org marked done forever; barren attempts retry every 3h forever and can clog the 120-candidate window. |
| M8 | `main.js:6290` / `lib/teams.js:466` | The desync force-leave door exists for Meet only (Teams desync still drops a leave); Teams' drought message promises a transcript no code path delivers + audio capture leaks. |
| M9 | `lib/reflection.js:237` | Empty (non-throwing) model completion zeroes the accum + advances BOTH cursors with no log — silently consumes the doc window. |
| M10 | `lib/importance.js:142` | **C2→C3 economics: structurally unreachable from the doc side** — docs bump (score−5), so a 9-point dossier adds 4 vs threshold 150 with halve-on-trip decay. The thought stream is the load-bearing feeder; with it quota-deferred, C3 is dark outside induced fires (matches the 08-11 measurement). Tuning decision, not a bug fix. |
| M11 | `main.js:15798` | Contract-mint backstop logs `[contract] canvas doc started` without checking the upserts — false for every beat focus. |
| M12 | `main.js:7812` | 625113f side-effect: intake-classify kick still gates on `('task','converse','answer')` — factual turns moved to `'lookup'`, so factual-shaped turns lost the assignment-reclassification kick. |
| M13 | `lib/quota_gate.js:54` | `spentSince` over a 26h ring: a >26h-stale mark silently under-counts spend (re-opens the 07-31 silent-drain class on scrape outage). |
| M14 | `lib/canvas_split.js:44` | Parse arm 3 resolves garbage labels ("split this into two docs **and keep the sources**" → labels `['two','keep the sources']`). |
| M15 | `lib/meeting_scribe.js:274` | Crash mid-finalize leaves `scribe_active='finalizing'` forever (no boot recovery); next meeting inherits stale segments. |

Remaining mediums + 23 lows (incl. docs drift: the build track's PROGRESS block ends at 08-11; `fallthrough.js` header claims meeting-lane wiring that is deliberately absent; `smoke_file_ingest` double-registered → true headline is **395 unique**; 110 of 505 on-disk smokes ungated) are in the full result: `tasks/w4ehktnfa.output` + per-agent transcripts in the workflow dir.

---

## 4. Completion matrix (believed vs verified)

| Track item | Believed | Verified state |
|---|---|---|
| Spine 1 router + DB-foundation (625113f, 8698385) | live-proven | **Sound where aimed**; quota door into reply path confirmed CLOSED (interactive lane never deferred). Residue: M1 empty-operator fallback, M2 dead top tier, M12 lost kick |
| Quota inversion (cf2b5ef) | proven | **Core correct** (directed floor-only verified); tier-LABELING leaks around it: H2, M4, M5 |
| Contract doc + titles (0d1a242..aaacb0a) | live-proven | Healthy core; M3 replay windows, M11 false mint log; 3 mint guards have 3 shapes (low) |
| SPLIT (a8f65f1) | "auto-completed on reboot" | **Built but broken live (H3)** — the auto-completion was the bug's signature |
| C1/C2 importance (3a0a7c9, c845a25) | done | Organ correct; **coverage gap H6** (meeting/paste/web bypass) + **M10 economics** |
| C3 grounded reflection (928ff47, f3d7a71) | live-proven (induced) | Firewall + cursors + RRR intact; M9 empty-completion hazard; dark in practice per M10 |
| C4 persona drive (eeea505, 0b86b58) | live-proven | **Clean end-to-end** — DUE gate in executor, no self_model path, no chat path |
| Org lane P1–P3 (dd50880..7990c4b) | live-proven | Provenance design enforced end-to-end; live-fetch edge: **H1**, M7 |
| Meeting fixes (5c6ba20, c056db7) | smoke-tested | Finalize claim genuinely synchronous; **both live fixes have production holes: H4, H5**; M8, M15 |
| A1 fallthrough | complete, all lanes | Organ healthy; **one consumer (media_cc)**; meeting lanes deliberately not wired (in-code comments) — docs/header stale |
| Gate 396/396 | green | Arithmetically honest, structurally optimistic: 395 unique, ~23 suites green via exit-0 fallback, **zero main.js coverage**, H7 |
| dc41919 revert | total | **Verified total** — zero residue (exemplary self-correction, 77 min) |

---

## 5. FIX ORDER (proposed — nothing applied yet)

Ranked by blast-radius × user-visibility × dependency. Each batch = commits + smokes + gate green; live-gated items marked.

**Batch 1 — outage + spend (small diffs, immediate):**
1. **H1** org-fetch settle + outer deadline (kills the full-autonomy-outage class)
2. **H2** honest autonomous tiers + **M4** swarm `'directed'` + **M5** condenseComplete lane (stops the background pace-exemption; expect measurable burn drop)
3. **H7** register `smoke_meeting_scribe` (one line)

**Batch 2 — the meeting lane (irreversible-action class):**
4. **H5** first-person veto + stay cues + smoke phrasings
5. **H4** host-aware forceLeave deps + canvas no-deps smoke; fold **M8** (Teams desync door; fix the unbacked transcript promise text; stop the audio-capture leak)
6. **M15** boot recovery for `scribe_active='finalizing'` + segment reset

**Batch 3 — split repair + canvas replay (one root cause: pre-assigned-id re-add is not harmless):**
7. **H3** destination-namespaced block ids + explicit source-doc fate + **M14** parse-arm guard; **inspect/repair doc #3792** (was the source gutted?)
8. **M3** replay idempotency (adopted-engine board + pre-replay mint race) + **M11** honest mint log

**Batch 4 — Spine-4 completion:**
9. **H6** meeting_lane → doc_store.land (+ paste-intake, web_page, research_org sweep — one disease, one sweep)
10. **M9** empty-completion guard (don't zero accum / advance cursors on an empty model reply — log + retry next tick)
11. **M10** C2 economics — **decision, not code**: either raise doc bump (drop the −5) or lower the threshold; recommend deciding after H6 lands real meeting pressure

**Batch 5 — principle + gate integrity:**
12. **M1** operator-empty fallback: inject a "couldn't verify, say so" directive instead of silent training answer (the DB-foundation principle's last leak)
13. **M6** run_smokes exit-0 fallback → require a recognized result line; **fix the double registration** (low)
14. **M2** router top tier: pass the control flags (or drop the dead tier + log honestly) + **M12** re-add factual to the intake-kick allowlist
15. **M13** quota ring/mark degradation guard

**Deliberately parked:** the 110 ungated smokes (audit which are stale vs gate-worthy — its own pass); a main.js wiring-smoke harness (the structural cure for "zero smokes load main.js" — significant design work, belongs on the track as its own item); fallthrough meeting-lane wiring (deliberate per in-code comments — fix the stale header/docs only); docs drift (fold into Batch-1 commit).

---

*Full evidence: `C:\Users\azrae\AppData\Local\Temp\claude\...\tasks\w4ehktnfa.output` (158KB) + per-agent transcripts under `subagents/workflows/wf_778a84fb-e74/`. Review was read-only; tree untouched.*
