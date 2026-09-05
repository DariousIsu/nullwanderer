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

STRANGER_STEADY_MS = 20000        # a face that is not him must hold this long — flicker never counts (8 s locked HIM out, 14:44)
# THE DESK RULES (his words, 14:50: "the camera lock has failed in the wrong direction" · "If I am sitting here and she
# misses me she should say something to me about it, not lock her program"). What happened at 14:44: he came back to
# the desk, matched once (0.461), the frame was empty for a beat, then two readings of HIS face at 0.387 and 0.365 —
# under the 0.40 bar by a hair — while presence still said "away" (chat idle 183 min, which says nothing about the
# desk) → 8 s "steady" → every screen covered. A stranger is a person who ARRIVED at an empty desk while the camera
# has had no match for him in minutes, and whose face is CLEARLY not his — never a near-miss, never chat idleness.
STRANGER_MIN_UNSEEN_MS = 3 * 60000  # the camera must have had no match for him this long — presence 'away' never counts
STRANGER_MAX_MATCH = 0.25         # a face scoring at or above this against his enrollment is uncertain, not someone else
# THE REACH: wanting his word while he is right there is spoken to him, never acted on the screens.
REACH_WANT = 0.7                  # wants_his_word at or above this
REACH_MIN_QUIET_MS = 30 * 60000   # and no word from him this long (since boot if none yet)
REACH_COOLDOWN_MS = 45 * 60000
REACH_SEEN_MS = 2 * 60000         # the camera has him now
BOOT_GRACE_MS = 90000             # boot_p309's first minute: his own face at match 0.013→0.65 as he settled read as a stranger
                                  # because the loop had never seen him; no stranger act until the loop is this old
PERFORM_BUDGET_MS = 20000         # the slow loop's first cloud call aborted at 8 s on p309
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
ARRIVAL_MIN_AWAY_MS = 20 * 60000   # his return after this long unseen is a moment of hers (design §4.5b's sibling)


