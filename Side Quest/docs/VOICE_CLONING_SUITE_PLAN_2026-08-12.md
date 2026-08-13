# Full Voice-Cloning Suite — Integrated Build Plan

**Date:** 2026-08-12
**Status:** DESIGN COMPLETE — handoff for next-session pickup (this session compacted here).
**Author:** synthesized from a 4-lens design pass (architecture / in-app UX / clone lane / reuse-vs-Echo), adversarially reconciled and grounded against the real codebase.
**Related:** [VOICE_TWO_WAY_INVESTIGATION_2026-08-12.md](VOICE_TWO_WAY_INVESTIGATION_2026-08-12.md) (the two-way arc + Phase-1 GPU proofs), commit `7cd025e` (Kokoro provider + sidecar).

> Verified on disk: `sidecar/tts_kokoro_venv` already holds `kokoro`, `f5_tts`, `faster_whisper`, `imageio_ffmpeg`, `soundfile` **in one venv**, and F5 cloning was proven from exactly that env this session. That settles the biggest design conflict: **one shared venv, per-engine sidecars.**

---

## Cross-lens decisions (with justification)

1. **Shared venv, not isolated.** All voice sidecars point at `sidecar/tts_kokoro_venv/Scripts/python.exe` (coexistence proven + F5 already runs there + ~15–18 GB tight disk). Fallback if a future pin bump breaks it: isolate `tts_f5_venv` — a one-line `ENGINES` edit (design is venv-agnostic).
2. **One resident sidecar PER ENGINE**, not a generalized dispatcher — independent idle-kill + VRAM release, keeps the proven NDJSON contract untouched. New `sidecar/tts_f5.py`.
3. **`lib/tts.js` `_services` Map keyed by engine**, superseding the provider-recycle singleton — piper(CPU)+kokoro(GPU)+f5(GPU) stay warm without thrash. Mitigate VRAM with per-engine idle-kill + a GPU advisory lock shared with ComfyUI + GPU-OOM→piper(CPU) fallback (never silent).
4. **Single `data/voices/registry.json`** as source of truth (not a per-file library). Blends are entries; **clones also** get `data/voices/clones/<id>/` with `ref.wav`, `ref.txt`, `cond.pt`, `sample.wav`, and a `voice.json` that IS the inseparable consent/provenance/license record.
5. **Module split:** `lib/voices.js` (pure registry: load/resolve/mint/revoke/setActive/setSurface) + `lib/voice_studio.js` (IPC glue for the Studio surface).
6. **Ownership — Zoe vs Echo:** Zoe owns the registry, Voice Studio UX, selection/routing, and GPU synth + clone/enroll sidecars. Echo owns only the real-time full-duplex loop (VAD/barge-in/endpointing/wakeword/`AgentSession`/`voice_mint_token`). **Replace** Echo's duplicate `echo/voice/tts_kokoro.py` with a thin client of Zoe's shared sidecar reading the shared registry → one engine, one identity, many consumers.
7. **F5 as an NDJSON resident sidecar** via the existing `createPiperService` (lazy-spawn + idle-kill free), not an HTTP server. The standalone tuner (`kokoro_tuner_server.py`, :8199) is retired and folded into the app. Enrollment/intake is a one-shot sidecar (heavy, rare).
8. **Consent/ethics — 4-gate model, calibrated:** default path is Lucas cloning **his own** voice (`subject:"self"`) → allowed. Third-party and any public/commercial output are gated/refused. Watermark + accent-washout scoring are unproven on ROCm → best-effort, spiked in Phase 7, not launch blockers for the self-voice path. Ships kill-switched OFF (`ZOE_CLONE_ENABLED=off`).

---

## (A) Target architecture

```
main.js ──speakThroughCompanion({surface})──▶ lib/tts.js
                                                │ voices.resolve({voice,surface}) → {engine,params,license,policy}
                                                │ _services: Map<engine, residentSidecar>  (per-engine idle-kill)
        ┌───────────────────────────────────────┼──────────────────────────────┐
        ▼                                        ▼                              ▼
 sidecar/tts_piper.py (CPU)        sidecar/tts_kokoro.py (GPU)         sidecar/tts_f5.py (GPU, NEW)
 voice=.onnx per request           per-request recipe/weights          per-voice cond.pt cache
 (already multi-voice)             + in-proc blend cache (EDIT)         (clone runtime)
                                                                                 ▲
                          sidecar/f5_intake.py (NEW, one-shot enroll: yt-dlp→ffmpeg→whisper→quality→mint)
```

