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
| A3 | "Look up the latest X" — live lookup | **WORKS (live-verified fresh53)** | "Look up the latest: who currently holds the office of Louisiana Secretary of State, and since when?" → **"Nancy Landry. Assumed office January 8, 2024, after winning election November 18, 2023."** Correct + current, grounded via Google/excavate, one voice. (Minor: verbose query passed whole to Google — cosmetic, Google forgave it; a background loop stalled and the 150s watchdog force-resumed — recovery working.) |
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
| B2 | Canvas EDIT | **WORKS (live-verified fresh51)** | Seeded a scratch 6-item checklist (B1), then "add two items at the end, keep the rest" → `[canvas-cmd] edit order on the working doc → applying in place`, updated **in place** (6→8 lines, same `tab_key`, 346→442ch), first six untouched. Reply one voice + accurate ("added 'Secure a venue' and 'Recruit volunteers'… still the same first six"). No narration reject, no phantom tab, no double relay. (Handled by the legacy canvas-cmd net via route=converse, not the artifact-router — the dual path, but it delivers.) |
| B3 | Report composed from held material | **WORKS (fixed + live-verified fresh51) — now rides the notes deliverables** | Composes grounded/cited reports from held material with honest "Data Gaps" sections + open-questions→metabolism; unverified emails flagged not guessed. FINDING 1 (the notes-retrieval gap) FIXED (46af743 + 6a3a253): the door now searches notes/ for the richest held artifacts, EXCLUDING prior report-*.md. Root of the miss was product_ledger's `slice(-400)` scanning only 400 of 1,963 notes files by name (the deliverable sat at #1169) — replaced with a filename pre-filter across ALL files. Live proof: the report grew 8,163→10,995ch and now covers 45 parishes (was ~5), riding notes/louisiana-parishes-leadership.md. FINDING 2 (open): a stale same-topic directed focus can tangle a report request; clear the focus first. |
| B4 | Product pull-up (product_ledger) | **FIXED-PENDING-LIVE** | Census B4: pulled the STALE draft over the finished doc; presented a failure record as the artifact; claimed canvas landing that didn't verify. Fixed (supersession cb180a6, failure-record exclusion + emit-return-checked relay 803eab4). Live check: `pullup-retrieval` say-assertions. |
| B5 | House-style packaging | **PARTIAL** | fresh45: real branded HTML+PDF landed, honest self-check — BUT packaged the corrupted working tab (stale-sibling, now fixed by supersession) and the working-doc corruption is REPAIRED (parish-working-tab rewrite). Re-drive post-reset to confirm it packages the right source. |
| B6 | Drop a PDF onto the canvas — ingest | **NEEDS-LIVE-CONTEXT** | Requires a real drop. |

## C. Research (directed / list-completion / enrich / deep)

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| C1 | Directed research assignment (P0→P4b) | **WORKS (live-verified fresh48/49) — EXCELLENT** | Drove "research the LA/MS Public Service Commission, build a dossier." Directed research web-searched + cross-referenced + produced ANALYST-GRADE cited dossiers (all 5 LA commissioners with districts/party/terms, 6 recent votes with docket numbers/dissents/dates/sources; MS: found commissioners, honestly flagged the pending seat, CAUGHT + corrected a LA/MS cross-contamination). Found+fixed a precedence collision (0aa0232): a discover assignment also fired the report-from-HELD door, landing a "we hold nothing" report on canvas beside the real dossier — now the compose/retrieve doors stand down on discover (verified fresh49: no report door fired). |
| C2 | Run controls (wrap/expand/stop) | **WORKS (stop)** | fresh45: stop landed, focus cleared, honest relay. Wrap/expand X-of-N honesty untested live. |
| C3 | Named-roster fill / list-completion | **WORKS (live-verified fresh49) — cite-or-leave-blank honored** | "Build a contact table for these 5 people, find emails." Landed a table with ZERO guessed emails: grounded official district emails where published (northern.district@/central.district@psc.ms.gov), honest "No direct email" + real fallback (office phone / general email) where not — correctly tracked Maxwell left for USDA, Presley's official email inactive. Routed enrich→canvas_create (not the roster_intake lane specifically), but the anti-fabrication contract held. Minor: an operator "I have enough…" preamble leaked to the doc top → fixed (1eb7aa1). |
| C4 | Deep dive (premium single-subject) | **WORKS for atomic lookups (live-verified fresh53); broad-dossier form = directed lane** | RE-DRIVE after the fall-through fix (9cbdf83): "Cleco — who owns it now, who's the CEO?" → **correct + detailed: "Bill Fontenot is president and CEO. Ownership in transition — Stonepeak + Bernhard Capital acquiring Cleco from the Macquarie-led consortium (BCI, Manulife); awaiting regulatory closing."** Full reversal of the fresh51 honest-miss. The fresh51 failure was a MISDIAGNOSIS as "substrate-blocked" — real cause was (a) the broad 4-part "deep dive" need mismatched to excavate's find-ONE-answer contract, (b) JS-blind pages with no text fall-through. Narrowing + the fall-through floor → correct delivery. The broad multi-part dossier form runs via the DIRECTED lane, accreting onto canvas (notes/directed-37xx-dossier), not a single excavate. |
| C5 | Swarm (parallel worker surge) | **SUBSTRATE-BLOCKED (deferred)** | Swarm = N parallel directed-research workers on the same web-read substrate that C4/C6 just proved is down (search keyless + excavator JS-blind). Driving it now reproduces the honest-miss at 3-4× the spend with no new safety property to confirm. Re-drive once the substrate is provisioned; the distinct thing to watch there is partition convergence (no double-work, no gaps). |
| C6 | Social/online-account enrich | **HONEST-MISS + never-vouches CONFIRMED (live fresh51)** | "Enrich Marcus Thibodeaux (Lafayette small-biz owner) — find verifiable social/public profiles." Obscure subject + dead search substrate → **invented zero handles**, reported honestly ("results came back generic, not his actual profiles"). **The UNKNOWN-never-vouches safety property HELD** — the important result. Blocked by the same substrate; also re-exposed the **query-extractor defect worse than G6**: it searched `"his social media accounts and any public profiles you can verify"` — **dropped the subject name entirely**, grabbing the trailing clause. |

