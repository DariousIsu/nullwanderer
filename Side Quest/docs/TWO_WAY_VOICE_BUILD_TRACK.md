# Two-Way (Full-Duplex, Hands-Free) Local Voice — Build Track

Status: Decision-ready. Author: lead architect. Date: 2026-08-12.
Target app: Side Quest / Zoe (`C:/Users/azrae/Desktop/Side Quest`, package `zoe-lane`, `main.js`).
Hardware: Windows 11, AMD RX 7900 XT, native ROCm (HIP device 1), torch ROCm 2.12 (HIP 7.2), single user.

---

## 1. RECOMMENDATION — Build B: a NATIVE in-app loop, no media server

**Decision: Path B.** Build the two-way loop entirely inside the Side Quest Electron process: renderer `getUserMedia` mic → VAD/endpointing → a faster-whisper STT sidecar (NDJSON, CPU int8) → the existing Zoe chat turn → the already-shipped GPU Kokoro TTS sidecar → renderer playback + VRM lip-sync, with a barge-in controller that pauses playback and flushes the TTS queue on speech-start. No WebRTC, no SFU, no LiveKit.

### Why B wins

1. **The hard seams already exist and are live in this app.** Three of the four heavy pieces are shipped and proven in Side Quest today:
   - GPU TTS out: `sidecar/tts_kokoro.py` (torch KModel on ROCm `cuda`, `HIP_VISIBLE_DEVICES=1`, Zoe's real blend from `data/voices/zoe_voice.json` — af_bella 0.318 / af_nicole 0.273 / bf_isabella 0.409, British, speed 1.13), driven resident via `lib/tts.js:181-188` over the same NDJSON `--serve` contract as Piper.
   - Playback + barge-in cancel point: `renderer/kg3d.js` `window.sq.onCompanionSpeak({url})` (~L3769) → `faceAttachAudio(url)` → `new Audio(url)` kept as `face.audioEl` (~L1326-1337); `avatar.js` mirrors it for VRM lip-sync. The play handle and the cancel target already exist.
   - Mic permission pattern: `main.js:330-345` already grants `media`/`audioCapture` on the `persist:zoe-google` and `persist:zoe-teams` meeting partitions via `setPermissionRequestHandler`/`setPermissionCheckHandler`. Extending it to the default renderer session is a ~4-line mirror.

2. **Path A (LiveKit Phase-4C) never ran end-to-end and carries structural weight this box does not need.**
   - It is scaffolding, not a loop: only 4C.0–4C.3 are built. No wakeword gate, no curator/LLM wiring, no Kokoro TTS, no barge-in, no persistence; the STT plugin exists but is not wired into the agent (agent still only heartbeats). Doc header itself: "Design locked; implementation pending."
   - It is **not installed** here: Echo's `.venv` has only an empty `livekit/plugins/silero` namespace stub — `import livekit.agents/.rtc/.api` all `find_spec -> None`, zero `livekit*` pip metadata. Standing it up means fetching the pinned `livekit-server.exe` v1.12.0 (network), installing `livekit-agents` (which clashes with crewai/arize-phoenix on wrapt 1.x), and running two extra managed sidecars + a WebRTC room — a 3-tier topology (renderer ⇄ livekit-server.exe ⇄ python agent).
   - LiveKit's one genuine draw is the **semantic turn detector / multi-party SFU** — value for rooms with many participants. This is a **single-user, single-box, loopback** deployment. We pay all the infra weight for a feature we don't use.
   - Its whole pipeline is CPU-only (kokoro-onnx CPU with the broken DirectML/AMD ConvTranspose path, faster-whisper CPU, Silero ONNX CPU) and speaks the wrong voice (`af_heart` placeholder, not Zoe). To reuse it we'd rip out and replace the STT/TTS device layer anyway — so the "reuse" is illusory.

3. **Path C (hybrid: keep LiveKit transport, swap brain+TTS) inherits A's biggest liability — the never-run SFU coupling — for zero benefit on a loopback single-user box.** Everything in the session/agent layer is hard-bound to a running `livekit-server.exe` + `rtc.Room` + `AgentSession`; `session.start()` cannot function without the server. There is also an unverified version risk: the code's `turn_handling` dict assumes a `livekit-agents` API that may not match the pinned release (`AgentSession(**kwargs)` would raise at construction). A media server between a renderer and a python process **on the same machine** is pure latency and failure surface. C loses.

4. **ROCm/device math is clean for B.** TTS on the 7900 XT (cuda:0 under ROCm, ~63 MB model, ~20 GB VRAM — no contention). STT stays CPU int8 `base` (ctranslate2 has **no** ROCm/HIP backend; `get_cuda_device_count()==0`; onnxruntime here exposes only CPU/Azure EPs) — Echo's own measured `base` int8 was RTF ~19.86× (sub-second for a 10 s utterance), fast enough. VAD is tiny (renderer wasm or CPU ONNX). Zero VRAM contention, no GPU STT chase needed. This is exactly the device split the prior ROCm-for-STT veto already validated.

### What we lift from Echo (adapt, don't run)

- `echo/voice/stt_whisper.py` transcribe **core** — `_frame_to_float32_16k`/`_resample` (int16→float32, 48k→16k), the silence guard (`np.abs(audio).max() < 1e-4` to stop Whisper hallucinating on quiet), `WhisperModel(base, device='cpu', compute_type='int8')`. Strip the `from livekit.agents import stt` wrapper and the `stt.STT` subclass; wrap the core in an NDJSON sidecar modeled on `sidecar/tts_kokoro.py`.
- `echo/voice/wakeword.py` `WakeWordGate` state machine (openWakeWord ONNX, bundled `hey_jarvis`/`hey_mycroft`, 1280-sample/16kHz/80ms chunks, IDLE→LISTENING→PROCESSING, `arm_done()` re-arm, 30 s timeout) — lift-as-is for the later always-on phase; it's CPU-cheap and the only ready listen-gate in either repo.
- Drop the empty `.venv/livekit/*` stub; nothing functional depends on it.

---

## 2. SLICE 1 — First runnable slice (PUSH-TO-TALK, single turn)

> **STATUS 2026-08-12: CODE-COMPLETE + BACKEND-PROVEN LIVE; pending in-app activation (reboot).**
> Built: `sidecar/stt_whisper.py` (NDJSON, faster-whisper `base` int8 CPU, decodes webm/opus via PyAV,
> silence-guard lifted from Echo), `lib/stt.js` (resident sidecar mgr reusing `lib/tts.js` `parseNdjson`),
> `scripts/smoke_stt.js` (live TTS→STT round-trip). Wired: `preload.js` (`sq.sttTranscribe`),
> `renderer/index.html` (`#mic-btn`), `renderer/chat.js` (PTT → `send()`), `main.js` (default-session mic
> grant + `stt:transcribe` IPC).
> **⚠ kg3d.js reconciliation:** the draft said edit `renderer/kg3d.js` — that file is OFF-LIMITS (kg-viz
> STOPPED). Not needed: PTT lives at the chat-input seam (`chat.js` `send()`), and reply playback already
> runs via `main.js speakThroughCompanion` (companion or the speakers-fallback). No kg3d.js touch.
> **Proof:** `smoke_stt.js` PASS — STT recovered "The quick brown fox…" (880 ms, CPU) from a Kokoro wav;
> a separate check decoded a **webm/opus** clip (798 ms), the renderer's real capture format. Node syntax
> clean on all 6 touched files. **Not yet proven:** the in-app UI loop (mic button → getUserMedia → spoken
> reply) — needs an app reboot to load the main/preload/sidecar changes (ask + live-guard per request-reboots).


**Goal:** prove the loop end-to-end with the least moving parts. Hold a key (or click a mic button) → speak → release → transcript enters the existing chat turn exactly as if typed → Zoe's reply is spoken by the shipped GPU Kokoro voice. **No VAD, no barge-in, no wakeword, no media server.**

Endpointing in Slice 1 = the push-to-talk key itself (press = start capture, release = end utterance). This removes the only genuinely new algorithmic risk (endpointing) from the proving slice.

### STT engine + device (Slice 1)
- Engine: `faster-whisper` 1.2.1 (CTranslate2), model `base`, `device='cpu'`, `compute_type='int8'`, `beam_size=5`, `cpu_threads=0` (all cores). Already importable in the Kokoro venv.
- Call `prewarm()`/load once at sidecar `--serve` boot so first utterance doesn't pay the ~150 MB HF cache download + model load. Bundle/pre-download the `base` model so it works offline.
- GPU STT is explicitly out of scope (no ROCm ctranslate2, no CUDA/DirectML EP here) — reserve the 7900 XT for Kokoro.

### Files to CREATE
- `C:/Users/azrae/Desktop/Side Quest/sidecar/stt_whisper.py`
  - NDJSON `--serve` resident sidecar mirroring `sidecar/tts_kokoro.py`'s contract: read one JSON job `{in: <wav/pcm path or base64>, sampleRate}` from stdin → transcribe → write `{ok, text, ms}` to stdout. Guts = the lifted `stt_whisper.py` transcribe core (resample + silence guard + `WhisperModel.transcribe(vad_filter=False)`), **with the LiveKit `stt.STT` wrapper removed**. Load model on boot.
- `C:/Users/azrae/Desktop/Side Quest/lib/stt.js`
  - Resident-child manager mirroring `lib/tts.js`'s `createPiperService` machinery (spawn `KOKORO_VENV_PY sidecar/stt_whisper.py --serve`, NDJSON round-trip, idle-respawn). Exports `transcribe(wavPathOrPcm) -> {text}`.
- `C:/Users/azrae/Desktop/Side Quest/renderer/voice-ptt.js`
  - Renderer module: on push-to-talk keydown → `getUserMedia({audio})` + `MediaRecorder`/`AudioWorklet` capture to a Blob; on keyup → hand PCM/WAV to main via a new IPC (`window.sq.sttTranscribe(buf)`), receive text, then inject that text into the **existing chat turn** exactly as the typed-input path does (reuse the current send-message function — do not build a second brain path).

### Files to EDIT
- `C:/Users/azrae/Desktop/Side Quest/main.js`
  - Add default-session mic grant (~4 lines mirroring L330-345): `session.defaultSession.setPermissionRequestHandler`/`setPermissionCheckHandler` allowing `media`/`audioCapture` for the main renderer origin.
  - Register IPC `sttTranscribe` → `lib/stt.js.transcribe(...)` → return text; register push-to-talk plumbing if a global/app shortcut is used.
- `C:/Users/azrae/Desktop/Side Quest/lib/tts.js`
  - No engine change needed (Kokoro `--serve` already resident). Confirm the reply from the chat turn routes to `onCompanionSpeak` as today.
- `C:/Users/azrae/Desktop/Side Quest/renderer/kg3d.js`
  - Wire `voice-ptt.js` into the renderer boot; reply playback already handled by the existing `onCompanionSpeak`→`faceAttachAudio` path (no change to playback itself).
- `C:/Users/azrae/Desktop/Side Quest/preload*` (whichever exposes `window.sq`)
  - Expose `sttTranscribe` and the PTT hooks on the `window.sq` bridge.

### Acceptance test (Slice 1)
1. Launch Side Quest. Hold the PTT key, say "What's on my calendar today?", release.
2. Within ~1–1.5 s of release, the exact same chat turn fires that a typed message would (verify one turn, one trajectory row — no duplicate brain path).
3. Zoe's reply is spoken in her real GPU Kokoro blend (British, the `zoe_voice.json` recipe) through the speakers, with VRM lip-sync moving.
4. No `livekit-server.exe` process exists; no WebRTC. `HIP_VISIBLE_DEVICES=1` Kokoro sidecar is the only GPU consumer; STT sidecar runs on CPU.
5. Round-trip (release → first audio) logged; STT transcription time logged separately to confirm CPU int8 `base` is sub-second on a ~5–10 s utterance.

---

## 3. Phase ladder: Slice 1 → full hands-free

| Phase | Adds | Acceptance | Reboot? |
|---|---|---|---|
| **S1 Push-to-talk** | mic → CPU STT sidecar → existing chat turn → GPU Kokoro out | Held-key single turn speaks Zoe's reply; no media server, no dup turn | Yes (new sidecar + main.js perms/IPC) |
| **S2 VAD endpointing** | replace the key with speech start/stop detection — V1 = renderer RMS energy gate; V2 = `@ricky0123/vad-web` (Silero ONNX wasm) in the renderer so raw frames never leave it for endpointing | Speak without holding a key; utterance auto-slices; silence < ~600 ms tail cuts it; false-fire rate acceptable in a quiet room | No (renderer JS + IPC tweak; hot-reloadable) |
| **S3 Barge-in** | a controller that on VAD speech-start pauses `face.audioEl` and signals main to flush the resident Kokoro `--serve` queue / skip pending sentence jobs; chunk reply text per **sentence** so time-to-first-audio drops and cancel granularity is finer (Kokoro is batch-per-utterance today) | Start talking mid-reply → Zoe's speech stops < ~300 ms and the new utterance is captured; no orphaned audio | No (renderer controller + a flush IPC + sentence chunking in `lib/tts.js`) |
| **S4 Wakeword / always-on** | lift `echo/voice/wakeword.py` `WakeWordGate` into a small CPU sidecar/worker; mic always open, openWakeWord gates STT (`hey jarvis`/`hey mycroft` bundled; custom `hey zoe` via ~1–2 hr openWakeWord training later); state machine `arm_done()` re-arms after each reply | Say the wake phrase from across the room → Zoe enters listening, transcribes one utterance, replies, re-arms; ambient TV/podcast does not trigger the curator at tuned threshold | Yes (new resident wakeword worker + boot wiring); a mic-disable toggle / PTT fallback must ship alongside |

Sentence-chunked streaming TTS (S3) is the one place we outgrow the current one-WAV-per-utterance sidecar; keep the NDJSON contract but let `lib/tts.js` submit per-sentence jobs and play them gaplessly, which also makes barge-in cancel cheap.

---

## 4. Risks + open decisions for Lucas

**Decisions that fork the build:**

1. **Wake phrase.** openWakeWord has no pre-trained "hey zoe" / "hey echo". Ship an off-the-shelf phrase (`hey jarvis`/`hey mycroft`) now and custom-train "hey zoe" later (~1–2 hr pipeline), or invest in the custom model before S4 ships? Default recommendation: ship `hey jarvis` in S4, train "hey zoe" as a fast-follow. **Needs Lucas.**

2. **Always-on vs press-to-listen as the end state.** S4 (always-on wakeword) is the "hands-free" target, but an always-open mic on a single-user workstation has a false-positive/privacy surface (TV, calls, other people in the room). Alternative end state: stop at S2/S3 with a click-or-key-to-listen toggle and skip always-on. **Needs Lucas** — this decides whether S4 is built at all.

3. **Barge-in latency target.** 300 ms TTS-cancel is the Echo design target; sentence-chunking gets us close on batch Kokoro. If Lucas wants sub-150 ms interrupt, that forces true frame-streaming TTS (bigger change to the sidecar output shape). Confirm 300 ms is acceptable.

**Risks (no fork, just watch):**

- **CPU STT under multitask load.** `base` int8 is sub-second idle, but heavy concurrent CPU work could push it past conversational tolerance. Mitigation ladder if it bites: smaller model (`tiny`/`distil`) or the deferred whisper.cpp Vulkan path on the 7900 XT (GPU STT) — only if measured need; don't build speculatively.
- **VAD false endpointing in S2** (cutting the user off mid-sentence, or not ending). Renderer RMS gate is crude; `vad-web` Silero is the fallback. Tunable endpoint tail (min/max silence) exposed as config.
- **Mic permission scope.** Granting `media` on the default renderer session widens the app's mic surface beyond the meeting webviews. Acceptable for a single-user local app, but note it in the security posture.
- **Offline-first.** Ensure the `base` Whisper model is bundled/pre-fetched so S1 works with no network (Kokoro assets already local).
- **Do not regress the shipped voice.** The Kokoro GPU sidecar + `zoe_voice.json` blend is live and is Zoe's identity — the loop consumes it unchanged; no edits to the blend or device pinning.

---

### One-line summary
Build the loop natively in Side Quest (Path B): reuse the live GPU Kokoro TTS, the `onCompanionSpeak`/`faceAttachAudio` playback+lip-sync path, and the meeting mic-permission pattern; add a CPU faster-whisper NDJSON STT sidecar (transcribe core lifted from Echo's `stt_whisper.py`, LiveKit wrapper stripped); prove it with a push-to-talk single turn; then ladder VAD → barge-in → wakeword. LiveKit is dropped — its one advantage (multi-party turn-taking over an SFU) is dead weight on a single-user loopback box, and its stack has never run end-to-end here.
