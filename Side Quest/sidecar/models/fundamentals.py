"""fundamentals — the partisan-lean PRIOR model (Lucas's spec, real data).

Prior margin for a seat = **538 partisan lean** (built from recent presidential results weighted — the "past
elections" signal, pre-blended into a per-seat number) + an **incumbency** adjustment. This is the Cook-PVI-style
backbone every serious forecaster uses for unpolled seats. A=Dem positive (matches the reactor/sim convention).

Data (data/elections/, from 538, CC-licensed, GitHub — no guestbook):
  538_partisan_lean_districts.csv   district,lean   e.g. CA-22,+10.3   (all 435 House seats)
  538_partisan_lean_states.csv      state,lean      e.g. Arizona,-7.2  (all 50 + DC, for Senate)

Stdlib-only (csv). A polled seat overrides this prior upstream; here we supply the prior for the whole seat universe.
"""
import os
import csv
import time
from .base import Model, result

# USPS ↔ full state name (the STATES lean file is keyed by full name; our seat ids carry the abbreviation)
_ABBR_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}


def _data_dir(config):
    if config and config.get("data_dir"):
        return config["data_dir"]
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "data", "elections"))


def _load_leans(data_dir):
    """→ (districts:{'CA-22':lean}, states:{'Arizona':lean}). Last column = the lean (file uses a year header)."""
    dist, st = {}, {}
    for fname, target, key in (("538_partisan_lean_districts.csv", "district", "district"),
                               ("538_partisan_lean_states.csv", "state", "state")):
        path = os.path.join(data_dir, fname)
        try:
            with open(path, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    val = list(row.values())[-1]   # the lean column (header is a year like "2022")
                    try:
                        (dist if target == "district" else st)[row[key].strip()] = float(val)
                    except (ValueError, TypeError):
                        pass
        except FileNotFoundError:
            pass
    return dist, st


def _lean_key(race):
    """our seat id (S-AZ / H-CA-22) → ('state','Arizona') | ('district','CA-22') | (None,None)."""
    seat = str(race.get("seat") or "")
    if race.get("chamber") == "senate" or seat.startswith("S-"):
        abbr = (race.get("state") or (seat[2:] if seat.startswith("S-") else "")).upper()
        return ("state", _ABBR_NAME.get(abbr, abbr))
    if seat.startswith("H-"):
        parts = seat[2:].split("-")
        if len(parts) == 2 and parts[1].isdigit():
            return ("district", "%s-%d" % (parts[0].upper(), int(parts[1])))   # H-CA-22 → CA-22 (strip zero-pad)
    st, d = (race.get("state") or "").upper(), race.get("district")
    if st and d is not None:
        return ("district", "%s-%d" % (st, int(d)))
    return (None, None)


class Fundamentals(Model):
    name = "fundamentals"

    def run(self, inputs, config):
        t0 = time.time()
        cfg = config or {}
        dist, states = _load_leans(_data_dir(cfg))
        inc_adv = float(cfg.get("incumbency_adv", 2.0))   # incumbent personal-vote bump (tunable prior)
        seats, matched = [], 0
        for r in inputs.get("races", []):
            kind, key = _lean_key(r)
            lean = dist.get(key) if kind == "district" else (states.get(key) if kind == "state" else None)
            if lean is not None:
                matched += 1
            base = lean if lean is not None else 0.0
            inc = {"A": inc_adv, "B": -inc_adv}.get(r.get("incumbent_party"), 0.0)
            m = base + inc
            seats.append({"seat": r.get("seat"), "chamber": r.get("chamber"),
                          "margin": round(m, 2), "lo": round(m - 8, 2), "hi": round(m + 8, 2),
                          "source": "partisan_lean" if lean is not None else "no_lean"})
        return result(self.name, seats, t0,
                      diagnostics={"note": "538 partisan lean + incumbency", "matched": matched,
                                   "total": len(seats), "leans_loaded": len(dist) + len(states)})