All sidecars share `tts_kokoro_venv` + the proven HIP/MIOpen env block (`HIP_VISIBLE_DEVICES=1`, persistent MIOpen cache, `KMP_DUPLICATE_LIB_OK`). `lib/tts.js` transport (`parseNdjson`, id-correlation, idle-kill, fail-soft, one-shot) is **unchanged** — it already generalizes.

**`ENGINES` table (new in `lib/tts.js`):**
```js
const KVENV = 'sidecar/tts_kokoro_venv/Scripts/python.exe';   // shared
const ENGINES = {
  piper:  { py: VENV_PY, runner: 'sidecar/tts_piper.py',  gpu:false, idleMs: LONG },
  kokoro: { py: KVENV,   runner: 'sidecar/tts_kokoro.py', gpu:true,  idleMs: GPU_IDLE },
  f5:     { py: KVENV,   runner: 'sidecar/tts_f5.py',     gpu:true,  idleMs: GPU_IDLE },
};
```

**Registry schema (`data/voices/registry.json` — track this file; blobs git-ignored):**
```json
{ "version":1, "active":"zoe",
  "surfaces":{"companion":"zoe","meeting":"zoe","read-aloud":"zoe","two-way":"zoe"},
  "voices":{
    "zoe":  {"id":"zoe","name":"Zoe","kind":"blend","engine":"kokoro",
             "recipe":{"weights":{"af_bella":0.318,"af_nicole":0.273,"bf_isabella":0.409},"lang":"b","speed":1.13},
             "sample":"zoe/sample.wav","license":"Apache-2.0","consent":null},
    "lucas":{"id":"lucas","name":"Lucas (clone)","kind":"clone","engine":"f5",
             "ref":{"audioPath":"clones/lucas/ref.wav","refText":"clones/lucas/ref.txt","cachePath":"clones/lucas/cond.pt"},
             "record":"clones/lucas/voice.json","sample":"clones/lucas/sample.wav",
             "license":"CC-BY-NC-4.0","commercial_use":false,"consent":"self-clone 2026-08-12"},
    "amy":  {"id":"amy","name":"Amy (stock)","kind":"stock","engine":"piper",
             "modelPath":"en_US-amy-medium.onnx","speaker":null,"license":"MIT","consent":null}
  }}
```
Resolution precedence in `voices.resolve`: explicit `opts.voice` id → surface override (config, then registry) → `config.activeVoice` → `registry.active` → legacy `.onnx`-path shim (keeps today's `main.js` call working).

**Sidecar set (final):**

| file | status | role |
|---|---|---|
| `sidecar/tts_piper.py` | exists, no change | stock CPU, already multi-voice |
| `sidecar/tts_kokoro.py` | **edit** | per-request `recipe`/weights + in-proc blend cache (drop the baked `RECIPE_PATH`, fall back to `zoe_voice.json`) |
| `sidecar/tts_f5.py` | **new** | F5 clone runtime, NDJSON, per-voice `cond.pt` cache |
| `sidecar/f5_intake.py` | **new** | one-shot enroll: fetch→clean/VAD→whisper→quality verdict→mint |
| (later) streaming mode | **edit** | chunked-PCM job mode in kokoro/f5 sidecars for duplex |

---

## (B) In-app UX — Voice Studio

**Host (no new window):** one rail button in `renderer/workspace.html` Studios group; `workspace.js:select()` already swaps `view.src`/title, and `main.js:299-300` forces the shared `preload.js` onto every workspace webview → `voice.html` gets `window.sq` for free (like the Editor surface).

**New renderer files:** `renderer/voice.html` (one surface, three sub-tabs: Library / Tuner / Clone) + `renderer/voice.js` (the **Tuner is a near-verbatim port** of the `PAGE` script in `kokoro_tuner_server.py`, swapping `fetch('/synth')` → `window.sq.voice.preview(recipe)` and adding **Save as named voice**; playback via `new Audio(pathToFileURL(out))` as at `companion.html:54`).

**IPC (`sq.voice.*` in `preload.js`; `ipcMain.handle` near the editor block ~`main.js:3168+`; delegate to `lib/voice_studio.js`):**

| channel | does |
|---|---|
| `voice:library-list` | registry entries + stock, mark active |
| `voice:stock-voices` | 12 Kokoro ids/labels (lift `VOICES` from `kokoro_tuner_server.py`) |
| `voice:preview {recipe,text}` | synth one sample → temp wav |
| `voice:save {name,recipe}` | write registry entry + bake `sample.wav` |
| `voice:set-active {id}` | set `registry.active`/surface → `shutdownTts()` hot-recycle |
| `voice:delete {id}` | remove entry + sample (soft for clones — see §C revoke) |
| `voice:clone-intake {mode,pathOrUrl,bytes}` | yt-dlp/file/mic → ffmpeg cut+normalize → whisper → `{ref_wav,ref_text,duration,quality}` |
| `voice:clone-preview {ref_wav,ref_text,text,cfg,nfe}` | F5 synth → wav url |
| `voice:mint {intake,consent}` | write-gated mint (§C Gate 1/2) |

**Mic capture (Clone→record):** `getUserMedia`+`MediaRecorder` in `voice.html`. **Gotcha:** the `setPermissionRequestHandler` allow-lists at `main.js:330-345` are scoped only to `persist:zoe-google`/`persist:zoe-teams`. The workspace webview uses the default session → **add a `media`/`audioCapture` allow handler on the workspace session/partition**, or mic access hangs silently.

---

## (C) Consent / ethics / licensing

Kokoro/Piper are voiceless synthesizers (no identity risk). A **clone is a captured human identity + license + consent record** — inseparable from its `voice.json`. Ships kill-switched OFF (`ZOE_CLONE_ENABLED=off`).

**Per-clone `data/voices/clones/<id>/voice.json`** (no valid record → no voice): `{id, display_name, engine, license, commercial_use, created_utc, ref{path,text_path,duration_s,sha256,source,source_url}, consent{subject:self|third_party, subject_name, granted_by, granted_utc, scope, attestation, revoked}, provenance{watermark,quality,accent_baseline}, policy{public_output,impersonation_allowed}}`.

**Four gates (in code, in order):**
1. **Consent at mint** (`voices.mint` write-gate): requires `consent.subject`+`granted_by`+`attestation`; `third_party` forces `public_output:false`+`impersonation_allowed:false`, no override.
2. **License propagation:** F5 = CC-BY-NC → every F5 voice stamped `commercial_use:false`; any publish/commercial path checks + refuses. Escape = re-mint on an MIT engine (Chatterbox, future) — license becomes a routing decision.
3. **Watermark + provenance (best-effort):** Perth/AudioSeal inaudible mark. **⚠ UNPROVEN on ROCm-Windows** — spike before treating as done; don't block the self-voice path on it.
4. **Refuse public impersonation (speak-time read-gate):** refuse third-party voice → public/shareable surface, or speech framed as a real named person's real statement. `subject:"self"` for the assistant's own speech = allowed default. `revoked:true` → hard refuse even if files remain.

Minting a third-party voice or emitting cloned audio to any outbound/publishable channel is surfaced to the operator for confirmation (consistent with `zoe-email-send-disabled`). **Lucas cloning his own voice for his own assistant is the sanctioned default and is not blocked.**

---

## (D) Phased build plan (each independently shippable)

Reboot rule: `main.js`/`preload.js`/`lib/config.js` → reboot; `renderer/*` → hot; `sidecar/*.py` → hot (respawns); blend `set-active` → hot via `shutdownTts()`. Obey the memory rules: **ask for a per-session reboot grant + run the live-guard** (user-turn age >3min, no meeting, no in-flight) before any kill; `git add` NAMED files only (Desktop is a repo containing SQ — never `git add -A`); never touch `renderer/kg3d.js`.

- **Phase 0 — DONE this session:** Kokoro GPU sidecar live (Zoe speaks a blend via speakers); `piper|kokoro` provider switch; blend tuner web UI (retiring); F5 clone proven on the 7900 XT; reference intake proven (yt-dlp + ffmpeg + faster-whisper); shared venv holds both engines.
- **Phase 1 — Registry foundation. ✅ DONE 2026-08-12.** `lib/voices.js` (load/list/get/resolve/setActive/setSurface/upsert/remove + legacy-`.onnx` shim + first-boot migration; factory+singleton like `createPiperService`); `data/voices/registry.json` **seeded** from the live world (`zoe` blend active + 5 Piper stock); `scripts/smoke_voices.js` (**29/29 PASS** under plain node AND Electron-as-Node) added to the `run_smokes.js` gate. **Accept met:** smoke proves migration + full resolve precedence ladder + legacy shim + fail-soft (empty/corrupt/absent never throw). **Reboot:** none needed (nothing yet consumes the registry — `lib/tts.js` still runs its own `piper|kokoro` switch; Phase 2 wires resolve→synth). **NOTE on `.gitignore`:** did NOT weaken the blanket `data/` ignore (protects Zoe's personal state); `registry.json` lives untracked in `data/voices/` beside `zoe_voice.json` — use `git add -f data/voices/registry.json` if versioning is wanted.
- **Phase 2 — Multi-blend Kokoro + engine routing.** Edit `sidecar/tts_kokoro.py` (per-request recipe/weights + blend cache by weight-hash); `lib/tts.js` (`_singleton`→`_services` Map + `ENGINES` + resolve-driven params); `lib/config.js` (`activeVoice`); `main.js:479` (`{surface:'companion'}`). **Accept:** switch `registry.active` between two blends → voice changes next utterance, no model reload. **Reboot:** yes.
- **Phase 3 — Voice Studio (Library + Tuner).** *The tab the operator asked for.* `renderer/workspace.html` rail button; new `renderer/voice.html`+`voice.js` (port tuner); new `lib/voice_studio.js`; `preload.js` `sq.voice.*`; `main.js` IPC. Retire `kokoro_tuner_server.py`/:8199. **Accept:** audition blends, save a named voice, set active → companion speaks it. **Reboot:** yes (main/preload), renderer hot after.
- **Phase 4 — F5 clone runtime.** New `sidecar/tts_f5.py` (port the proven spike: HIP/MIOpen preamble, `_REAL_STDOUT` split, soundfile I/O shim, `torch.distributed` stubs, `load_with_torchcodec` monkeypatch, `--serve` NDJSON, per-voice `cond.pt` cache keyed by `(ref_mtime,ref_text,model)`, warmup default voice); add `f5` to `ENGINES`; `cloneConfig()`. **Accept:** warm same-voice latency drops (cond cached); one-shot + serve both work. **Reboot:** yes (config).
- **Phase 5 — Enrollment + intake + write-gate.** New `sidecar/f5_intake.py` (yt-dlp/file → ffmpeg mono/24k/EBU-R128 → VAD pick 6–12s → whisper ref_text → quality verdict); `lib/voices.js` `mint` = Gate 1+2, writes `clones/<id>/{ref.wav,ref.txt,cond.pt,sample.wav,voice.json}`. **Accept:** bad ref → reject; no-consent → refused; good self-ref → selectable. **Reboot:** no.
- **Phase 6 — Clone flow in Studio + clone-as-Zoe.** `main.js` mic-permission handler on the workspace session (§B) + IPC `clone-intake/preview/mint`; `renderer/voice.js` Clone sub-tab (record/URL/file → preview → save). **Accept:** record 10s → preview → save → set active → companion speaks the clone. **Reboot:** yes once (mic handler).
- **Phase 7 — Guardrail hardening.** Gate 4 read-gate + `revoke` soft-delete (keep provenance); watermark hook (Gate 3, **spike first**); accent-washout scorer (**spike first** — needs a speaker-embedding model, not installed). **Accept:** third-party+public → refuse; revoked → hard refuse; watermark/accent land only if spikes pass. **Reboot:** no (unless config touched).
- **Phase 8 — Per-surface overrides + GPU coexistence.** `lib/config.js` (`surfaceVoices`, `gpuIdleMs`); `lib/tts.js` (per-engine GPU idle-kill; advisory GPU lock shared with image-gen; GPU-OOM→piper retry); meeting path passes `surface:'meeting'`. **Accept:** meeting vs companion carry different voices; synth during a ComfyUI batch degrades to Piper instead of OOM. **Reboot:** yes.
- **Phase 9 — Streaming job mode (duplex prereq).** Chunked-PCM streaming in kokoro+f5 sidecars; streaming request variant in `lib/tts.js`. **Accept:** low first-audio latency + clean barge-in cut-off. **Reboot:** sidecar no / lib/tts.js maybe.
- **Phase 10 — Wire into the two-way loop (Echo).** Point `echo/voice/session.py`'s TTS plugin at Zoe's shared sidecar reading the shared registry; delete/replace `echo/voice/tts_kokoro.py`; salvage `session.py`/`agent.py`/`wakeword.py`/`voice_mint_token`. Follow Echo branch topology (local mirror only, never branch off main). **Accept:** full-duplex speaks the same registry voice as chat/read-aloud/meetings; change the recipe once → everything updates. **Reboot:** Echo-side.

*Trajectory: Zoe speaks in blended AND cloned voices for chat, read-aloud, and meetings (Phases 1–8) well before the hard duplex plumbing; the duplex loop inherits the identity for free (9–10).*

---

## (E) Risks + open decisions

1. **VRAM contention with ComfyUI (20 GB).** Kokoro(~1 GB)+F5(~1.3 GB) warm alongside a big SDXL batch can OOM. Mitigations designed; the GPU lock is new coordination. **Decision:** lock-file vs in-process semaphore, and does the image-gen path honor it?
2. **Shared-venv fragility.** Works today; a future `transformers`/`x-transformers`/`torch` bump for one engine could break the other. **Decision:** freeze/pin the venv now to prevent drift?
3. **Watermark + accent-washout unproven on ROCm.** **Decision:** launch-blocking or best-effort for the self-voice path? (Recommend best-effort; spike in Phase 7.)
4. **Disk ~15–18 GB.** F5 weights already installed; incremental cost is small git-ignored `cond.pt`/wav blobs. Low, but watch as clones accrue.
5. **Reboot cadence.** Phases 2/3/4/6/8 each need a reboot — batch main/preload/config edits per phase; obey the live-guard.
6. **Echo cutover timing.** Collapsing `echo/voice/tts_kokoro.py` is Phase 10 (depends on streaming, Phase 9). **Decision:** keep Echo's kokoro-onnx as a fallback during transition? (Recommend yes until duplex is proven E2E — Echo's Phase-4C stack has never run E2E.)
7. **`configured` gets stricter for clones** (valid consent record, not just files-exist) — confirmed it won't disable the existing blend path (blends have `consent:null`, validate trivially).

## Key files (absolute)
- `C:\Users\azrae\Desktop\Side Quest\lib\tts.js` · `lib\config.js` (`ttsConfig`) · `main.js` (`speakThroughCompanion` + call ~479; preload injection 299-300; mic-permission precedent 330-345; ensureComfyUI 2947-2970; dialog 3449; editor IPC ~3168+)
- `C:\Users\azrae\Desktop\Side Quest\sidecar\tts_kokoro.py` · `sidecar\kokoro_tuner_server.py` (PAGE/blend math/VOICES to port) · `sidecar\tts_kokoro_venv\Scripts\python.exe` (shared venv, holds kokoro+f5_tts+faster_whisper+imageio_ffmpeg+soundfile)
- `C:\Users\azrae\Desktop\Side Quest\data\voices\zoe_voice.json` (seed → migrate)
- `renderer\workspace.html`/`workspace.js`; `renderer\companion.html:54` (audio playback pattern)
- Echo salvage: `NX ECHO\nx-echo\echo\voice\{session.py,agent.py,wakeword.py}`; replace `echo\voice\tts_kokoro.py`
- **New:** `lib\voices.js`, `lib\voice_studio.js`, `renderer\voice.html`, `renderer\voice.js`, `sidecar\tts_f5.py`, `sidecar\f5_intake.py`, `data\voices\registry.json`, `scripts\smoke_voices.js`

> The F5 install recipe (`--no-deps`, soundfile I/O shim, `torch.distributed` stubs, transformers 4.x pin, x-transformers<2) is already satisfied in the shared venv, but `sidecar/tts_f5.py` must be written fresh (the `scratchpad/f5_clone.py` spike lives in the session temp dir, not the repo).
