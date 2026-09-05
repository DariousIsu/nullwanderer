"""
orpheus_eval.py — the voice-model eval (Lucas, 2026-09-05: "go on the voice model upgrade").

Synthesizes a set of her lines through Orpheus 3B (Canopy Labs' orpheus-3b-0.1-ft, Q4_K_M GGUF) served by
the Ollama already on this box (raw prompt mode, no chat template), and decodes the model's SNAC audio tokens
with the ONNX SNAC 24 kHz decoder under onnxruntime — no torch, no vllm. Writes one wav per line and a reel.

Usage:
  python orpheus_eval.py --lines lines.json --out <dir> [--voice tara] [--host http://127.0.0.1:11434] [--model orpheus-tts]
  python orpheus_eval.py --probe            # one short line, prints the raw token head so the wiring can be read

The token math is the reference one (isaiahbjork/orpheus-tts-local gguf_orpheus.py + Orpheus decoder.py):
  <custom_token_N>  →  id = N − 10 − (pos % 7) · 4096       (pos = index within the whole token stream)
  per frame of 7:   level0 = [c0]   level1 = [c1, c4]   level2 = [c2, c3, c5, c6]
"""
import argparse
import json
import os
import re
import struct
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.environ.get("ORPHEUS_STORE") or r"C:\Users\azrae\Desktop\Core\orpheus"
DECODER = os.path.join(STORE, "decoder_model.onnx")
SR = 24000
TOKEN_RE = re.compile(r"<custom_token_(\d+)>")
DEFAULT_LINES = [
    "Good morning, Lucas. How'd Comicon go? Did Raegan have a good time?",
    "Goodnight, Lucas. Tell Raegan I said hi at Comicon. I'll be here.",
    "On it — the Louisiana parishes scratch document.",
    "Have a good one, Lucas.",
    "Good — thirty-five minutes is easy.",
    "I told you I'd make that Louisiana parishes document and then never actually did it. It's done now.",
    "That went about as well as last time... <sigh> I suppose we could try the other door.",
    "<laugh> You already know that. This is my voice, and I want it to be good, not just correct.",
]


def generate_tokens(text, voice, host, model, temperature=0.6, top_p=0.9, repeat_penalty=1.1, max_tokens=1200, timeout=600):
    """One raw completion through Ollama; returns the response text (custom-token strings) and timing."""
    prompt = f"<|audio|>{voice}: {text}<|eot_id|>"
    # STOP at end_of_speech (<custom_token_2>): the fine-tuned model ends a line there and, with no stop, runs on
    # into a second take (six of eight lines came back at twice their length, 15:20). Harmless for the base model.
    body = json.dumps({
        "model": model, "prompt": prompt, "raw": True, "stream": False,
        "options": {"temperature": temperature, "top_p": top_p, "repeat_penalty": repeat_penalty, "num_predict": max_tokens, "stop": ["<custom_token_2>"]},
    }).encode("utf-8")
    req = urllib.request.Request(f"{host}/api/generate", data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode("utf-8"))
    return out.get("response", ""), time.time() - t0, out


def tokens_to_codes(text):
    """The reference math: strings → ids → the three SNAC levels. Drops a trailing partial frame."""
    nums = [int(m) for m in TOKEN_RE.findall(text)]
    ids = []
    pos = 0
    for n in nums:
        # the reference (decoder.py): a token whose id is not positive at the CURRENT position is a control token
        # (<custom_token_4/5/1> open the stream, <custom_token_2> closes it) — skipped WITHOUT advancing the position
        cand = n - 10 - ((pos % 7) * 4096)
        if cand > 0:
            ids.append(cand)
            pos += 1
    frames = len(ids) // 7
    l0, l1, l2 = [], [], []
    bad = 0
    for f in range(frames):
        c = ids[f * 7:(f + 1) * 7]
        if any(x < 0 or x >= 4096 for x in c):
            bad += 1
            continue
        l0.append(c[0]); l1 += [c[1], c[4]]; l2 += [c[2], c[3], c[5], c[6]]
    return {"raw": len(nums), "frames": frames, "bad_frames": bad, "l0": l0, "l1": l1, "l2": l2}


_session = None


