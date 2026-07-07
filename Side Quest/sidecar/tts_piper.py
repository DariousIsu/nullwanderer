"""
sidecar/tts_piper.py — local text-to-speech runner (voice-avatar-plan V1 + persistent V1+).

Two modes, one code path:
  * ONE-SHOT (default): read ONE JSON job from stdin, synthesize, write ONE JSON line, exit.
  * SERVE (`--serve`): stay resident. Read newline-delimited JSON requests from stdin, synthesize each,
    write one newline-delimited JSON response per request. The voice MODEL is loaded ONCE and cached, so
    every request after the first skips the ~1.5-2s model reload (the whole point of the persistent mode).

Request:  { "id"?: <any>, "text": <str>, "voice": <path .onnx>, "out": <wav path>, "speaker"?: <int> }
Response: { "id"?, "ok": true, "out", "bytes", "sampleRate" }  |  { "id"?, "ok": false, "error" }

Consume-only / offline: no network, no telemetry. The voice model (piper .onnx + sibling .onnx.json) is
supplied by the caller. Piper prints ONNX init chatter; in serve mode we permanently point sys.stdout at
sys.stderr and write responses to a saved real-stdout handle, so the protocol stream stays clean JSON.
"""
import sys
import os
import json
import wave
import warnings
warnings.filterwarnings("ignore")

# saved handle to the REAL stdout — responses go here; everything else (piper chatter) → stderr.
_REAL_STDOUT = sys.stdout


def _respond(obj):
    _REAL_STDOUT.write(json.dumps(obj) + "\n")
    _REAL_STDOUT.flush()


def synth_one(req, voices):
    """Synthesize one request. `voices` is a path→PiperVoice cache (persists across calls in serve mode).
    Returns a response dict. Never raises."""
    rid = req.get("id")
    text = (req.get("text") or "").strip()
    voice = req.get("voice") or ""
    out = req.get("out") or ""
    speaker = req.get("speaker")

    if not text:
        return {"id": rid, "ok": False, "error": "empty text"}
    if not voice or not os.path.exists(voice):
        return {"id": rid, "ok": False, "error": "voice model not found: " + str(voice)[:160]}
    if not out:
        return {"id": rid, "ok": False, "error": "no out path"}

    try:
        from piper import PiperVoice
        v = voices.get(voice)
        if v is None:
            v = PiperVoice.load(voice)      # the expensive step — cached so it happens at most once per voice
            voices[voice] = v
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        syn_config = None
        if speaker is not None:
            try:
                from piper.config import SynthesisConfig
                syn_config = SynthesisConfig(speaker_id=int(speaker))
            except Exception:
                syn_config = None
        with wave.open(out, "wb") as wf:
            # piper 1.4.x: synthesize_wav sets the wav header (set_wav_format=True) then streams audio.
            v.synthesize_wav(text, wf, syn_config=syn_config)
        sr = 0
        try:
            with wave.open(out, "rb") as rf:
                sr = rf.getframerate()
        except Exception:
            sr = 0
        size = os.path.getsize(out) if os.path.exists(out) else 0
    except Exception as e:
        return {"id": rid, "ok": False, "error": ("synthesize: " + str(e))[:200]}

    if not size:
        return {"id": rid, "ok": False, "error": "wav not written"}
    return {"id": rid, "ok": True, "out": out, "bytes": size, "sampleRate": sr}


def serve():
    """Persistent loop: one NDJSON request per stdin line → one NDJSON response. Exits when stdin closes."""
    # all incidental output (piper init chatter) → stderr; responses go to _REAL_STDOUT via _respond().
    sys.stdout = sys.stderr
    voices = {}
    _respond({"ok": True, "ready": True})   # handshake so the manager knows the process is live
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            _respond({"ok": False, "error": "bad request json"})
            continue
        _respond(synth_one(req, voices))


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    # one-shot: read all of stdin as a single job
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception:
        _respond({"ok": False, "error": "bad job json"})
        return
    # keep piper chatter off stdout for the single response too
    sys.stdout = sys.stderr
    _respond(synth_one(job, {}))


if __name__ == "__main__":
    main()
