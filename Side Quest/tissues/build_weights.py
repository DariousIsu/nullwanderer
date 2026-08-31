"""tissues/build_weights.py — compile the affect weight files into data/affect_weights.db.

The affect substrate's L0: human-normed lexicons and ACT coefficient tables become one read-only
SQLite file the tissues query. Run OFFLINE (build step, not app runtime); the app and tissues only
ever open the result read-only. Rebuild any time from data/lexicons/ — this script is idempotent
(drops + recreates).

LICENSE RAIL: data/ is git-ignored. The NRC lexicons are free for non-commercial research but must
NEVER be redistributed — they live only in data/lexicons/ and this compiled db. actdata is CC0.
Warriner is CC BY-NC-ND (internal transformation OK, no derivative distribution).

Sources compiled (formats verified 2026-08-31):
  nrc-vad/NRC-VAD-Lexicon-v2.1/NRC-VAD-Lexicon-v2.1.txt   TSV term\tv\ta\td — SIGNED [-1,1] (v2.1
                                                          moved off v1's [0,1]; keep as-is, the
                                                          tissues expect signed)
  nrc-emolex/.../NRC-Emotion-Lexicon-Wordlevel-v0.92.txt  long TSV term\temotion\t0|1 (store 1s only)
  Ratings_Warriner_et_al.csv                              1-9 means + SDs (independent cross-check)
  actdata/us2010_impressionabo_{f,m}.dat                  Z-selector row + 9 coefficients (ACT
                                                          impression formation, USA 2010)
  actdata/us2010_emotionid_{f,m}.dat                      ACT emotion equations
  actdata/usfullsurveyor2015_{identities,behaviors,mods}.csv  term,E,P,A (+gender dupes dropped)

Usage: python tissues/build_weights.py [--root <repo root>]
"""
import csv
import os
import sqlite3
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if "--root" in sys.argv:
    ROOT = os.path.abspath(sys.argv[sys.argv.index("--root") + 1])
LEX = os.path.join(ROOT, "data", "lexicons")
OUT = os.path.join(ROOT, "data", "affect_weights.db")

SCHEMA = """
DROP TABLE IF EXISTS vad;
DROP TABLE IF EXISTS emolex;
DROP TABLE IF EXISTS warriner;
DROP TABLE IF EXISTS epa;
DROP TABLE IF EXISTS act_eqn;
DROP TABLE IF EXISTS build_meta;
CREATE TABLE vad (term TEXT PRIMARY KEY, v REAL NOT NULL, a REAL NOT NULL, d REAL NOT NULL);
CREATE TABLE emolex (term TEXT NOT NULL, emotion TEXT NOT NULL, PRIMARY KEY (term, emotion));
CREATE TABLE warriner (term TEXT PRIMARY KEY, v REAL, a REAL, d REAL, v_sd REAL, a_sd REAL, d_sd REAL);
CREATE TABLE epa (kind TEXT NOT NULL, term TEXT NOT NULL, e REAL, p REAL, a REAL, PRIMARY KEY (kind, term));
CREATE TABLE act_eqn (eqn_set TEXT NOT NULL, eqn_type TEXT NOT NULL, gender TEXT NOT NULL,
                      z TEXT NOT NULL, c TEXT NOT NULL, PRIMARY KEY (eqn_set, eqn_type, gender, z));
CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT);
"""