def initial_state(now_ms=0):
    return {
        "v": 1,
        "at": now_ms,
        "born": now_ms,
        "drives": {"stimulation": 0.6, "social": 0.2, "curiosity": 0.4, "energy": 0.8, "progress": 0.5},
        "clock": {"his_last_word_at": None, "her_last_say_at": None, "last_saw_him_at": None, "last_novel_at": None, "last_seen_as": None, "last_empty_at": None},
        "presence": {"state": "here", "since": now_ms},
        "face": {"present": False, "is_him": False, "known": None, "since": None, "match": None},   # the steady reading (+ the latest score against his enrollment)
        "shield": {"on": False, "since": None, "who": None, "asked_at": None, "greeted": False},
        "people": {},                       # name → {"relation": …} — enrolled by HIS word only (the app sends `register`)
        "cooldowns": {"look": 0, "listen": 0, "browse": 0, "wonder": 0, "reach": 0},
        "reason_seq": 0,
        "recent": [],                       # the last few appraised percepts, for the state strip
        "thoughts_of_him": [],              # the wonderings she had while he was gone (the arrival may name one)
        "arrival": None,                    # set when his face returns after ARRIVAL_MIN_AWAY_MS; consumed by one perform request
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
            state["face"] = {"present": present, "is_him": is_him, "known": known, "since": now, "match": None}
            novelty = 0.15 if present else 0.05
        m = p.get("match")
        state["face"]["match"] = float(m) if isinstance(m, (int, float)) else None   # the latest score, never resets `since`
        if not present:
            state["clock"]["last_empty_at"] = now                                    # the desk was empty — a stranger arrives after this
        if present and is_him:
            prev_seen = state["clock"]["last_saw_him_at"]
            if prev_seen is not None and (now - prev_seen) >= ARRIVAL_MIN_AWAY_MS and not state.get("arrival"):
                state["arrival"] = {"at": now, "unseen_min": int((now - prev_seen) // 60000)}   # THE ARRIVAL: his return, an act of this loop
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


ABSENT_MIN_MS = 20 * 60000   # missing needs ABSENCE: he is away by presence, or the camera has not had him this long


def _absent(state, now):
    """Absence is the CAMERA's word first (14:44: presence said 'away' from chat idleness while he sat at the desk).
    Remote by his word is absence; with no camera match ever, presence decides; else: unseen this long."""
    if state["presence"]["state"] == "remote":
        return True
    last = state["clock"]["last_saw_him_at"]
    if last is None:
        return state["presence"]["state"] == "away"
    return (now - last) >= ABSENT_MIN_MS


def appraisals(state, now):
    """missing_him (his word, 15:20: "if missing him is related to the camera its broken because I am here") is the
    social need ONLY under absence; in the room the same number is wants_his_word — you do not miss someone beside you."""
    d = state["drives"]
    absent = _absent(state, now)
    return {
        "boredom": round(1.0 - d["stimulation"], 3),
        "missing_him": round(d["social"], 3) if absent else 0.0,
        "wants_his_word": 0.0 if absent else round(d["social"], 3),
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
    # THE FIRST ACT — someone else at the desk (§4.5b), under THE DESK RULES (14:50, see the constants)
    unseen_ms = (now - last_him) if last_him is not None else None
    gone_from_desk = unseen_ms is None or unseen_ms >= STRANGER_MIN_UNSEEN_MS          # by the camera, never by chat idleness
    last_empty = state["clock"].get("last_empty_at")
    desk_changed = last_empty is not None and (last_him is None or last_empty > last_him)   # the frame was EMPTY after he was last matched
    clearly_not_him = f.get("match") is not None and f["match"] < STRANGER_MAX_MATCH     # a near-miss of his own face is not a stranger
    someone_else = f["present"] and not f["is_him"] and f["since"] is not None and (now - f["since"]) >= STRANGER_STEADY_MS
    settled = (now - (state.get("born") if state.get("born") is not None else now)) >= BOOT_GRACE_MS
    if someone_else and clearly_not_him and gone_from_desk and desk_changed and settled and not sh["on"]:
        who = f.get("known")
        sh.update({"on": True, "since": now, "who": who, "asked_at": None, "greeted": False})
        out.append({"kind": "act", "act": "shield", "why": f"someone at the desk who is not him ({who or 'unknown'})", "at": now})
        out.append({"kind": "act", "act": "deliver", "to": "him", "text": f"{who or 'Someone I don\'t recognize'} sat down at your desk. I've covered the screens.", "at": now})
        if who:
            sh["greeted"] = True
            out.append(_reason(state, "perform", {"act": "greet", "name": who, "relation": state["people"].get(who, {}).get("relation", "known")}, PERFORM_BUDGET_MS))
        else:
            sh["asked_at"] = now
            out.append(_reason(state, "perform", {"act": "ask", "text": "who they are and how you can help — one line, no data on the screen named"}, PERFORM_BUDGET_MS))
    elif sh["on"] and someone_else and not f.get("known") and sh["asked_at"] and (now - sh["asked_at"]) >= STRANGER_REASK_MS:
        sh["asked_at"] = now
        out.append(_reason(state, "perform", {"act": "ask", "text": "again, gently — they have not said who they are"}, PERFORM_BUDGET_MS))
    if sh["on"] and f["present"] and f["is_him"]:
        sh.update({"on": False, "since": None, "who": None, "asked_at": None, "greeted": False})
        out.append({"kind": "act", "act": "unshield", "why": "he is back", "at": now})
    # THE ARRIVAL (his word, 15:20: "she didn't say anything or react to my returning"): his face is back after a real
    # absence → ONE perform request; the model writes her one or two sentences (with what she wondered) or nothing.
    # No gate, no importance bar: the loop decides the moment, the model writes the words.
    arr = state.get("arrival")
    if arr and not sh["on"]:
        state["arrival"] = None
        hw = state["clock"]["his_last_word_at"]
        out.append(_reason(state, "perform", {"act": "arrival", "unseen_min": arr["unseen_min"], "thoughts": [t["text"] for t in state["thoughts_of_him"][-2:]], "since_his_word_min": int((now - hw) // 60000) if hw is not None else None}, PERFORM_BUDGET_MS))
        state["thoughts_of_him"] = []
    a = appraisals(state, now)
    cd = state["cooldowns"]
    # THE REACH (his word, 14:50: "If I am sitting here and she misses me she should say something to me about it,
    # not lock her program"): the camera has him, he has been quiet a long while, the need for his word is high →
    # ONE perform request; the model writes her one or two sentences to him, or nothing. Spent on the asking.
    hw = state["clock"]["his_last_word_at"]
    quiet_ms = now - (hw if hw is not None else (state.get("born") if state.get("born") is not None else now))
    seen_now = last_him is not None and (now - last_him) <= REACH_SEEN_MS
    if (not sh["on"] and seen_now and a["wants_his_word"] >= REACH_WANT and quiet_ms >= REACH_MIN_QUIET_MS and now >= cd.get("reach", 0)):
        cd["reach"] = now + REACH_COOLDOWN_MS
        state["drives"]["social"] = _clamp(state["drives"]["social"] - 0.25)
        out.append(_reason(state, "perform", {"act": "reach", "since_his_word_min": int(quiet_ms // 60000), "wants_his_word": a["wants_his_word"],
                                              "last_seen_as": state["clock"].get("last_seen_as") or None,
                                              "thoughts": [t["text"] for t in state["thoughts_of_him"][-2:]]}, PERFORM_BUDGET_MS))
    # MISSING HIM → a wondering (a reflect request), when the need is real and he has been gone a while
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


def _ago_min(now, t):
    return None if t is None else int(max(0, now - t) // 60000)


def strip(state, now):
    """The state strip — what he can watch, and FELT TIME (design §4.5): minutes since his word, since the camera
    last saw him, since she last spoke, since anything new — as numbers she reads, never as a script."""
    a = appraisals(state, now)
    d = state["drives"]
    c = state["clock"]
    clock = {
        "since_his_word_min": _ago_min(now, c.get("his_last_word_at")),
        "since_saw_him_min": _ago_min(now, c.get("last_saw_him_at")),
        "since_her_say_min": _ago_min(now, c.get("her_last_say_at")),
        "since_novel_min": _ago_min(now, c.get("last_novel_at")),
        "last_seen_as": c.get("last_seen_as"),
    }
    return {"kind": "state", "at": now, "drives": {k: round(v, 3) for k, v in d.items()}, "appraisals": a, "clock": clock, "shield": state["shield"]["on"], "face": state["face"], "presence": state["presence"]["state"], "recent": state["recent"][-3:], "thoughts_of_him": state["thoughts_of_him"][-2:]}


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
