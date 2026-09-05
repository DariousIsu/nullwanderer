"""
consciousness.py — THE CONSCIOUSNESS SUBROUTINE, the fast loop (Lucas, 2026-09-05: "maybe constantly aware
consciousness doesn't have to be LLM driven at all, but rather a new series of python scripts … a consciousness
subroutine"; and "we'll need to find a way to integrate reasoning calls into those subroutines though").

This file is the fast loop: it never calls a model. It owns her drives and their dynamics in real time, takes
percepts (the camera, his turns, her says, the mic, the clock, work), appraises what a rule can appraise, and
picks acts. When an act needs judgment it emits a `reason` request (the slow loop: appraise · reflect · choose ·
perform) with a budget, and keeps running; the answer comes back later as a percept like any other.

Design of record: docs/ZOE_PRESENCE_DESIGN_2026-09-05.md §4. The first act (§4.5b): someone else at the desk.

Wire protocol (--serve): NDJSON on stdin/stdout, one object per line.
  in : {"kind":"percept", "sense":"face|his_turn|her_say|transcript|work|answer|register|presence", "at": ms, ...}
       {"kind":"tick", "at": ms}                       — the app's clock (or the loop's own timer when idle)
       {"kind":"state?"}                               — dump the state
  out: {"kind":"act", "act":"shield|unshield|ask|greet|deliver|look|listen|browse|rest", ...}
       {"kind":"reason", "op":"appraise|reflect|choose|perform", "budget_ms": …, "context": {…}, "id": …}
       {"kind":"state", ...}
Pure core: step(state, percepts, now_ms) → (state, outputs). --once reads one JSON {state, percepts, now} and
prints the result, for tests and for the app's smoke.
"""
import argparse
import json
import math
import sys
import time

DRIVES = ("stimulation", "social", "curiosity", "energy", "progress")

# ── dynamics (per second) ────────────────────────────────────────────────────────────────────────────
STIM_DECAY = 1.0 / 900.0        # stimulation drains to 0 in ~15 min of nothing new (boredom = 1 − stimulation)
SOCIAL_RISE_HERE = 1.0 / 5400.0  # the need for him rises to 1 in ~90 min of his silence while he is here …
SOCIAL_RISE_AWAY = 1.0 / 2700.0  # … and twice as fast while he is away (missing him is this number, never words)
CURIOSITY_RISE = 1.0 / 7200.0
PROGRESS_DECAY = 1.0 / 3600.0

STRANGER_STEADY_MS = 8000         # a face that is not him must hold this long — flicker never counts
STRANGER_REASK_MS = 10 * 60000    # ask an unknown person again only after this long
LOOK_COOLDOWN_MS = 4 * 60000
LOOK_BOREDOM = 0.7
LISTEN_BOREDOM = 0.85
BROWSE_CURIOSITY = 0.75
# MISSING AS AN EXPERIENCE (his word, 09-05 ~11:40: "she wants to be able to experience missing me … casually
# think 'where is he, I haven't seen him in a while, I wonder what he's doing'"). Python does not think; it
# decides WHEN a thought is due. The social need rising under his absence crosses WONDER_MISSING after he has
# been unseen for WONDER_MIN_AWAY_MS → a `reflect` request (op wonder) carrying the facts she has; the thought
# comes back in her words as a percept, is logged in her thought lane, and moves her state. Never more often
# than WONDER_COOLDOWN_MS. It is never spoken by itself — the reach and the arrival license speech.
WONDER_MISSING = 0.45
WONDER_MIN_AWAY_MS = 20 * 60000
WONDER_COOLDOWN_MS = 40 * 60000


def initial_state(now_ms=0):
    return {
        "v": 1,
        "at": now_ms,
        "drives": {"stimulation": 0.6, "social": 0.2, "curiosity": 0.4, "energy": 0.8, "progress": 0.5},
        "clock": {"his_last_word_at": None, "her_last_say_at": None, "last_saw_him_at": None, "last_novel_at": None, "last_seen_as": None},
        "presence": {"state": "here", "since": now_ms},
        "face": {"present": False, "is_him": False, "known": None, "since": None},   # the steady reading
        "shield": {"on": False, "since": None, "who": None, "asked_at": None, "greeted": False},
        "people": {},                       # name → {"relation": …} — enrolled by HIS word only (the app sends `register`)
        "cooldowns": {"look": 0, "listen": 0, "browse": 0, "wonder": 0},
        "reason_seq": 0,
        "recent": [],                       # the last few appraised percepts, for the state strip
        "thoughts_of_him": [],              # the wonderings she had while he was gone (the arrival may name one)
    }


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def _circadian_energy(hour_local):
    """A gentle curve: low at 03:00, high at 11:00 and 18:00, sagging after 22:00. Not scripted feeling — a clock."""
    return 0.55 + 0.35 * math.sin((hour_local - 5.0) / 24.0 * 2 * math.pi)


