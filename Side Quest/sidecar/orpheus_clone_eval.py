"""
orpheus_clone_eval.py — THE CLONE EVAL (Lucas, 2026-09-05 ~12:10: "I want to clone the proper voice and get the
more natural feel from Orpheus if we can get it to work").

Zero-shot cloning by in-context example: a reference recording of HER voice (her Kokoro blend, zoe_ref.wav) is
encoded into SNAC codes by the ONNX encoder, laid out as the model's 7-tokens-per-frame audio tokens, and put in
the prompt with its transcript; then the new text; the model continues in the reference voice. The decode is the
eval's (orpheus_eval.py). The prompt uses the Orpheus control tokens by their custom_token names, which exist
in every Orpheus GGUF's vocabulary:
  128259 start_of_human = <custom_token_3>    128009 <|eot_id|>        128260 end_of_human = <custom_token_4>
  128261 start_of_ai    = <custom_token_5>    128257 start_of_speech = <custom_token_1>
  128258 end_of_speech  = <custom_token_2>    128262 end_of_ai       = <custom_token_6>
  audio token id = 128266 + code + pos|4096  ->  <custom_token_(10 + code + pos|4096)>

Usage:
  python orpheus_clone_eval.py --ref zoe_ref.wav --ref-text zoe_ref.txt --model orpheus-pre [--lines lines.json] --out <dir>
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import orpheus_eval as OE  # noqa: E402

STORE = os.environ.get("ORPHEUS_STORE") or r"C:\Users\azrae\Desktop\Core\orpheus"
ENCODER = os.path.join(STORE, "encoder_model.onnx")
SOH, EOT, EOH, SOA, SOS, EOS, EOA = "<custom_token_3>", "<|eot_id|>", "<custom_token_4>", "<custom_token_5>", "<custom_token_1>", "<custom_token_2>", "<custom_token_6>"

LINES = [
    "Good morning, Lucas. How'd Comicon go? Did Raegan have a good time?",
    "On it — the Louisiana parishes scratch document.",
    "That went about as well as last time... <sigh> I suppose we could try the other door.",
    "<laugh> You already know that. This is my voice, and I want it to be good, not just correct.",
]


def read_wav(path):
    import numpy as np
    with open(path, "rb") as f:
        b = f.read()
    sr = int.from_bytes(b[24:28], "little")
    pcm = np.frombuffer(b[44:], dtype="<i2").astype(np.float32) / 32768.0
    return sr, pcm


def encode(pcm, sr):
    """Her reference -> SNAC codes (l0, l1, l2) through the ONNX encoder."""
    import numpy as np
    import onnxruntime as ort
    if sr != OE.SR:
        raise RuntimeError(f"reference must be {OE.SR} Hz (got {sr})")
    s = ort.InferenceSession(ENCODER, providers=["CPUExecutionProvider"])
    x = np.asarray(pcm, dtype=np.float32).reshape(1, 1, -1)
    out = s.run(None, {s.get_inputs()[0].name: x})
    l0, l1, l2 = [np.asarray(o).reshape(-1).astype(int).tolist() for o in out]
    return l0, l1, l2


def codes_to_tokens(l0, l1, l2):
    """The model's layout, 7 per frame: [l0[i], l1[2i], l2[4i], l2[4i+1], l1[2i+1], l2[4i+2], l2[4i+3]] with the
    positional offset pos|4096 and the base 10 (custom_token_N ↔ id 128256+N)."""
    frames = min(len(l0), len(l1) // 2, len(l2) // 4)
    toks = []
    for i in range(frames):
        seq = [l0[i], l1[2 * i], l2[4 * i], l2[4 * i + 1], l1[2 * i + 1], l2[4 * i + 2], l2[4 * i + 3]]
        for pos, c in enumerate(seq):
            toks.append(f"<custom_token_{10 + int(c) + pos * 4096}>")
    return "".join(toks), frames


def clone_prompt(ref_text, ref_tokens, new_text):
    return f"{SOH}{ref_text}{EOT}{EOH}{SOA}{SOS}{ref_tokens}{EOS}{EOA}{SOH}{new_text}{EOT}{EOH}{SOA}{SOS}"


def generate(prompt, host, model, temperature=0.4, top_p=0.9, repeat_penalty=1.1, max_tokens=1500, timeout=900):
    import urllib.request
    body = json.dumps({"model": model, "prompt": prompt, "raw": True, "stream": False, "keep_alive": -1,
                       "options": {"temperature": temperature, "top_p": top_p, "repeat_penalty": repeat_penalty, "num_predict": max_tokens, "num_ctx": 4096}}).encode("utf-8")
    req = urllib.request.Request(f"{host}/api/generate", data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode("utf-8"))
    return out.get("response", ""), time.time() - t0, out


def f0(pcm, sr):
    import numpy as np
    n = min(len(pcm), int(sr * 0.5)); s = (len(pcm) - n) // 2
    x = pcm[s:s + n]
    best, bl = 0.0, 0
    for lag in range(sr // 400, sr // 70):
        c = float(np.dot(x[:-lag], x[lag:]))
        if c > best:
            best, bl = c, lag
    return round(sr / bl) if bl else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--ref-text", required=True)
    ap.add_argument("--model", default="orpheus-pre")
    ap.add_argument("--host", default=os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"))
    ap.add_argument("--lines", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "..", "data", "voices", "eval_2026-09-05"))
    ap.add_argument("--tag", default="clone")
    a = ap.parse_args()
    lines = LINES if not a.lines else json.load(open(a.lines, encoding="utf-8"))
    ref_text = open(a.ref_text, encoding="utf-8").read().strip()
    sr, pcm = read_wav(a.ref)
    t0 = time.time()
    l0, l1, l2 = encode(pcm, sr)
    ref_tokens, frames = codes_to_tokens(l0, l1, l2)
    print(f"reference: {len(pcm) / sr:.2f}s -> {frames} frames, {frames * 7} audio tokens, encoded in {time.time() - t0:.2f}s | f0 {f0(pcm, sr)} Hz")
    # round trip: decode the reference's own codes — the encoder/decoder pair must reproduce her
    rt = OE.decode({"l0": l0[:frames], "l1": l1[:frames * 2], "l2": l2[:frames * 4]})
    OE.write_wav(os.path.join(a.out, f"{a.tag}_ref_roundtrip.wav"), rt)
    print(f"round trip: {len(rt) / OE.SR:.2f}s | f0 {f0(rt, OE.SR)} Hz -> {a.tag}_ref_roundtrip.wav (should sound like her)")
    os.makedirs(a.out, exist_ok=True)
    made, report = [], []
    for i, line in enumerate(lines):
        try:
            text, secs, raw = generate(clone_prompt(ref_text, ref_tokens, line), a.host, a.model)
            codes = OE.tokens_to_codes(text)
            if codes["frames"] == 0:
                report.append({"i": i, "line": line, "error": "no audio frames", "head": text[:120]}); print(f"[{i + 1}/{len(lines)}] no audio frames — head: {text[:80]!r}"); continue
            audio = OE.decode(codes)
            p = os.path.join(a.out, f"{a.tag}_{i + 1:02d}.wav")
            n = OE.write_wav(p, audio)
            tok_s = (raw.get("eval_count") or 0) / max(1e-9, (raw.get("eval_duration") or 0) / 1e9)
            rec = {"i": i, "line": line, "wav": os.path.basename(p), "audio_s": round(n / OE.SR, 2), "gen_s": round(secs, 1), "tok_per_s": round(tok_s, 1), "frames": codes["frames"], "bad_frames": codes["bad_frames"], "f0": f0(audio, OE.SR), "prompt_tokens": raw.get("prompt_eval_count")}
            report.append(rec); made.append(p)
            print(f"[{i + 1}/{len(lines)}] {rec['wav']} {rec['audio_s']}s in {rec['gen_s']}s ({rec['tok_per_s']:.0f} tok/s, {rec['frames']} frames, {rec['bad_frames']} bad, f0 {rec['f0']} Hz, prompt {rec['prompt_tokens']} tok)", flush=True)
        except Exception as e:  # noqa: BLE001
            report.append({"i": i, "line": line, "error": str(e)[:200]}); print(f"[{i + 1}/{len(lines)}] FAILED: {e}", flush=True)
    if made:
        OE.reel(made, os.path.join(a.out, f"{a.tag}_reel.wav"))
    with open(os.path.join(a.out, f"{a.tag}_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    ok = [r for r in report if "wav" in r]
    print(f"done: {len(ok)}/{len(lines)} | reel: {a.tag}_reel.wav" if ok else "done: nothing synthesized")


if __name__ == "__main__":
    main()