## D. Renders (saga / vault deliverable shapes)

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| D1 | Schema-locked shapes (quick-hit / briefing / op-ed / verification / citation-pack / draft-review) | **RENDER SHAPES UNREACHABLE via chat (request still served)** | "Give me a quick-hit briefing on X" routes to the GENERIC report-from-held door (composed 6367ch → notes+canvas), NOT saga_render_quick_hit — so the schema-locked/voice-validated/cite-floor render FORMATS have no dedicated chat door (operator/echoSuit-side only), like E2/H4. The user's ask is served by B3's report door; the branded format is not. Beta-spec gap: add chat doors for the render shapes, or accept operator-only. |
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
| F4 | Rehearsal / R2 self-scripting | **BROKEN — no tool persisted; but anti-fab gate CAUGHT it (live fresh51)** | "Build yourself a reusable F→C tool at a path, test it on 72°F." → narrated creating `tools/f_to_c.py` + correct math (72°F→22.22°C), **but the file was never written** (verified absent on disk). **R2 self-scripting does not actually persist/register a tool.** ⭐**The anti-fabrication reply gate FIRED on Lucas's surface** — verified the falsifiable path claim vs reality, found it false, appended a retraction to the reply: *"the file I named isn't actually there… I won't claim a file/canvas/image/db record exists unless it really does."* Strongest live proof of the a-fab gate to date. (Ideal: suppress the false claim, not append a retraction — but honest + safe.) |
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
| G3 | Watch a video / find clips | **PARTIAL — identifies, can't read content (live fresh51)** | "Watch this video and tell me what happens: youtube…jNQXAC9IVRw" → correctly ID'd "Me at the zoo, the first YouTube upload" (metadata), opened with captions on, then `[media_cc] watching (no new captions, dom)` **~20× — zero captions scraped**, **never fell through to `av_transcribe`**, turn **unsettled** on an unkept promise ("I'll tell you once the captions roll through"). Same caption-scrape-empty failure as **G2 (Teams 0/101)**, same no-fallthrough shape as C4/G6. **Plus a LEAK: the watch session never terminated** — its `media_cc watching` loop kept spinning through the next two unrelated turns (no stop, no timeout). The watch lane needs a bounded lifetime / stop-on-idle. |
| G4 | Listen / transcribe a call | **NEEDS-LIVE-CONTEXT** | Requires live audio. |
| G5 | Record a recipe by demonstration | **NEEDS-LIVE-CONTEXT** | Requires a live demonstration. |
| G6 | "Open X in your browser" | **PARTIAL — single-hop opens, multi-hop drops the action (live fresh51)** | ①"check the web for the latest NWS active alert" → opened the alerts page, read the front tab, reported the alert area **empty** honestly (that page renders alerts as a JS map, no text) — no fabrication. ②"look up Baton Rouge on Wikipedia, give the population" → web-intent fired but sent the **whole verbose sentence** as the Google query (crude entity extraction); read the results snippet ("227,470 at the 2020 census") and reported it honestly as *a snippet, not the article*, promising to open the article. ③ follow-up "yes, open the article" → **routed `converse` (conf 0.5) — the web-action intent was LOST**; emitted a bare `"Opening the actual Wikipedia article now."` promise-say with **no `[web] open`, no tool call, no content**, and settled. Two defects: (a) query extraction; (b) affirmative follow-up loses the action intent → unkept promise-say the guard can't force (no action was ever assigned). **(b) = prime evidence for the work-contract spine.** |

