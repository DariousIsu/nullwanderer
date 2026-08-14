# Full Hands-Free Conversation — Spec

Status: Spec (design). Date: 2026-08-12. Builds on [TWO_WAY_VOICE_BUILD_TRACK.md](TWO_WAY_VOICE_BUILD_TRACK.md).
Target: Side Quest / Zoe (`C:/Users/azrae/Desktop/Side Quest`). Path B (native in-app loop, no media server).
Precondition: **Slice 1 (push-to-talk) is live** — `sidecar/stt_whisper.py` + `lib/stt.js` + `renderer/chat.js` PTT + `main.js stt:transcribe` + default-session mic grant. Reply is spoken by `main.js speakThroughCompanion` ([main.js:484](../main.js)).

> **BUILT 2026-08-12 (this session), pending reboot to test:** Slice 2 (conversation mode) **+ two operator overrides folded in:**
> - **Streaming voice** (pulled forward from S3): the prompted reply now speaks **sentence-by-sentence as it streams** (`createSpeechSession` + `_lastSentenceEnd` + per-sentence flush in the `chat:send` emit) instead of one synth after the whole reply lands — the "she stays quiet then dumps the whole thing" fix. Only `<say>` is spoken (the `TagStreamParser` keeps `<think>` out of the stream — verified).
> - **Unprompted speech** (reverses the §1 "text-only" boundary below, per Lucas): her autonomous **utterances** are now spoken aloud via a `voice:speak` IPC, triggered from the renderer's existing "utterance" branches in `chat.js onComplete` — the single choke point that covers auto/heartbeat/continuity/legacy. **Her thoughts/monologue/readings are NOT spoken** (only `type:'utterance'`, never `'thought'`/`'reading'`).
>
> Files touched: `main.js` (`broadcastVoiceSpeaking`, `_playWavFile`, `speakThroughCompanion` refactor, `createSpeechSession`, `_lastSentenceEnd`, streaming in `chat:send`, `voice:speak` IPC, default-session mic grant), `preload.js` (`onVoiceSpeaking`, `speak`), `renderer/index.html` (`#convo-btn`), `renderer/chat.js` (conversation loop + unprompted-utterance speak). Syntax clean; chunker logic unit-checked. **Barge-in (S3 full-duplex/AEC) and wake-word (S4) still pending.**

---

## 1. What "full conversation" means

Speak to Zoe and be spoken back to **without touching the keyboard or mouse** once conversation mode is on: the mic listens continuously, detects when you start and stop talking (endpointing), transcribes, runs the **existing** chat turn, and she replies in her GPU Kokoro voice — then it listens again. Later: interrupt her mid-reply (barge-in), and optionally enter conversation from across the room by wake phrase.

**Non-goals / boundaries (deliberate):**
- **One brain path.** Voice never builds a second turn pipeline — it drops a transcript into the same `send()` a typed message uses. Everything downstream (tools, memory, voice-out) is unchanged.
- **Her autonomous ("sheep") utterances stay text-only.** Only the prompted *reply* is spoken (verified: `speakThroughCompanion` is called only from the `chat:send` `onComplete`). Conversation mode does not start speaking her idle monologue — that would break turn-taking and open a self-trigger loop.
- **No always-on mic by default.** Conversation mode is explicitly entered (a toggle), not always listening. Wake-word/always-on is an *optional* later slice, off by default (privacy: a single-user workstation has a TV/other-people surface).

---

## 2. Turn-taking state machine (the core)

```
                 ┌───────────────────────── conversation OFF ──────────────────────────┐
                 │  IDLE  (mic closed; push-to-talk still available as before)          │
                 └───────────────▲─────────────────────────────────┬───────────────────┘
                    toggle off /  │ auto-timeout (N min silence)     │ toggle on
                                  │                                  ▼
   ┌──────────────────────────────────────────────────────────────────────────────────┐
   │ CONVERSATION MODE (mic open, echoCancellation+noiseSuppression on)                 │
   │                                                                                    │
   │   LISTENING ──VAD speech-start──▶ CAPTURING ──VAD speech-end(silence tail)──▶      │
   │      ▲                                                        TRANSCRIBING          │
   │      │                                                            │                 │
   │      │                                            empty/failed ◀──┤ text            │
   │      │                                                            ▼                 │
   │      │                                                        THINKING (chat turn)  │
   │      │                                                            │ onComplete      │
   │      │                                                            ▼                 │
   │      └──────────────── speaking-done ◀──────────────────────── SPEAKING (TTS)      │
   │                          (S2: mic suspended while SPEAKING;                          │
   │                           S3: mic stays open w/ AEC → barge-in cancels SPEAKING)     │
   └──────────────────────────────────────────────────────────────────────────────────┘
```

