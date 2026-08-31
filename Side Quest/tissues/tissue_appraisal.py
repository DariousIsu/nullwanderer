"""tissues/tissue_appraisal.py — L2, the APPRAISAL TISSUE (affect substrate B2).

One deterministic pass, milliseconds of CPU, zero model calls: reads the exhaust the program already
emits (obs_events wins/needs/stress; the operator's recent turns; her own recent readings), scores
the text against the compiled weights (data/affect_weights.db), mints emotion INSTANCES with
intensities and REASONS (GAMYGDALA shape: every instance traces to the event that made it), decays
prior instances (FAtiMA exact half-life), and integrates a two-layer mood point (WASABI-lite:
impulses spike emotion x; x drags slow mood y via a coupling slope; both spring home). Output = a
JSON manifest the voice may someday render. The tissue reads databases mode=ro ONLY and writes
nothing but its own JSON state/manifest under data/affect/.

The division of labor is LAW: this pass produces the feeling WITH REASONS; the frontier voice
translates it, never invents it.

Appraisal sources → instance table (v1, deliberately small):
  obs win            → joy       intensity 0.35  (a pursuit resolved / a delivery registered)
  obs need           → concern   intensity 0.20  (an escalated problem is activating)
  obs machine/db     → distress  intensity 0.30  (real resource stress)
  operator turn VAD  → warmth / sting  |v|-scaled (how his words actually read; ≥2 lexicon hits or
                        no reading — fail-absent)
  own readings VAD   → interest / unease  |v|-scaled (the tone of what she's taking in)

Usage: python tissues/tissue_appraisal.py --db <sq.db> --weights <affect_weights.db>
         --state-dir <dir> [--now <epoch_ms>]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from affect_common import (clamp, emo_tags, half_life_decay, load_state, open_ro, save_json,
                           vad_score)

EMOTION_HALF_LIFE_MS = 45 * 60 * 1000      # instance fade — ~45 min half-life
PRUNE_BELOW = 0.02                          # a faded instance is removed (GAMYGDALA prunes at ~0)
MOOD_X_HALF_LIFE_MS = 30 * 60 * 1000        # emotion layer springs home fast
MOOD_Y_HALF_LIFE_MS = 6 * 60 * 60 * 1000    # mood layer springs home slow
COUPLING = 0.15                             # WASABI slope: how hard x drags y per pass
MAX_INSTANCES = 12
MAX_TURNS = 6                               # operator turns read per pass (bounded)
MAX_READINGS = 8                            # her own recent readings per pass

DEFAULT_STATE = {"instances": [], "mood": {"x": 0.0, "y": 0.0}, "cursors": {"obs": 0, "turn": 0, "mono": 0}, "at": 0}


def seed_cursor(db, table, since_id, tail):
    """Birth-cursor rule (first live run's lesson): a cursor of 0 means the tissue was just born —
    it observes from the tail of the table, never from row 1 (the first pass otherwise appraised
    years-old fossil turns and would crawl history forever)."""
    if since_id:
        return since_id
    row = db.execute(f"SELECT MAX(id) FROM {table}").fetchone()
    return max(0, (row[0] or 0) - tail)


def band(y):
    if y >= 0.25:
        return "bright"
    if y >= 0.08:
        return "warm"
    if y <= -0.25:
        return "heavy"
    if y <= -0.08:
        return "dimmed"
    return "even"


def appraise_obs(db, since_id):
    """Curated obs_events → (instances, new_cursor). Same signals internal_state appraises."""
    since_id = seed_cursor(db, "obs_events", since_id, 200)
    rows = db.execute(
        "SELECT id, lane, kind, text, ref FROM obs_events WHERE id > ? ORDER BY id ASC LIMIT 200",
        (since_id,),
    ).fetchall()
    out, seen, cur = [], set(), since_id
    for _id, lane, kind, text, ref in rows:
        cur = _id
        sig = f"{lane}:{kind}:{ref or ''}"
        if sig in seen:
            continue
        if kind == "win":
            seen.add(sig)
            out.append({"name": "joy", "intensity": 0.35, "valence": 1,
                        "reason": f"win — {str(text)[:120]}"})
        elif kind == "need":
            seen.add(sig)
            out.append({"name": "concern", "intensity": 0.20, "valence": -1,
                        "reason": f"need escalated — {str(text)[:120]}"})
        elif kind == "anomaly" and lane in ("machine", "db"):
            seen.add(sig)
            out.append({"name": "distress", "intensity": 0.30, "valence": -1,
                        "reason": f"{lane} stress — {str(text)[:120]}"})
    return out, cur


def appraise_turns(db, wdb, since_id):
    """The operator's recent words, read through the lexicon — MicroPsi's legitimacy/affiliation
    signal made concrete. Only genuine lexicon readings mint instances (fail-absent)."""
    since_id = seed_cursor(db, "turns", since_id, MAX_TURNS)
    rows = db.execute(
        "SELECT id, content FROM turns WHERE id > ? AND speaker = 'user' ORDER BY id ASC LIMIT ?",
        (since_id, MAX_TURNS),
    ).fetchall()
    out, cur = [], since_id
    for _id, content in rows:
        cur = _id
        s = vad_score(wdb, content)
        if not s:
            continue
        v, _a, _d, hits, top = s
        if abs(v) < 0.08:
            continue
        name = "warmth" if v > 0 else "sting"
        out.append({"name": name, "intensity": clamp(abs(v) * 1.2, 0.05, 0.6),
                    "valence": 1 if v > 0 else -1,
                    "reason": f"his turn#{_id} read {name} (v={v:.2f}, {hits} lexicon hits: "
                              + ", ".join(f"{w} {val:+.2f}" for w, val in top) + ")"})
    return out, cur


def appraise_readings(db, wdb, since_id):
    """The tone of her own intake (readings/thoughts) — interest when it runs positive, unease
    when it runs dark. Bounded, fail-absent."""
    since_id = seed_cursor(db, "monologue", since_id, MAX_READINGS)
    rows = db.execute(
        "SELECT id, content FROM monologue WHERE id > ? AND type IN ('reading','thought') "
        "ORDER BY id ASC LIMIT ?",
        (since_id, MAX_READINGS),
    ).fetchall()
    vs, cur, last_top = [], since_id, None
    for _id, content in rows:
        cur = _id
        s = vad_score(wdb, content)
        if s:
            vs.append(s[0])
            last_top = s[4]
    if len(vs) < 3:
        return [], cur
    mean_v = sum(vs) / len(vs)
    if abs(mean_v) < 0.10:
        return [], cur
    name = "interest" if mean_v > 0 else "unease"
    return [{"name": name, "intensity": clamp(abs(mean_v), 0.05, 0.4),
             "valence": 1 if mean_v > 0 else -1,
             "reason": f"intake tone over {len(vs)} readings (mean v={mean_v:.2f}; e.g. "
                       + ", ".join(f"{w} {val:+.2f}" for w, val in (last_top or [])) + ")"}], cur


def run(db_path, weights_path, state_dir, now_ms):
    db = open_ro(db_path)
    wdb = open_ro(weights_path)
    state_path = os.path.join(state_dir, "appraisal_state.json")
    st = load_state(state_path, DEFAULT_STATE)
    dt = max(0, now_ms - (st.get("at") or now_ms))

    # 1. decay standing instances (exact half-life), prune the faded
    kept = []
    for inst in st.get("instances", []):
        inst = dict(inst)
        inst["intensity"] = round(half_life_decay(inst["intensity"], dt, EMOTION_HALF_LIFE_MS), 4)
        if inst["intensity"] >= PRUNE_BELOW:
            kept.append(inst)

    # 2. fresh appraisals from exhaust since the cursors
    cs = st.get("cursors", dict(DEFAULT_STATE["cursors"]))
    fresh = []
    a, cs["obs"] = appraise_obs(db, cs.get("obs", 0))
    fresh += a
    b, cs["turn"] = appraise_turns(db, wdb, cs.get("turn", 0))
    fresh += b
    c, cs["mono"] = appraise_readings(db, wdb, cs.get("mono", 0))
    fresh += c
    for inst in fresh:
        inst["born_at"] = now_ms
    kept = (kept + fresh)[-MAX_INSTANCES:]

    # 3. mood dynamics (WASABI-lite): impulses hit x; x decays fast; y is dragged by x, decays slow
    mood = st.get("mood", {"x": 0.0, "y": 0.0})
    x = half_life_decay(mood.get("x", 0.0), dt, MOOD_X_HALF_LIFE_MS)
    y = half_life_decay(mood.get("y", 0.0), dt, MOOD_Y_HALF_LIFE_MS)
    # Soft-squash the per-pass impulse sum (GAMYGDALA's gain form, g=1): bounded (−1,1) with
    # ordering preserved — a heavy pass reads ELEVATED, never pinned at the rail where all
    # information dies (the internal_state v2 saturation lesson, applied on day one here).
    raw = sum(i["intensity"] * i["valence"] for i in fresh)
    impulse = raw / (1 + abs(raw))
    x = clamp(x + impulse, -0.95, 0.95)
    y = clamp(y + x * COUPLING, -0.95, 0.95)

    st = {"instances": kept, "mood": {"x": round(x, 4), "y": round(y, 4)}, "cursors": cs, "at": now_ms}
    save_json(state_path, st)

    manifest = {
        "at": now_ms,
        "tissue": "appraisal",
        "mood": {"x": round(x, 3), "y": round(y, 3), "band": band(y)},
        "emotions": sorted(
            [{"name": i["name"], "intensity": round(i["intensity"], 3), "reason": i["reason"]}
             for i in kept if i["intensity"] >= 0.05],
            key=lambda e: -e["intensity"])[:8],
        "fresh_appraisals": len(fresh),
        "law": "deterministic pass; the voice translates, never invents",
    }
    save_json(os.path.join(state_dir, "manifest_appraisal.json"), manifest)
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
    print(json.dumps(m, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
