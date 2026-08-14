"""sidecar/stt_whisper.py — local CPU speech-to-text (faster-whisper `base`, int8), Zoe's ears.

Same NDJSON contract as sidecar/tts_kokoro.py, so lib/stt.js drives it identically:
  * ONE-SHOT (default): read ONE JSON job from stdin, transcribe, write ONE JSON line, exit.
  * SERVE (--serve): resident loop, one NDJSON request per line -> one NDJSON response.

Request:  { "id"?: <any>, "in": <audio file path> }
Response: { "id"?, "ok": true, "text": <str>, "ms": <int>, "lang": <str> } | { "id"?, "ok": false, "error" }

CPU int8 `base` BY DESIGN: ctranslate2 has no ROCm/HIP backend on this box (get_cuda_device_count()==0),
so STT stays on the CPU and the RX 7900 XT is reserved for Kokoro TTS. Decodes any ffmpeg-readable
container (the renderer's MediaRecorder emits webm/opus) via PyAV -> 16 kHz mono float32, silence-guards
(Whisper hallucinates on pure silence), then transcribes. The transcribe core (decode + silence guard +
WhisperModel(base, cpu, int8)) is lifted from echo/voice/stt_whisper.py with the LiveKit stt.STT wrapper
stripped. Model-load + torch/av chatter go to stderr; the protocol stream on stdout stays clean JSON.
"""
import sys, os, json, time

# Keep OpenMP happy (ctranslate2 + any torch in-proc) and quiet the HF symlink warning on Windows.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import warnings
warnings.filterwarnings("ignore")

_REAL_STDOUT = sys.stdout  # responses go here; all other output -> stderr

MODEL_SIZE = os.environ.get("ZOE_STT_MODEL", "base")   # tiny|base|small|... (base is cached; sub-second on CPU)
DEVICE = "cpu"
COMPUTE_TYPE = "int8"
BEAM_SIZE = 5            # faster-whisper default; base int8 is fast enough to afford it
SAMPLE_RATE = 16000     # Whisper requires 16 kHz mono float32

_state = {"model": None}


def _respond(obj):
    _REAL_STDOUT.write(json.dumps(obj) + "\n")
    _REAL_STDOUT.flush()


def _ensure_model():
    if _state["model"] is not None:
        return
    from faster_whisper import WhisperModel
    _state["model"] = WhisperModel(
        MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE, cpu_threads=0,
    )


def transcribe_one(req):
    """Transcribe one audio file. Never raises — always returns a response dict."""
    rid = req.get("id")
    path = req.get("in") or ""
    if not path:
        return {"id": rid, "ok": False, "error": "no input path"}
    if not os.path.exists(path):
        return {"id": rid, "ok": False, "error": "input not found"}
    t0 = time.time()
    try:
        _ensure_model()
        import numpy as np
        from faster_whisper.audio import decode_audio
        audio = decode_audio(path, sampling_rate=SAMPLE_RATE)   # -> float32 mono @16k via PyAV
        peak = 0.0 if (audio is None or audio.size == 0) else float(np.abs(audio).max())
        dur = 0.0 if (audio is None or audio.size == 0) else round(audio.size / SAMPLE_RATE, 2)
        # Silence guard: Whisper hallucinates full sentences on pure silence. Skip the transcribe call.
        if peak < 1e-4:
            return {"id": rid, "ok": True, "text": "", "ms": int((time.time() - t0) * 1000), "lang": "", "dur": dur, "peak": round(peak, 4)}
        # Anti-hallucination flags (these killed the "woof woof / ho ho / thanks" repetition in the bake-off):
        # whisper's own VAD drops non-speech; no_speech_threshold gates silence; condition_on_previous_text=False
        # stops it looping on prior garbage; temperature=0 is deterministic; pin English. NO peak-normalize
        # (it mangled quiet, click-y mic audio — a click became the peak and crushed the speech).
        segments, info = _state["model"].transcribe(
            audio, beam_size=BEAM_SIZE, language="en", vad_filter=True,
            no_speech_threshold=0.6, condition_on_previous_text=False, temperature=0.0,
        )
        text = "".join(s.text for s in segments).strip()   # segments is a generator — materialize once
    except Exception as e:
        return {"id": rid, "ok": False, "error": ("transcribe: " + str(e))[:200]}
    return {"id": rid, "ok": True, "text": text,
            "ms": int((time.time() - t0) * 1000),
            "lang": getattr(info, "language", "") or "",
            "dur": dur, "peak": round(peak, 4)}


def serve():
    sys.stdout = sys.stderr  # keep faster-whisper/ct2/av chatter off the protocol stream
    try:
        _ensure_model()       # pay the model load up front so the first utterance is fast
    except Exception as e:
        _respond({"ok": True, "ready": True, "warn": ("load: " + str(e))[:160]})
    else:
        _respond({"ok": True, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            _respond({"ok": False, "error": "bad request json"})
            continue
        _respond(transcribe_one(req))


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception:
        _respond({"ok": False, "error": "bad job json"})
        return
    sys.stdout = sys.stderr
    _respond(transcribe_one(job))


if __name__ == "__main__":
    main()
