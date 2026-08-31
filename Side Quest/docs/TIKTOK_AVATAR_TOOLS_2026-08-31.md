# TikTok avatar tools — the doors, their contracts, and what remains (2026-08-31)

Lucas's order: she is building the TikTok project herself; this wave puts the TOOLS in place so they
exist when she reaches for them. Identity anchors settled with him: face = `data/avatars/zoe_ref.jpg`
(her photoreal portrait — AI-born, no real-person likeness), voice = her normal program voice
(lib/tts.js, Piper). Posting account: deliberately deferred until video creation is proven.

## The pipeline seam

    script → lib/tts.synthesize() → WAV
           → lib/talking_head.render({ wav })            → head MP4 (photoreal, lip-synced)
           → lib/video_compose.compose({ video, wav, script }) → 1080x1920 MP4, captions burned
           → data/video_out/  (review folder — publishing is a LATER, gated door)

Every stage ends in a file on disk the next stage (and a human) can inspect. Both new modules follow
the lib/tts.js contract: fail-soft `{ ok:false, error }` — never throw — and never SAY without DOING:
`ok:true` carries a `probe` measured off the finished file with ffprobe, not assumed.

## Door 1 — lib/video_compose.js (LIVE, gate passed)

`compose({ video|image, wav, script|captions, out })` → `{ ok, path, probe, captionCards }`.
1080x1920, visual scaled/padded onto the program-dark ground (#0d0d10), captions as authored ASS
cards (≤5 words, char-weighted timing across the audio). Explicit `captions:[{text,start,end}]`
(e.g. whisper alignment via lib/stt.js) always beats the estimate. Binaries are in-repo
(ffmpeg-static / ffprobe-static) — no PATH dependence.

GATE (2026-08-31): `data/video_out/gate1_still.mp4` — zoe_ref + zoe_voice_LOCKED.wav + test script →
probe {1080x1920, 6.25s, audio true}, frames pulled and eyeballed: portrait clean, cards legible and
advancing. Delivered to Lucas.

## Door 2 — lib/talking_head.js (LIVE, gate passed)

GATE (2026-08-31): `data/video_out/gate2_head_256.mp4` — zoe_ref + zoe_voice_LOCKED.wav at 256/crop →
6.24s in 341s CPU; 4-frame strip pulled and eyeballed: four distinct mouth shapes, identity holds.
Caveat measured, not assumed: SadTalker's raw MP4 carries NO audio track — the compose stage muxes
the WAV, so always pass `wav` to compose after render.


`render({ image?, wav, out?, size?, preprocess?, still?, enhance? })` → `{ ok, path, probe, tookMs }`.
Engine v1 = SadTalker under `sidecar/talking_head/` (repo + th_venv py3.10 + ~2.5GB weights, CPU —
offline lane, minutes per clip is fine). `available()` is the measured presence probe. Defaults:
her portrait, 512, `preprocess:'full'` (whole frame, face animated in place — feeds Door 1 directly),
`still:true` (composed delivery, no head-wander).

Engine v2 candidate when quality demands it: Sonic (AMD/ROCm fork exists;
github.com/vshortt73/sonic-talking-head) — slot it behind the same render() contract. Disk note:
only ~60GB free on C:, Sonic-class weights + ROCm are tens of GB — check before pulling.

Venv landmines already stepped on (don't re-derive): uv venvs ship NO pip (use `uv pip --python`),
NO setuptools — and librosa 0.9.2 needs pkg_resources, which setuptools ≥81 removed → pinned
`setuptools<81`. torch 2.0.1+cpu / torchvision 0.15.2+cpu keeps basicsr 1.4.2 importable.

## Door 3 — registration (LIVE)

- capability_manifest.js: `talking-head video` + `vertical video compose` probe entries — measured
  (module require + weights on disk), listed 10/10 on this boot's manifest.
- scripts/smoke_video_tools.js in the run_smokes allow-list — 12/12: caption math, both fail-soft
  contracts, registration presence.

## RESEARCH VERDICT (3-lane sweep, 2026-08-31) — the realism upgrade path

His order: "as real as possible" + full-body / waist-up FULL animation. SadTalker is the 2023 tier;
the 2025-26 class does body+gesture from one image + audio. Three independent research lanes agree:

**Models (both Wan-family, both GGUF-quantized to fit 20GB, both Apache-2.0):**
- InfiniteTalk (MeiGen) — #1 identity stability, body/posture animation, DESIGNED for 60-90s+
  streaming takes; Kijai ComfyUI-WanVideoWrapper; conservative gestures. github.com/MeiGen-AI/InfiniteTalk
- Wan2.2-S2V-14B (Alibaba) — most expressive full-body gesture of the runnable class, native ComfyUI
  workflow, GGUF Q2-Q8 ladder (QuantStack); long clips via ~4.8s extend-chunks; workflow-sensitive
  quality. huggingface.co/Wan-AI/Wan2.2-S2V-14B
- DROPPED: HunyuanVideo-Avatar (CUDA-bound + restrictive license — effectively unsupported on AMD).
  WATCHLIST: LongCat-Video-Avatar 1.5 (MIT, current open quality leader, ~40GB today — take #1 when
  community quants land; watch kijai/ComfyUI-WanVideoWrapper#1780).

**Route (the 2026 surprise): ZLUDA is LEGACY** — its own maintainer now points RDNA3 at native
Windows ROCm (ComfyUI ROCm 7.2 build, or patientx-cfz/comfyui-rocm which auto-installs
triton/sage/flash-attn). 7900 XT officially supported; Wan 2.1/2.2 proven on 7900-class. The old
ComfyUI-Zluda install on the Desktop should be left alone, not extended. Incantations:
PYTORCH_NO_HIP_MEMORY_CACHING=1, HSA_OVERRIDE_GFX_VERSION=11.0.0, GGUF Q4/Q5 + block swap
(14B bf16 does NOT fit 20GB), Lightning 4-step LoRA, test sage vs flash vs SDPA per workflow.
No fp8 hardware on RDNA3 (casts to fp16 — int8 GGUF beats fp8 files here). Expected: ~4-10 min
per 5s clip at 480p accelerated; ~RTX-3090-minus-15% territory. WSL2 ROCm = escape hatch (also
where LoRA TRAINING lives — Windows ROCm wheels are inference-only).

**Realism stack (applies to whatever renders; biggest wins first):**
1. Identity: multi-angle reference sheet from zoe_ref for the i2v model now; Wan character LoRA once
   she's past ~50 clips (train on WSL2 or cloud, 12GB-class); ReActor face-pass as enforcement.
2. Keep any continuous avatar shot SHORT — jump-cut grammar with b-roll/text cards between avatar
   segments (measured finding: long fullscreen avatar takes expose the tells).
3. Post chain IN ORDER: upscale (low denoise) → light blur → fine grain (ffmpeg noise=alls~12-20) →
   grade toward a live-action reference → RIFE/minterpolate to 30fps. Mostly ffmpeg → extends
   video_compose, not a new tool.
4. Voice: KEEP the breaths (attenuate, don't delete), room-tone/IR so the voice sits in a room,
   two-pass loudnorm I=-14:TP=-1.5 (ffmpeg — extends the compose audio path).
5. Platform grammar: face upper-middle third, soft frontal-light look prompted into the scene,
   TikTok safe zones, burned captions (Door 1 already does these).

**⭐INFINITETALK GATE PASSED (2026-08-31 PM).** Stack stood up: ROCm 7.1 + the pre-existing
`.venv-rocm` (torch 2.12 nightly — ALREADY on the machine, his catch) in ComfyUI-Zluda dir running
NATIVE ROCm on the 7900 XT (`HIP_VISIBLE_DEVICES=1` — device 0 is the iGPU); Kijai wrapper + KJNodes
+ VHS; InfiniteTalk Single Q8 GGUF + Wan2.1-i2v-14B Q4_K_M GGUF + umt5 fp8 + lightx2v rank64
(~21.5GB pulled). Cures en route: transformers 5.14→4.56.2 (5.x imports torch FSDP; ROCm nightly has
no distributed) · merge_loras=False (GGUF can't merge) · kill boot-test PYTHON child, not the bash
wrapper (zombie held comfyui.db). Gate render `data/video_out/gate4_infinitetalk_raw.mp4`: 156+pad
frames, 3 windows, 480x832, 6 steps — head turns, torso, HAND GESTURE, genuine mid-blink, identity
holds; flaws = garment-print drift, 480p softness (post chain's job). ~103 min on SDPA — speed levers
untouched: triton-windows + sage-attn, audio-length num_frames (padded to 9s), shorter takes.
Composed final `gate4_final.mp4` (1080x1920) proves the full chain. Headless driver =
scratchpad submit_infinitetalk.py pattern: schema-validated API graph → POST /prompt → poll /history.
NEXT: engine 'wan' in lib/talking_head.js · takes registry (clips = OBJECTS: mood/framing/gesture/
seed/grade — the reuse well: V2V re-dub = driving footage, direct-reuse idle beats, LoRA dataset
flywheel) · realism post pass into video_compose.

**Build order agreed shape:** (A) stand up native-ROCm ComfyUI + S2V and InfiniteTalk GGUFs → A/B
gate on zoe_ref + locked WAV, eyeball picks the winner; (B) winner becomes engine 'wan' behind the
UNCHANGED talking_head.render() contract (ComfyUI headless API); (C) realism post pass + loudnorm
into video_compose. Disk caution: ~60GB free vs ~40-50GB for stack+models — check before pulling.

## THE STUDIO (studio/, LIVE 2026-08-31 PM) — workspace + autonomous producer + cloner

A local console (node http, no deps) at http://127.0.0.1:8790 (.claude/launch.json entry "studio";
`node studio/server.js`). Answers his two asks: (1) script-in → autonomous → review-gate is REAL,
(2) a place to watch it and to generate scenes independent of Zoe.
- `studio/runner.js` — the producer state machine: queued→voicing→rendering→cutting→ready_for_review.
  Deterministic house-format parser (time-range headers, ZO: lines, (b-roll) directions); unparseable
  prose → one on-camera segment + a logged warning, never a silent guess. HALTS at review — nothing
  posts. Ticks in-process every 5s; one stage per tick, restart-safe. Jobs at data/studio/jobs/<id>/.
- `studio/comfy_client.js` — the InfiniteTalk take as a parameterized, schema-validated API graph
  (ref image + WAV + duration + prompt → submit/poll). This is the reusable engine for `talking_head`
  engine 'wan' too.
- `studio/cloner.js` — CLONER (his bosses' ask): upload a real video → representative reference frame
  (ffmpeg thumbnail filter) + 4 alternates + captured voice sample → a PERSONA selectable per job.
  ⭐CONSENT IS STRUCTURAL: createPersona REFUSES without a consent attestation (stored w/ who+when);
  proven live (gate rejects no-consent upload). Voice cloning itself = separate lane (sample captured
  only). Personas at data/studio/personas/<id>/.
- `studio/index.html` — the console: submit script, watch stage trackers live, review player with
  approve/reject/retry, clones panel w/ candidate-frame picker + consent-gated upload.
- Persona-parameterized end to end → generate scenes with ANY face/voice apart from Zoe; her lane can
  later POST the same /api/jobs. Verified live: intro script → parsed 3 segs → voiced → take queued;
  clone created from a real video w/ frames+voice+consent; both consent + missing-media guards reject.
- smoke_video_tools.js covers assemble() fail-soft (15/15). Studio has no smoke yet (UI-heavy;
  module-load + guard checks run clean).

## RESEARCH v2 — voice cloning + body-motion (2-lane sweep, 2026-08-31 PM)

His asks: fill the voice-clone gap (full voice from HOURS of a real person), full multi-pose video per
clone, and "can we map body motion from studied media as a reusable overlay." Verdicts:

**VOICE CLONE — fine-tune, don't settle for zero-shot** (hours of data + "full voice" = timbre AND
prosody; zero-shot nails timbre only). Primary: **F5-TTS fine-tuned from `mrfakename/OpenF5-TTS-Base`
(Apache-2.0 — the default F5 weights are CC-BY-NC, use OpenF5)** — best English naturalness + long-form
stability (flow-matching, no autoregressive drift → true arbitrary length), pure PyTorch (ROCm-friendly),
Piper-shaped CLI for a Node sidecar. Fallback: **Chatterbox (Resemble AI), MIT end-to-end, best AMD +
OpenAI-compatible server, LoRA fine-tune fits 20GB** (full FT ~18GB tight; watermarks output). Third:
GPT-SoVITS (MIT, explicit prosody/timbre split) if F5 prosody isn't close enough. AVOID commercial:
XTTS-v2 (CPML non-commercial, licensor defunct), Fish/OpenAudio (NC weights), default F5 weights.
⭐AMD SPLIT: native-Windows torch 2.12 ROCm is fine for INFERENCE (pure-PyTorch F5/Chatterbox); FINE-TUNE
in WSL2/Ubuntu ROCm (Windows ROCm breaks torch.distributed/torchvision — training loops). Workflow:
same-day F5 zero-shot baseline (proves pipeline+timbre) → fine-tune on the hours for studio voice.

**BODY MOTION — YES, and it lands in the existing stack.** #1 **Wan2.2-Animate-14B** (Apache-2.0, GGUF
Q8/FP8 fits 20GB, native ComfyUI + Kijai `WanVideoAnimateEmbeds`, DWPose preprocessing via
comfyui_controlnet_aux) — a reference person performs a driving video's body motion+expression; a 2026
refresh **Wan-Animate-2** (08-07, Apache-2.0) is the current best if node support caught up. #2
UniAnimate-DiT. ⭐COMBINE WITH LIP-SYNC: the Kijai wrapper feeds Animate pose/face embeds AND
InfiniteTalk/MultiTalk audio embeds into ONE sampler — but Animate already drives the mouth, so the
RELIABLE path is TWO-PASS: Wan-Animate (body) → InfiniteTalk V2V (re-drive lips from audio). REUSABLE
MOTION LIBRARY = real: (A) DWPose skeleton sequences saved as pose-map videos, reused across identities
via the models' built-in pose rescaling; (B) **ComfyUI-MotionCapture (GVHMR→SMPL .npz + FBX + Mixamo/UE
retarget)** — identity-agnostic 3D motion, the durable "study media → map → apply to any avatar" answer.

**BUILT THIS WAVE (policy + multi-pose, LIVE + logic-proven):**
- ⭐PRIVACY GATE ENFORCED IN CODE: cloner personas are oneToOne + postEligible:false; runner.decide
  REFUSES 'approve' on a 1:1 clone ("use download"), only 'download'→delivered. His rule: 1:1 clones
  are download-only, handed to the depicted person, NEVER posted. Zoe (synthetic) stays post-eligible.
- POSE LIBRARY: persona.poses[]; cloner.togglePose + addSource (ingest more videos AND photos-at-angles
  → richer poses + longer voice corpus); runner ROTATES poses across on-camera takes → multi-pose cuts.
- Persona voice seam in runner (job.voice → tts.synthesize) — waits on the F5 engine.
- voice_clone sidecar venv + F5-TTS installing (CPU torch for the engine-proof; ROCm swap later).

**OPEN (needs his input / a system step):** Russ media path (hours of video/webcam/photos + voice) —
the first real clone, blocked on where the files are · WSL2/Ubuntu+ROCm for the fine-tune (system
install, confirm) · Wan-Animate as a new studio engine (motion lane) · a MODEL QC judge before review.

## WAVE 3 (2026-08-31 late) — voice clone wired, motion library LIVE (his constraints)

His constraints: NO Ubuntu/WSL/ROCm-training, "pretty good" zero-shot voice, native+existing hardware,
NO patch-arounds, DO NOT process real people through Claude (build the tool, he tests). All honored.
- VOICE CLONE (zero-shot, native): lib/voice_clone.js + sidecar/voice_clone/clone_tts.py (F5-TTS),
  runner routes job.voice→clone else Piper, cloner.buildVoice trims a 12s reference. Uses the ALREADY-
  CACHED SWivid F5-TTS weights (OpenF5 5GB blocked — DISK FULL, 1-2GB free). ⚠BLOCKED at runtime:
  F5's newer stack needs torchcodec↔FFmpeg SHARED LIBS (ffmpeg-static is a static exe, no libav*.dll) —
  a native dep that won't resolve on this disk-full no-patch box. GRACEFUL: a clone-voice failure
  DEGRADES to the program voice (runner), so clone videos still complete. Unblock = free ~10GB (proper
  ffmpeg libs / OpenF5) or the new machine. Wiring is sound; failure is deep in F5, not our code.
- ⭐MOTION LIBRARY — BUILT + PROVEN: studio/motion.js + sidecar/motion/extract_motion.py (MediaPipe
  Tasks API, pose_landmarker.task 5MB, native CPU no-GPU). Upload video OR YouTube URL (yt-dlp, 480p,
  video DELETED after — white-label keeps only the skeleton). Output = normalized hip-centered/torso-
  scaled 33-pt keypoints (motion.json) + skeleton-only preview.mp4. Proven on Zoe's synthetic clip
  (225 frames, identity-stripped) — sent to him. Studio panel live (list/add/delete). data/studio/motions/.
- POLICY/POSE from wave 2 all live; smoke pending update for the new modules.

⭐LAYERED-MOTION TRUTH (his fidelity Q — breathing/hair/jiggle/hands/talking): realism is LAYERED, and
the reusable library is only the INTENT layer. L1 gross body/gesture = the skeleton library (built).
L2 hands/fingers + facial micro = an extractor UPGRADE to MediaPipe HOLISTIC (21-pt hands + 468 face)
or DWPose — buildable. L3 SECONDARY PHYSICS (hair sway, soft-body jiggle, breathing, cloth) is NOT
harvested into a library — the diffusion RENDERER (InfiniteTalk/Wan-Animate) already GENERATES it
emergently (why the clips look alive), or it's physics-SIMMED on a 3D SMPL rig. L4 lip/mouth = audio-
driven (InfiniteTalk). So: library carries what the body DOES; the renderer carries the life. Richer
library roadmap = Holistic hands/face (clean upgrade) → SMPL 3D (GVHMR, durable + physics-ready).
APPLYING motion to avatars = Wan-Animate lane (next; two-pass with InfiniteTalk V2V for lips).

## WAVE 4 (2026-08-31 night) — voice tuner folded in + workspace goes live

- ⭐EXISTING GENERATOR = the voice for personas (his point): tts.synthesize(text,{voice}) proven with a
  non-default voice (Amy). Persona voice picker (studio) lists Zoe + 5 stock Piper voices; runner routes
  engine 'existing'→tts. F5 real-voice-clone is the OPTIONAL "match the real person" upgrade, still
  disk/torchcodec-blocked. NOTE: stock voices all read female — Kokoro has male styles (am_/bm_) for a
  cheap male add.
- ⭐VOICE TUNER FOLDED INTO THE STUDIO (sidecar/kokoro_tuner_server.py, :8199, Kokoro on the 7900 XT —
  the tool that authored zoe_voice.json's blend). launch.json entry "voice-tuner". Studio "Voice tuner"
  panel: live status dot, Open-tuner link, save-recipe form → studio/char_voices.js store
  (data/studio/character_voices.json). A saved recipe = a ★ character voice in the persona picker;
  runner routes engine 'kokoro'→lib/voice_kokoro (POSTs the tuner's /synth), graceful fallback if the
  tuner's down. ⚠LIVE kokoro-synth proof PENDS GPU-free (tuner needs the GPU, busy with intro takes —
  didn't boot it to avoid OOM against the 14B render). Wiring + module-loads verified; recipe-parse in UI.
  This makes personas TOP-TO-BOTTOM (custom voice + reference + poses) and is the seam for MORE CHARACTERS.
- ⭐WORKSPACE IS LIVE: the in-progress intro render (run outside the Studio via submit_intro_takes.py) is
  now a WATCHABLE Studio job (job_intro_zoexplains, external:true — runner.tick SKIPS external jobs, never
  clobbers). Detail pane shows stage/segments(A✓ B✓ C… D…)/log, updates live. When C/D land I update the
  record + assemble the rough cut into it. Motion library ready for his uploads (upload/YouTube → skeleton).

⭐HIS VISION (faster/cleaner Zoe from motion studies + live avatar + more characters): the mechanism is
real — a reusable white-label motion library means you DON'T re-generate gross motion every clip; you
DRIVE from a clean pre-mapped motion (Wan-Animate two-pass), which is both faster (less to solve) and
cleaner (consistent, artifact-free motion). Same path skins the LIVE avatar (avatar_director's clip menu
→ pre-rendered/pose-driven loops). Personas being top-to-bottom (voice+face+poses+motion) = the "more
characters" substrate. Build order to get there: APPLY-motion lane (Wan-Animate) → takes/motion registry
→ live-skin. Not built yet; the pieces now all exist to assemble it.

## NOT built (deliberately, in order)

1. **Publishing door** — waits for the account (his word). When it comes: lib/browser.js (her own
   authenticated Chrome profile) stages the upload; TikTok's official Content Posting API is the
   compliant primary once registered (unaudited apps post self-only). EVERY post sets the
   AI-generated label. Publish rides an approvals.js gate — same law that keeps outbound email off.
2. **Whisper caption alignment** — pass `captions` from lib/stt.js word timings when tighter sync
   than the estimate is wanted. The compose contract already accepts it.
3. **B-roll stills** — ComfyUI-Zluda (SDXL) exists standalone on the Desktop; not wired as a door.
