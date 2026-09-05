/**
 * lib/avatar_posture.js — WHERE AN ANSWER CAME FROM → HOW HER BODY CARRIES IT.
 *
 * cognition.answerGrounded already returns { say, enriched, enrichSource, missed, need, tried }, and main.js
 * resolved it into a log line ("searched-miss" / "enriched:<src>" / "grounded") and threw it away. Whether she
 * FOUND anything, and WHERE it came from, are facts the program owns — strictly better evidence than reading
 * the wording for tone. So the source decides the posture; a model, if one is switched on at all, only refines.
 *
 * Measured 2026-07-23 on the real decision: this map alone was right 4/4 in 0ms, while local gemma4:12b
 * managed 0/4 at 1638ms and hermes3:8b changed one case for the worse. Hence pure, and hence the default.
 *
 * UMD for the SAME reason lib/avatar_state.js is: main-side code and the kg3d renderer must run the identical
 * mapping or the body will disagree with the log about what just happened. One source, no drift.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AvatarPosture = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Her own settled memory reads as home ground; something she had to go and fetch is newer and less settled
  // and should carry less body behind it. Keys are cognition's enrichSource values verbatim.
  const SOURCE_POSTURE = {
    forecast: 'speak_emphatic',   // her OWN model — the strongest ground she has
    graph: 'speak',               // our KG: settled, already hers
    convo: 'speak',               // what was actually said here before
    news: 'speak',                // her own stream, corroborated
    routed: 'speak',              // a tool she drove herself
    wiki: 'speak_soft',           // outside, and only just now looked up
    'wiki-verify': 'speak_soft',
    web: 'speak_soft',
    excavate: 'speak_soft',       // had to dig for it — least settled of all
  };

  // What the deterministic layer does when the turn carries no posture at all.
  const FALLBACK = { hear: 'listen', say: 'speak', think: 'think' };

  // THE LOOK WORDS (the wants project, cut 13's gaze half, 09-05): where her eyes go is part of the posture vocabulary —
  // she looks AT HIM when she speaks to him or listens, and AWAY when she thinks. A second channel beside the clip:
  // the companion's look-at bone and the 2D face's pupils read it (lib/avatar_state.gazeTarget turns it into a gaze).
  const LOOK = { say: 'at_him', hear: 'at_him', think: 'away' };
  function lookForTurn(turn) {
    const kind = String((turn && turn.kind) || 'idle');
    const look = LOOK[kind] || null;
    return look ? { look, why: 'event:' + kind } : null;
  }

  /*
   * PURE. A cognition result → a posture, or null when the turn carries no usable signal (so the caller falls
   * through rather than inventing certainty). `decisive` means the program is surer than a model could be —
   * callers must NOT spend a model call second-guessing it.
   */
  function postureFromTurn(turn) {
    if (!turn || typeof turn !== 'object') return null;
    const kind = String(turn.kind || 'say');
    // An honest miss: she checked her records, searched, and came back empty. There is nothing here for a
    // model to read — the body should say "no", because that is what happened.
    if (turn.missed === true) return { clip: 'shake', decisive: true, why: 'searched-miss' };
    if (kind !== 'say') return null;                     // posture is about how she ANSWERS
    // Answered with no enrichment at all = it was already in hand. Her most settled state.
    if (turn.enriched === false && !turn.enrichSource) return { clip: 'speak', decisive: false, why: 'grounded' };
    const src = String(turn.enrichSource || '');
    if (!src || !SOURCE_POSTURE[src]) return null;
    return { clip: SOURCE_POSTURE[src], decisive: false, why: 'enriched:' + src };
  }

  /*
   * The whole decision in one call, for callers that just want a clip name: posture first, deterministic map
   * second. `has` is an optional membership test against the live clip menu, so a caller can never be handed
   * a clip its player does not own.
   */
  function clipForTurn(turn, has) {
    const ok = typeof has === 'function' ? has : function () { return true; };
    const p = postureFromTurn(turn);
    if (p && ok(p.clip)) return { clip: p.clip, decisive: !!p.decisive, why: p.why };
    const kind = String((turn && turn.kind) || 'idle');
    const f = FALLBACK[kind];
    if (f && ok(f)) return { clip: f, decisive: false, why: 'event:' + kind };
    return null;
  }

  return { SOURCE_POSTURE, FALLBACK, LOOK, postureFromTurn, clipForTurn, lookForTurn };
}));
