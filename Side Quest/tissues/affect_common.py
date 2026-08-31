"""tissues/affect_common.py — shared substrate for the affect tissues.

THE LOAD-BEARING SAFETY PROPERTY (inherited from lib/analysis_lane.js): every database this module
opens is opened SQLite mode=ro (URI), falling back to immutable=1 on a hot WAL. A write attempt is
rejected by SQLite itself; WAL readers never block the live writer. Tissue state and manifests are
JSON files under data/affect/ — a tissue NEVER writes any live database.

Determinism: every entry point takes now_ms explicitly. Same inputs + same now → identical output
bytes (the hard-test law). No wall-clock reads outside main().
"""
import json
import math
import os
import re
import sqlite3
import tempfile

TOKEN_RE = re.compile(r"[a-z][a-z'-]{1,30}")


def open_ro(path):
    """Read-only SQLite open; immutable fallback for a hot WAL. Raises if the file is absent."""
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    uri = "file:" + path.replace("\\", "/") + "?mode=ro"
    try:
        return sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.OperationalError:
        return sqlite3.connect(uri + "&immutable=1", uri=True, timeout=5)


def tokens(text, cap=400):
    return TOKEN_RE.findall(str(text or "").lower())[:cap]


POLAR_FLOOR = 0.2   # NRC's own PolarSubset practice: near-neutral terms ("have", "on", "sure")
                    # carry no affect signal — only polar words contribute to a reading. The first
                    # live run's warmth reasons led with function words; this is that cure.


def vad_score(weights_db, text, cap=400):
    """Mean signed VAD of the POLAR lexicon hits in `text` (NRC v2.1 range [-1,1] per axis;
    |valence| >= POLAR_FLOOR to contribute). Returns (v, a, d, hits, top) — top = up to 3
    strongest-valence contributing words — or None when fewer than 2 polar hits (too little
    signal to call a reading; fail-absent, never guess)."""
    toks = tokens(text, cap)
    if not toks:
        return None
    marks = ",".join("?" for _ in set(toks))
    rows = weights_db.execute(
        f"SELECT term, v, a, d FROM vad WHERE term IN ({marks}) AND abs(v) >= {POLAR_FLOOR}",
        list(set(toks)),
    ).fetchall()
    if len(rows) < 2:
        return None
    n = len(rows)
    v = sum(r[1] for r in rows) / n
    a = sum(r[2] for r in rows) / n
    d = sum(r[3] for r in rows) / n
    top = sorted(rows, key=lambda r: -abs(r[1]))[:3]
    return (v, a, d, n, [(t, round(tv, 2)) for t, tv, _, _ in top])


def emo_tags(weights_db, text, cap=400):
    """EmoLex Plutchik tags present in `text`, as {emotion: count}."""
    toks = tokens(text, cap)
    if not toks:
        return {}
    marks = ",".join("?" for _ in set(toks))
    out = {}
    for _term, emo in weights_db.execute(
        f"SELECT term, emotion FROM emolex WHERE term IN ({marks})", list(set(toks))
    ):
        out[emo] = out.get(emo, 0) + 1
    return out


def half_life_decay(value, dt_ms, half_life_ms):
    """Exponential half-life decay (FAtiMA-style exact form)."""
    if dt_ms <= 0 or half_life_ms <= 0:
        return value
    return value * math.pow(0.5, dt_ms / half_life_ms)


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def load_state(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return dict(default)


def save_json(path, obj):
    """Atomic write (tmp + replace) so a killed tissue never leaves a torn file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
