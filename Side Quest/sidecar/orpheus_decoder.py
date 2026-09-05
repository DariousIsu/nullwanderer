"""
orpheus_decoder.py — the resident SNAC decoder for her Orpheus voice (Lucas, 2026-09-05: "the zoe voice is the
one, switch her over" · "streaming"). One process, the ONNX decoder loaded once, NDJSON over stdio (the
face_embed.py idiom).

Whole-line mode:
  in : {"id": n, "text": "<custom_token_…>…", "out": "path.wav"}
  out: {"id": n, "ok": true, "out": …, "bytes": …, "seconds": …, "frames": …, "bad_frames": …} | {"id", "ok": false, "error"}

Stream mode (the reference's windows: every new frame, decode the last 4 frames and emit the SECOND one — the
decoder sees a frame of context before and two after; the tail flushes on done):
  in : {"id": n, "stream": true, "append": "<custom_token_…>"}      — raw text as it arrives (a tag may split across chunks)
       {"id": n, "stream": true, "done": true}                      — flush the tail
       {"id": n, "stream": true, "abort": true}                     — drop the stream (a barge-in)
  out: {"id": n, "seq": k, "pcm": "<base64 int16 LE mono 24 kHz>", "samples": m}   (zero or more per append)
       {"id": n, "done": true, "frames": f, "samples": total}
The token math and the decode live in orpheus_eval.py (the eval that chose this voice) — one implementation.
"""
import base64
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orpheus_eval as OE  # noqa: E402

TOKEN_RE = re.compile(r"<custom_token_(\d+)>")
WINDOW = 4          # frames per decode window
FRAME_SAMPLES = 2048


class Stream:
    """Per-id state: the unparsed text tail, the positional token ids, the frames emitted so far."""

    def __init__(self):
        self.tail = ""
        self.ids = []          # the positive ids, in order (control tokens skipped without advancing)
        self.emitted = 0       # frames emitted
        self.seq = 0
        self.samples = 0

    def append(self, text):
        self.tail += text
        # parse every complete tag; keep whatever trails the last '>' (a tag may be split across chunks)
        last = self.tail.rfind(">")
        if last < 0:
            return
        head, self.tail = self.tail[:last + 1], self.tail[last + 1:]
        for m in TOKEN_RE.finditer(head):
            n = int(m.group(1))
            cand = n - 10 - ((len(self.ids) % 7) * 4096)
            if cand > 0:
                self.ids.append(cand)

    def frames(self):
        return len(self.ids) // 7

    def _codes(self, f0, f1):
        l0, l1, l2 = [], [], []
        f1 = min(f1, self.frames())          # never slice past the frames that exist
        for f in range(f0, f1):
            c = self.ids[f * 7:(f + 1) * 7]
            if len(c) < 7 or any(x < 0 or x >= 4096 for x in c):
                c = [0] * 7
            l0.append(c[0]); l1 += [c[1], c[4]]; l2 += [c[2], c[3], c[5], c[6]]
        return {"l0": l0, "l1": l1, "l2": l2}

    def ready(self):
        """Yield (seq, pcm_int16_bytes) for every frame that can now be emitted with context."""
        import numpy as np
        out = []
        n = self.frames()
        # frame k can be emitted once frames k-1 .. k+2 exist (a 4-frame window with k second): k+2 < n → k ≤ n-3;
        # the first frame's window is 0..3, so it waits for four frames
        while self.emitted <= n - 3 and (self.emitted > 0 or n >= WINDOW):
            k = self.emitted
            f0 = max(0, k - 1)
            audio = OE.decode(self._codes(f0, f0 + WINDOW))
            off = (k - f0) * FRAME_SAMPLES
            chunk = audio[off:off + FRAME_SAMPLES]
            pcm = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            self.seq += 1; self.samples += len(chunk); self.emitted += 1
            out.append((self.seq, pcm))
        return out

    def flush(self):
        """On done: emit every frame not yet emitted (the last two, without trailing context)."""
        import numpy as np
        out = []
        n = self.frames()
        if n == 0:
            return out
        f0 = max(0, n - WINDOW)
        audio = OE.decode(self._codes(f0, n))
        while self.emitted < n:
            k = self.emitted
            off = (k - f0) * FRAME_SAMPLES
            chunk = audio[off:off + FRAME_SAMPLES]
            pcm = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            self.seq += 1; self.samples += len(chunk); self.emitted += 1
            out.append((self.seq, pcm))
        return out


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()


def main():
    if "--serve" not in sys.argv:
        print("usage: orpheus_decoder.py --serve", file=sys.stderr); sys.exit(2)
    t0 = time.time()
    try:
        OE.decode({"l0": [0], "l1": [0, 0], "l2": [0, 0, 0, 0]})   # load the session now, not on the first sentence
    except Exception as e:  # noqa: BLE001
        _emit({"kind": "ready", "ok": False, "error": str(e)[:200]}); sys.exit(1)
    _emit({"kind": "ready", "ok": True, "load_s": round(time.time() - t0, 2)})
    streams = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        if req.get("stream"):
            try:
                if req.get("abort"):
                    streams.pop(rid, None); continue
                st = streams.get(rid)
                if st is None:
                    st = streams[rid] = Stream()
                if req.get("append"):
                    st.append(str(req["append"]))
                    for seq, pcm in st.ready():
                        _emit({"id": rid, "seq": seq, "pcm": base64.b64encode(pcm).decode("ascii"), "samples": len(pcm) // 2})
                if req.get("done"):
                    for seq, pcm in st.flush():
                        _emit({"id": rid, "seq": seq, "pcm": base64.b64encode(pcm).decode("ascii"), "samples": len(pcm) // 2})
                    _emit({"id": rid, "done": True, "frames": st.frames(), "samples": st.samples})
                    streams.pop(rid, None)
            except Exception as e:  # noqa: BLE001
                _emit({"id": rid, "done": True, "ok": False, "error": str(e)[:200]}); streams.pop(rid, None)
            continue
        try:
            codes = OE.tokens_to_codes(req.get("text") or "")
            if codes["frames"] == 0:
                _emit({"id": rid, "ok": False, "error": "no audio frames"}); continue
            audio = OE.decode(codes)
            n = OE.write_wav(req["out"], audio)
            _emit({"id": rid, "ok": True, "out": req["out"], "bytes": 44 + n * 2, "sampleRate": OE.SR, "seconds": round(n / OE.SR, 2), "frames": codes["frames"], "bad_frames": codes["bad_frames"]})
        except Exception as e:  # noqa: BLE001
            _emit({"id": rid, "ok": False, "error": str(e)[:200]})


if __name__ == "__main__":
    main()
