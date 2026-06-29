# Zoe Watches Media — Closed-Caption Capture Architecture (design doc)

> **Status: DRAFT for decision.** Companion to [[ZOE_HOST_ARCHITECTURE]]. Grounded in a
> read of her live browser substrate (`lib/web.js`) and the Meet caption capture
> (`lib/gmeet.js`) that this generalizes. Goal: let Zoe *watch and follow any video that
> carries captions* — starting with free media in her own browser, eventually login-walled
> streaming — the same way she already *follows a meeting*. No code yet; this locks the design.

## The goal (Lucas)
We taught Zoe to **join meetings and follow them through closed captions** — she joins muted,
introduces herself, turns CC on, and reads the live caption stream as her real-time perception
(`lib/gmeet.js`). Lucas wants to **generalize that one narrow skill into a general one**:

1. **Now:** play arbitrary videos in **her dedicated browser** with **CC turned on**, and have
   her follow along — perceive the captions live, exactly as she follows a meeting.
2. **Later:** give her access to **streaming services** so she can watch whatever media is on
   them, captions-driven, with her legitimate logins.

The meeting flow is **one instance** of a general capability: *perceive timed text rendered by a
video player in her browser.* This doc designs that general capability.

## Non-goal (the trap)
- **Do NOT bypass DRM.** Widevine/PlayReady decrypt the *video*, not the caption layer. Every
  approach here reads captions the player *already rendered* or *transcribes audio* — none touch
  the protected video path. Anything that decrypts streams is explicitly out of scope and not
  needed.
- **Do NOT build one giant per-site scraper.** Captions arrive in five different forms (below);
  a single hook can't cover them. The design is a **cascade**, not a monolith.
- **Do NOT fork a second browser/perception stack.** This rides her existing Playwright Chrome
  (`lib/web.js`) and the same "surface new lines as readings" perception wiring as gmeet.

---

## What the study found (grounded)

### A. Her browser substrate already supports this
`lib/web.js` is a **real system Chrome driven by Playwright** (`launchPersistentContext`,
own profile dir → logins/cookies survive restarts — `lib/web.js:119`). It exposes
`ensure()` → a live Playwright `page`, plus navigate/read/click/type and **arbitrary
`page.evaluate`** (the same call gmeet uses to scrape Meet's caption region —
`lib/gmeet.js:319`). Everything this doc needs — open a URL, run JS in the page, poll the
DOM, intercept network — is **already available on that `page`**. No new browser stack.

### B. The Meet capture is a narrow special case of the general problem
`lib/gmeet.js` does exactly four things this generalizes:
1. **Enable captions** — sends `Shift+C`, falls back to the CC button (`liveEnableCaptions`,
   `lib/gmeet.js:291`).
2. **Scrape the caption region** — anchors on `[role="region"][aria-label*="Captions"]`,
   reads each row by cloning it and **removing the speaker badge + avatars** (class-free,
   durable against Google's CSS churn — `lib/gmeet.js:313`).
3. **Dedupe** scrolling/mutating lines against a **seen-set** (`_seenCaps`, exact
   `speaker|text` — `lib/gmeet.js:676`).
4. **Surface** new lines into her perception as `readings` (`surface(...)`,
   `lib/gmeet.js:686`), persist to a timestamped transcript, and synthesize a running
   understanding.

Steps 3–4 are **already general** — they don't care where the lines came from. Only steps
1–2 are Meet-specific. The generalization is: **swap the Meet-specific enable+scrape for a
multi-source capture cascade; keep dedupe + perception verbatim.**

### C. Captions arrive in five forms — no single hook covers them
This is the load-bearing finding. Capture method is dictated by *how the player delivers CC*:

| Form | Examples | Read it via | Notes |
|---|---|---|---|
| **Native `<track>` / TextTrack** | Vimeo, news sites, plain HTML5 `<video>` w/ `.vtt` | `video.textTracks[].activeCues` in `page.evaluate` | Cleanest; exact cue timing; immune to CSS churn |
| **DOM-rendered overlay** | YouTube, **Google Meet**, Netflix, Disney+, HBO | Scrape the caption container (gmeet pattern, generalized) | Native `textTracks` usually empty here; player paints its own DOM |
| **Sidecar subtitle segments** | HLS/DASH streams (`.vtt`/`.ttml` per segment) | Playwright `page.on('response')` filter + parse | Format-stable; yields the *whole* track, not just the current line |
| **Burned-in / bitmap (PGS)** | DVD/Blu-ray rips, some broadcast | OCR video frames | Hard; out of scope for v1 |
| **No captions at all** | Live audio, podcasts, raw video | Audio → her ASR engine | Universal floor; touches no DRM |

### D. She already owns the ASR floor
Echo's transcription surface (`av_transcribe`, `av_download`, `transcription_capture_start/stop`,
`attend_session_*`) means the **"no captions" fallback already exists** — capture tab/system
audio, run ASR, emit lines in the same shape. This is what guarantees coverage on *anything that
makes sound*, and it's the legally cleanest path for content where DOM access is unwelcome.

