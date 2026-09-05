"""
voice_wer.py — THE INTELLIGIBILITY GATE (Lucas, 2026-09-05 15:10: "Did you mean for the orpheus reel to be random
jibberish?"). Pitch and length said run 3 was her; the words were gone. Every synthesized line is now transcribed
(faster-whisper base, CPU) and scored against its text; a reel with a mean score above the bar never reaches
Ollama or him. Her own Kokoro lines score ~0.3 under this crude measure, so the bar is generous, not strict.

Usage: python voice_wer.py <report.json> <wav_dir> [--bar 0.6]   → prints per-line scores; exit 0 under the bar, 3 over
"""
import argparse
import difflib
import json
import os
import re
import sys


def words(s):
    return re.sub(r"[^a-z' ]", " ", s.lower()).split()


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    if not r:
        return 1.0
    return round(1 - difflib.SequenceMatcher(a=r, b=h).ratio(), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("report"); ap.add_argument("wav_dir"); ap.add_argument("--bar", type=float, default=0.6)
    a = ap.parse_args()
    from faster_whisper import WhisperModel
    wm = WhisperModel("base", device="cpu", compute_type="int8")
    rep = json.load(open(a.report, encoding="utf-8"))
    scores = []
    for x in rep:
        if "wav" not in x:
            continue
        p = os.path.join(a.wav_dir, x["wav"])
        segs, _ = wm.transcribe(p, language="en", beam_size=1)
        hyp = " ".join(s.text for s in segs).strip()
        ref = re.sub(r"<[a-z]+>", " ", x["line"])
        w = wer(ref, hyp); scores.append(w)
        print(f"{x['wav']}: wer {w} | {hyp[:90]!r}")
    if not scores:
        print("no lines"); sys.exit(3)
    mean = round(sum(scores) / len(scores), 2)
    print(f"mean wer {mean} over {len(scores)} lines | bar {a.bar} -> {'PASS' if mean <= a.bar else 'FAIL'}")
    sys.exit(0 if mean <= a.bar else 3)


if __name__ == "__main__":
    main()
