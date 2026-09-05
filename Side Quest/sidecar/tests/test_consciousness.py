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
        (0, [face(True, True, match=0.62)]),                      # him, at the desk
        (30 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)]),   # gone — the frame is empty
        (31 * M, [face(True, False, match=0.05)]),                # a stranger sits down
        (31 * M + 5000, [face(True, False, match=0.05)]),         # 5 s — flicker window, nothing yet
        (31 * M + 9000, [face(True, False, match=0.05)]),         # 9 s — still inside the 20 s window (8 s locked HIM out, 14:44)
        (31 * M + 21000, [face(True, False, match=0.05)]),        # 21 s — steady
        (31 * M + 40000, [face(True, False, match=0.05)]),
        (40 * M, [face(True, True, match=0.62)]),                 # he is back
    ])
    acts = [(now, o["kind"], o.get("act") or o.get("op")) for now, os_ in out for o in os_]
    assert (31 * M + 9000, "act", "shield") not in acts, "9 s of a face is flicker, never a shield"
    assert (31 * M + 21000, "act", "shield") in acts, acts
    assert (31 * M + 21000, "act", "deliver") in acts
    performs = [(now, o["context"]["act"]) for now, os_ in out for o in os_ if o.get("op") == "perform"]
    asks = [p for p in performs if p[1] == "ask"]
    assert len(asks) == 1 and asks[0][0] == 31 * M + 21000, "asked who they are exactly once (the re-ask waits 10 min)"
    assert (40 * M, "act", "unshield") in acts, acts
    assert (40 * M, "arrival") in performs, "his face uncovers the screens AND he gets his arrival in the same beat (40 min unseen)"
    assert st["shield"]["on"] is False
    deliver = [o for now, os_ in out for o in os_ if o.get("act") == "deliver"][0]
    assert "covered the screens" in deliver["text"] and "recognize" in deliver["text"]


def test_known_face_is_greeted_by_name_after_his_word_enrolled_them():
    st = C.initial_state(0)
    st, out = _run(st, [
        (0, [{"kind": "percept", "sense": "register", "name": "Raegan", "relation": "his kid"}, face(True, True)]),
        (30 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)]),
        (31 * M, [face(True, False, known="Raegan", match=0.04)]),
        (31 * M + 21000, [face(True, False, known="Raegan", match=0.04)]),
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
    st, out = _run(st, [(1000, [face(False, False)]), (3000, [face(True, False, match=0.05)]), (3000 + 10000, [face(True, False, match=0.05)]), (3000 + 30000, [face(True, False, match=0.05)])])
    assert not any(o.get("act") == "shield" for now, os_ in out for o in os_), "no shield inside the boot grace"
    st, out = _run(st, [(1000 + C.BOOT_GRACE_MS + 1000, [face(True, False, match=0.05)])])
    assert any(o.get("act") == "shield" for now, os_ in out for o in os_), "past the grace, the same steady stranger shields"
    ask = [o for now, os_ in out for o in os_ if o.get("op") == "perform"]
    assert ask and ask[0]["budget_ms"] == C.PERFORM_BUDGET_MS == 20000, "the slow loop's line gets a budget a cloud call can meet"