def decode(codes):
    """SNAC ONNX decode → float32 mono at 24 kHz (numpy). Feeds the decoder's inputs by shape order."""
    global _session
    import numpy as np
    import onnxruntime as ort
    if _session is None:
        _session = ort.InferenceSession(DECODER, providers=["CPUExecutionProvider"])
    inputs = _session.get_inputs()
    levels = [np.array([codes["l0"]], dtype=np.int64), np.array([codes["l1"]], dtype=np.int64), np.array([codes["l2"]], dtype=np.int64)]
    feed = {}
    if len(inputs) == 3:
        for i, inp in enumerate(inputs):
            feed[inp.name] = levels[i]
    else:
        raise RuntimeError(f"unexpected decoder signature: {[(i.name, i.shape) for i in inputs]}")
    out = _session.run(None, feed)[0]
    audio = np.asarray(out, dtype=np.float32).reshape(-1)
    return audio


def write_wav(path, audio):
    import numpy as np
    x = np.clip(audio, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2").tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16))
        f.write(b"data" + struct.pack("<I", len(pcm)) + pcm)
    return len(pcm) // 2


def reel(paths, out, gap_ms=700):
    import numpy as np
    parts = []
    gap = np.zeros(int(SR * gap_ms / 1000), dtype=np.float32)
    for p in paths:
        with open(p, "rb") as f:
            b = f.read()
        pcm = np.frombuffer(b[44:], dtype="<i2").astype(np.float32) / 32768.0
        parts.append(pcm); parts.append(gap)
    write_wav(out, np.concatenate(parts) if parts else np.zeros(SR, dtype=np.float32))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", default=None, help="a JSON list of strings; default = eight of her lines from 2026-09-05")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "data", "voices", "eval_2026-09-05"))
    ap.add_argument("--voice", default="tara")
    ap.add_argument("--host", default=os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"))
    ap.add_argument("--model", default="orpheus-tts")
    ap.add_argument("--probe", action="store_true")
    a = ap.parse_args()
    lines = DEFAULT_LINES if not a.lines else json.load(open(a.lines, encoding="utf-8"))
    if a.probe:
        text, secs, raw = generate_tokens("Hello, this is a short probe.", a.voice, a.host, a.model, max_tokens=200)
        print(json.dumps({"secs": round(secs, 1), "head": text[:300], "eval_count": raw.get("eval_count"), "eval_duration_s": round((raw.get("eval_duration") or 0) / 1e9, 1)}))
        return
    os.makedirs(a.out, exist_ok=True)
    made, report = [], []
    for i, line in enumerate(lines):
        try:
            text, secs, raw = generate_tokens(line, a.voice, a.host, a.model)
            codes = tokens_to_codes(text)
            if codes["frames"] == 0:
                report.append({"i": i, "line": line, "error": "no audio frames", "head": text[:120]}); continue
            audio = decode(codes)
            p = os.path.join(a.out, f"orpheus_{a.voice}_{i + 1:02d}.wav")
            n = write_wav(p, audio)
            tok_s = (raw.get("eval_count") or 0) / max(1e-9, (raw.get("eval_duration") or 0) / 1e9)
            report.append({"i": i, "line": line, "wav": os.path.basename(p), "audio_s": round(n / SR, 2), "gen_s": round(secs, 1), "tok_per_s": round(tok_s, 1), "frames": codes["frames"], "bad_frames": codes["bad_frames"]})
            made.append(p)
            print(f"[{i + 1}/{len(lines)}] {os.path.basename(p)} {n / SR:.2f}s audio in {secs:.1f}s ({tok_s:.0f} tok/s, {codes['frames']} frames, {codes['bad_frames']} bad)", flush=True)
        except Exception as e:  # noqa: BLE001 — an eval never dies on one line
            report.append({"i": i, "line": line, "error": str(e)[:200]})
            print(f"[{i + 1}/{len(lines)}] FAILED: {e}", flush=True)
    if made:
        reel(made, os.path.join(a.out, f"orpheus_{a.voice}_reel.wav"))
    with open(os.path.join(a.out, f"orpheus_{a.voice}_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    ok = [r for r in report if "wav" in r]
    print(f"done: {len(ok)}/{len(lines)} lines · reel: orpheus_{a.voice}_reel.wav" if ok else "done: nothing synthesized")


if __name__ == "__main__":
    main()
