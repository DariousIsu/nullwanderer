"""sidecar/speaker_verify.py — local speaker embedding (voice fingerprint) via 3D-Speaker CAM++ (sherpa-onnx).

WHY (2026-08-13): the always-on mic captures ANY speech in the room — a video the operator is watching, a
person nearby, an announcement — and, with a clean STT pipeline, feeds all of it to Zoe's brain as if the
operator said it. The cure is speaker verification: only accept an utterance whose voice matches the enrolled
operator. This sidecar turns one utterance WAV into a 512-dim L2-normalized embedding; the POLICY (enrolled
centroid, cosine threshold, gate on/off) lives in lib/speaker.js + main.js so it can be tuned without touching
Python. Proven on this box: same voice ~0.97 cosine, clearly different voices ~0.2-0.33, ~30-90ms/utterance CPU.

Same NDJSON contract as sidecar/stt_parakeet.py, so lib/speaker.js drives it identically to lib/stt.js:
  Request:  { "id"?: <any>, "in": <audio file path> }
  Response: { "id"?, "ok": true, "emb": [<512 floats>], "dim", "ms", "dur", "peak" } | { "id"?, "ok": false, "error" }

Runs in its OWN venv (sidecar/spk_venv): sherpa-onnx ships its own native runtime, independent of the
onnxruntime python wheel the Parakeet STT venv uses, so the two must not share a venv. Decodes any
ffmpeg-readable container (the renderer's WAV/webm) → 16 kHz mono float32, matching the STT decode path.
"""
import sys, os, json, time, subprocess
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
import warnings
warnings.filterwarnings("ignore")
import numpy as np

_REAL_STDOUT = sys.stdout  # responses go here; all other output -> stderr
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_MODEL = os.path.join(_HERE, "..", "data", "voices", "models", "3dspeaker_campplus_en.onnx")
MODEL = os.path.abspath(os.environ.get("ZOE_SPEAKER_MODEL", _DEFAULT_MODEL))
SAMPLE_RATE = 16000
_state = {"ext": None, "ffmpeg": None, "dim": 0}


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
    if _state["ext"] is not None:
        return
    import sherpa_onnx
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=2, provider="cpu")
    _state["ext"] = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    _state["dim"] = int(_state["ext"].dim)
    # warm the graph on 1s of silence so the first real request is fast
    s = _state["ext"].create_stream()
    s.accept_waveform(sample_rate=SAMPLE_RATE, waveform=np.zeros(SAMPLE_RATE, dtype=np.float32))
    s.input_finished()
    if _state["ext"].is_ready(s):
        _state["ext"].compute(s)


def _decode(path):
    # ffmpeg → 16k mono float32 (anti-aliased resample; identical to the STT decode so enrolled + runtime
    # embeddings share acoustic conditioning). Reads WAV/webm/opus by content, not extension.
    pcm = subprocess.run(
        [_ffmpeg(), "-nostdin", "-i", path, "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "-"],
        capture_output=True).stdout
    return np.frombuffer(pcm, dtype=np.float32).copy()


def embed_one(req):
    """Embed one audio file → L2-normalized vector. Never raises — always returns a response dict."""
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
        if not audio.size:
            return {"id": rid, "ok": False, "error": "empty audio"}
        peak = float(np.abs(audio).max())
        dur = round(audio.size / SAMPLE_RATE, 2)
        s = _state["ext"].create_stream()
        s.accept_waveform(sample_rate=SAMPLE_RATE, waveform=audio)
        s.input_finished()
        if not _state["ext"].is_ready(s):
            return {"id": rid, "ok": False, "error": "too little audio to embed"}
        vec = np.array(_state["ext"].compute(s), dtype=np.float32)
        n = float(np.linalg.norm(vec))
        if n < 1e-9:
            return {"id": rid, "ok": False, "error": "degenerate embedding"}
        vec = vec / n
    except Exception as e:
        return {"id": rid, "ok": False, "error": ("embed: " + str(e))[:200]}
    return {"id": rid, "ok": True, "emb": [round(float(v), 6) for v in vec], "dim": int(vec.size),
            "ms": int((time.time() - t0) * 1000), "dur": dur, "peak": round(peak, 4)}


def serve():
    sys.stdout = sys.stderr  # keep sherpa/onnx chatter off the protocol stream
    try:
        _ensure_model()
    except Exception as e:
        _respond({"ok": True, "ready": True, "warn": ("load: " + str(e))[:160]})
    else:
        _respond({"ok": True, "ready": True, "dim": _state["dim"]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            _respond({"ok": False, "error": "bad request json"})
            continue
        _respond(embed_one(req))


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
    _respond(embed_one(job))


if __name__ == "__main__":
    main()
