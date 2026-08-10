# Program Census — Phase 2 Results (started 2026-08-08)

Grading law: every scenario is driven through the inside access port (127.0.0.1:8767, the REAL
runChatTurn pipeline) and graded on the USER SURFACE ONLY — the reply text as Lucas would read it,
plus the artifact read back directly from its destination (canvas mirror db, notes files, DB rows).
Log lines are used to identify MECHANISMS of failure, never as evidence of success.

Verdicts: **WORKS** (surface evidence attached) / **BROKEN** (mechanism named) /
**UNREACHABLE** (no door for a natural order) / **NEEDS-LIVE-CONTEXT** / **DEFERRED-QUOTA**
(untestable until the 08-09 pool reset — directed lanes stop at 97%, pool was at 98% during runs).

The capability inventory (45 rows, groups A–H) is the companion file: `capability_census.md`
(session scratchpad copy; canonical inventory to be committed alongside as INVENTORY.md).

---

## Boot-chain finding (pre-scenario, fresh44 → fresh45)

**FINDING — silent canvas-replay skip when the engine is late at boot.** fresh44's engine spawn
"never became healthy" (boot_fresh44.log:71), so the `.then(attached => ...)` chain at main.js:1386-1390
returned early and `replayCanvasFromStore()` never ran — and it only runs ONCE, at boot. Echo
recovered minutes later, but the whole fresh44 session ran with an unreplayed canvas: the durable
mirror held the complete parish deliverable, the live surface never showed it. Both failure paths
are silent (`if (!attached) return;` and an empty `catch {}`). Cure for the fix list: replay must
re-fire when the engine becomes healthy after a failed boot attach (or on every successful attach,
idempotently), and a replay skip must LOG.
Verification of the cure-by-reboot: fresh45 printed `[canvas] replayed 60 document(s) / 298 block(s)`,
zero per-tab failures, and the parish tab was read back from the mirror: 5 blocks, 69,657 chars,
title "Louisiana Parishes — Government & Leadership".

---

## Scenario runs

### B4 — product pull-up ("Pull up that Louisiana parish leadership list we made")
**Verdict: BROKEN (mechanism works, ranking + voice defects).** Run 2026-08-08 ~15:0x ET, tookMs 72,540.
- What worked: artifact-router hit `intent=pullup`; product_ledger retrieved a real held product and
  RE-PRESENTED it (no regeneration, no research spin-up); canvas write landed durably
  (`promise-pullup-report-parish-leadership-of-louisiana`, 12,128 bytes); reply carried honest
  provenance ("saved at 9:01 AM ET") and offered alternates.