- **LISTENING → CAPTURING:** VAD sees energy above threshold for a short debounce (~150 ms) → start buffering audio.
- **CAPTURING → TRANSCRIBING:** VAD sees silence for the **endpoint tail** (~600–800 ms) → stop, send the buffered clip to STT.
- **TRANSCRIBING → THINKING:** non-empty transcript → `send()` (the existing path). Empty/failed → back to LISTENING (no turn).
- **THINKING → SPEAKING:** reply completes (`onComplete`) → `speakThroughCompanion` plays the reply.
- **SPEAKING → LISTENING:** playback finishes → reopen the ear. **This is why the renderer needs a "speaking done" signal** (see §4).

---

## 3. Conversation-mode lifecycle

- **Enter:** a toggle in the composer (a 🎙️ **conversation** button next to 🎤 speak), or a hotkey. Push-to-talk (Slice 1) remains for one-shot use.
- **Exit:** toggle off; or auto-timeout after N minutes with no user speech (default 3 min) so a forgotten-open mic self-closes; or on window blur (optional).
- **Visible state:** the button reflects the machine — `LISTENING` (idle green), `● you're talking`, `… transcribing`, `speaking…` (ear closed). The user always knows if the mic is hot.
- **Interaction with push-to-talk:** entering conversation mode disables the manual 🎤 tap (avoid two capture owners); leaving re-enables it.

---

## 4. Self-hearing / duplex strategy (the crux)

The moment the mic is open **while she speaks**, it captures her own TTS from the speakers → STT transcribes her voice → she answers herself. This is the central hard problem and it defines the slice boundary:

- **S2 = half-duplex (no self-hearing by construction).** The ear is **suspended while SPEAKING** and reopened only when playback finishes. No AEC required. Needs a **"speaking start/done" signal** from main → renderer:
  - `main.js speakThroughCompanion` emits `voice:speaking {on:true}` before playback and `voice:speaking {on:false}` when it ends. The live path today is the OS speakers-fallback (`SoundPlayer.PlaySync` via `execFile`, whose callback = playback finished — a clean done signal). The companion-window path (when `ZOE_COMPANION=1`) is async; for now conversation mode assumes the speakers path (companion-done reporting is a follow-up).
  - Renderer suspends the VAD/capture on `on:true`, resumes on `on:false` (+ a small guard delay).
- **S3 = full-duplex barge-in (requires AEC).** To interrupt her, the mic must stay open during SPEAKING. Strategy:
  - Route the reply audio into the **chat renderer's** Web Audio graph (it already receives the `companion:speak {url, silent:true}` fan-out — [main.js:501](../main.js)) so Chromium's WebRTC **echoCancellation uses the render stream as the reference** and subtracts her voice from the mic capture. (Suppress the OS-fallback double-play while conversation mode owns playback.)
  - VAD runs on the AEC-cleaned mic. Residual echo stays below the speech threshold; the user's real voice crosses it → **barge-in**: pause playback, flush the resident Kokoro `--serve` queue, transition to CAPTURING.
  - ⚠ **Spike before trusting:** confirm Chromium AEC actually cancels same-renderer `HTMLAudioElement`/Web-Audio playback on this box. If AEC is insufficient, fall back to threshold-only barge-in (a loud deliberate interrupt) or a "stop" key.

---

## 5. VAD / endpointing

- **S2 V1 — RMS energy gate (zero-dependency, build first).** `AudioContext` + `AnalyserNode` on the mic stream; compute short-window RMS; speech-start when RMS > threshold for ~150 ms; speech-end when RMS < threshold for the endpoint tail (~700 ms). Thresholds + tail exposed as tunables. Crude but fine in a quiet room with `noiseSuppression` on, and it proves the whole loop.
- **S2 V2 — Silero VAD (upgrade if V1 is trigger-happy/laggy).** `onnxruntime-web` is **already in `node_modules`**; vendor `silero_vad.onnx` + the ort wasm into `renderer/vendor/` (CSP: self-hosted, no CDN) and run it in the renderer (or lift `@ricky0123/vad-web`). Frame-accurate speech probability → far fewer false fires. Same state machine; swap the detector.

