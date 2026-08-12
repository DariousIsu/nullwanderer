# Two-Way Voice + Dedicated Local GPU Voice Generator — Investigation & Plan

**Date:** 2026-08-12
**Scope:** (1) full hands-free two-way voice for the assistant; (2) a dedicated
local **GPU** voice generator running alongside the ComfyUI image generator on the
RX 7900 XT.
**Output requested:** investigation + plan only (no code this session).
**Operator choices this session:** natural-quality GPU voice (fixed identity, not
cloning); full hands-free conversation (always-listening + barge-in); plan only.

---

## 0. Bottom line

You are **not** starting from scratch, and the main blocker is **already obsolete**.

1. A purpose-built **full-duplex voice architecture already exists** — "Phase 4C"
   in the Echo repo: LiveKit AgentSession + Silero VAD + faster-whisper STT +
   **Kokoro TTS** + openWakeWord + framework-provided barge-in. The Python
   agent side is **built and committed**; the Kokoro models are already installed.
2. It is **CPU-only for one stale reason**: an operator "ROCm veto" dated
   **2026-05-29**, when Windows AMD ROCm was too rough. Your ComfyUI image-gen now
   runs on **native Windows ROCm** (`torch 2.12+rocm7.13`, gfx110X, the 7900 XT) —
   proof that reason no longer holds. **The GPU path is open again.**
3. The loop has **never run end-to-end**: the mic client + the bundled
   `livekit-server` media server live only in a **git worktree** (`sharp-bouman-d9016e`),
   not the main tree, and the Side Quest "Zoe" app has **zero** voice-room wiring.
4. The "dedicated GPU voice generator alongside the image generator" is a **small,
   low-risk addition**: Kokoro-82M is ~0.3–0.5 GB of VRAM next to SDXL's ~10 GB on a
   20 GB card. No meaningful contention.

So the work is mostly **finishing + un-vetoing**, not inventing.

---

## 0.5 Phase-1 spike — EXECUTED 2026-08-12 (Kokoro on the GPU: ✅ PASS)

Ran the Phase-1 spike (below). **Kokoro-82M synthesizes on the RX 7900 XT via
PyTorch-ROCm, and it's fast.** GPU proof unambiguous: model on `cuda:0`, VRAM
21.30 → 19.94 GB during synth, 1026 MB peak.