---

## THE design: a capture cascade (`lib/media_cc.js`)

A new module mirroring `lib/gmeet.js`'s stage machine, but for arbitrary playback. **One
abstraction — a `CaptionSource` — with three+ implementations tried in order of robustness/
cheapness.** Each source has the same contract: `enable(page)` and `poll(page) → [{text, ts,
speaker?}]`. The orchestrator dedupes (reuse gmeet's seen-set) and surfaces lines into her
perception **identically to a meeting**.

```
lib/media_cc.js  (stage machine: none → opening → enabling → watching → done)
│
├─ CaptionSource cascade (first that yields lines wins; re-probe if it goes dry)
│   ① TextTrackSource ...... read video.textTracks[mode='hidden'].activeCues on cuechange
│   ② DomOverlaySource ..... generalized gmeet scrape; per-site container config
│   ③ NetworkTrackSource ... page.on('response') catches .vtt/.ttml/HLS-DASH subs (full transcript mode)
│   ④ AsrLoopbackSource .... tab/system audio → existing transcription engine (universal floor)
│
├─ dedupe ................... reuse gmeet seen-set (exact text|ts key)            [PORT 1:1]
├─ surface ................. onReading(line) → her perception as a "reading"      [PORT 1:1]
├─ persist ................. timestamped transcript row (db.insertTranscriptLine) [PORT 1:1]
└─ synthesize .............. running "what am I watching" understanding tick      [PORT, retuned]
```

### The `CaptionSource` contract
```
interface CaptionSource {
  name: string
  async probe(page)  -> boolean      // is this source viable on the current page?
  async enable(page) -> {ok, via}    // turn CC on (Shift+C, click, set track.mode='hidden', …)
  async poll(page)   -> Line[]        // new cue lines since last poll (raw; orchestrator dedupes)
}
```
- **① TextTrackSource** — the big generalization. `page.evaluate`: find `<video>`, for each
  text track set `track.mode = 'hidden'` (cues fire without being painted), collect
  `track.activeCues`. Platform-agnostic, exact timing, **strictly better than the Meet scrape
  wherever it works.** Probe = "does any `<video>` expose a non-empty `textTracks`?"
- **② DomOverlaySource** — exactly the gmeet trick abstracted: a tiny **per-site config**
  `{ host, containerSelector, stripSelectors }` replaces hardcoded Meet anchors. Falls back to
  the same "clone node, strip chrome, read text" extraction (`lib/gmeet.js:339`). Covers
  YouTube/Netflix/Disney where ① is empty. Probe = "does the configured container exist / does a
  caption-ish region exist?"
- **③ NetworkTrackSource** — `page.on('response')` filtering by content-type/extension
  (`text/vtt`, `application/ttml+xml`, `.m3u8` subtitle playlists). Parses the standard format.
  **Best for full-transcript mode** ("transcribe what she watched") rather than live line-by-line.
  Optional in v1.
- **④ AsrLoopbackSource** — capture tab/system audio, route to the existing transcription
  engine, emit lines in the same shape. The floor: works on anything audible, no DRM contact.

### Why a cascade, not a switch
A single video can shift forms (an ad with `<track>`, then a player that paints its own DOM).
The orchestrator **re-probes when the active source goes dry** for N ticks and promotes the next
viable source — same self-healing spirit as gmeet's recipe-heal. Sources are ordered by
*robustness × cheapness*: ① (cleanest) → ② (broad) → ④ (universal). ③ runs in parallel when
"full transcript" is requested.

---

## Streaming services — the honest picture

Two caveats, neither a blocker for what Lucas described:

- **Legality / ToS.** Reading captions off a service Zoe is **legitimately logged into**, for
  live watch-along perception, is materially different from ripping video. ①/② read what the
  browser already painted; ④ listens to audio. **None break DRM** (Widevine decrypts video, not
  the caption layer). We stay on the painted-caption / audio path and never decrypt streams.
- **Technical.** Netflix/Disney+/HBO render subtitles as **timed-text DOM overlays** over the
  video → **approach ② reaches them**; their native `textTracks` are typically empty → ① won't.
  ④ is always the backstop. Persistent-profile logins (`lib/web.js`) mean she signs in once and
  it survives restarts, like her Google account for Meet.

**Staging implication:** prove ①+② on *free* media (YouTube) before touching any login-walled
service. Logins are a per-service onboarding step (sign in once in her browser), not new code.

---

## Staging (each step de-risks the next)
1. **Slice 1 — TextTrack + DOM cascade on free media. ✅ BUILT (offline-validated; live YouTube
   run pending).** `lib/media_cc.js` stage machine (`opening → enabling → watching → done`),
   sources ① + ② in `liveReadCaptions`, dedupe + surface ported from gmeet, wired into the idle
   loop (`lib/monologue.js`, after the gmeet block) and triggered by "watch/play `<url>`"
   (`main.js`). 27/27 offline checks pass (`scripts/smoke_media_cc.js`). **Live verify on
   YouTube** (DOM overlay) and a Vimeo/HTML5 page (native track) next — the live DOM bits need her
   running app, same as gmeet's live-meeting verification.
2. **Slice 2 — running understanding + transcript. ✅ BUILT (offline-validated).** Ported
   gmeet's synthesize tick retuned for "what am I watching" (no speaker turns, no
   actions/directives/sign-off): `modelWatchUnderstanding` forms a 1–2 sentence running
   comprehension every few caption lines (or after a max-wait, for slow videos), accumulated into
   `media_understanding_log`; `synthesizeWatch` turns it into an end-of-video recap stored as
   **retrievable episodic memory** on playback-end. Her awareness line (`context.js`) now prefers
   the understanding over raw captions, and a **post-watch recall line** lets her remember a video
   she just watched for 6h. Transcript persistence shipped in slice 1. 36/36 offline checks pass.