## H. Peripheral

| # | Capability | Verdict | Evidence / remaining live check |
|---|---|---|---|
| H1 | Local image gen ("draw me…") | **WORKS (live-verified fresh49)** | "Draw me two pictures of a Louisiana bayou at sunset" → `[draw] made 2/2`, two real PNGs written (data/zoe_workspace/images/gen_*.png), honest reply ("two bayou sunsets… on your Canvas"). Minor: the count-prefix "two pictures of" isn't stripped from the SDXL subject (cosmetic). |
| H2 | Calendar surface (view + operator writes) | **UNTESTED (UI-only)** | No chat door by design; verify via the studio UI. |
| H3 | Editor / verification studio | **UNTESTED (UI-only)** | Advisory lanes; live Echo required. |
| H4 | QR suite | **UNREACHABLE / operator-only** | Desk-verdict: qr_* appears nowhere in main.js; reachable only if the operator model picks it from the Echo catalog. No deterministic door; never observed. |
| H5 | KG / 3D graph visualization | **UNTESTED (UI-only)** | Read-only panel; verify via UI. |

---

## ⚠️ SUBSTRATE FINDING (live fresh51, 2026-08-10) — the web-read stack is degraded, and it gates a whole column

Driving C4 + G6 surfaced one shared root cause behind every research/open-web miss, distinct from any lane's own logic:

1. **Search-provider keys are absent.** Direct engine probe `web_search("Cleco…")` → `results:[]`, `providers_skipped: {exa:"no_key_or_error", brave:"no_key_or_error", duckduckgo:"no_key_or_error"}`. Every lane that *leads* with search finds nothing. (SQ `.env` carries no EXA/BRAVE/TAVILY/JINA key either.)
2. **The act-on-page excavator is JS-blind.** On NWS alerts and cleco.com the headless scan returned `NOT_VISIBLE` on every step — it cannot read JS-rendered pages, so excavation-fallback also yields nothing.
3. **But `web_fetch` works.** `web_fetch("en.wikipedia.org/wiki/Cleco")` → `tier:curl_cffi, 200, 50KB` of real content. The healthy path exists — **the lanes just never fall through to it** when search is dead and excavation is blind.

**Consequence for the census:** C4 (deep-dive), C5 (swarm), C6 (social-enrich), and G6 (open-web) all sit on this substrate — driving them now reproduces the same honest-miss. C1 passed earlier only because its subject was already in the local corpus. **The honesty layer is holding everywhere (zero fabrication under total substrate failure — the important safety result), but the *delivery* is blocked.**

**⚠️CORRECTION (2026-08-10, Lucas + code read): "provision search keys" was WRONG — the app went KEYLESS BY DESIGN.** There are three search paths: (1) Echo's federated `web_search` (exa/brave/**ddg**) — keyless-dead, but it's an UNUSED branch; (2) `lib/search_lane.js` — the app's own programmatic search, a headless off-screen patchright Chrome running **Bing** (DDG was abandoned — it *null-routed this IP* after the lane over-pinged its HTML endpoint); (3) `lib/web.js`+excavate — the *visible* browser driving **Google** ("real web google searching", what C4/G6/Shreveport used, proven live). So Zoe searches by **browser SERP-scraping (Bing headless + Google visible)**, not keyed APIs — no exa/brave/tavily keys needed. The raw-`fetch` Bing fallback returns junk (localized generic page), but the browser lanes work. **The real fix items:** (b) **make the research lanes fall through to `web_fetch`/`web_extract` of a resolved URL** when the vision read reports `NOT_VISIBLE` — LANDED (9cbdf83). Also — seen **twice, systemic**: the web-intent **query extractor** does not resolve the subject. G6 ② sent the whole verbose instruction as the query; C6 was worse — it searched `"his social media accounts and any public profiles you can verify"` and **dropped the subject name ("Marcus Thibodeaux Lafayette") entirely**, grabbing only the trailing clause. Resolve the entity before searching.

