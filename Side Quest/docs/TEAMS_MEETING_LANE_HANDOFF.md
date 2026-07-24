# Teams Meeting Interface — parallel-lane handoff

**Written 2026-07-24 by the schedule-fix context, for the context building the Teams interface.**
Reference-style: it points at the real files to mirror and the exact shared surface — not a spec to
follow line by line.

## Goal
Let Zoe join + observe **Microsoft Teams** meetings the way she already does Google Meet. Lucas's work
life (Rainey Center) runs on Teams — e.g. the BGOV meeting (`BGOV | People Agent and Grants`, today
10:00 ET) is a Teams call. Today there is **zero** Teams support; the whole meeting stack is Meet-only.

## The pattern to mirror (build STANDALONE — do not refactor gmeet.js)
Build `lib/teams.js` as a parallel of [lib/gmeet.js](../lib/gmeet.js), **reusing gmeet's exported pure
helpers** rather than duplicating or refactoring them (keeps this lane collision-free; a shared
"meeting core" refactor is a *later, separate* job, not this one):

- **Reuse from `require('./gmeet')`** (all pure, already exported + smoke-tested): `parseCaptions`,
  `segmentTurns`, `parseAttendees`, `addressesSelf`, `isSelfSpeaker`, `selfNames`, `looksLikeSignOff`,
  `extractDirective`, `validateIntro`, `ensureIntro`, `introPrompt`, `parseMeetingAction`,
  `ledgerAdd`/`ledgerRows`/`renderLedger`, `meetChatOpen`/`meetIntroOn`.
- **Build new in `lib/teams.js`**: the stage machine (`start`/`get`/`set`/`runTick`/`synthesizeMeeting`)
  — it can be near-identical to gmeet's; the only real difference is the DOM layer below and the
  join/guest flow. Use its OWN meta keys (`teams_stage`, `teams_url`, …) so a Teams and a Meet session
  can't clobber each other's state.
- **DOM layer**: mirror [lib/meet_canvas.js](../lib/meet_canvas.js) → `lib/teams_canvas.js`. That's
  where the platform-specific automation lives (`CAPTIONS_JS`, `IN_MEETING_JS`, `ATTENDEES_JS`,
  `clickByLabelJS`, the driver). Teams' live-caption / attendee / "Leave" DOM is entirely different
  from Meet's — this is the bulk of the real work.
- **Recipe**: `recipes/teams_join.json` (mirror `recipes/gmeet_join.json`) — join/leave selectors in
  DATA so the fragile Teams DOM heals like Meet's.

## Shared file = main.js (3 touchpoints — YOURS to edit)
These are all far from the chat/answer region I'm editing, so no hunk overlap — but coordinate that
only ONE of us edits main.js at a time:
1. `startCanvasMeeting` ([main.js:2362](../main.js)) — add a Teams branch: mount into a
   `persist:zoe-teams` partition, **guest-join** (no `portZoeGoogleSession` — see unknowns), kick
   `teams.start()`. Consider a `startCanvasMeeting(url, title, {platform})` param over a fork.
2. join-detect wire ([main.js:5020](../main.js)) — add `detectTeamsUrl(userMessage)` beside
   `detectMeetUrl`; route a `teams.microsoft.com` link to the Teams branch.
3. driver register + idle-loop advance — `meetDriverInst` ([main.js:2324](../main.js)), the runTick
   advance (~[main.js:4146](../main.js)), and the canvas-hosted deps wire ([monologue.js:912](../lib/monologue.js))
   — register + advance the Teams driver + finalize its notes.
   Renderer: a Teams webview mount alongside the Meet pane (IPC `canvas:teams-join`, mirroring
   `canvas:meet-join` — [preload.js:45](../preload.js)).

## Lane boundary (so the two contexts don't collide)
- **You own:** every new `teams*` file, `recipes/teams_join.json`, the renderer Teams mount, and the 3
  main.js meeting-orchestration spots above.
- **You do NOT touch:** the chat/answer path in main.js (~lines 5490–6150), `lib/gmeet.js`,
  `lib/meet_canvas.js`, `lib/answer_draft.js`, `lib/week_context.js`, `lib/cognition.js` — that's my
  lane (confab guard + the just-landed schedule fix).
- **Discipline:** `git add` NAMED FILES / `git add -p` only (repo root is Desktop with unrelated
  churn — never `git add -A`). Neither context reboots under the other; whoever wants a reboot asks
  Lucas (companion in use).

## Teams-specific unknowns (the real risk — resolve these live)
- **Guest join flow**: Teams web → "Join on the web instead" → the "continue on this browser" gate →
  prejoin screen → type a name → "Join now". Likely needs NO MS account IF the meeting allows guests
  (org policy). Confirm on a real invite; if guests are blocked, Zoe needs an MS identity (bigger).
- **URL forms** (both appear in the real BGOV invite): `https://teams.microsoft.com/meet/<id>?p=<pass>`
  and `https://teams.microsoft.com/l/meetup-join/19%3ameeting_…%40thread.v2/0?context=…`.
  `detectTeamsUrl` must match both.
- **Captions**: off by default — must be enabled (More ⋯ → Language and speech → Turn on live
  captions), then scraped from Teams' own caption DOM. No Meet analog; build fresh.
- **Leave**: Teams "Leave" control selector (its own aria-label).

## Verify like gmeet
- Pure helpers → offline smoke (`scripts/smoke_gmeet.js` is the template → `scripts/smoke_teams.js`),
  run with `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_teams.js`.
- Live DOM (join/captions/attendees/leave) → iterate against a real Teams meeting; it will not be
  right first try (Meet's selectors took live iteration too).

## Timing reality
A reliable Teams join-and-observe is **not** a 2-hour build. Ship the general capability; a live
join of today's 10:00 BGOV is a stretch goal only if guest-join + the caption DOM come together fast.
Do not bank the demo on it.
