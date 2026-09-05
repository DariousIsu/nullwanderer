"""Pins for the consciousness subroutine's fast loop (sidecar/consciousness.py). Run:
  <echo venv>/python -m pytest "Side Quest/sidecar/tests" -q
"""
import copy
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import consciousness as C  # noqa: E402

M = 60000


def _run(state, timeline):
    """timeline: [(now_ms, [percepts])] → list of (now, outputs). Advances the state through each beat."""
    out = []
    for now, ps in timeline:
        state, o = C.step(state, ps, now)
        out.append((now, o))
    return state, out


def face(present, is_him, known=None, **kw):
    return {"kind": "percept", "sense": "face", "present": present, "is_him": is_him, "known": known, **kw}


def test_stranger_shields_asks_once_and_unshields_on_his_face():
    st = C.initial_state(0)
    st, out = _run(st, [
        (0, [face(True, True)]),                                  # him, at the desk
        (30 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)]),   # gone
        (31 * M, [face(True, False)]),                            # a stranger sits down
        (31 * M + 5000, [face(True, False)]),                     # 5 s — flicker window, nothing yet
        (31 * M + 9000, [face(True, False)]),                     # 9 s — steady
        (31 * M + 20000, [face(True, False)]),
        (40 * M, [face(True, True)]),                             # he is back
    ])
    acts = [(now, o["kind"], o.get("act") or o.get("op")) for now, os_ in out for o in os_]
    assert (31 * M + 5000, "act", "shield") not in acts, "5 s of a face is flicker, never a shield"
    assert (31 * M + 9000, "act", "shield") in acts, acts
    assert (31 * M + 9000, "act", "deliver") in acts
    asks = [a for a in acts if a[2] == "perform"]
    assert len(asks) == 1 and asks[0][0] == 31 * M + 9000, "asked who they are exactly once (the re-ask waits 10 min)"
    assert (40 * M, "act", "unshield") in acts, acts
    assert st["shield"]["on"] is False
    deliver = [o for now, os_ in out for o in os_ if o.get("act") == "deliver"][0]
    assert "covered the screens" in deliver["text"] and "recognize" in deliver["text"]


def test_known_face_is_greeted_by_name_after_his_word_enrolled_them():
    st = C.initial_state(0)
    st, out = _run(st, [
        (0, [{"kind": "percept", "sense": "register", "name": "Raegan", "relation": "his kid"}, face(True, True)]),
        (30 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)]),
        (31 * M, [face(True, False, known="Raegan")]),
        (31 * M + 9000, [face(True, False, known="Raegan")]),
    ])
    outs = [o for now, os_ in out for o in os_]
    greet = [o for o in outs if o.get("op") == "perform"]
    assert greet and greet[0]["context"]["act"] == "greet" and greet[0]["context"]["name"] == "Raegan" and greet[0]["context"]["relation"] == "his kid"
    assert any(o.get("act") == "shield" for o in outs), "the screens are covered for a known face too — the data is his"
    assert not any(o.get("context", {}).get("act") == "ask" for o in outs), "a known face is never asked who they are"


def test_no_stranger_act_in_the_boots_first_ninety_seconds():
    """boot_p309, 11:04: his own face at match 0.013→0.65 as he settled, held 8 s, read as a stranger — the loop had
    never seen him. A face the loop cannot match in its first BOOT_GRACE_MS is never a stranger."""
    st = C.initial_state(1000)
    st, out = _run(st, [(1000, [face(True, False)]), (1000 + 10000, [face(True, False)]), (1000 + 30000, [face(True, False)])])
    assert not any(o.get("act") == "shield" for now, os_ in out for o in os_), "no shield inside the boot grace"
    st, out = _run(st, [(1000 + C.BOOT_GRACE_MS + 1000, [face(True, False)])])
    assert any(o.get("act") == "shield" for now, os_ in out for o in os_), "past the grace, the same steady stranger shields"
    ask = [o for now, os_ in out for o in os_ if o.get("op") == "perform"]
    assert ask and ask[0]["budget_ms"] == C.PERFORM_BUDGET_MS == 20000, "the slow loop's line gets a budget a cloud call can meet"


def test_a_face_while_he_is_here_never_shields():
    st = C.initial_state(0)
    st, out = _run(st, [(0, [face(True, True)]), (20000, [face(True, False)]), (40000, [face(True, False)])])
    assert not any(o.get("act") == "shield" for now, os_ in out for o in os_), "he was seen 40 s ago and is here — someone leaning in beside him is not a stranger at his desk"


def test_boredom_rises_with_nothing_new_and_produces_a_look_then_waits():
    st = C.initial_state(0)
    st["drives"]["stimulation"] = 0.6
    st, out = _run(st, [(0, [face(True, True)]), (10 * M, []), (12 * M, []), (13 * M, []), (17 * M, [])])
    a = C.appraisals(st, 17 * M)
    assert a["boredom"] > 0.9, a
    sensing = [(now, o["act"]) for now, os_ in out for o in os_ if o.get("act") in ("look", "listen")]
    # 10 min of nothing new: bored past 0.85 → listen; 2 min later, listen on cooldown → look; at 13 both wait; at 17 listen again
    assert sensing == [(10 * M, "listen"), (12 * M, "look"), (17 * M, "listen")], sensing
    same_kind_gaps = [b[0] - a_[0] for a_, b in zip(sensing, sensing[1:]) if a_[1] == b[1]]
    assert all(g >= C.LOOK_COOLDOWN_MS for g in same_kind_gaps), "a sense act never repeats inside its cooldown"