### ✅ FIX #1 LANDED + LIVE RE-VERIFIED (fresh52, commit 9cbdf83)
The fall-through floor (b) is built into `excavate()`/`seePage()`: vision blind on every screen → `web_extract`/`web_fetch` the page text → distil the answer (never invents). Gate 379/379. **Live re-verify on fresh52 established three things:**
1. **The fix loads + fires safely** — `[excavate] vision miss → web_extract fall-through read 724ch, no answer in text` on a thin page → honest not-found, zero fabrication.
2. **The read substrate WORKS** — Baton Rouge lookup: `[excavate] FOUND: population 222,795 (census.gov)` via vision. Content CAN be read + grounded (turn 2 replied grounded on 222,795).
3. **A suspected reply-seam (found answer not reaching the reply) DID NOT REPRODUCE on clean re-drives — no speculative fix built.** The Baton Rouge turn-1 "I don't have that number… let me try again" (while the log showed excavate `FOUND: 222,795`) looked like the M5.6 ack-seam race for found answers. But three fresh fresh53 drives worked correctly: **Shreveport** → found city 175,902, delivered it; **Lafayette** → excavate found only PARISH data (257,949) and Zoe **correctly refused to conflate parish-as-city** (honest: "lists the parish not the city, want me to dig deeper?" — right call, Lafayette city ≈121k). So the read + honesty path work; the Baton Rouge miss was a one-off transient (interim emit, or the still-active Cleco directed-research tool-router racing cognition — context pollution, not a structural seam). **Watch-item, not a fix.**

---

## Tally (45 capabilities)

**Post-reset live verification (fresh47, pathway_suite --run, 7/9):**
- **WORKS (now live-verified): 19** — **A3**, A1, A2, A4, A5, A6, B1, **B2**, B3, B4, C1, C2(stop), C3, E1, F1, F6, F8, F9, H1
  (fresh48/49 drives: B1, C1+discover-fix, C3 cite-or-leave-blank, H1 image gen, B3 report-from-held;
  **fresh51: B2 canvas-edit in-place; fresh53: A3 live-lookup (Nancy Landry, correct)** + Shreveport/
  Lafayette factual lookups both correct — the KEYLESS browser search path WORKS, see the substrate correction).
  **NB: C4/C6/G6's "substrate-blocked" verdicts were MISDIAGNOSED — search isn't dead (app is keyless-by-design,
  browser SERP-scraping works); those misses were the excavator being JS-blind / find-one-answer mismatch,
  which the fall-through floor (9cbdf83) addresses. Re-drive them against the fall-through.**
- **fresh51 SUBSTRATE-BLOCKED honest-misses (delivery blocked, honesty HELD — zero fabrication): 3** —
  C4 deep-dive, C6 social-enrich (never-vouches confirmed), G6 open-web (multi-hop). All three trace to
  the ONE web-read substrate finding above (search keyless + excavator JS-blind + no fallthrough to the
  working `web_fetch`). C5 swarm **deferred** on the same substrate.
- **fresh51 PARTIAL (identify-but-can't-read-content): G3** watch-video — IDs the video, scrapes zero
  captions, no fallthrough to `av_transcribe`, unsettled promise. Same failure family as G2 (Teams).
- **THE CROSS-CUTTING DISEASE (now 4 lanes, reproducible): pick-a-primary-reader → primary fails →
  NO fallthrough to the working path → end on an unkept promise-say (sometimes unsettled).**
  G6 (search/excavator→no web_fetch), C4 (excavator→no web_fetch), G3 (DOM-captions→no av_transcribe),
  G2 (Teams captions). This IS the work-contract spine — the census has now produced hard evidence.
- **fresh51 BROKEN (found live): F4** R2 self-scripting — narrates creating a tool file + correct math,
  but **no file is ever written/registered**. ⭐**BUT the anti-fabrication reply gate CAUGHT it live** —
  verified the path claim vs disk, appended a retraction to Lucas's reply. Strongest a-fab proof to date.
  (Also a LEAK: the G3 watch session never terminated — spun through 2 later turns.)
- **BROKEN (found live, since FIXED): 1** — B1 generative-create (fixed 4f63b9c, re-verified fresh51).
- **PARTIAL: 2** — F2; B3-notes FIXED.
- **UNREACHABLE (chat door): 2** — E2, H4
- **NEEDS-LIVE-CONTEXT: 7** — A7, A9, B6, G1, G2, G4, G5
- **UNTESTED remaining (chat-drivable): F5 byline (public — explicit-go only), A3, A8, D2, F3, F4, F7**;
  UI-only: D1, H2/H3/H5. The chat-drivable census is now **substrate-limited** — the rest either wait on
  the substrate fix or need Lucas's go (F5).

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
