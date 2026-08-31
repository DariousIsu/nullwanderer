"""
sidecar/voice_clone/clone_tts.py — zero-shot voice cloning via F5-TTS, one utterance per call.

Given a reference WAV (a clean clip of the target voice) + the text to speak, synthesize speech in
that voice. Native Windows, no WSL, no ROCm required (runs on CPU torch; a ROCm torch swap only makes
it faster). "Pretty good" zero-shot per the operator's brief — timbre from the reference, arbitrary
length from F5's flow-matching (no autoregressive drift).

Contract (matches the Piper sidecar's shape): read one JSON request on argv, print one JSON line.
  in : { "text": str, "ref_audio": path, "ref_text": str|null, "out": path }
  out: { "ok": true, "out": path } | { "ok": false, "error": str }

ref_text may be null — F5 auto-transcribes the reference with Whisper. Weights: OpenF5-TTS-Base
(Apache-2.0), resolved from the HF cache.
"""
import sys, json, traceback

def main():
    try:
        req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad request: {e}"})); return

    try:
        from importlib.resources import files
        from f5_tts.api import F5TTS
        import soundfile as sf

        text = (req.get("text") or "").strip()
        ref_audio = req.get("ref_audio")
        ref_text = req.get("ref_text") or ""   # "" → F5 auto-transcribes with Whisper
        out = req.get("out")
        if not text or not ref_audio or not out:
            print(json.dumps({"ok": False, "error": "text, ref_audio and out are required"})); return

        # Prefer OpenF5 (Apache-2.0) when its checkpoint is present; otherwise fall back to the
        # already-cached SWivid F5TTS_v1_Base (auto-resolved, CC-BY-NC — fine for proof, swap for commercial).
        ckpt = req.get("ckpt") or ""
        if ckpt:
            model = F5TTS(model="F5TTS_Base", ckpt_file=ckpt, vocab_file=req.get("vocab") or "")
        else:
            model = F5TTS(model="F5TTS_v1_Base")
        wav, sr, _ = model.infer(
            ref_file=ref_audio, ref_text=ref_text, gen_text=text,
            remove_silence=True,
        )
        sf.write(out, wav, sr)
        print(json.dumps({"ok": True, "out": out, "sampleRate": int(sr)}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{e}", "trace": traceback.format_exc()[-800:]}))

if __name__ == "__main__":
    main()