def test_his_turn_sates_the_social_need_and_it_rises_faster_while_he_is_away():
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, _ = C.step(st, [{"kind": "percept", "sense": "his_turn"}], 1000)
    assert st["drives"]["social"] < 0.35
    here = copy.deepcopy(st); away = copy.deepcopy(st)
    away["presence"] = {"state": "away", "since": 1000}
    here, _ = C.step(here, [], 1000 + 30 * M)
    away, _ = C.step(away, [], 1000 + 30 * M)
    assert away["drives"]["social"] > here["drives"]["social"] > 0.3, (here["drives"]["social"], away["drives"]["social"])
    assert C.appraisals(away, 1000 + 30 * M)["missing_him"] > C.appraisals(here, 1000 + 30 * M)["missing_him"]


def test_curiosity_asks_the_slow_loop_to_choose_and_never_blocks():
    st = C.initial_state(0)
    st["drives"]["curiosity"] = 0.8
    st, out = C.step(st, [], 5000)
    r = [o for o in out if o["kind"] == "reason"]
    assert r and r[0]["op"] == "choose" and r[0]["budget_ms"] > 0 and r[0]["id"] == 1
    assert st["drives"]["curiosity"] < 0.8, "asking spends some of the need; the answer returns as a percept"
    st, out2 = C.step(st, [{"kind": "percept", "sense": "answer", "id": 1, "text": "the Louisiana parish map"}], 9000)
    assert not any(o["kind"] == "reason" for o in out2), "no second ask inside the cooldown"


def test_missing_him_becomes_a_wondering_with_the_facts_and_a_cooldown():
    """His word: 'she wants to be able to experience missing me … casually think where is he, I haven't seen him
    in a while, I wonder what he's doing'. Python decides WHEN; the thought is a reflect request; the answer
    returns as a percept and is kept; his turn clears it."""
    st = C.initial_state(0)
    st, _ = C.step(st, [face(True, True, expression="focused"), {"kind": "percept", "sense": "his_turn"}], 0)
    st, out = _run(st, [
        (5 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)]),
        (15 * M, []),                      # unseen 15 min: too soon (20 min floor)
        (30 * M, []),                      # unseen 30 min, social risen under absence → a wondering is due
        (45 * M, []),                      # inside the 40-min cooldown → no second one
        (75 * M, []),                      # past it → a second wondering, carrying the first
    ])
    reasons = [(now, o) for now, os_ in out for o in os_ if o["kind"] == "reason" and o["op"] == "reflect"]
    assert [r[0] for r in reasons] == [30 * M, 75 * M], [r[0] for r in reasons]
    ctx = reasons[0][1]["context"]
    assert ctx["act"] == "wonder" and ctx["unseen_min"] == 30 and ctx["since_his_word_min"] == 30 and ctx["last_seen_as"] == "focused" and ctx["presence"] == "away" and ctx["missing"] >= C.WONDER_MISSING, ctx
    assert reasons[0][1]["budget_ms"] == 20000
    # the thought comes back as a percept and is kept; it opens a question (curiosity rises a little)
    st["drives"]["curiosity"] = 0.5
    cur = st["drives"]["curiosity"]
    st, _ = C.step(st, [{"kind": "percept", "sense": "answer", "id": reasons[0][1]["id"], "op": "reflect", "ok": True, "text": "He said thirty-five minutes. It has been longer; the roads, probably."}], 76 * M)
    assert st["thoughts_of_him"] and "thirty-five" in st["thoughts_of_him"][-1]["text"] and st["drives"]["curiosity"] > cur
    assert C.strip(st, 76 * M)["thoughts_of_him"], "the strip shows what she wondered"
    # his turn: the wonderings are answered
    st, _ = C.step(st, [{"kind": "percept", "sense": "his_turn"}], 77 * M)
    assert st["thoughts_of_him"] == []


def test_no_wondering_while_he_is_here_or_seen_recently():
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, out = _run(st, [(0, [face(True, True)]), (30 * M, [face(True, True)]), (60 * M, [face(True, True)])])
    assert not any(o["kind"] == "reason" and o["op"] == "reflect" for now, os_ in out for o in os_), "seen on camera → no wondering, however high the need"


def test_once_mode_round_trips_json():
    req = {"now": 9000, "percepts": [face(True, True), {"kind": "percept", "sense": "his_turn"}]}
    py = sys.executable
    r = subprocess.run([py, os.path.join(os.path.dirname(__file__), "..", "consciousness.py"), "--once"], input=json.dumps(req), capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["state"]["clock"]["his_last_word_at"] == 9000 and res["state"]["face"]["is_him"] is True and isinstance(res["outputs"], list)


def test_the_strip_is_what_he_can_watch():
    st = C.initial_state(0)
    s = C.strip(st, 0)
    assert s["kind"] == "state" and set(s["drives"]) == set(C.DRIVES) and "boredom" in s["appraisals"] and s["shield"] is False
    assert s["clock"] == {"since_his_word_min": None, "since_saw_him_min": None, "since_her_say_min": None, "since_novel_min": None, "last_seen_as": None}


def test_felt_time_rides_the_strip():
    """Design §4.5: minutes since his word, since the camera had him (and how he looked), since she spoke — numbers."""
    st = C.initial_state(0)
    st, _ = C.step(st, [face(True, True, expression="tired"), {"kind": "percept", "sense": "his_turn"}], 0)
    st, _ = C.step(st, [{"kind": "percept", "sense": "her_say"}], 2 * M)
    st, _ = C.step(st, [face(False, False)], 5 * M)
    s = C.strip(st, 130 * M)
    assert s["clock"]["since_his_word_min"] == 130 and s["clock"]["since_saw_him_min"] == 130 and s["clock"]["since_her_say_min"] == 128 and s["clock"]["last_seen_as"] == "tired"
    assert s["clock"]["since_novel_min"] == 125, s["clock"]