---

## 6. Slices (each independently testable)

| Slice | Adds | Files | Accept | Reboot |
|---|---|---|---|---|
| **S1 ✅ done** | push-to-talk single turn | (shipped) | tap → speak → spoken reply | done |
| **S2 Conversation mode (half-duplex)** | 🎙️ toggle; continuous RMS-VAD endpointing; auto-send via `send()`; ear suspended while SPEAKING via `voice:speaking` signal; auto-timeout | `renderer/chat.js`, `renderer/index.html`, `preload.js` (`onVoiceSpeaking`), `main.js` (emit `voice:speaking` around playback) | Toggle on → speak naturally (no tap) → she replies → it listens again; speaking never self-triggers; 3-min silence auto-exits | **Yes** (main+preload) |
| **S2.5 Silero VAD** *(only if RMS too crude)* | vendor Silero+ort → frame-accurate endpointing | `renderer/vendor/*`, `renderer/chat.js` | far fewer false fires in normal room noise | No |
| **S3 Barge-in (full duplex)** | **BUILT 2026-08-12 (pending test):** reply audio now plays IN the chat renderer (`voice:play`/`voice:play-done` handshake; `mainWindow` `autoplayPolicy:'no-user-gesture-required'`) so Chromium AEC subtracts it from the mic; `_speech` gained `gen`+`flush()` for barge cancel; renderer barge window (`BARGE_RMS`/`BARGE_MS`, polls 40ms) → `bargeIn()` flushes + captures the interruption; **echoPeak instrumented** to judge AEC; gated by meta `barge_in` (half-duplex fallback). ⚠AEC efficacy on this box unproven → read the `residual echo peak` console logs. | `main.js`, `preload.js`, `renderer/chat.js` | talk over her → she stops <~300 ms, your utterance captured; no self-hearing | **Yes** |
| **S4 Wake-word / always-on** *(optional)* | lift `echo/voice/wakeword.py` `WakeWordGate` into a CPU sidecar; wake phrase enters conversation mode hands-free | `sidecar/wakeword.py`, `lib/wakeword.js`, `main.js` | say the phrase across the room → enters LISTENING; ambient TV doesn't trigger | **Yes** |

Trajectory: **S2 is the "full conversation" MVP** — hands-free, natural turn-taking, safe (half-duplex). S3 makes it interruptible. S4 makes entry hands-free.

---

## 7. Forks + recommended defaults

1. **Always-on vs click-to-enter.** *Default: click-to-enter conversation mode* (the 🎙️ toggle). "Full conversation" = hands-free *within* a session you opened, not an always-hot mic. S4 wake-word is the opt-in path to fully hands-free entry. → Recommend building S2+S3; treat S4 as optional.
2. **Barge-in latency (S3).** *Default: ~300 ms via sentence-chunked TTS.* Sub-150 ms needs true frame-streaming TTS (larger sidecar rework) — defer unless it feels laggy.
3. **Wake phrase (only if S4).** Ship bundled `hey jarvis`/`hey mycroft`; custom "hey zoe" is a ~1–2 hr openWakeWord train, fast-follow.
4. **Endpoint tail length (S2).** *Default 700 ms* silence = end-of-utterance. Tunable; too short clips mid-sentence pauses, too long feels sluggish.

---

## 8. Risks

- **Self-hearing** — solved by construction in S2 (half-duplex); the real risk lives in S3 (AEC efficacy on this stack) — spike first, threshold-only fallback.
- **VAD false fires** (RMS) — mitigate with `noiseSuppression`, debounce, and the Silero upgrade path (S2.5).
- **`voice:speaking` done-signal only covers the speakers path** today (SoundPlayer callback). If `ZOE_COMPANION=1` later, the companion window must report playback-end too — noted, not built.
- **Auto-timeout** is mandatory so a forgotten-open mic self-closes.
- **Mic surface** — conversation mode holds an open mic on Zoe's own window; visible state + auto-timeout + explicit toggle are the guards. No always-on without S4 + an explicit opt-in.
- **Do not regress Slice 1 or the shipped voice.** PTT and `speakThroughCompanion` stay working; conversation mode is additive.
