"""tissues/tissue_impression.py — L3, the IMPRESSION TISSUE (affect substrate B3).

"How does she feel ABOUT X" — a per-subject impression computed deterministically from real
encounters, never asserted. v1 subjects = the owner world (the people/orgs that matter most);
encounters = conversation turns that mention the subject by name or alias with WORD-BOUNDARY
matching (the single-token disease's lesson: substrings never match — "Al" claims nothing).

Per subject (schema per docs/AFFECT_SUBSTRATE_RESEARCH_2026-08-31.md §4):
  valence     age-decayed mean of the VAD reading of each encounter's text (7-day half-life —
              recent encounters dominate, old ones fade, nothing is erased)
  arousal     mean |arousal| of encounters in the last 48h (how activating the subject is NOW)
  attachment  tanh(log1p(encounters)/3) × orbit × valence-lean — grows with real contact,
              weighted by how close the subject orbits (family > work > held), warmed or cooled
              by the valence history. ALMA's personal-anchor idea, computed.
  wonder      recency × (1 − summary richness) — a subject touched often but thinly known
              itches to be researched (MicroPsi's uncertainty urge, per-subject)
  reasons[]   MANDATORY — the encounter turn ids and top contributing words behind every number

Pure function of (db, weights, now): no state file — recomputed each pass over a bounded window,
so identical inputs give identical bytes (the hard-test law). Reads mode=ro; writes only its
manifest JSON.

Usage: python tissues/tissue_impression.py --db <sq.db> --weights <affect_weights.db>
         --state-dir <dir> [--now <epoch_ms>]
"""
import argparse
import json
import math
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from affect_common import clamp, open_ro, save_json, vad_score
from affect_common import tokens as _tokens

TURN_WINDOW = 400                       # bounded: most recent turns scanned per pass
ENCOUNTER_HALF_LIFE_MS = 7 * 24 * 3600 * 1000
RECENT_MS = 48 * 3600 * 1000
ORBIT = {"owner": 1.0, "work": 0.8}     # owner_world namespace → closeness weight (else 0.6)
MIN_ALIAS_LEN = 3


def subjects(db):
    out = []
    for coord, ns, name, aliases, summary in db.execute(
        "SELECT coord, namespace, name, aliases, summary FROM owner_world"
    ):
        names = [name] if name else []
        try:
            parsed = json.loads(aliases) if aliases else []
            names += [a for a in parsed if isinstance(a, str)]
        except ValueError:
            names += [a.strip() for a in str(aliases).split(",") if a.strip()]
        names = [n for n in names if len(n) >= MIN_ALIAS_LEN]
        if not names:
            continue
        out.append({"coord": coord, "ns": ns or "", "names": names, "summary": summary or ""})
    return out


def turn_window(db):
    rows = db.execute(
        "SELECT id, ts, speaker, content FROM turns WHERE speaker IN ('user','ai_said') "
        "ORDER BY id DESC LIMIT ?",
        (TURN_WINDOW,),
    ).fetchall()
    return list(reversed(rows))


def impress(subj, turns, wdb, now_ms):
    pats = [re.compile(r"\b" + re.escape(n.lower()) + r"\b") for n in subj["names"]]
    hits = []
    for tid, ts, _speaker, content in turns:
        low = str(content or "").lower()
        if any(p.search(low) for p in pats):
            hits.append((tid, ts, content))
    if not hits:
        return None

    num = den = 0.0
    recent_a, top_words, reason_ids = [], [], []
    for tid, ts, content in hits:
        age = max(0, now_ms - (ts or now_ms))
        w = math.pow(0.5, age / ENCOUNTER_HALF_LIFE_MS)
        s = vad_score(wdb, content)
        if s:
            v, a, _d, _hits, top = s
            num += v * w
            den += w
            if age <= RECENT_MS:
                recent_a.append(abs(a))
            top_words += top
        reason_ids.append(tid)
    valence = round(num / den, 3) if den > 0.0001 else 0.0
    arousal = round(sum(recent_a) / len(recent_a), 3) if recent_a else 0.0

    orbit = ORBIT.get(subj["ns"], 0.6)
    lean = 0.5 + 0.5 * clamp(valence * 2, -1, 1)          # valence history warms/cools the bond
    attachment = round(math.tanh(math.log1p(len(hits)) / 3) * orbit * lean, 3)

    last_age = max(0, now_ms - (hits[-1][1] or now_ms))
    recency = math.pow(0.5, last_age / ENCOUNTER_HALF_LIFE_MS)
    richness = clamp(len(subj["summary"]) / 200.0, 0, 1)
    wonder = round(recency * (1 - richness), 3)

    words = sorted(set(top_words), key=lambda t: -abs(t[1]))[:4]
    # B5-lite: the subject's EPA FUNDAMENTAL — who they are to her, in affect-control terms — from
    # the first identity word her own world-summary uses ("The daughter, 12, cheer." → 'daughter' →
    # the dictionary EPA). Deterministic word-match only; no identity word in the dictionary → null,
    # honestly absent. The event-deflection half of B5 (verbs → behavior words) is a later slice.
    epa = None
    for tok in _tokens(subj["summary"], cap=30):
        row = wdb.execute("SELECT e, p, a FROM epa WHERE kind='identity' AND term=?", (tok,)).fetchone()
        if row:
            epa = {"e": round(row[0], 2), "p": round(row[1], 2), "a": round(row[2], 2), "word": tok}
            break
    return {
        "coord": subj["coord"],
        "name": subj["names"][0],
        "epa": epa,
        "valence": valence,
        "arousal": arousal,
        "attachment": attachment,
        "wonder": wonder,
        "encounters": len(hits),
        "reasons": [
            f"{len(hits)} encounter(s) in the last {TURN_WINDOW}-turn window "
            f"(turn ids {', '.join(str(i) for i in reason_ids[-5:])})",
            ("tone carried by: " + ", ".join(f"{w} {v:+.2f}" for w, v in words)) if words
            else "no lexicon reading on the encounter text (valence rests at 0 honestly)",
        ] + ([f"identity '{epa['word']}' from her world-summary → EPA fundamental (usfullsurveyor2015)"] if epa else []),
    }


def run(db_path, weights_path, state_dir, now_ms):
    db = open_ro(db_path)
    wdb = open_ro(weights_path)
    turns = turn_window(db)
    out = []
    for subj in subjects(db):
        imp = impress(subj, turns, wdb, now_ms)
        if imp:
            out.append(imp)
    out.sort(key=lambda i: -i["attachment"])
    manifest = {
        "at": now_ms,
        "tissue": "impression",
        "subjects": out,
        "window_turns": len(turns),
        "law": "computed from real encounters with reasons; the voice translates, never invents",
    }
    save_json(os.path.join(state_dir, "manifest_impressions.json"), manifest)
    db.close()
    wdb.close()
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--now", type=int, default=None)
    args = ap.parse_args()
    now_ms = args.now if args.now is not None else int(time.time() * 1000)
    m = run(args.db, args.weights, args.state_dir, now_ms)
    print(json.dumps({"subjects": len(m["subjects"]), "at": m["at"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