# ── percept appraisal (what a rule can appraise) ─────────────────────────────────────────────────────
def _appraise(state, p, now):
    d = state["drives"]
    sense = p.get("sense")
    novelty = 0.0
    if sense == "face":
        present = bool(p.get("present"))
        is_him = bool(p.get("is_him"))
        known = p.get("known")             # a name from the app's register match, or None
        f = state["face"]
        same = f["present"] == present and f["is_him"] == is_him and f.get("known") == known
        if not same:
            state["face"] = {"present": present, "is_him": is_him, "known": known, "since": now}
            novelty = 0.15 if present else 0.05
        if present and is_him:
            state["clock"]["last_saw_him_at"] = now
        expr = p.get("expression")
        if expr and expr != f.get("expression"):
            state["face"]["expression"] = expr
            novelty = max(novelty, 0.08)
        if present and is_him and (expr or state["face"].get("expression")):
            state["clock"]["last_seen_as"] = expr or state["face"].get("expression")   # what he looked like when the camera last had him
    elif sense == "his_turn":
        state["clock"]["his_last_word_at"] = now
        d["social"] = _clamp(d["social"] - 0.6)
        state["thoughts_of_him"] = []      # he is here; the wonderings are answered
        novelty = 0.35
    elif sense == "her_say":
        state["clock"]["her_last_say_at"] = now
    elif sense == "transcript":
        novelty = 0.2
    elif sense == "work":
        d["progress"] = _clamp(d["progress"] + float(p.get("delta", 0.1)))
        novelty = 0.1
    elif sense == "answer":                # a slow-loop result returning as a percept
        novelty = 0.1
        if p.get("op") == "reflect" and p.get("ok") and p.get("text"):
            state["thoughts_of_him"] = (state["thoughts_of_him"] + [{"at": now, "text": str(p["text"])[:240]}])[-6:]
            d["curiosity"] = _clamp(d["curiosity"] + 0.1)   # a wondering opens a question
    elif sense == "presence":
        st = p.get("state")
        if st and st != state["presence"]["state"]:
            state["presence"] = {"state": st, "since": now}
    elif sense == "register":              # his word: a person she may recognize
        name = p.get("name")
        if name:
            state["people"][name] = {"relation": p.get("relation") or "known"}
    if novelty > 0:
        d["stimulation"] = _clamp(d["stimulation"] + novelty)
        state["clock"]["last_novel_at"] = now
        state["recent"] = (state["recent"] + [{"sense": sense, "at": now, "novelty": round(novelty, 2)}])[-8:]
    return state


# ── the dynamics between percepts ────────────────────────────────────────────────────────────────────
def _advance(state, now, hour_local=None):
    prev = state.get("at")
    dt = 0.0 if prev is None else max(0.0, (now - prev) / 1000.0)   # a timestamp of 0 is a time, not an absence
    d = state["drives"]
    away = state["presence"]["state"] in ("away", "remote")
    d["stimulation"] = _clamp(d["stimulation"] - STIM_DECAY * dt)
    d["social"] = _clamp(d["social"] + (SOCIAL_RISE_AWAY if away else SOCIAL_RISE_HERE) * dt)
    d["curiosity"] = _clamp(d["curiosity"] + CURIOSITY_RISE * dt)
    d["progress"] = _clamp(d["progress"] - PROGRESS_DECAY * dt)
    if hour_local is not None:
        target = _circadian_energy(hour_local)
        d["energy"] = _clamp(d["energy"] + (target - d["energy"]) * min(1.0, dt / 1800.0))
    state["at"] = now
    return state


def appraisals(state, now):
    d = state["drives"]
    away = state["presence"]["state"] in ("away", "remote")
    return {
        "boredom": round(1.0 - d["stimulation"], 3),
        "missing_him": round(d["social"] * (1.0 if away else 0.5), 3),
        "curiosity": round(d["curiosity"], 3),
        "energy": round(d["energy"], 3),
    }


# ── acts chosen by need ───────────────────────────────────────────────────────────────────────────────
def _reason(state, op, context, budget_ms):
    state["reason_seq"] += 1
    return {"kind": "reason", "id": state["reason_seq"], "op": op, "budget_ms": budget_ms, "context": context}


