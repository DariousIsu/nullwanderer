# Zoe Program Census — THE SCORECARD (beta-completion spec)

Lucas's directive (2026-08-08): *"the program has 100s of tools and work surfaces — have you test
run the entire program? the next build should be a completion for first real beta testing."* This
scorecard is that spec: every user-orderable capability, its current best-known verdict, the
evidence behind it, and the exact live check that remains. **It is the definition of done.**

## Verdict legend
- **WORKS** — verified on the surface Lucas grades (reply text + artifact read back directly), or
  observed working on cadence for an autonomous lane.
- **FIXED-PENDING-LIVE** — a census-found defect has a committed fix + hermetic-smoke proof, but the
  live re-run is blocked on the Ollama budget (exhausted 2026-08-08; resets ~08-09 20:00Z). One
  post-reset boot clears these.
- **BROKEN** — a mechanism-level defect with no fix yet.
- **UNREACHABLE** — the capability exists but a natural chat order has no deterministic door.
- **NEEDS-LIVE-CONTEXT** — only provable with a real meeting / paste / screen / video in the room.
- **UNTESTED** — code-complete, never driven; no desk verdict possible (needs a live run to grade).

Grading law: log lines prove a *mechanism ran*; only the reply + the artifact prove the *answer*.
The pathway suite (`scripts/pathway_suite.js --run`, 9 cases) now enforces this — its first
post-reset run is the gate on flipping FIXED-PENDING-LIVE → WORKS for the conversation lanes.

---