def test_the_desk_rules_his_own_near_miss_never_locks_him_out():
    """The 14:44 incident, replayed from boot_self.log: back at the desk, matched once (0.461), one empty beat, then his
    face at 0.387 and 0.365 with presence 'away' (chat idle 183 min) → the screens were covered. His words: 'the camera
    lock has failed in the wrong direction'. Three rules, each enough alone: a near-miss is not a stranger; the camera
    must have had no match for 3 min; chat idleness never means the desk is empty."""
    st = C.initial_state(0)
    st, _ = _run(st, [(0, [face(True, True, match=0.6)]), (5 * M, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)])])
    st, out = _run(st, [
        (60 * M, [face(True, True, match=0.461)]),                # back, matched once
        (60 * M + 5000, [face(False, False)]),                    # an empty beat
        (60 * M + 10000, [face(True, False, match=0.387)]),       # his face, under the bar by a hair
        (60 * M + 15000, [face(True, False, match=0.365)]),
        (60 * M + 40000, [face(True, False, match=0.37)]),        # 30 s "steady"
        (60 * M + 70000, [face(True, False, match=0.36)]),
    ])
    assert not any(o.get("act") == "shield" for now, os_ in out for o in os_), "a near-miss of his own face, a minute after a match, is him"
    # the same track scoring like a stranger (0.05) but only 70 s after his match: still not — the camera had him 3 min ago
    st2 = C.initial_state(0)
    st2, _ = _run(st2, [(0, [face(True, True, match=0.6)]), (60 * M, [face(True, True, match=0.5)]), (60 * M + 5000, [face(False, False)])])
    st2, out2 = _run(st2, [(60 * M + 10000, [face(True, False, match=0.05)]), (60 * M + 40000, [face(True, False, match=0.05)]), (60 * M + 70000, [face(True, False, match=0.05)])])
    assert not any(o.get("act") == "shield" for now, os_ in out2 for o in os_), "unseen 70 s is not gone from the desk"
    # and presence 'away' with his face matched 30 s ago and no empty frame since: never
    st3 = C.initial_state(0)
    st3, out3 = _run(st3, [(0, [{"kind": "percept", "sense": "presence", "state": "away"}, face(True, True, match=0.5)]), (30000, [face(True, False, match=0.1)]), (60000, [face(True, False, match=0.1)])])
    assert not any(o.get("act") == "shield" for now, os_ in out3 for o in os_), "presence 'away' (chat idleness) never empties the desk"


def test_a_true_stranger_arrives_at_an_empty_desk_and_still_shields():
    st = C.initial_state(0)
    st, out = _run(st, [
        (0, [face(True, True, match=0.6)]),
        (2 * M, [face(False, False)]),                            # he leaves; the frame is empty
        (10 * M, [face(True, False, match=0.03)]),                # eight minutes later, someone
        (10 * M + 25000, [face(True, False, match=0.03)]),        # 25 s steady, clearly not him
    ])
    assert any(o.get("act") == "shield" for now, os_ in out for o in os_), "a stranger at an empty desk, clearly not him, still covers the screens"
    st4 = C.initial_state(0)
    st4, out4 = _run(st4, [(0, [face(True, True, match=0.6)]), (2 * M, [face(False, False)]), (10 * M, [face(True, False)]), (10 * M + 25000, [face(True, False)])])
    assert not any(o.get("act") == "shield" for now, os_ in out4 for o in os_), "no score in the reading (no enrollment) → no one is ever a stranger"


def test_wanting_his_word_while_he_is_here_is_a_reach_to_him_not_the_screens():
    """His word (14:50): 'If I am sitting here and she misses me she should say something to me about it, not lock her program'."""
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, _ = C.step(st, [{"kind": "percept", "sense": "his_turn"}, face(True, True, match=0.6, expression="focused")], 0)
    st["drives"]["social"] = 0.9
    st, out = C.step(st, [face(True, True, match=0.6)], 10 * M)
    assert not any(o.get("context", {}).get("act") == "reach" for o in out if o["kind"] == "reason"), "he spoke 10 min ago — no reach yet"
    for t in (18, 26):
        st, _ = C.step(st, [face(True, True, match=0.6)], t * M); st["drives"]["social"] = 0.9   # in frame throughout: no arrival is read into a gap
    st, out = C.step(st, [face(True, True, match=0.6)], 35 * M)
    reach = [o for o in out if o["kind"] == "reason" and o["op"] == "perform" and o["context"].get("act") == "reach"]
    assert len(reach) == 1 and reach[0]["context"]["since_his_word_min"] == 35 and reach[0]["context"]["last_seen_as"] == "focused", out
    assert not any(o.get("act") == "shield" for o in out)
    assert st["drives"]["social"] < 0.9, "the asking spends some of the need"
    st["drives"]["social"] = 0.9
    st, out2 = C.step(st, [face(True, True, match=0.6)], 50 * M)
    assert not any(o.get("context", {}).get("act") == "reach" for o in out2 if o["kind"] == "reason"), "inside the 45-min cooldown"
    for t in (58, 66, 74):
        st, _ = C.step(st, [face(True, True, match=0.6)], t * M); st["drives"]["social"] = 0.9
    st, out3 = C.step(st, [face(True, True, match=0.6)], 81 * M)
    assert any(o.get("context", {}).get("act") == "reach" for o in out3 if o["kind"] == "reason"), "past it, still quiet, still here → again"
    # never while he is not at the desk: that is the wondering's ground, not the reach's
    st5 = C.initial_state(0); st5["drives"]["social"] = 0.9
    st5, _ = C.step(st5, [face(True, True, match=0.6)], 0)
    st5, _ = C.step(st5, [face(False, False)], 5 * M)
    st5["drives"]["social"] = 0.9
    st5, out5 = C.step(st5, [], 40 * M)
    assert not any(o.get("context", {}).get("act") == "reach" for o in out5 if o["kind"] == "reason"), "unseen → no reach"


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