def load_vad(db):
    path = os.path.join(LEX, "nrc-vad", "NRC-VAD-Lexicon-v2.1", "NRC-VAD-Lexicon-v2.1.txt")
    n = 0
    with open(path, encoding="utf-8") as f:
        rows = []
        for i, line in enumerate(f):
            parts = line.rstrip("\n").split("\t")
            if i == 0 and parts[0] == "term":
                continue
            if len(parts) != 4:
                continue
            try:
                rows.append((parts[0], float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                continue
        db.executemany("INSERT OR REPLACE INTO vad VALUES (?,?,?,?)", rows)
        n = len(rows)
    return n


def load_emolex(db):
    path = os.path.join(LEX, "nrc-emolex", "NRC-Emotion-Lexicon", "NRC-Emotion-Lexicon-Wordlevel-v0.92.txt")
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[2] == "1":
                rows.append((parts[0], parts[1]))
    db.executemany("INSERT OR REPLACE INTO emolex VALUES (?,?)", rows)
    return len(rows)


def load_warriner(db):
    path = os.path.join(LEX, "Ratings_Warriner_et_al.csv")
    rows = []
    with open(path, encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                rows.append((row["Word"],
                             float(row["V.Mean.Sum"]), float(row["A.Mean.Sum"]), float(row["D.Mean.Sum"]),
                             float(row["V.SD.Sum"]), float(row["A.SD.Sum"]), float(row["D.SD.Sum"])))
            except (KeyError, ValueError):
                continue
    db.executemany("INSERT OR REPLACE INTO warriner VALUES (?,?,?,?,?,?,?)", rows)
    return len(rows)


def load_epa(db):
    total = 0
    for kind, fname in (("identity", "usfullsurveyor2015_identities.csv"),
                        ("behavior", "usfullsurveyor2015_behaviors.csv"),
                        ("modifier", "usfullsurveyor2015_mods.csv")):
        path = os.path.join(LEX, "actdata", fname)
        rows = []
        with open(path, encoding="utf-8") as f:
            r = csv.DictReader(f)
            for row in r:
                try:
                    # E,P,A = overall means; E2,P2,A2 are the gendered duplicates — average when they
                    # differ (the standard means-only collapse), which for this file is a no-op.
                    e = (float(row["E"]) + float(row["E2"])) / 2
                    p = (float(row["P"]) + float(row["P2"])) / 2
                    a = (float(row["A"]) + float(row["A2"])) / 2
                    rows.append((kind, row["term"].strip().lower().replace("_", " "), e, p, a))
                except (KeyError, ValueError):
                    continue
        db.executemany("INSERT OR REPLACE INTO epa VALUES (?,?,?,?,?)", rows)
        total += len(rows)
    return total


def load_eqns(db):
    total = 0
    for eqn_type in ("impressionabo", "emotionid"):
        for gender in ("f", "m"):
            path = os.path.join(LEX, "actdata", f"us2010_{eqn_type}_{gender}.dat")
            rows = []
            with open(path, encoding="utf-8") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 2 or not parts[0].startswith("Z"):
                        continue
                    rows.append(("us2010", eqn_type, gender, parts[0], " ".join(parts[1:])))
            db.executemany("INSERT OR REPLACE INTO act_eqn VALUES (?,?,?,?,?)", rows)
            total += len(rows)
    return total


def main():
    if not os.path.isdir(LEX):
        print(f"FATAL: {LEX} missing — download the lexicons first (see module docstring)")
        return 1
    db = sqlite3.connect(OUT)
    db.executescript(SCHEMA)
    counts = {
        "vad": load_vad(db),
        "emolex": load_emolex(db),
        "warriner": load_warriner(db),
        "epa": load_epa(db),
        "act_eqn": load_eqns(db),
    }
    meta = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "vad_source": "NRC VAD v2.1 (signed [-1,1]); research use, NO redistribution",
        "emolex_source": "NRC Emotion Lexicon v0.92 (flag=1 rows only); research use, NO redistribution",
        "warriner_source": "Warriner et al. 2013 (1-9 scale); CC BY-NC-ND 3.0",
        "actdata_source": "ahcombs/actdata us2010 eqns + usfullsurveyor2015 dicts; CC0",
        **{f"count_{k}": str(v) for k, v in counts.items()},
    }
    db.executemany("INSERT OR REPLACE INTO build_meta VALUES (?,?)", list(meta.items()))
    db.commit()

    # verification — counts + known-word spot checks (fail loud, never silently green)
    fails = []
    if counts["vad"] < 50000:
        fails.append(f"vad rows {counts['vad']} < 50000")
    if counts["emolex"] < 10000:
        fails.append(f"emolex rows {counts['emolex']} < 10000")
    if counts["warriner"] < 13000:
        fails.append(f"warriner rows {counts['warriner']} < 13000")
    if counts["epa"] < 2000:
        fails.append(f"epa rows {counts['epa']} < 2000")
    if counts["act_eqn"] < 40:
        fails.append(f"act_eqn rows {counts['act_eqn']} < 40")
    love = db.execute("SELECT v FROM vad WHERE term='love'").fetchone()
    if not love or love[0] < 0.5:
        fails.append(f"spot: vad('love').v = {love} — expected strongly positive")
    dread = db.execute("SELECT v FROM vad WHERE term='dread'").fetchone()
    if not dread or dread[0] > -0.3:
        fails.append(f"spot: vad('dread').v = {dread} — expected strongly negative")
    fear = db.execute("SELECT 1 FROM emolex WHERE term='abandon' AND emotion='fear'").fetchone()
    if not fear:
        fails.append("spot: emolex('abandon') missing fear tag")
    hero = db.execute("SELECT e FROM epa WHERE kind='identity' AND term='hero'").fetchone()
    if not hero or hero[0] < 1.5:
        fails.append(f"spot: epa identity 'hero' E = {hero} — expected high evaluation")
    z0 = db.execute("SELECT c FROM act_eqn WHERE eqn_type='impressionabo' AND gender='f' AND z='Z000000000'").fetchone()
    if not z0 or len(z0[0].split()) != 9:
        fails.append("spot: impressionabo constant row missing or not 9 coefficients")
    db.close()

    for k, v in counts.items():
        print(f"  {k}: {v} rows")
    if fails:
        print("FAIL:")
        for f_ in fails:
            print("  ✗", f_)
        return 1
    print(f"PASS — {OUT} built + spot-checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
