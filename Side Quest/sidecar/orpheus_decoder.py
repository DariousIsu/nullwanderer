"""
orpheus_decoder.py — the resident SNAC decoder for her Orpheus voice (Lucas, 2026-09-05: "the zoe voice is the
one, switch her over"). One process, the ONNX decoder loaded once, NDJSON over stdio (the face_embed.py idiom):
  in : {"id": n, "text": "<custom_token_…>…", "out": "path.wav"}
  out: {"id": n, "ok": true, "out": "path.wav", "bytes": …, "seconds": …, "frames": …, "bad_frames": …}
       {"id": n, "ok": false, "error": "…"}
The token math and the decode live in orpheus_eval.py (the eval that chose this voice) — one implementation.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orpheus_eval as OE  # noqa: E402


def main():
    if "--serve" not in sys.argv:
        print("usage: orpheus_decoder.py --serve", file=sys.stderr); sys.exit(2)
    t0 = time.time()
    try:
        OE.decode({"l0": [0], "l1": [0, 0], "l2": [0, 0, 0, 0]})   # load the session now, not on the first sentence
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"kind": "ready", "ok": False, "error": str(e)[:200]}) + "\n"); sys.stdout.flush()
        sys.exit(1)
    sys.stdout.write(json.dumps({"kind": "ready", "ok": True, "load_s": round(time.time() - t0, 2)}) + "\n"); sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            codes = OE.tokens_to_codes(req.get("text") or "")
            if codes["frames"] == 0:
                sys.stdout.write(json.dumps({"id": rid, "ok": False, "error": "no audio frames"}) + "\n"); sys.stdout.flush(); continue
            audio = OE.decode(codes)
            n = OE.write_wav(req["out"], audio)
            sys.stdout.write(json.dumps({"id": rid, "ok": True, "out": req["out"], "bytes": 44 + n * 2, "sampleRate": OE.SR, "seconds": round(n / OE.SR, 2), "frames": codes["frames"], "bad_frames": codes["bad_frames"]}) + "\n")
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({"id": rid, "ok": False, "error": str(e)[:200]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