- Defect 1 — WRONG PRODUCT: it pulled the stale 9:01 AM gap-analysis report ("only about a third
  have elected leadership"), not the complete 64-parish deliverable made at 1:57 PM
  (notes/louisiana-parishes-leadership.md, 813 officials). Mechanism: lib/product_ledger.searchProducts
  scores title/body token hits with time decay; the stale report matches the same tokens, also exists
  as a doc_store row, and its head contains "list". There is NO supersession concept — a finished
  product cannot outrank its own earlier draft. (Work-contract spine feature: artifact registry with
  supersession/done-state.)
- Defect 2 — TWO VOICES: the reply opened with a contacts-route non-sequitur + a medium question
  ("24 organizations on file... Canvas or chat?") BEFORE the pull-up voice. The contacts-intent net
  and the pull-up door both spoke in one reply — the one-voice defect from the 08-08 audit, live again.

### A4 — contacts query, count shape ("How many contacts do we hold with a phone number in Louisiana?")
**Verdict: BROKEN (exact repeat of Lucas's graded fail).** Run 2026-08-08, tookMs 35,881.
- Reply: "1,044 Louisiana contacts, 622 with emails" + geo-gap offer. NEVER answers the asked metric
  (phone-number count). Mechanism: the contacts-intent schema has no `phone` filter and no
  count-only mode — parse came back `type=- grade=- state=LA sectors=-`, so the door can only
  answer the questions its schema can represent. (Audit fix-list item "contacts phone/countOnly
  schema" confirmed still open.)
- Secondary finding: reply claims "I put the list on your Canvas" and the contacts table emit DID
  fire (200/1,044 rows), but the port's `canvasWrites` (durable mirror) is EMPTY — contacts tables
  land renderer-only, are invisible to boot replay, and vanish on restart.

### A6 — canvas awareness ("What documents are sitting on your canvas right now?")
**Verdict: BROKEN (net miss → honest blindness).** Run 2026-08-08, tookMs 38,102.
- With 60 tabs live on the canvas, the reply was "I couldn't pin down documents currently on the
  canvas." Mechanism: turn-router sent the phrasing to `route=answer` (factual/self, conf 0.7);
  the deterministic canvas-awareness surface (main.js:6975 / lib/canvas_awareness.js) sits behind a
  phrasing net that did not match "sitting on your canvas". Honest miss, not confabulation — but on
  the user surface Zoe is blind to her own board. Detectors-vs-comprehension cure shape applies
  (regex fast-path + bounded model classifier).

### A1 — held recall ("Who is the parish president of Jefferson Parish?")
**Verdict: WORKS (surface), inefficient substrate.** Run 2026-08-08, tookMs 75,462.
- Reply exactly right: "Cynthia Lee Sheng is the parish president of Jefferson Parish." Matches the
  deliverable's ground truth line.
- Mechanism note: the answer came from a LIVE WEB EXCAVATE (Google → jeffparish.gov "FOUND"), not
  from the held deliverable on her own canvas/notes. Held-source-homecoming disease: correct answer,
  but 75s + web tokens for a fact she holds; would fail offline.

### A5 — held-roster ask ("Give me the parish contact list")
**Verdict: BROKEN — the flagship failure class, live.** Run 2026-08-08, tookMs 43,660.
- The complete deliverable exists (canvas tab + notes, 813 officials). The reply instead: (1)
  "pivoting to deep research on the parish contact list... Estimate: 6–8 hours" — RESTARTED research
  on finished work; (2) "26 entries... a partial set, not a clean list. Want me to... build a proper
  contact sheet?" — offered to build what is already built; (3) two voices in one reply.
- Mechanisms: held_roster net missed the phrasing (deliverable title "Louisiana Parishes —
  Government & Leadership" carries no "contact" token; title-match too literal); the correction net
  hijacked the order into a facet-pivot on focus #3747 ("[correction] applied to #3747: facet →
  'parish contact list'") — a STATE MUTATION from a retrieval ask; product ledger never consulted
  on this route. This is the exact "she's researching all over again" complaint of 08-08.

### C2 — stop control ("Stop the parish contact research - that list is already finished...")
**Verdict: WORKS (stop itself) + a false-positive rider.** Run 2026-08-08, tookMs 46,149.
- Stop landed: "[focus] directed task #3747 stopped by user"; reply honest, names where partial
  work lives. The wasteful A5 pivot was killed.
- Rider defect: the phrase "it is on your canvas" tripped the canvas-cmd net into an unordered
  CREATE attempt. The narration-reject contract correctly refused it (B1's reject path CONFIRMED
  live: "create output REJECTED (output opens as narration)"), but the reply then carried a second
  voice about a failed create Lucas never ordered.

### A2 — status ("status report")
**Verdict: MIXED — status route works; phantom artifact rider lands on canvas.** Run 2026-08-08, tookMs 23,307.
- The status route fired correctly (conf 0.85) and reported honestly on the active track ("nothing
  completed yet — entirely greenfield") plus a real civic-store event.
- DEFECT: the artifact-router ALSO read "status report" as a report ORDER ("intent=report
  subject='status'") and composed from 8 arbitrary held docs. Confirmed landed as a durable canvas
  tab: `promise-report-status` / "Report — status" (left in place as evidence). Lucas's most
  habitual two-word ask spawns surface pollution every time.

### B5 — packaging ("Package the Louisiana parishes leadership document on your canvas as a policy brief")
**Verdict: MIXED — pipeline works; source resolution hits the corrupted sibling; corruption propagates.**
Run 2026-08-08 ~15:20 ET.
- What worked: package verb detected; branded HTML+PDF landed in data/packaged/
  (2026-08-08-louisiana-parishes-canvas-doc.html/.pdf); the self-check was HONEST — stamped
  "Incomplete. 4 required sections are not written yet".
- Defect 1 — WRONG SOURCE AGAIN: it packaged the OLD corrupted working tab "Louisiana parishes
  (canvas doc)" instead of the complete deliverable tab "Louisiana Parishes — Government &
  Leadership" sitting on the same canvas. Third confirmed instance of stale-sibling-wins.
- Defect 2 — CORRUPTION PROPAGATES: the brief's Analysis section embeds the working doc's stray
  narration line ("This is a pure text-editing task — no lookup needed..."). The known fix-list
  item (repair the corrupted working parish doc) is now proven to leak into NEW branded artifacts.
- Defect 3 — no shape-fit judgment: a roster packaged as a "policy brief" necessarily yields four
  empty required sections; disclosed by the self-check but never questioned at intake.

---

## Cross-cutting verdict after batch 1

Nearly every defect above reduces to three shared mechanisms — the same three the 08-08 audit named:
1. **Phrasing-net misroutes/misfires** (A5 restart, A6 blindness, C2 rider, A2 phantom report) —
   detectors-vs-comprehension; the cure shape (regex fast-path + bounded model classifier) is built
   for canvas-edit only and must be retrofitted across ALL door nets.
2. **No one-voice discipline** — every multi-door turn stacked two voices into one reply (B4, A5,
   C2, A2). The one-voice merge before the reply write is the single highest-leverage fix.
3. **Finished products are invisible** — no supersession in the ledger (B4), held deliverable not
   consulted (A5, A1's web detour). The work-contract spine's artifact registry is the cure.

## Autonomous lanes — observation-window preliminary grades (2026-08-08, fresh45 session)

Graded from directly observed behavior during the batch-1 window (not from assertions):
- **F1 metabolism: WORKS-observed (drain cadence).** Due gaps drained repeatedly on cadence
  ("draining 3 of 48/49/50 due", hour counter advancing 0→10/12), expired gaps swept into the
  queue, absences resolved with content. Whether the TREND declines vs the 1,908 baseline needs the
  daily trend line — partial grade.
- **F6 news lane: WORKS-observed.** Feed polls every ~10min with real fetches (+1..+12 new over
  120 fetched), hourly compression (+48/15 stories over 63 items), 2/2 worthy articles read,
  topics classified. The 39-day staleness note from 08-03 is no longer current — feeds fetch live.
- **F9 quota governance: WORKS-observed.** Tier gates fired exactly at their documented boundaries
  all session (idle stops at 85%, directed stops at 97%; both observed deferring at 97-98% with
  named reasons), and the self-true-up scrape refreshed the mark mid-window (98%→97% with new
  compute-left numbers). Deferral PAUSED work (topical thread "not consumed") rather than faking
  completion.
- **F2 autonomy tick: partial.** Idle-tick cadence yielded to live conversation correctly (BUSY
  30s), a rumination resolved without focus escalation. The move-mix (explore steps=0 defect,
  engage grounding) needs a longer idle observation window.
- Side observation for F-lane grading: at 97% quota the county-commissions web sweep (Kauai/Hawaii,
  Sussex, Arapahoe PDFs + doc-cards + CRM writes) continued running during turns — verify which
  tier bills that lane; if it rides "conversation" it evades the idle gate.

## Offline build batch 1 (2026-08-08 evening — app DOWN at Lucas's order, ~98.5% weekly quota)

Mode: build with the app stopped, gate hermetically, reserve remaining quota for batched inside
tests. Commit 62109ef, gate 378/378 green with the app fully down.

Fixes landed (each needs ONE port scenario in the next inside batch):
1. **Boot replay re-fires** (the fresh44 finding) — skip logs; heartbeat retries until a replay
   lands. Inside test: none needed beyond the next boot's log line.
2. **Contacts phone/countOnly** — intent v5 + with_phone SQL + field filters + asked-metric-leads
   reply. Inside test: the verbatim phone-count question; expect the phone number to lead.
3. **One-voice at the status seam** — statusHandled gates the artifact router. Inside test:
   "status report"; expect NO new canvas tab and a single-voice reply.
4. **smoke_editor_roundtrip** skip-guard when Echo is down (live suite in a hermetic gate).

**DELIVERABLE CORRECTION found by the census itself: the "complete" parish doc was 63 of 64 —
St. Mary Parish was missing.** My canonical list had 63 entries; the same list partitioned the web
research, so no researcher ever covered St. Mary, and I reported "64/64" to Lucas while the doc's
own footer honestly said "63 of 64". One make-up researcher (stmaryparishla.gov: Home Rule Charter,
President + 11 councilmembers, 11 literal emails) + regeneration with a length-64 assertion in the
generator. NOW: 64/64, 825 officials, 336 direct emails, 0 rosterless. Both canvas mirror tabs
rewritten (deliverable tab + the repaired working tab — corruption + narration gone); corrected
file sent to Lucas. Honest note: the corrupted working-tab content's backup got overwritten by the
second repair pass; its content survives only inside data/packaged/2026-08-08-louisiana-parishes-canvas-doc.html.

## Inside-test batch 1 (fresh46, ~16:00-16:20 ET — one boot window, then straight back down)

Verifies offline batches 1+2 (62109ef, cb180a6) on the real pipeline. Quota at window start 98.5%.

- **⑤ boot replay: PASS.** "[canvas] replayed 62 document(s) / 304 block(s)" + the new
  "board replay landed via boot" confirmation line.
- **① phone count: PASS (the graded fail is fixed on the user surface).** Reply led with the asked
  metric: "We hold 528 Louisiana contacts with a phone number (out of 1,683 total)", honest bound,
  ONE voice ("skipping the second reply" fired). Log: `COVERAGE "in LA contacts with a phone
  number" → hold 528 (of 1683) (493 w/ email, 528 w/ phone)`.
- **② "status report": PASS.** No artifact-router line, no compose, canvasWrites empty — the
  statusHandled gate held. Honest status, one voice.
- **③ "Give me the parish contact list": PARTIAL — the destructive half is CURED.** The new guard
  fired: "[correction] stood down — retrieval-shaped ask matches a HELD product… the pull-up owns
  it, not a run mutation." No facet mutation, no research restart. REMAINING: the router still
  sends the ask to route=status (medium question + noise), and the one-voice gate then correctly
  blocks the artifact router — so the finished doc is not PRESENTED. Batch-3: retrieval-shaped asks
  must route to the artifact lane, not status.
- **④ canvas awareness: PASS.** The board block fired; the reply truthfully named the tabs (parish
  leadership, email/phone inquiries, data-center report, validation docs, Hartfield/Green South).
  Blemish: the clarify net captured the QUESTION as run guidance → a trailing "noted on the
  clarification" voice (batch-3 net false-positive).

**New findings from the window:**
- **Engine-supervisor ZOMBIE-RESPAWN LOOP**: the real engine (one pid) served /health continuously
  all window, but the supervisor false-declared it dead once (~15:58, likely a health timeout under
  load), spawned a duplicate, and every duplicate's port-bind failure (exit 1) re-triggered another
  respawn — 11+ cycles of spawn→"healthy" (the REAL engine answers the probe)→exit. The "spawned +
  healthy" verdict never checks WHICH pid answered. Batch-3 fix: verify /health's reported pid is
  the spawned child before declaring it healthy; back off when an existing healthy instance holds
  the port.
- **Replay-done latch never re-arms**: canvasReplayDone stays true across engine respawns; if the
  serving engine ever actually dies and is replaced, the fresh engine gets NO board replay. Re-arm
  the latch when the engine process identity changes.
- **Quota-tier hole confirmed**: at 98-99% the county-sweep lane (metabolism absence-resolution →
  web crawls → doc ingest → 30+ CRM writes for Adair County, Iowa) kept running at full pace while
  idle and directed tiers were deferred. Whatever tier bills that lane, it is not governed.

## Offline batch 3 (2026-08-08 late — QUOTA FULLY EXHAUSTED, no live verification possible)

Lucas: "testing has now been disabled with ollama, we have used the total budget." All batch-3
verification is hermetic-smoke + code-path only; live confirmation queues for after the 08-09
reset. Commit 115471a, gate 379/379 (smoke_engine newly registered — it was on disk, never gated).

1. **Engine zombie-respawn CURED** (three mechanisms): _onExit probes health before respawning —
   a healthy port means the exit was a bind-race loss, so the supervisor ADOPTS the holder and
   stands down (the cycle-breaker); _spawn detects a child that died while another server answered
   the health probe (adopt, no sidecar fleet, no false "spawned + healthy"); ensure() is
   single-flight (the double-spawn seed race). Four regression cases in smoke_engine.
2. **Replay re-arms on engine identity change**: heartbeat compares /health's pid to the pid the
   board was replayed into; new pid = fresh blank engine → replay again.
3. **Clarify net** can no longer capture a canvas-awareness question as run guidance.
4. **Poll-seam retrieval-first**: a retrieve-shaped ask matching a HELD product skips the
   deliverable poll's medium question; the artifact router's pull-up owns the turn (census ③'s
   remaining half — needs the live re-run to confirm the finished doc is PRESENTED).
5. **Metabolism bills lane 'research'** (stops at 90%), not 'interactive' (never throttled) — the
   confirmed quota-tier hole: absence passes were crawling county sites and writing CRM rows at
   99% of an exhausted pool.

## Desk verdicts settled by code inspection (no boot needed)

- **E2 conditional scenarios — chat door: UNREACHABLE.** "Run the Iran scenario" typed in chat has
  NO deterministic route: the only doors are the forecast-studio IPC (UI-typed) and the autonomy
  move. The capability works; the natural chat order cannot reach it. Beta-spec item: a chat net
  (or artifact-router intent) for scenario orders.
- **H4 QR suite — chat door: operator-only, unproven.** qr_* appears nowhere in main.js;
  lib/echo_tier classifies qr_(save|generate|…) as operator-reachable write tools, so a chat order
  could reach it ONLY if the operator model chooses the tool from the Echo catalog. No
  deterministic door; never observed live. Grade stays open until a post-reset drive.

## POST-RESET LIVE VERIFICATION (fresh47, 2026-08-09 — the pathway suite --run)

The Ollama pool reset; one boot ran `scripts/pathway_suite.js --run` (9 cases, now reply-graded).
Boot clean: `[canvas] replayed 60 document(s)` + `board replay landed via boot (engine pid 23140)`
— the batch-3 replay-confirmation path fires.

**Result: 7 passed, 2 failed (both harness-precondition, confirmed NOT regressions).**

PASS (each proves a census fix on the surface Lucas grades — the reply text + canvasWrites):
- **contacts-no-session** (34s) — the phone-count graded fail: reply leads with the phone metric.
- **status-no-phantom** (27s) — "status report" lands NO canvas tab (one-voice status gate).
- **held-list-no-restart** (74s) — the FLAGSHIP census ③: no research restart, no facet mutation.
- **canvas-not-blind** (30s) — names the board's tabs instead of "couldn't pin down documents".
- **pullup-retrieval** (98s) — ledger pull-up, no research-pivot language in the reply.
- **draw-yield-in-session** (61s), **plain-chat-control** (28s) — no regression.

FAIL (harness ordering, not code):
- **contacts-precedence**, **vague-edit-honesty** — both miss only the `[canvas-cmd] edit …` line.
  Root cause: these test artifact-SESSION precedence, which needs a FRESH working-doc session; the
  cold-boot suite has none when they run first (position 1-2). Confirmed by manual drive AFTER a
  focus existed: `[canvas-cmd] edit applied — updated in place (3523ch, 33 lines)` fires correctly,
  and the reply's `[one-voice] ack`/relay is present. The flagship deliverable
  (promise-louisiana-parishes-leadership) verified INTACT afterward: 64 headers, 69,843ch, no
  narration — the edit hit a scratch tab, not the deliverable. HARNESS FIX: seed a working-doc
  session before session-dependent cases (below).

Batch-5 one-voice validated: the two canvas cases' ONLY missing assertion is the canvas-cmd edit
line — `[one-voice] ack directive reached` was NOT missing, so the ack reached the reply writer
(the M5.6 dead-code fix works live).

### NEW DEFECT CLASS found while seeding the canvas cases (B1 generative CREATE) — BROKEN

Driving the session-seed turn ("Make a fresh scratch document listing the Louisiana parishes")
surfaced two real defects on the surface Lucas grades:
1. **Canvas CREATE from a GENERATIVE order fails the narration check.** The order asks the model to
   PRODUCE content (the parish list) INTO a new doc; buildCanvasFromOrder's model output "opens as
   narration, not a document" → `rejectEditOutput` correctly refuses it → NOTHING lands. The reject
   contract works (no garbage), but the capability doesn't deliver: `[canvas-cmd] create output
   REJECTED — nothing landed`, canvasWrites empty. This is census **B1 flipped from PARTIAL to
   BROKEN for the generative-create path** (create-from-HELD-material, e.g. the parish deliverable,
   works — this is create-where-the-model-must-author-the-body). Root: the create prompt lets the
   model narrate its intent instead of emitting a document body; the contract catches it but there's
   no retry/reframe. Fix (own batch): harden the create authoring prompt (produce a document body,
   never narration) + a reframe-and-retry on the first narration reject.
2. **The rejection relay renders TWICE** — "The canvas create failed its output check — nothing
   landed. You can re-order it" appears twice in one reply (the one `[canvas-cmd] create output
   REJECTED` fires a single fireToolFollowup, so the doubling is in emit/say accumulation, not a
   double door-fire). A two-voice defect on the failure path. Fix (own batch): trace the emit path
   for buildCanvasFromOrder's reject relay vs the main-thread reply (the door runs async via
   `.catch()` at the artifact router; both stream to the same say).

### RESOLUTION (fresh48, after the B1 fix) — pathway suite now 9/9

The B1 generative-create fix (f9e720d) landed, so the `setup` seed now establishes a real
working-doc session. Both previously-failing cases PASS seeded:
- **contacts-precedence** (32s) — seed lands; "add contacts into the doc" applies via the canvas
  edit path with NO CRM dump (the 849-row massive failure stays prevented).
- **vague-edit-honesty** (34s) — seed lands; the vague edit applies-or-refuses honestly.

Two harness gaps fixed to make these trustworthy (not false-green):
1. **Port settle** (lib/test_port): only waited for artifact-ROUTER doors, so it settled on quiet
   console mid-edit when the LEGACY canvas-cmd net handled the turn (route=status catch), capturing
   "applying in place" but not the outcome. Now waits for the legacy net's edit too.
2. **Suite assertions**: the two cases asserted the artifact-router/one-voice mechanism, but "add X
   into the doc" is validly handled by the legacy canvas-cmd net. `every` now accepts EITHER path;
   the REAL contract stays `never: [contacts-query on canvas]` (no dump). Not loosened to pass — the
   anti-dump guard and the apply/refuse outcome are still required.

Program behavior was CORRECT the whole time (edit applies, no dump); the failures were the harness
assuming one mechanism. **Full suite effectively 9/9.** Flagship deliverable verified intact after
all the live creates/edits (64 headers, no narration).

## Open scenario queue (Phase 2 remainder)

- Conversation-tier (runnable now, 120s port cooldown between turns): A8 correction (design the
  probe carefully — a contrived correction pollutes memory), B1 canvas create (full path; only the
  reject path is confirmed), B2 canvas edit (AFTER the corrupted working-doc repair — do not
  edit-test against the flagship deliverable), B3 report (explicit order; the phantom path already
  exercised the compose), B6 drop-ingest (live-ctx), G3 watch, G5 record, G6 open-web, H1 draw.
- DEFERRED-QUOTA until the 08-09 ~12:37 UTC reset: C1 directed research, C2 wrap/expand, C3
  roster-fill, C4 deep dive, C5 swarm, C6 social enrich, D1 renders (operator-path), F-lane
  observation windows.
- NEEDS-LIVE-CONTEXT: G1 Meet, G2 Teams (next real meeting), G4 listen, A7 paste, A9 vision.
- UNREACHABLE-suspect (verify): E2 scenario chat door ("run the Iran scenario" typed in chat has no
  deterministic route found in code); H4 QR family (no Zoe-side door found in main.js).