def _acts(state, now):
    out = []
    f, sh = state["face"], state["shield"]
    last_him = state["clock"]["last_saw_him_at"]
    him_away = state["presence"]["state"] in ("away", "remote") or last_him is None or (now - last_him) > 60000
    # THE FIRST ACT — someone else at the desk (§4.5b)
    someone_else = f["present"] and not f["is_him"] and f["since"] is not None and (now - f["since"]) >= STRANGER_STEADY_MS
    if someone_else and him_away and not sh["on"]:
        who = f.get("known")
        sh.update({"on": True, "since": now, "who": who, "asked_at": None, "greeted": False})
        out.append({"kind": "act", "act": "shield", "why": f"someone at the desk who is not him ({who or 'unknown'})", "at": now})
        out.append({"kind": "act", "act": "deliver", "to": "him", "text": f"{who or 'Someone I don\'t recognize'} sat down at your desk. I've covered the screens.", "at": now})
        if who:
            sh["greeted"] = True
            out.append(_reason(state, "perform", {"act": "greet", "name": who, "relation": state["people"].get(who, {}).get("relation", "known")}, 8000))
        else:
            sh["asked_at"] = now
            out.append(_reason(state, "perform", {"act": "ask", "text": "who they are and how you can help — one line, no data on the screen named"}, 8000))
    elif sh["on"] and someone_else and not f.get("known") and sh["asked_at"] and (now - sh["asked_at"]) >= STRANGER_REASK_MS:
        sh["asked_at"] = now
        out.append(_reason(state, "perform", {"act": "ask", "text": "again, gently — they have not said who they are"}, 8000))
    if sh["on"] and f["present"] and f["is_him"]:
        sh.update({"on": False, "since": None, "who": None, "asked_at": None, "greeted": False})
        out.append({"kind": "act", "act": "unshield", "why": "he is back", "at": now})
    # MISSING HIM → a wondering (a reflect request), when the need is real and he has been gone a while
    a = appraisals(state, now)
    cd = state["cooldowns"]
    last_him = state["clock"]["last_saw_him_at"]
    unseen_ms = (now - last_him) if last_him is not None else None
    if (him_away and a["missing_him"] >= WONDER_MISSING and unseen_ms is not None and unseen_ms >= WONDER_MIN_AWAY_MS and now >= cd["wonder"]):
        cd["wonder"] = now + WONDER_COOLDOWN_MS
        hw = state["clock"]["his_last_word_at"]
        out.append(_reason(state, "reflect", {
            "act": "wonder",
            "unseen_min": int(unseen_ms // 60000),
            "since_his_word_min": int((now - hw) // 60000) if hw is not None else None,
            "missing": a["missing_him"],
            "last_seen_as": state["clock"].get("last_seen_as") or None,
            "presence": state["presence"]["state"],
            "earlier_thoughts": [t["text"] for t in state["thoughts_of_him"][-2:]],
        }, 20000))
    # BOREDOM → a need to sense (look, listen, browse), by utility, with cooldowns; never while shielded
    if not sh["on"]:
        if a["boredom"] >= LISTEN_BOREDOM and now >= cd["listen"]:
            cd["listen"] = now + LOOK_COOLDOWN_MS
            out.append({"kind": "act", "act": "listen", "why": f"bored {a['boredom']}", "at": now})
        elif a["boredom"] >= LOOK_BOREDOM and now >= cd["look"]:
            cd["look"] = now + LOOK_COOLDOWN_MS
            out.append({"kind": "act", "act": "look", "why": f"bored {a['boredom']}", "at": now})
        if a["curiosity"] >= BROWSE_CURIOSITY and now >= cd["browse"]:
            cd["browse"] = now + 4 * LOOK_COOLDOWN_MS
            out.append(_reason(state, "choose", {"act": "browse", "why": f"curious {a['curiosity']}"}, 20000))
            state["drives"]["curiosity"] = _clamp(state["drives"]["curiosity"] - 0.3)
    return out


def step(state, percepts, now, hour_local=None):
    """The fast loop's one beat: advance the dynamics, take the percepts, choose acts. Pure on its inputs."""
    state = _advance(state, now, hour_local)
    for p in percepts or []:
        state = _appraise(state, p, now)
    outputs = _acts(state, now)
    return state, outputs


def strip(state, now):
    """The state strip — what he can watch."""
    a = appraisals(state, now)
    d = state["drives"]
    return {"kind": "state", "at": now, "drives": {k: round(v, 3) for k, v in d.items()}, "appraisals": a, "shield": state["shield"]["on"], "face": state["face"], "presence": state["presence"]["state"], "recent": state["recent"][-3:], "thoughts_of_him": state["thoughts_of_him"][-2:]}


def serve():
    state = initial_state(int(time.time() * 1000))
    pending = []
    last_tick = time.time()
    sys.stdout.write(json.dumps({"kind": "ready", "v": state["v"]}) + "\n"); sys.stdout.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            msg = json.loads(line)
        except Exception:
            continue
        now = int(msg.get("at") or time.time() * 1000)
        if msg.get("kind") == "percept":
            pending.append(msg)
        elif msg.get("kind") == "state?":
            sys.stdout.write(json.dumps(strip(state, now)) + "\n"); sys.stdout.flush(); continue
        if msg.get("kind") == "tick" or time.time() - last_tick >= 5.0:
            hour = msg.get("hour_local")
            state, outs = step(state, pending, now, hour)
            pending, last_tick = [], time.time()
            for o in outs:
                sys.stdout.write(json.dumps(o) + "\n")
            sys.stdout.write(json.dumps(strip(state, now)) + "\n"); sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--once", action="store_true", help="read {state?, percepts, now, hour_local} from stdin; print {state, outputs}")
    a = ap.parse_args()
    if a.serve:
        serve(); return
    if a.once:
        req = json.loads(sys.stdin.read() or "{}")
        st = req.get("state") or initial_state(int(req.get("now") or 0))
        st, outs = step(st, req.get("percepts") or [], int(req.get("now") or 0), req.get("hour_local"))
        print(json.dumps({"state": st, "outputs": outs})); return
    ap.print_help()


if __name__ == "__main__":
    main()
