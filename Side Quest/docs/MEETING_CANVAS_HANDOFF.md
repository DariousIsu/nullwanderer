# Meeting-in-Canvas + Scribe — handoff to the Zoe-building context

Built in the Side Quest (calendar/canvas) context. This is the seam where it crosses into Zoe's
meeting cognition — handing off here. Everything below is on disk, syntax-clean, smoke-green, and the
app runs. **Not yet committed** (checkpoint pending — see end).

## Goal (Lucas's vision)
**All roads → Canvas.** Every meeting join (calendar "Zoe: Join", a Meet link in chat, autonomous)
opens Google Meet *inside Zoe's Canvas pane*, freeing her dedicated CDP browser. She keeps her FULL
current meeting behavior **+ more**, split into two model channels:
- **Actor (her)** — listens, researches what she hears, answers when addressed. *Untouched* (gmeet).
- **Scribe (new, separate)** — records / documents / analyzes (running minutes + final recap) on its
  OWN dedicated cloud model. Must never be confused with or slow her actor.

## What's built + VERIFIED
- **Meet-in-canvas pane** (`renderer/canvas.{html,js}` `#meetpane`): fixed floating webview
  (`partition="persist:zoe-google"`, Chrome UA, draggable/resizable/min/close, drag-shield). main
  grants camera/mic to that partition only (`configureZoeMeetPartition`), `webviewTag:true`, captures
  the guest webContents on `did-attach-webview`, and **mutes the pane's audio output**
  (`setAudioMuted(true)`) — she follows via captions, so no echo. ✅ echo fixed, ✅ verified.
- **Sign-in AS HER without the webview block:** Google blocks interactive sign-in in embedded webviews
  ("Couldn't sign you in / browser may not be secure"). Solved by **porting her live Google cookies**
  from her already-signed-in dedicated browser into the partition before the pane loads
  (`portZoeGoogleSession` in main → `web.cookies()` in `lib/web.js` → `session.fromPartition(...).cookies.set`).
  ✅ she signs in perfectly now.
- **The "new body" for her actor:** `lib/meet_canvas.js` `createMeetDriver(getWC)` implements gmeet's
  hooks (preClear/joinNow/enableCaptions/scrapeCaptions/scrapeAttendees/postChat/inMeeting/leave) via
  `guest.executeJavaScript` + `sendInputEvent`. `canvasMeetDeps()` returns gmeet's DI shape backed by
  the driver, so **gmeet's SAME tested stage machine runs through the canvas — gmeet.js UNCHANGED.**
- **All join routes → canvas:** `startCanvasMeeting(url,title)` in main (ports cookies → mounts pane →
  `gmeet_host='canvas'` → `gmeet.start`). Wired to `meet:join` IPC (calendar "Zoe: Join" / detail
  button via `sq.joinMeet`) AND the chat-link detector (main.js ~2073). monologue gmeet tick picks
  canvas deps when `gmeet_host==='canvas'`.
- **The SCRIBE:** `lib/meeting_scribe.js` — separate recorder on `config.scribeModel()` =
  **`gemini-3-flash-preview:cloud`** (env `ZOE_MEETING_SCRIBE_MODEL`). Reads `meeting_transcript`
  (what gmeet already persists), refreshes running minutes every 6 lines, writes final recap as
  durable memory at meeting end. Wired in `lib/monologue.js` AFTER the gmeet tick (orchestration only,
  gmeet untouched) + a finalize-on-end check. `streamChat` gained an optional top-level `think` param.
  Smoke `scripts/smoke_meeting_scribe.js` 12/12. gemini probed live: **~2.83s** for a 6-line minutes
  update (350 thinking + full minutes). NOTE: gemini **always thinks** (`think:false` not honored via
  Ollama) → budget is 1200 tok so thinking + minutes both fit.
- **Models:** actor = `gemma4:31b-cloud` (= `meetingModel()`, unchanged); scribe =
  `gemini-3-flash-preview:cloud` (new dedicated channel). web-search plumbing reused as-is, driven by
  the actor.
- **QoL (unrelated):** `lib/window_state.js` persists position/size/maximized for all 4 windows
  (main/editor/workspace/canvas) to `data/window_state.json`. Restores next launch.

## NOT yet verified live (needs a real meeting)
- Full canvas join → muted join → intro post → caption follow → answer-when-addressed → leave, driven
  by the driver's `executeJavaScript` selectors. Meet rotates DOM classes — the join/postChat/leave
  selectors in `lib/meet_canvas.js` (and gmeet's recipes don't apply to the webview) may need tuning
  against the live pane. `window.sq.meetProbe()` (any console) reads live `{inMeeting, captionLines,
  captionsSample, attendees}` to debug scrape.
- Scribe running against a real live transcript (smoke used injected deps).

## What's LEFT (the Zoe-builder's lane)
1. **Decouple the scribe onto its OWN heartbeat** (like `media_cc` caption heartbeat) so it runs truly
   in parallel and can never serialize with / slow her actor tick. Today it's a sequential call in the
   monologue gmeet tick. Small refactor: a dedicated interval started on canvas-meeting begin, stopped
   at end. **Recommended next step.**
2. **Caption/transcription source = BOTH, fused** (Lucas): currently the actor scrapes Meet captions
   from the webview; the scribe reads that transcript. Echo audio transcription (attend_session /
   transcription_capture) is NOT wired to the canvas — fuse audio transcription + captions into one
   timeline feeding the scribe. CHECK whether Echo transcription grabs SYSTEM audio (window-agnostic,
   works regardless) or browser audio (must repoint). gemini-3-flash is multimodal → a path to the
   scribe ingesting meeting AUDIO directly later.
3. **`lib/media_cc`** caption overlay + the autonomous "G Meet Step 2" participation still assume the
   dedicated CDP browser in places — audit for the canvas path.
4. Selector hardening for the driver against live Meet DOM (see above).

## Files touched (this context)
`renderer/canvas.{html,js}`, `lib/meet_canvas.js` (new), `lib/meeting_scribe.js` (new),
`scripts/smoke_meeting_scribe.js` (new), `lib/window_state.js` (new),
`main.js` (meet:join/meet:probe/startCanvasMeeting/portZoeGoogleSession/partition+webview/audio-mute/
window-state wiring), `preload.js` (sq.joinMeet/onMeetJoin/meetProbe), `lib/config.js`
(meetingModel/scribeModel), `lib/ollama.js` (think passthrough), `lib/monologue.js` (canvas deps
selection + scribe tick/finalize), `lib/web.js` (cookies export), `renderer/calendar.{html,js}`
(Slice 6 Join buttons → joinMeet). gmeet.js: **NOT touched.**

## Reboot/verify
Judge live by electron proc count + port 8765, not the npm exit code (wrapper reports 127 on detach).
`gemini-3-flash-preview:cloud` resolves via the local daemon (ollama.com cloud auth). Calendar Slices
0–3 are already committed (5f5b1ce); everything above is the uncommitted checkpoint.
