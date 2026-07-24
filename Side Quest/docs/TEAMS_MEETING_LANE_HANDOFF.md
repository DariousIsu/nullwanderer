# Teams Meeting Interface — parallel-lane handoff

**Written 2026-07-24 by the schedule-fix context, for the context building the Teams interface.**
Reference-style: it points at the real files to mirror and the exact shared surface — not a spec to
follow line by line.

> **UPDATE 2026-07-24 (Lucas):** Zoe now has her OWN Teams account — so the plan flips from anonymous
> guest-join to **authenticated join**, mirroring the Meet path exactly. Touchpoint 1 and the
> "Authenticated join flow" unknown below are already revised for this: DO port her session (a
> `portZoeTeamsSession` analog of `portZoeGoogleSession`), do NOT guest-join. Prereq: sign her Teams
> account into her DEDICATED browser once (that's the cookie-port source — MS, like Google, blocks
> interactive sign-in inside an embedded webview).
>
> **Settled 2026-07-24:** it's a **personal** MS account and it's ALREADY signed into her dedicated
> browser — so `portZoeTeamsSession` has cookies to copy today (source domains `login.live.com` /
> `teams.live.com` / `teams.microsoft.com`), no setup step. Because it's a personal (external) account,
> she WILL land in the **lobby** on Lucas's org meetings (e.g. BGOV) and wait for the host to admit — so
> the Teams stage machine needs a **waiting/lobby stage gmeet has no analog for**.

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
  — mostly parallels gmeet's, but with three real differences: the DOM layer below, the auth/join flow,
  and a NEW **lobby/waiting stage** (joining → waiting → intro → …) gmeet has no analog for — Teams drops
  her (an external personal account) in a lobby until the host admits her. Use its OWN meta keys
  (`teams_stage`, `teams_url`, …) so a Teams and a Meet session can't clobber each other's state.
- **DOM layer**: mirror [lib/meet_canvas.js](../lib/meet_canvas.js) → `lib/teams_canvas.js`. That's
  where the platform-specific automation lives (`CAPTIONS_JS`, `IN_MEETING_JS`, `ATTENDEES_JS`,
  `clickByLabelJS`, the driver). Teams' live-caption / attendee / "Leave" DOM is entirely different
  from Meet's — this is the bulk of the real work.
- **Recipe**: `recipes/teams_join.json` (mirror `recipes/gmeet_join.json`) — join/leave selectors in
  DATA so the fragile Teams DOM heals like Meet's.

