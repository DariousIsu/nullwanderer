# Interface-over-Cloud + Governed Lanes — Design (no code yet)

Consolidated from the 2026-06-29 brainstorm. Builds directly on `docs/TRACKS_PRIORITY_DESIGN.md`
(the Track + priority model) and the determinism-law in memory `cloud-operator-and-integrity`. This is
the layer that makes the interface model "float over" the cloud models, and turns every autonomous
intake channel (research, video, news, meetings) into a **governed lane** that doesn't pollute the
subconscious. Frame: [[zoe-is-the-memory]] (protect the substrate above all) + [[front-cortex-architecture]]
(local VOICE / cloud COGNITION) + [[tracks-priority-design]] (a lane is a Track).

Status: DESIGN ONLY. Nothing built. Sequenced in §9.

---

## 1. The core reframe — one brain, interface polls, cloud produces

To the **program** it is ONE brain: one state store (the Track/memory substrate). The program never
needs to know which model produced a given fact. The layering is internal:

- **Cloud = the producer.** Does the cognition and writes **structured outputs straight to the canvas +
  the Track index** — sections, fields, status — NOT prose blobs handed back to the voice model.
  *Structure survives the handoff; prose degrades.* This is why "getting the info back sucks" today:
  the cloud emits prose, Dans re-voices it lossily, and we patch with fact-injection.
- **Interface (Dans) = moderator + poller.** Takes intake, and for any factual claim **polls the brain**
  and relays in voice. It never produces or voices the full deliverable (determinism-law).
- **Program (orchestrator) = deterministic.** Owns assembly, the index, scheduling, and the poll API.

**The missing piece = a first-class POLL layer.** `lib/track.buildAnswer` (Slice 1) is the embryo:
generalize it into *the interface's only way of knowing things*. Dans doesn't answer from its own (lossy)
memory — it asks the brain. **Two-tier polling** keeps it cheap: structured questions (count / list /
status / "what do we have on X") answer **deterministically** from the program (no model call); only
fuzzy/synthesis questions hit a cloud model.

> Future (flagged, not now): structure the cloud prompts for multi-step accuracy at the LEAST tokens —
> a deliberate prompt-engineering pass once the poll layer exists.

---

## 2. Lanes — every autonomous channel is a governed Track on its own surface

A **lane** = a Track (lifecycle + index + priority) for an ongoing autonomous activity, **isolated from
the subconscious** and surfaced to the interface via a lightweight pointer (§3). Lanes:

| Lane | Lifecycle | Surface | Writes to general substrate? |
|---|---|---|---|
| **Research** (exists) | discover → deepen → organize → assemble | her browser | yes (it's the deliverable) |
| **Media** (video) | select → ingest → comprehend → done | none for BULK; browser for STREAM/SEE | **no auto-write** — deliberate promotion only |
| **News sentinel** | always-on ingest → trigger / brief | feeds (no browser) | only via briefs / triggers |
| **Meeting** | joining → awaiting_admit → in → observing → done | **own browser window** | meeting notes/action-items only |

Key rule: **a lane does not auto-accrete to `self_model` / `interests` / general `knowledge`.** Promotion
into the general substrate is **deliberate** (a learning Track consuming the lane), never a side effect of
the activity. This single rule kills the video dup-pollution AND the identity drift at the architecture
level (not as a patch).

---

## 3. The heartbeat pointer — how "float above" is implemented

Instead of inlining lane *content* into context (today's awareness line dumps captions → pollution), each
heartbeat injects ONE line per active lane: `Now: <activity> "<title>" → node #N` (e.g. `watching`,
`researching <Track>`, `in meeting <url> — awaiting admit`, `reading <doc>`). The interface KNOWS what's
going on and can dereference `#N` on demand, but the content lives in the node, not the prompt. Minimal
tokens, full awareness, zero pollution. (Refines `lib/context.js buildAwarenessBlock`'s `mediaLine`.)

---

## 4. Media subsystem — three modes, all cloud-processed

Real-time tick-watching is the wrong default. (Today there is NO bulk path — `lib/media_cc.js` reads the
DOM captions tick by tick; the av/transcript tools live in Echo, unwired.)

1. **BULK (prerecorded — new default):** fetch the WHOLE transcript in one shot (YouTube timedtext /
   Echo `av_transcribe`), ONE cloud pass → structured notes. No real-time loop, no 1406-entry monologue
   flood, *better* comprehension (full context > streaming fragments), and **it never touches the
   browser** → dissolves the contention problem (§6).
2. **STREAM (live only):** can't fetch the future → rolling-caption tail + periodic cloud digest. The only
   case that needs the real-time loop.
3. **SEE (vision, opt-in, rare):** the ONLY reason to sit 1:1 is to actually *look* (demo, diagram,
   footage). Snapshot+vision mode; expensive; deliberately invoked, never the idle default.

Dedup is automatic: a transcript fetched once is ONE Track-indexed node; a "re-watch" is a no-op against
the index (fixes the 42-nodes-for-15-videos pollution). Value gate: off-Track / below-mastery video gets
low importance or stays episodic-only; only project-serving video earns durable weight.

---

## 5. News sentinel — the always-on second lane

A standing monitor lane: **feeds-first, not video** (transcribing AP's YouTube 24/7 is expensive + lossy;
AP/wire publish RSS/API — Echo has `fetch_feed`/`fetch_feeds_batch`/`gdelt_*`). Shape:
- **always-on ingest** of chosen sources (text feeds; video only when a specific story needs footage),
- **trigger conditions** — topics/keywords tied to her active projects → fire a low-level alert that rides
  the priority/alert system (§ Tracks design),
- **scheduled briefs** — hourly/daily digest via a scheduled-task → cloud digest of the window → canvas +
  a Dans nudge.
Generalizes beyond news (watch a bill, a person, an org = the same sentinel).

---

## 6. Browser/session isolation — the contention fix

Today one browser is shared by her browsing + research + video + a meeting join, and they collide. Live
proof: a meeting join (2026-06-29 19:57) tripped a spurious step-4 reCAPTCHA because the directed-research
driver was hammering Google searches in the SAME browser during the join. Fix: **each lane that needs a
browser gets its own session/window.** BULK + feeds need none; only STREAM, SEE, and meetings hold a
browser — so contention becomes the exception. A meeting window can hold the waiting room open while
research runs elsewhere.

---

## 7. Meeting lane — the admit hold + dedicated window

Two defects (live 2026-06-29): `MAX_STAGE_STRIKES=3` and **no "awaiting admittance" concept** in
`lib/gmeet.js` — she knocks ("Ask to join"), checks `inMeeting()` once, sees not-in, strikes 3× and bails
in <1 min. Fixes:
- **Distinguish** "Join now" (open → in immediately) from "Ask to join" (knock → wait for host).
- **`awaiting_admit` hold:** after a knock, if not inside, DON'T strike — re-check `inMeeting()` each tick
  for up to **~5 minutes** (`gmeet_admit_since` timestamp). Admitted → intro. Hold expires → give up
  *gracefully* ("I knocked but wasn't let in after 5 minutes — try again?").
- **Dedicated window** (shared isolation work with §6) so the join can't be navigated away mid-knock and
  she can hold the waiting room while other lanes run.
- A reCAPTCHA on a `google.com` **sign-in** should reclassify as a `login` blocker ("sign me in", which
  sticks) rather than `captcha` ("let me in").

---

## 8. The video-data corrections (audit A–E) — folded in, not patched

| Audit fix | Where it lives now |
|---|---|
| A anti-re-pick + B store-dedup | **dissolved** into BULK + the Track index (§4) |
| C value-gate | the media lane's **priority** + deliberate-promotion (§2, §4) |
| D self-model firewall | **lane isolation** (no identity auto-write, §2) + the critique-grounding fix below |
| E cleanup | janitorial: purge the 42 media dupes + the ONE contaminated `self_model` row (§9 E0) |

**Self-model write discipline (the deeper D):** identity updates must (a) **never** come from user
2nd-person critique stored as her 1st-person belief (the live bug: *"I am picking on my video jumping
around…"*), and (b) not form from sheer passive **volume** (the *"philosophical curiosity core trait"*
formed by idle-bingeing philosophy). Per Lucas's call (2026-06-29): video MAY still inform self-model, but
the critique-grounding leak is fixed and the volume-drift guard is flagged as a follow-on, not this build.

---

## 9. Slice plan (incremental, gate-green, substrate-protected)

- **E0 — janitorial cleanup (now, offline, independent):** purge the 42 `media_watch` dupes (collapse to
  15 unique), demote the off-task junk nodes, delete the contaminated `self_model` row. Read-only audit
  already done; this is a one-time guarded write + a smoke.
- **I — interface-poll layer:** generalize `lib/track.buildAnswer` into the interface's poll API +
  establish the cloud-writes-structured-output convention. **Highest leverage** — the root of "info back
  sucks." Pure-logic + smokes.
- **M — media subsystem:** BULK/STREAM/SEE + dedicated media lane + dedup-via-index + no-identity-write +
  the heartbeat pointer. Folds in audit A–D. (BULK fetch is net-new; verify transcript availability with
  `av_transcribe` fallback.)
- **MT — meeting lane:** the `awaiting_admit` 5-min hold + the sign-in-reCAPTCHA reclassify, then the
  dedicated window (shares §6 isolation with M). Offline-testable via `smoke_gmeet`.
- **N — news sentinel:** feeds-first always-on monitor + triggers + scheduled briefs. Follow-on once a
  single lane works.

These sit under the existing Tracks slices 2–4: **lanes ARE the scheduler's multi-track generalization**,
and the poll layer is the interface half of the deliverable pipeline.

---

## 10. Invariants (do-not-break)
- **One brain to the program; layering is internal.** Cloud produces structure → canvas/index; program
  assembles/indexes/schedules; interface polls + moderates + relays. Dans never produces a deliverable.
- **Lanes don't auto-write identity/interests/general-knowledge** — promotion is deliberate.
- **Each browser-holding lane is isolated** — no shared-browser contention.
- **Never defeat a CAPTCHA / sign-in.** A sign-in reCAPTCHA → ask to be signed in; a real wall → ask for help.
- **Protect the memory pipeline** — incremental, gate-green, behind the existing store.

---

## 11. Open decisions
- **Poll layer as its own slice (I) ahead of media** (recommended — it's the root) vs part of the media build.
- **Lane storage:** view over existing meta/Track tables vs a minimal `lanes` index.
- **News sentinel:** feeds-first (recommended) vs a live-video channel experience even at higher cost.
- **Self-model volume-drift guard:** evidence-threshold for identity updates — design now or defer.