## A. Conversation & memory

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| A1 | Factual + shared-history recall | **WORKS** | fresh45 live: "Who is the parish president of Jefferson Parish?" → "Cynthia Lee Sheng" (matches the deliverable). Caveat: answered via web-excavate, not the held doc (held-source-homecoming inefficiency, not a correctness fail). |
| A2 | "How's the research going" — status | **FIXED-PENDING-LIVE** | Census ②: "status report" spawned a phantom "Report — status" tab. Fixed (statusHandled gates the artifact router, 62109ef). Live check: `status-no-phantom` suite case (canvasEmpty). |
| A3 | "Look up the latest X" — live lookup | **UNTESTED** | Operator web path; not driven this census. Post-reset drive. |
| A4 | Held-contacts query (list/count) | **FIXED-PENDING-LIVE** | Census ①: "how many with a phone number" answered with totals+emails (Lucas's graded fail). Fixed (phone/countOnly schema, 62109ef) + re-run fresh46: "528 with a phone number (of 1,683)" leads. Live check: `contacts-no-session` say-assertions. |
| A5 | Held-roster ask ("give me the parish contact list") | **FIXED-PENDING-LIVE** | Census ③ (flagship): restarted 6-8h research on the finished list. Destructive half CURED (correction net stands down, retrieval-first guard, cb180a6) — fresh46 confirmed "stood down, no run mutation". Retrieval-presentation half fixed at the poll seam (115471a), UNVERIFIED live. Live check: `held-list-no-restart`. |
| A6 | Doc-QA + canvas awareness | **FIXED-PENDING-LIVE** | Census ④: blind with 60 tabs ("couldn't pin down documents"). Fixed (board-aware buildBlock, cb180a6) + re-run fresh46: named the tabs truthfully. Live check: `canvas-not-blind`. |
| A7 | Paste a huge email/text + ask | **NEEDS-LIVE-CONTEXT** | Requires a real paste in the room. |
| A8 | Correction of the prior turn | **UNTESTED** | A contrived correction pollutes memory; drive carefully post-reset. |
| A9 | "Can you see my screen?" / image | **NEEDS-LIVE-CONTEXT** | Requires a real screen/attachment. |

## B. Canvas & documents

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| B1 | Canvas CREATE | **WORKS (fixed + live-verified fresh48)** | Was BROKEN for generative create (model narrated → rejected → nothing landed + doubled relay). FIXED (f9e720d): salvageNarration strips the operator's conversational opener + reframe-retry fallback; NARRATION_OPEN catches "I'll"/"Here's" contractions; the outcome-report exclusion kills the doubled reject relay. Live proof: "make a doc listing the parishes" → landed (1120ch, 65 lines), reply = ack + "64 parishes", one followup, no double. Create-from-held still works. |
| B2 | Canvas EDIT | **UNTESTED** | Do not edit-test against the flagship deliverable. Drive against a scratch doc post-reset. |
| B3 | Report composed from held material | **UNTESTED (compose exercised)** | The A2 phantom path exercised the composer; the intended report order not driven clean. |
| B4 | Product pull-up (product_ledger) | **FIXED-PENDING-LIVE** | Census B4: pulled the STALE draft over the finished doc; presented a failure record as the artifact; claimed canvas landing that didn't verify. Fixed (supersession cb180a6, failure-record exclusion + emit-return-checked relay 803eab4). Live check: `pullup-retrieval` say-assertions. |
| B5 | House-style packaging | **PARTIAL** | fresh45: real branded HTML+PDF landed, honest self-check — BUT packaged the corrupted working tab (stale-sibling, now fixed by supersession) and the working-doc corruption is REPAIRED (parish-working-tab rewrite). Re-drive post-reset to confirm it packages the right source. |
| B6 | Drop a PDF onto the canvas — ingest | **NEEDS-LIVE-CONTEXT** | Requires a real drop. |

## C. Research (directed / list-completion / enrich / deep)

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| C1 | Directed research assignment (P0→P4b) | **WORKS (live-verified fresh48/49) — EXCELLENT** | Drove "research the LA/MS Public Service Commission, build a dossier." Directed research web-searched + cross-referenced + produced ANALYST-GRADE cited dossiers (all 5 LA commissioners with districts/party/terms, 6 recent votes with docket numbers/dissents/dates/sources; MS: found commissioners, honestly flagged the pending seat, CAUGHT + corrected a LA/MS cross-contamination). Found+fixed a precedence collision (0aa0232): a discover assignment also fired the report-from-HELD door, landing a "we hold nothing" report on canvas beside the real dossier — now the compose/retrieve doors stand down on discover (verified fresh49: no report door fired). |
| C2 | Run controls (wrap/expand/stop) | **WORKS (stop)** | fresh45: stop landed, focus cleared, honest relay. Wrap/expand X-of-N honesty untested live. |
| C3 | Named-roster fill / list-completion | **WORKS (live-verified fresh49) — cite-or-leave-blank honored** | "Build a contact table for these 5 people, find emails." Landed a table with ZERO guessed emails: grounded official district emails where published (northern.district@/central.district@psc.ms.gov), honest "No direct email" + real fallback (office phone / general email) where not — correctly tracked Maxwell left for USDA, Presley's official email inactive. Routed enrich→canvas_create (not the roster_intake lane specifically), but the anti-fabrication contract held. Minor: an operator "I have enough…" preamble leaked to the doc top → fixed (1eb7aa1). |
| C4 | Deep dive (premium single-subject) | **UNTESTED** | Premium-lane spend; drive post-reset within quota. |
| C5 | Swarm (parallel worker surge) | **UNTESTED** | Partition convergence must be watched live. |
| C6 | Social/online-account enrich | **UNTESTED** | UNKNOWN-never-vouches staging; drive post-reset. |

## D. Renders (saga / vault deliverable shapes)

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| D1 | Schema-locked shapes (quick-hit / briefing / op-ed / verification / citation-pack / draft-review) | **UNTESTED** | Reached via operator/condense; cite_floor enforced Echo-side. Drive one shape post-reset. |
| D2 | Certify a document (vault + certification) | **UNTESTED** | Two-lane advisory workflow; live Echo required (smoke_editor_roundtrip now skips when Echo is down). |

## E. Forecast & scenario

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| E1 | 2026 midterm forecast machine | **WORKS (observed)** | fresh45 logs: recompute ran every turn (470 seats, House P(D) 48%, calibration live). Widgets untested visually. |
| E2 | Conditional "what-if" scenario | **UNREACHABLE (chat door)** | Desk-verdict: a typed "run the Iran scenario" has NO deterministic route — only forecast-studio IPC (UI) + the autonomy move reach it. Capability works; the chat order can't. **Beta-spec gap: add a scenario chat net or artifact-router intent.** |

## F. Autonomous lanes

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| F1 | Metabolism — recheck-queue drain | **WORKS (observed)** + **FIXED-PENDING-LIVE (tier)** | fresh45/46: drained on cadence, absences resolved. Census found it billed lane 'interactive' (ungated) — crawled counties at 99% pool. Fixed to 'research' (stops at 90%, 115471a; chain verified 79e2108). Live check: defers at 90% post-reset. |
| F2 | Autonomy decision tick | **PARTIAL** | Idle-tick cadence + rumination observed healthy; the explore-steps=0 class and engage-grounding need a longer idle window. |
| F3 | Lines of inquiry (+ mid-chat dig) | **UNTESTED** | Drive a dig fork post-reset. |
| F4 | Rehearsal / R2 self-scripting | **UNTESTED** | R2 card recently reachable; graduation-to-tool never proven live. |
| F5 | Byline (research→write→publish) | **UNTESTED** | PUBLIC Substack surface — highest blast radius; drive with care + explicit go. |
| F6 | News lane (189-feed + briefing) | **WORKS (observed)** | fresh45/46: polls every ~10min with real fetches, hourly compression, articles read. The 39-day staleness (08-03) is stale — feeds fetch live. |
| F7 | Roster refresh organ (federal + state + election-night) | **UNTESTED** | Previously fabricated 267/270 coverage; repaired v2/v3 live proofs pending. Post-reset. |
| F8 | Nightly self-test through the port | **WORKS (harness)** | The port drove ~15 census turns end-to-end; it IS the test surface. Nightly cadence (pathway_cadence) untested live. |
| F9 | Quota governance + routing | **WORKS (observed)** | fresh45/46: tier gates fired at documented boundaries (idle 85%, directed 97%), self-true-up scraped mid-window. |

## G. Meetings & media

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| G1 | Google Meet — join/observe/scribe/leave | **NEEDS-LIVE-CONTEXT** | Requires a real meeting. Leave-polarity fixed 08-07; scribe boot-resume untested. |
| G2 | Teams meeting | **NEEDS-LIVE-CONTEXT / known-degraded** | First live fire 08-07: join+observe worked, 0/101 captions scraped. Fix d7b2c99 live, PROOF = next real meeting. |
| G3 | Watch a video / find clips | **UNTESTED** | Drive "watch this video <url>" post-reset. |
| G4 | Listen / transcribe a call | **NEEDS-LIVE-CONTEXT** | Requires live audio. |
| G5 | Record a recipe by demonstration | **NEEDS-LIVE-CONTEXT** | Requires a live demonstration. |
| G6 | "Open X in your browser" | **UNTESTED** | Drive post-reset. |

## H. Peripheral

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| H1 | Local image gen ("draw me…") | **UNTESTED** | SDXL/ComfyUI; kill-switch smoke-covered. Drive one draw post-reset. |
| H2 | Calendar surface (view + operator writes) | **UNTESTED (UI-only)** | No chat door by design; verify via the studio UI. |
| H3 | Editor / verification studio | **UNTESTED (UI-only)** | Advisory lanes; live Echo required. |
| H4 | QR suite | **UNREACHABLE / operator-only** | Desk-verdict: qr_* appears nowhere in main.js; reachable only if the operator model picks it from the Echo catalog. No deterministic door; never observed. |
| H5 | KG / 3D graph visualization | **UNTESTED (UI-only)** | Read-only panel; verify via UI. |

---

## Tally (45 capabilities)

**Post-reset live verification (fresh47, pathway_suite --run, 7/9):**
- **WORKS (now live-verified): 15** — A1, A2, A4, A5, A6, B1, B4, C1, C2(stop), C3, E1, F1, F6, F8, F9
  (B1 fixed+verified fresh48; C1 verified excellent + discover-precedence fix; C3 cite-or-leave-blank honored fresh49).
  (A2/A4/A5/A6/B4 flipped FIXED-PENDING-LIVE → WORKS by the suite's reply-graded passes:
  contacts-no-session, status-no-phantom, held-list-no-restart, canvas-not-blind, pullup-retrieval).
- **BROKEN (found live): 1** — B1 generative-create (model narrates → rejected → nothing lands +
  doubled relay). Own batch.
- **PARTIAL: 2** — B3, F2 (B5 packaging now works modulo the repaired working doc).
- **UNREACHABLE (chat door): 2** — E2, H4
- **NEEDS-LIVE-CONTEXT: 7** — A7, A9, B6, G1, G2, G4, G5
- **UNTESTED (needs a live drive): ~16** — A3, A8, B2, C1, C3, C4, C5, C6, D1, D2, F3, F4, F5, F7, G3, G6, H1, H2/H3/H5(UI)

## What "first real beta" requires from here (the completion build)

1. **One post-reset boot** runs `pathway_suite --run` (flips the 7 FIXED-PENDING-LIVE + the 4
   PARTIAL conversation lanes to WORKS or exposes a residual) and drives the ~18 UNTESTED
   capabilities to first grades. This is the single biggest remaining coverage step.
2. **Two UNREACHABLE chat doors to build** (E2 scenario, H4 QR) — or an explicit decision that they
   stay UI/operator-only for beta.
3. **The one work-contract spine** (whackamole-to-merge): the recurring diseases this census found —
   phrasing-net misroutes, two-voice replies, stale-product wins, ungoverned lanes — are ONE
   disease (doors judging in a vacuum). Every fix above is a point-fix; the spine builds the
   done-definition / artifact-registry / single-owner / read-back contract ONCE and lanes feed it.
   The point-fixes are the interim; the spine is the beta-completion build.