3. **Slice 3 — ASR floor.** Wire ④ to the existing transcription engine for no-caption media and
   as the streaming backstop.
4. **Slice 4 — streaming logins.** Onboard one service (sign in once in her browser), confirm ②
   reaches its caption overlay, ④ backstops. Per-service container config as needed.
5. **Slice 5 — Transcript Studio wire.** Feed media captions into Transcript Studio alongside the
   gmeet capture (the integration already flagged in [[ZOE_HOST_ARCHITECTURE]] — "integrate Zoe's
   gmeet caption capture → into transcription studio"; media-watch rides the same wire).

## What transfers 1:1 from gmeet (keep)
- Dedupe seen-set (`_seenCaps`) and the bound on its size (`lib/gmeet.js:683`).
- `surface(content, label)` → perception-as-readings (`lib/gmeet.js:599`).
- Timestamped transcript persistence (`db.insertTranscriptLine`, `lib/gmeet.js:694`).
- The class-free "clone row, strip chrome, read text" extraction (`lib/gmeet.js:339`) → becomes
  DomOverlaySource's default extractor.
- Stage-machine shape (one stage per idle tick, strikes/heal) — `runTick` (`lib/gmeet.js:597`).

## What's new (build)
- The `CaptionSource` abstraction + the four sources (① and ② for v1).
- The **per-site overlay config** registry (host → container/strip selectors).
- The **re-probe / promote-next-source** healing loop.
- "What am I watching" synthesize prompt (retuned from the meeting recap prompt).

## Top risks to engineer against
1. **Big players leave `textTracks` empty** (YouTube/Netflix paint their own DOM) → ① alone is
   insufficient; ② must cover them. *Mitigation: cascade, not switch.*
2. **Per-site CSS churn** for ② (same problem gmeet fights with Meet) → prefer ① where present;
   keep ② extraction class-free (clone+strip) and anchor on aria/role where possible.
3. **ToS / DRM overreach** → stay strictly on painted-caption + audio paths; never decrypt.
   Document this boundary in the module header like gmeet documents its "never touch Lucas's
   shared browser" rule.
4. **Audio capture plumbing** (④) on Windows — tab vs system loopback device selection; lean on
   the existing transcription engine's device handling rather than re-inventing.
5. **"Watching" monopolizing the idle loop** — gmeet hit this (a stale `observing` starved
   cognition, `lib/gmeet.js:654`). Reuse its leave-detection discipline: bound the watch, detect
   playback-ended, exit cleanly.

## Open items
- **Live-follow vs. full-transcript** are two modes (① /② vs. ③). v1 = live-follow; confirm
  whether "transcribe the whole thing after" is wanted now or later.
- **Speaker labels** — meetings have named speakers; most media captions don't. Drop the
  speaker-turn machinery for media (it's gmeet-specific) unless a source provides names.
- **Which streaming service first** (slice 4) — pick the one Lucas most wants and that renders a
  clean caption overlay.
- **Prose-vs-grid** n/a here; this is perception, not authoring. But media transcripts likely
  want to land in the same document model / Transcript Studio as meetings (ties to
  [[ZOE_HOST_ARCHITECTURE]]).