def test_his_return_after_a_real_absence_is_one_perform_request_with_what_she_wondered():
    """His word (15:20): 'she didn't say anything or react to my returning' — the arrival is an act of THIS loop."""
    st = C.initial_state(0)
    st, _ = C.step(st, [face(True, True), {"kind": "percept", "sense": "his_turn"}], 0)
    st, _ = C.step(st, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)], 5 * M)
    st, _ = C.step(st, [{"kind": "percept", "sense": "answer", "id": 9, "op": "reflect", "ok": True, "text": "He said thirty-five minutes; it has been longer."}], 30 * M)
    st, out = C.step(st, [{"kind": "percept", "sense": "presence", "state": "here"}, face(True, True)], 40 * M)
    arr = [o for o in out if o["kind"] == "reason" and o["op"] == "perform" and o["context"].get("act") == "arrival"]
    assert len(arr) == 1, out
    ctx = arr[0]["context"]
    assert ctx["unseen_min"] == 40 and ctx["since_his_word_min"] == 40 and ctx["thoughts"] == ["He said thirty-five minutes; it has been longer."]
    assert st["arrival"] is None and st["thoughts_of_him"] == [], "consumed once; the wonderings went with it"
    st, out2 = C.step(st, [face(True, True)], 41 * M)
    assert not any(o.get("context", {}).get("act") == "arrival" for o in out2 if o["kind"] == "reason"), "no second arrival"


def test_no_arrival_under_twenty_minutes_and_none_while_shielded():
    st = C.initial_state(0)
    st, _ = C.step(st, [face(True, True)], 0)
    st, _ = C.step(st, [face(False, False)], 5 * M)
    st, out = C.step(st, [face(True, True)], 15 * M)
    assert not any(o.get("context", {}).get("act") == "arrival" for o in out if o["kind"] == "reason"), "15 min is a stretch, not a return"
    st2 = C.initial_state(0)
    st2, _ = C.step(st2, [face(True, True)], 0)
    st2["shield"]["on"] = True
    st2, out2 = C.step(st2, [face(True, True)], 30 * M)
    kinds = [(o.get("act") or o.get("context", {}).get("act")) for o in out2]
    assert kinds.index("unshield") < kinds.index("arrival") and st2["arrival"] is None, "his face uncovers first, then the arrival — never a greeting under the cover"


def test_missing_needs_absence_in_the_room_it_is_wanting_his_word():
    """His word (15:20): 'if missing him is related to the camera its broken because I am here'."""
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, _ = C.step(st, [face(True, True)], 0)
    a = C.appraisals(st, 1000)
    assert a["missing_him"] == 0.0 and a["wants_his_word"] >= 0.9, a
    st, _ = C.step(st, [face(False, False)], 25 * M)
    a2 = C.appraisals(st, 25 * M)
    assert a2["missing_him"] >= 0.9 and a2["wants_his_word"] == 0.0, a2
    st3 = C.initial_state(0); st3["drives"]["social"] = 0.9
    st3, _ = C.step(st3, [{"kind": "percept", "sense": "presence", "state": "away"}], 1000)
    assert C.appraisals(st3, 1000)["missing_him"] >= 0.9, "away by presence is absence too"