## Shared file = main.js (4 touchpoints — YOURS to edit)
These are all far from the chat/answer region I'm editing, so no hunk overlap — but coordinate that
only ONE of us edits main.js at a time:
1. `startCanvasMeeting` ([main.js:2362](../main.js)) — add a Teams branch: mount into a
   `persist:zoe-teams` partition, **authenticated join** — add a `portZoeTeamsSession()` mirroring
   `portZoeGoogleSession` ([main.js:2341](../main.js)) that copies her Microsoft/Teams cookies
   (personal MS account → `login.live.com` / `teams.live.com` / `teams.microsoft.com`) from her dedicated
   browser into `persist:zoe-teams` BEFORE the pane loads, then kick `teams.start()`. (She's signed into Teams on
   her dedicated browser; MS blocks interactive sign-in inside a webview, same as Google — port the authed
   cookies, don't sign in in-pane.) Consider a `startCanvasMeeting(url, title, {platform})` param over a fork.
2. join-detect wire ([main.js:5020](../main.js)) — add `detectTeamsUrl(userMessage)` beside
   `detectMeetUrl`; route a `teams.microsoft.com` link to the Teams branch.
3. driver register + idle-loop advance — `meetDriverInst` ([main.js:2324](../main.js)), the runTick
   advance (~[main.js:4146](../main.js)), and the canvas-hosted deps wire ([monologue.js:912](../lib/monologue.js))
   — register + advance the Teams driver + finalize its notes.
   Renderer: a Teams webview mount reusing the SINGLE meeting pane, parameterized by platform (one
   meeting at a time — pick partition + URL + driver per platform; do NOT add a 2nd parallel pane). IPC
   `canvas:teams-join`, mirroring `canvas:meet-join` — [preload.js:45](../preload.js).
4. **partition permissions (easy to miss — load-bearing)** — `configureZoeMeetPartition`
   ([main.js:293](../main.js)) grants `media`/`audioCapture`/`videoCapture`/`display-capture` to the
   `persist:zoe-google` session so `getUserMedia` works inside the webview. The `persist:zoe-teams`
   partition needs the SAME grant (add a `configureZoeTeamsPartition`, or generalize this one to take a
   partition name), wired BEFORE the Teams webview loads. Miss it and Teams' prejoin device access hangs
   **silently** — a webview has no chrome to click "Allow", so there's no manual fallback, and even
   muted the prejoin screen requests devices to render the mic/cam preview.

## Lane boundary (so the two contexts don't collide)
- **You own:** every new `teams*` file, `recipes/teams_join.json`, the renderer Teams mount, and the 4
  main.js meeting-orchestration spots above.
- **You do NOT touch:** the chat/answer path in main.js (~lines 5490–6150), `lib/gmeet.js`,
  `lib/meet_canvas.js`, `lib/answer_draft.js`, `lib/week_context.js`, `lib/cognition.js` — that's my
  lane (confab guard + the just-landed schedule fix).
- **Discipline:** `git add` NAMED FILES / `git add -p` only (repo root is Desktop with unrelated
  churn — never `git add -A`). Neither context reboots under the other; whoever wants a reboot asks
  Lucas (companion in use).

## Teams-specific unknowns (the real risk — resolve these live)
- **Authenticated join flow** (personal MS account, already signed into her dedicated browser): Teams web
  → "continue on this browser" gate → prejoin screen (already signed in as her — no name to type) →
  "Join now" → **lobby** (external to Lucas's tenant → the host must admit her; build the waiting stage —
  gmeet has no analog). `portZoeTeamsSession` can copy her cookies today; no setup outstanding.
- **In-meeting chat policy for external participants** (gates the MANDATORY disclosure intro): some org
  meeting policies disable or restrict chat for external/guest participants. If chat is off for her, she
  CANNOT post the required "I'm an AI here on Lucas's behalf" disclosure — so that must gate whether she
  joins at all, NOT silently observe undisclosed. Confirm on a real org invite; audio-loopback perception
  ([lib/meeting_audio.js](../lib/meeting_audio.js)) still works, but presence-without-disclosure does not.
- **URL forms** (both appear in the real BGOV invite): `https://teams.microsoft.com/meet/<id>?p=<pass>`
  and `https://teams.microsoft.com/l/meetup-join/19%3ameeting_…%40thread.v2/0?context=…`.
  `detectTeamsUrl` must match both.
- **Captions**: off by default — must be enabled (More ⋯ → Language and speech → Turn on live
  captions), then scraped from Teams' own caption DOM. No Meet analog; build fresh.
- **Leave**: Teams "Leave" control selector (its own aria-label).
- **Embedded-webview UA (test this FIRST — "does Teams kick the pane")**: Teams web is fussier than Meet
  about browser support — an Electron `<webview>` may hit "your browser isn't supported / get the app".
  Set the webview's `useragent` to a current Chrome/Edge string so Teams accepts it. Meet needs no such
  override; Teams likely does. If even a UA override won't load it, the canvas route is blocked and Teams
  falls back to her dedicated browser (lib/web.js) — the thing we're trying to avoid.

## Verify like gmeet
- Pure helpers → offline smoke (`scripts/smoke_gmeet.js` is the template → `scripts/smoke_teams.js`),
  run with `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_teams.js`.
- Live DOM (join/captions/attendees/leave) → iterate against a real Teams meeting; it will not be
  right first try (Meet's selectors took live iteration too).

## Timing reality
A reliable Teams join-and-observe is **not** a 2-hour build. Ship the general capability; a live
join of today's 10:00 BGOV is a stretch goal only if guest-join + the caption DOM come together fast.
Do not bank the demo on it.
