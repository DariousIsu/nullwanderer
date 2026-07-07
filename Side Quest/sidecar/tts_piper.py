"""
sidecar/tts_piper.py — local text-to-speech runner (voice-avatar-plan V1, the reduced-cost voice "guts").

Reads a JSON job from stdin: { "text": <str>, "voice": <path to .onnx>, "out": <wav path>, "speaker"?: <int> }
Synthesizes speech with Piper (offline, CPU) and writes a WAV to `out`.
Writes ONE JSON line to stdout: { "ok": true, "out", "bytes", "sampleRate" } or { "ok": false, "error" }.

Consume-only / offline: no network, no telemetry. The voice MODEL (piper .onnx + sibling .onnx.json) is
supplied by the caller — this runner only turns text into a wav with whatever voice it's handed.

Piper loads its ONNX model and may print init chatter; we redirect stdout to stderr during synthesis so
stdout stays clean JSON. Fail-soft: any error → a JSON error line (never a stack trace on stdout).
"""
import sys
import os
import json
import wave
import warnings
warnings.filterwarnings("ignore")


def main():
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception:
        sys.stdout.write(json.dumps({"ok": False, "error": "bad job json"}))
        return

    text = (job.get("text") or "").strip()
    voice = job.get("voice") or ""
    out = job.get("out") or ""
    speaker = job.get("speaker")

    if not text:
        sys.stdout.write(json.dumps({"ok": False, "error": "empty text"}))
        return
    if not voice or not os.path.exists(voice):
        sys.stdout.write(json.dumps({"ok": False, "error": "voice model not found: " + str(voice)[:160]}))
        return
    if not out:
        sys.stdout.write(json.dumps({"ok": False, "error": "no out path"}))
        return

    # model-load / init noise → stderr; keep stdout for the final JSON only
    _real = sys.stdout
    sys.stdout = sys.stderr
    try:
        from piper import PiperVoice
        v = PiperVoice.load(voice)
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
        sys.stdout = _real
        sys.stdout.write(json.dumps({"ok": False, "error": ("synthesize: " + str(e))[:200]}))
        return
    sys.stdout = _real

    if not size:
        sys.stdout.write(json.dumps({"ok": False, "error": "wav not written"}))
        return
    sys.stdout.write(json.dumps({"ok": True, "out": out, "bytes": size, "sampleRate": sr}))


if __name__ == "__main__":
    main()