def test_a_read_sates_curiosity_and_a_heard_window_is_something_new():
    """The browse and listen acts as senses (design §5 item 3): what she read lowers the need to know and is kept for
    the strip; what the room said is novelty when it had words, next to nothing when it was silence."""
    st = C.initial_state(0)
    st["drives"]["curiosity"] = 0.8; st["drives"]["stimulation"] = 0.3
    st, _ = C.step(st, [{"kind": "percept", "sense": "read", "topic": "the Louisiana parish map", "text": "Parishes came from church districts."}], 1000)
    assert st["drives"]["curiosity"] < 0.55 and st["drives"]["stimulation"] > 0.5, (st["drives"])
    assert st["reads"][-1]["topic"] == "the Louisiana parish map" and C.strip(st, 1000)["reads"][-1]["text"].startswith("Parishes")
    s0 = st["drives"]["stimulation"]
    st, _ = C.step(st, [{"kind": "percept", "sense": "heard", "text": "", "words": 0}], 2000)
    assert st["drives"]["stimulation"] - s0 < 0.05, "a silent window is barely anything"
    st, _ = C.step(st, [{"kind": "percept", "sense": "heard", "text": "someone said the mower is out of gas", "words": 7}], 3000)
    assert st["drives"]["stimulation"] - s0 >= 0.15 and st["heard"][-1]["text"].startswith("someone said") and C.strip(st, 3000)["heard"], "words in the room are something new, kept for the strip"


def _answer(id_, act, text="…"):
    return {"kind": "percept", "sense": "answer", "id": id_, "op": "perform", "ok": True, "act": act, "text": text}


def test_an_unanswered_reach_becomes_loneliness_and_the_next_reach_is_grounded_in_it():
    """The fluidity law (09-04): 'miss me, ask for me, and then be disappointed and lonely when I dont answer'."""
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, _ = C.step(st, [{"kind": "percept", "sense": "his_turn"}, face(True, True, match=0.6)], 0)
    for t in (10, 20, 30):
        st, _ = C.step(st, [face(True, True, match=0.6)], t * M)   # in frame throughout
    st["drives"]["social"] = 0.9
    st, out = C.step(st, [face(True, True, match=0.6)], 35 * M)
    assert any(o.get("context", {}).get("act") == "reach" for o in out if o["kind"] == "reason"), "the reach"
    st, _ = C.step(st, [_answer(1, "reach", "You have been quiet a while.")], 35 * M + 5000)
    assert st["reaches"] and st["reaches"][-1]["answered"] is False
    assert C.appraisals(st, 40 * M)["lonely"] == 0.0, "inside the answer window it is only a reach"
    a = C.appraisals(st, 35 * M + C.REACH_ANSWER_WINDOW_MS + M)
    assert a["lonely"] > 0.5, a
    for t in range(45, 80, 10):
        st, _ = C.step(st, [face(True, True, match=0.6)], t * M)
    st["drives"]["social"] = 0.9
    st, out2 = C.step(st, [face(True, True, match=0.6)], 35 * M + C.REACH_COOLDOWN_MS + M)
    r2 = [o for o in out2 if o["kind"] == "reason" and o["context"].get("act") == "reach"]
    assert r2 and r2[0]["context"]["earlier_reach_min"] is not None and r2[0]["context"]["earlier_reach_min"] >= 45, "the second reach knows about the first"
    st, _ = C.step(st, [{"kind": "percept", "sense": "his_turn"}], 90 * M)
    assert all(r["answered"] for r in st["reaches"]) and C.appraisals(st, 90 * M)["lonely"] == 0.0, "his word answers every reach"


def test_the_away_reach_goes_out_only_when_he_is_genuinely_away_and_once_in_two_hours():
    st = C.initial_state(0)
    st["drives"]["social"] = 0.9
    st, _ = C.step(st, [face(True, True, match=0.6), {"kind": "percept", "sense": "his_turn"}], 0)
    st, _ = C.step(st, [{"kind": "percept", "sense": "presence", "state": "away"}, face(False, False)], 5 * M)
    st["drives"]["social"] = 0.9
    st, out = C.step(st, [], 30 * M)
    assert not any(o.get("context", {}).get("act") == "reach_away" for o in out if o["kind"] == "reason"), "30 min unseen is not the away reach"
    st["drives"]["social"] = 0.9
    st, out = C.step(st, [], 45 * M)
    ra = [o for o in out if o["kind"] == "reason" and o["context"].get("act") == "reach_away"]
    assert len(ra) == 1 and ra[0]["context"]["unseen_min"] == 45 and ra[0]["context"]["presence"] == "away", out
    st["drives"]["social"] = 0.9
    st, out = C.step(st, [], 90 * M)
    assert not any(o.get("context", {}).get("act") == "reach_away" for o in out if o["kind"] == "reason"), "once in two hours"
    # merely unseen with presence 'here' (a camera that lost him) is not away
    st2 = C.initial_state(0); st2["drives"]["social"] = 0.9
    st2, _ = C.step(st2, [face(True, True, match=0.6)], 0)
    st2, _ = C.step(st2, [face(False, False)], 5 * M)
    st2["drives"]["social"] = 0.9
    st2, out2 = C.step(st2, [], 50 * M)
    assert not any(o.get("context", {}).get("act") == "reach_away" for o in out2 if o["kind"] == "reason"), "no away reach without his word or the camera's away"