| Metric | GPU (7900 XT, warm) | CPU |
|---|---|---|
| First-audio, short reply ("Sure, I can help with that.") | **83 ms** | — |
| First-audio, medium reply (108 chars) | **136 ms** | — |
| Sustained throughput (70 s of audio) | **74.7× real-time** (0.94 s compute) | 3.8× real-time (18.4 s) |
| Short 9.5 s sentence, cold/first-shape | ~2× real-time (fixed-cost floor) | ~2.3× |
| VRAM peak | **~1 GB** (coexists with SDXL's ~10 GB) | — |

**Corrected finding:** a mid-spike short-cold measurement suggested "GPU ≈ CPU ≈ 2×
RT, GPU gives no benefit" — that was **wrong**, an artifact of fixed per-utterance
G2P/overhead swamping the tiny inference on one short cold call. Warm + sustained,
the **GPU is ~20× faster than CPU** and delivers sub-150 ms first-audio. The
"dedicated GPU voice generator alongside the image generator" premise is **vindicated**.

**Deployment caveats (real, from the run):**
- First-ever call of a new phoneme-length *shape* pays a one-time MIOpen kernel
  autotune (5–25 s) — RDNA3 tuning DB is absent on Windows-ROCm (`gfx908_metadata`
  load errors, harmless). Mitigate with the **persistent MIOpen cache**
  (`MIOPEN_USER_DB_PATH`) + a **boot pre-warm** across a few sentence lengths.
- Use `MIOPEN_FIND_MODE=2` (immediate). `FIND_MODE=1` is **worse** here (re-searches
  every call → 0.7× RT).
- `HIP_VISIBLE_DEVICES=1` on this box (index 0 is the iGPU) — same as ComfyUI.
- fp32, eager, never `torch.compile`.

**The working install (reproducible):** overlay venv `sidecar/tts_kokoro_venv`
sharing ComfyUI's torch via a `.pth` (28 MB, no torch re-download) → `pip install
--no-deps kokoro` → base `misaki` (NOT `misaki[en]`, whose extra pins an old spaCy
that won't wheel) + spaCy 3.8 wheel + `en_core_web_sm` + `espeakng-loader` +
`phonemizer-fork` → **`transformers==4.46.3` pinned into the overlay** (ComfyUI's
`transformers 5.14.1` breaks kokoro: it eagerly imports `torch.distributed.tensor`,
which this ROCm-Windows torch build lacks — `torch.distributed.is_available()==False`).

**Verdict:** Phase-1 acceptance MET. Proceed to Phase 2 (make Kokoro-GPU the default
voice-out) — home it on the GPU via a persistent sidecar mirroring `ensureComfyUI()`,
with boot pre-warm + the persistent MIOpen cache. Quality A/B (Piper vs Kokoro) is
the operator's ear-test; wavs delivered.

---

## 1. What exists today (verified in code, 2026-08-12)

There are **two separate front-ends** and it matters which one owns voice:

| App | Location | Voice today | GPU today |
|---|---|---|---|
| **Zoe** (the daily program) | `Side Quest/` | Piper TTS (**CPU**) out; Echo transcription (**batch**, not streaming) in | ComfyUI SDXL/FLUX on the 7900 XT |
| **Saga** (separate Electron shell) | `NX ECHO/…/.claude/worktrees/sharp-bouman-d9016e/ui/` | LiveKit full-duplex stack (see §2) — **client parked in worktree** | none wired |

### 1a. Voice OUT — Piper, CPU (Zoe)
- `sidecar/tts_piper.py` + [lib/tts.js](../lib/tts.js): persistent NDJSON sidecar,
  warm ~85–100 ms/utterance, voice `en_GB-jenny_dioco-medium` (5 voices in
  `data/voices/`). Wired to the companion + chat replies with avatar lip-sync.
- Piper is a small ONNX/VITS model on **CPU**; it never touches the GPU. Fast but
  the low-fidelity tier.

### 1b. Voice IN — Echo transcription, batch (Zoe)
- [lib/listen.js](../lib/listen.js) and [lib/meeting_audio.js](../lib/meeting_audio.js)
  both use `capture_start → capture_stop → segments` = **record → stop →
  transcribe → read**. No streaming/continuous path. Whisper `base`.

### 1c. Local GPU — ComfyUI (Zoe)
- [main.js:2932](../main.js) `ensureComfyUI()`: SDXL/FLUX on `127.0.0.1:8188`,
  `HIP_VISIBLE_DEVICES=1` (discrete 20 GB 7900 XT), `--use-split-cross-attention`,
  app-supervised (spawn on boot, kill on exit, restart-on-crash). Native Windows
  ROCm. **This is the pattern to mirror for a GPU TTS sidecar.**

---

## 2. The Echo "Phase 4C" voice stack (the big find)

Design contract: `NX ECHO/nx-echo/docs/PHASE_4C_VOICE_DESIGN_2026-05-29.md`.
Git log shows sustained work: `Phase 4C wire-up` → a full `Phase 4F`
attend/ambient-listening arc → a LiveKit hardening pass (`H11`). Not abandoned
scaffolding.

**Built + committed (Python, `echo/voice/`):**
- `agent.py` — long-lived sidecar; joins a local LiveKit room and (default
  `enable_session=True`) assembles + starts the full STT→LLM→TTS session.
- `session.py` — `build_voice_session()`: Silero VAD + faster-whisper + LLM +
  Kokoro TTS into a LiveKit `AgentSession`; **barge-in is framework-provided**
  (interrupts in-progress TTS on VAD speech > `min_interruption_duration`, default
  500 ms) with tunable endpointing.
- `stt_whisper.py` — faster-whisper (CTranslate2) as a LiveKit STT plugin, **CPU
  int8 `base`**.
- `tts_kokoro.py` — **Kokoro-82M** (`kokoro-onnx`) as a LiveKit TTS plugin,
  **CPU-only**, streams 24 kHz chunks. Models already installed at
  `data/models/kokoro/`.
- `wakeword.py` — openWakeWord gate (always-on mic → wake → un-gate STT for one
  utterance → re-gate). Matches your chosen "always-on + wake-word" mode.
- `attend/*` — ambient-listening / observer-pass extraction (Phase 4F).

**Not built / parked / stale:**
- **Client + media server**: `livekit-server.cjs` and the Electron mic client
  exist **only in the worktree** `sharp-bouman-d9016e` (a separate "Saga" shell),
  **not** in the main tree. No `livekit-server.exe` binary bundled in main.
- **Never run live**: nothing publishes the operator's mic into the room in main,
  so the wake→STT→LLM→TTS→playback chain has never executed against a real mic.
- **All CPU** because of the veto (next section).

---

## 3. The key unlock: the ROCm veto is stale

`PHASE_4C_VOICE_DESIGN_2026-05-29.md §1` records:
- STT pinned to CPU: *"Operator vetoed AMD ROCm on 2026-05-29 (Windows ROCm support
  is too rough)."*
- TTS pinned to CPU: *"Kokoro's DirectML path is broken on AMD as of 2026-05
  (`ConvTranspose` op error; hexgrad/kokoro #79 + HF kokoro-onnx discussion #5)."*

Both reasons are now outdated:
- **Windows ROCm is native now.** ComfyUI runs SDXL on the 7900 XT via
  `torch 2.12+rocm7.13` (gfx110X wheels), landed ~2026-08-04. The "too rough"
  premise is gone.
- **The DirectML bug is sidesteppable.** With native ROCm-torch working on this
  box, Kokoro can run via its **PyTorch** path on ROCm — which never touches the
  broken DirectML `ConvTranspose` provider at all. (And the DirectML bug itself
  was 2026-05; worth a quick re-test on current `onnxruntime-directml`, but we
  don't depend on it.)

**Consequence:** a `device="cuda"`-style flip is a near one-line change in
`stt_whisper.py`/`tts_kokoro.py` for CUDA boxes, but on **AMD** the specifics
differ per engine — see §4.

---

## 4. Engine picks for THIS hardware (AMD ROCm / Windows)

The AMD-not-NVIDIA constraint is what rules engines in or out. CUDA-first tools
(faster-whisper's CT2 GPU, NeMo/Parakeet) are out or degrade to CPU.

| Role | Pick | GPU path on the 7900 XT | Notes |
|---|---|---|---|
| **TTS (the GPU "voice generator")** | **Kokoro-82M** (already integrated) | **PyTorch-ROCm** (primary) — the `kokoro` pip pkg on the same ROCm stack ComfyUI uses. DirectML = fallback, re-test only. | Apache-2.0, natural quality, ~0.3–0.5 GB VRAM, streams, first-audio <300 ms. Fixed identity (your choice). This is the low-risk win. |
| **STT** | **faster-whisper CPU `base`/`small`** now; **whisper.cpp + Vulkan** for GPU later | faster-whisper's CTranslate2 backend **does not support ROCm** — cannot flip its device to the 7900 XT. GPU whisper on AMD = the **Vulkan** build (`GGML_VULKAN=1`), already the documented future plugin `echo.voice.stt_whisper_cpp`. | CPU `base` is ~5–10× real-time (sub-second on typical utterances) — fine to ship on. Consider **Moonshine** ONNX later for lower-latency streaming. |
| **VAD / turn-taking** | **Silero VAD** + LiveKit semantic turn detector | CPU, negligible | Already wired. Optional `turndetect_port.py` fallback if it's too eager. |
| **Wake word** | **openWakeWord** (`hey_jarvis` etc.) | CPU, ~1 MB, sub-10 ms/chunk | Already built. |
| **LLM (the brain)** | Existing cloud (kimi/gpt-oss) or a local narrator | separate decision | The `SAGA_LOCAL_VOICE_HANDOFF_2026-06-03.md` proposes a local-narrator + cloud-consultant design; **out of scope** for the audio pipeline, keep on the current brain to start. |

**Net:** only **Kokoro moves to the GPU** to satisfy "voice generator on the GPU
alongside the image generator." Whisper stays CPU (fast enough, zero AMD-GPU risk),
with a clean Vulkan upgrade later if latency bites.

---

## 5. Budgets

**VRAM (20 GB total):**
- ComfyUI SDXL during a gen: ~8–12 GB.
- Kokoro-82M on GPU: ~0.3–0.5 GB.
- (Optional) whisper GPU: base ~1 GB / small ~2 GB / large-v3 ~4–5 GB — but staying
  CPU to start.
- **Kokoro + SDXL coexist trivially.** The only tight combo would be a large local
  LLM (Qwen3-14B ~9.3 GB) + SDXL simultaneously — which is why the brain stays off
  the GPU for now.

**Latency (perceived, first response audio):** dominated by the **LLM**, not the
audio engines. VAD/wake ≈ 0; STT sub-second (CPU base); Kokoro first-audio
<300 ms streaming; barge-in cancel <60 ms (LiveKit handles it). Expect ~1–3 s to
first audio, mostly the LLM round-trip. Stream a short spoken preamble to hide it.

---

## 6. The one real decision: where does two-way voice live?

The engines are settled; the architecture fork is **which app owns the loop**, and
it's your call. It changes the plan materially.

- **Option A — In the Zoe app (in-process, no LiveKit).**
  Build mic-capture + VAD + streaming STT + Kokoro-GPU + playback directly in
  Zoe's Electron main/renderer, reusing the existing **companion avatar + lip-sync**
  and the `ensureComfyUI()` sidecar pattern (add `ensureKokoro()`). Simplest to
  deploy (no Go media server, no WebRTC), lives in your daily surface, drives the
  avatar you already have. **Cost:** you hand-build turn-taking + barge-in (LiveKit
  gives those for free).

- **Option B — Finish Echo's Phase 4C (LiveKit) as-is.**
  Bundle `livekit-server.exe`, finish the worktree client, flip STT/TTS to GPU.
  Production-grade barge-in/turn-taking for free; but the client is a separate
  "Saga" shell (not Zoe), adds a media server + WebRTC, and salvages a parked
  worktree.

- **Option C — Hybrid (recommended).**
  Reuse the **Echo Python voice agent** (most-built piece: Kokoro, VAD, wake, barge-in),
  flip it to **GPU now that ROCm is native**, and make the **Zoe app the LiveKit
  client** (mic in + play the agent's audio track → drive the existing avatar).
  Keeps voice in your daily surface **and** salvages the battle-tested full-duplex
  loop instead of re-implementing turn-taking.

**Recommendation: C**, with a fast **A-style spike first** (see Phase 1) so you hear
Kokoro-on-GPU quality before committing to the LiveKit plumbing. If the spike voice
is great and the LiveKit client proves fiddly, A remains a clean fallback.

---

## 7. Phased plan

Each phase is independently shippable with an acceptance check. Phases 1–2 are the
"dedicated GPU voice generator"; 3–5 are "two-way voice."

### Phase 1 — Kokoro on the GPU (the voice generator) — **do this first**
- Stand up Kokoro-82M on the 7900 XT via **PyTorch-ROCm** (same stack as ComfyUI),
  as a persistent sidecar mirroring `ensureComfyUI()` (`ensureKokoro()` in Zoe, or
  the Echo `KokoroTTS.prewarm()` path with a ROCm device).
- **Acceptance:** a spoken sentence synthesized **on the GPU** (confirm via
  `rocm-smi`/VRAM delta), A/B'd against Piper for naturalness. Measure first-audio
  latency and real-time factor.

### Phase 2 — Make it the default voice-out
- Add a provider switch (`voice.provider = piper | kokoro`), Kokoro default,
  Piper fail-soft fallback (mirror `imageProvider()` in `lib/vision.js`).
- **Acceptance:** the companion + chat read-aloud speak in the Kokoro voice; Piper
  still works when Kokoro is down.

### Phase 3 — Streaming mic + VAD + end-of-turn (the input half)
- Continuous mic capture + **Silero VAD** + openWakeWord gate + **streaming STT**
  (chunked faster-whisper CPU to start). This is the piece Zoe lacks entirely
  (today's `listen.js` is manual batch).
- **Acceptance:** speak → partial transcript appears live → final transcript on
  end-of-turn, hands-free, no click.

### Phase 4 — Close the loop + barge-in
- Wire mic→STT→(existing brain)→Kokoro→playback→avatar lip-sync, with **barge-in**
  (interrupt TTS when you start speaking; cancel <60 ms). Under Option C this is
  LiveKit's `AgentSession`; under A it's a cancellable in-process player.
- **Acceptance:** a real back-and-forth conversation; interrupting her mid-sentence
  stops her within ~60 ms and she listens.

### Phase 5 — Polish
- Whisper→**Vulkan GPU** if latency bites; Moonshine for lower-latency streaming;
  turn-detector tuning; optional voice-cloning engine later (XTTS/Chatterbox on
  ROCm) if you revisit the "fixed identity" choice.

---

## 8. Risks / unknowns to retire during Phase 1

- **Kokoro on ROCm-torch**: unproven on this exact box (ComfyUI proves torch-ROCm
  broadly; Kokoro's ops specifically need a smoke test). If it hangs, DirectML
  re-test or CPU Kokoro (still an upgrade over Piper) is the fallback.
- **VRAM co-residency** with ComfyUI under real load — expected fine, measure.
- **Worktree client reuse (Option B/C)**: inspect `sharp-bouman-d9016e/ui/` to
  gauge how finished the LiveKit client is before committing to it.
- **Brain latency** dominates perceived responsiveness — the audio engines are not
  the bottleneck; plan the preamble-streaming trick.

---

## 9. File map (for implementation)

**Zoe (Side Quest):** [lib/tts.js](../lib/tts.js), `sidecar/tts_piper.py`,
[lib/listen.js](../lib/listen.js), [lib/meeting_audio.js](../lib/meeting_audio.js),
[main.js:2932](../main.js) (`ensureComfyUI` — the sidecar pattern),
`renderer/companion.html` (avatar lip-sync `attachAudio`).

**Echo voice stack (`NX ECHO/nx-echo/`):** `echo/voice/agent.py`,
`echo/voice/session.py`, `echo/voice/stt_whisper.py`, `echo/voice/tts_kokoro.py`,
`echo/voice/wakeword.py`, `echo/voice/saga_voice_llm.py`, `echo/voice/attend/*`;
`data/models/kokoro/` (models installed); `scripts/install_kokoro_models.py`.

**Docs:** `docs/PHASE_4C_VOICE_DESIGN_2026-05-29.md` (the build contract, incl. the
veto in §1), `docs/SAGA_LOCAL_VOICE_HANDOFF_2026-06-03.md` (the local-brain design,
separate concern).

**Parked client:** `.claude/worktrees/sharp-bouman-d9016e/ui/electron/livekit-server.cjs`
(+ full Saga Electron shell).
