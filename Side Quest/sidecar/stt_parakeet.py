"""sidecar/stt_parakeet.py — local speech-to-text via NVIDIA Parakeet-TDT-0.6B (onnx-asr, CPU).

WHY (2026-08-13, after Whisper's silence-hallucination bug): Parakeet is a transducer (RNN-T) — it emits
text only when there is acoustic evidence, so it does NOT hallucinate "Thanks / woof woof / ho ho" on
silence/noise the way Whisper does (Whisper zero-pads to 30s + was trained on caption text). ~160ms per
short utterance on CPU (no GPU needed; DirectML is an optional later flip). Same NDJSON contract as
sidecar/tts_kokoro.py, so lib/stt.js drives it identically.

Request:  { "id"?: <any>, "in": <audio file path> }
Response: { "id"?, "ok": true, "text", "ms", "dur", "peak", "lang" } | { "id"?, "ok": false, "error" }

Runs in its OWN venv (sidecar/stt_onnx_venv) — onnxruntime-directml/onnxruntime is mutually exclusive with
other onnxruntime wheels, so it must not share the ROCm-torch tts_kokoro_venv. Decodes any ffmpeg-readable
container (the renderer's webm/opus) → 16 kHz mono float32 via ffmpeg's anti-aliased resampler.
"""
import sys, os, json, time, subprocess
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import warnings
warnings.filterwarnings("ignore")
import numpy as np

_REAL_STDOUT = sys.stdout  # responses go here; all other output -> stderr
MODEL = os.environ.get("ZOE_STT_PARAKEET_MODEL", "nemo-parakeet-tdt-0.6b-v2")
SAMPLE_RATE = 16000
_state = {"model": None, "ffmpeg": None}


def _respond(obj):
    _REAL_STDOUT.write(json.dumps(obj) + "\n")
    _REAL_STDOUT.flush()


def _ffmpeg():
    if _state["ffmpeg"]:
        return _state["ffmpeg"]
    try:
        import imageio_ffmpeg
        _state["ffmpeg"] = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        _state["ffmpeg"] = "ffmpeg"
    return _state["ffmpeg"]


def _ensure_model():
    if _state["model"] is not None:
        return
    import onnx_asr
    _state["model"] = onnx_asr.load_model(MODEL, providers=["CPUExecutionProvider"])
    _state["model"].recognize(np.zeros(SAMPLE_RATE, dtype=np.float32))  # warm the graph


def _decode(path):
    # ffmpeg → 16k mono float32 (anti-aliased resample; handles webm/opus from MediaRecorder cleanly).
    pcm = subprocess.run(
        [_ffmpeg(), "-nostdin", "-i", path, "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "-"],
        capture_output=True).stdout
    return np.frombuffer(pcm, dtype=np.float32).copy()


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
        audio = _decode(path)
        peak = float(np.abs(audio).max()) if audio.size else 0.0
        dur = round(audio.size / SAMPLE_RATE, 2) if audio.size else 0.0
        text = ((_state["model"].recognize(audio) or "").strip()) if audio.size else ""
    except Exception as e:
        return {"id": rid, "ok": False, "error": ("transcribe: " + str(e))[:200]}
    return {"id": rid, "ok": True, "text": text, "ms": int((time.time() - t0) * 1000),
            "lang": "en", "dur": dur, "peak": round(peak, 4)}


def serve():
    sys.stdout = sys.stderr  # keep onnxruntime/hf chatter off the protocol stream
    try:
        _ensure_model()
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