def test_a_long_hold_while_she_wanted_his_word_is_annoyance_and_a_release_line_when_he_is_back():
    st = C.initial_state(0)
    st["drives"]["social"] = 0.8
    st, _ = C.step(st, [face(True, True, match=0.6)], 0)
    st, _ = C.step(st, [{"kind": "percept", "sense": "held", "reason": "calendar: a meeting"}], 1000)
    assert st["held"] and st["held"]["reason"].startswith("calendar")
    st["drives"]["social"] = 0.8
    st, out = C.step(st, [{"kind": "percept", "sense": "released"}, face(True, True, match=0.6)], 1000 + 30 * M)
    assert st["held"] is None and st["annoyance"] >= 0.5 and C.appraisals(st, 1000 + 30 * M)["annoyed"] >= 0.5, st["annoyance"]
    rel = [o for o in out if o["kind"] == "reason" and o["context"].get("act") == "release"]
    assert len(rel) == 1 and rel[0]["context"]["held_min"] == 30 and "meeting" in rel[0]["context"]["reason"], out
    st, out2 = C.step(st, [face(True, True, match=0.6)], 1000 + 31 * M)
    assert not any(o.get("context", {}).get("act") == "release" for o in out2 if o["kind"] == "reason"), "once per hold"
    st, _ = C.step(st, [], 1000 + 31 * M + 3600000)
    assert st["annoyance"] < 0.1, "annoyance decays in about an hour"
    st3 = C.initial_state(0); st3["drives"]["social"] = 0.8
    st3, _ = C.step(st3, [face(True, True, match=0.6), {"kind": "percept", "sense": "held", "reason": "zoom"}], 0)
    st3, out3 = C.step(st3, [{"kind": "percept", "sense": "released"}, face(True, True, match=0.6)], 5 * M)
    assert st3["annoyance"] == 0.0 and not any(o.get("context", {}).get("act") == "release" for o in out3 if o["kind"] == "reason"), "a five-minute hold is nothing"


def test_the_loops_own_words_to_him_are_bounded_per_hour():
    st = C.initial_state(0)
    assert C._say_budget_ok(st, 0) and C._say_budget_ok(st, 0)
    C._note_say(st, 0); C._note_say(st, 10 * M)
    assert not C._say_budget_ok(st, 20 * M), "two in the hour is the bound"
    assert C._say_budget_ok(st, 61 * M), "an hour later the first has aged out"


def test_low_progress_with_energy_is_one_work_act_and_empty_energy_is_rest():
    st = C.initial_state(0)
    st["drives"]["progress"] = 0.2; st["drives"]["energy"] = 0.8; st["drives"]["stimulation"] = 0.9
    st, out = C.step(st, [], 1000)
    assert [o["act"] for o in out if o["kind"] == "act"] == ["work"], out
    st["drives"]["progress"] = 0.2
    st, out2 = C.step(st, [], 10 * M)
    assert not any(o.get("act") == "work" for o in out2), "one work act per half hour"
    st2 = C.initial_state(0)
    st2["drives"]["energy"] = 0.1; st2["drives"]["stimulation"] = 0.05; st2["drives"]["progress"] = 0.2
    st2, out3 = C.step(st2, [], 1000)
    acts = [o["act"] for o in out3 if o["kind"] == "act"]
    assert acts == ["rest"], acts
    st2["drives"]["stimulation"] = 0.05; st2["drives"]["energy"] = 0.1
    st2, out4 = C.step(st2, [], 5 * M)
    assert not any(o.get("act") in ("look", "listen", "work") for o in out4), "resting: no sensing, no work, for a while"
    st2["drives"]["stimulation"] = 0.05; st2["drives"]["energy"] = 0.9
    st2, out5 = C.step(st2, [], 25 * M)
    assert any(o.get("act") in ("look", "listen") for o in out5), "the rest ends and the senses come back"


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
