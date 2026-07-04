#!/usr/bin/env python3
"""Fetch the forecasting reference datasets into data/elections/ (stdlib urllib; idempotent).

The data/ dir is gitignored (runtime data doesn't belong in git), so this script is the reproducible source of
record. All sources are free + unrestricted (NO Harvard Dataverse guestbook):

  538 partisan lean (CC-BY, fivethirtyeight/data on GitHub) — per-district + per-state Cook-PVI-style lean, built
      from weighted recent presidential results. THE coverage-prior backbone (every House seat + every state).
  MEDSL presidential (MIT, via keithpotz's committed copy) — state presidential results 1976-2024, for the
      2024-freshness pres-lean layer.

Harvard Dataverse MEDSL House/Senate returns (1976-2024) are guestbook-gated and NOT used — 538's lean is the
accessible equivalent of the "past-elections" partisan signal. Run:  python fetch_data.py [--force]
"""
import os
import sys
import urllib.request

SOURCES = [
    ("538_partisan_lean_districts.csv",
     "https://raw.githubusercontent.com/fivethirtyeight/data/master/partisan-lean/fivethirtyeight_partisan_lean_DISTRICTS.csv"),
    ("538_partisan_lean_states.csv",
     "https://raw.githubusercontent.com/fivethirtyeight/data/master/partisan-lean/fivethirtyeight_partisan_lean_STATES.csv"),
    ("2024president.csv",
     "https://raw.githubusercontent.com/keithpotz/Election-Prediction/main/src/data/polling_data/2024president.csv"),
    ("complete_data.csv",
     "https://raw.githubusercontent.com/keithpotz/Election-Prediction/main/src/data/polling_data/complete_data.csv"),
    # current members of Congress (unitedstates project, public domain) — for the INCUMBENCY term
    ("legislators-current.json",
     "https://unitedstates.github.io/congress-legislators/legislators-current.json"),
]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "data", "elections"))
    os.makedirs(out, exist_ok=True)
    force = "--force" in sys.argv
    for name, url in SOURCES:
        dest = os.path.join(out, name)
        if os.path.exists(dest) and not force:
            print("  skip (exists): " + name)
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SideQuest-forecast/0.1"})
            data = urllib.request.urlopen(req, timeout=60).read()
            with open(dest, "wb") as f:
                f.write(data)
            print("  fetched: %s (%d bytes)" % (name, len(data)))
        except Exception as e:
            print("  FAILED: %s - %s" % (name, e))
    print("data -> " + out)


if __name__ == "__main__":
    main()
