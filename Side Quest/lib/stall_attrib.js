'use strict';
/**
 * lib/stall_attrib.js — the stall attributor's two pure decisions. main.js keeps the clock, the label
 * store and the 1s probe; this module decides what a mark records and what a stall gets NAMED.
 *
 * THE BLIND SPOT (freeze cut 5, 2026-09-03): the attributor only retained the lane that went IDLE. A
 * lane whose synchronous block ends by marking a DIFFERENT lane in the same macrotask (the decompose
 * sweep: findUndecomposed's 2–10s walk, then `decompose doc#N` the instant it returns) was never named —
 * boot_p256's 47 sweep stalls all read `active: "decompose doc#51151" (3ms)`, a label three milliseconds
 * old blamed for a five-second block, and "decompose-sweep" appears in no stall line at all. Every
 * transition now carries the lane that just ended, and a stall names the lane that ended INSIDE the
 * blocked window — "decompose-sweep → decompose doc#51151" — with the run length of the one that ended.
 */

/** The activity record after marking `label` at `now` — carries the lane that just ended. */
function next(prev, label, now) {
  const a = prev || { label: 'idle', at: now };
  const n = { label: label || 'idle', at: now };
  if (n.label !== a.label) { n.prevLabel = a.label; n.prevStartAt = a.at; n.prevEndAt = now; }
  else { n.prevLabel = a.prevLabel; n.prevStartAt = a.prevStartAt; n.prevEndAt = a.prevEndAt; }   // a repeated mark carries the stamp forward
  return n;
}

/**
 * Name a stall of `drift` ms that the probe observed at `now`. The current label is at least as old
 * as the block (it started at or before the loop wedged) → it is the culprit, plainly. The current
 * label is YOUNGER than the block → it was marked inside the blocked window, so the lane that ENDED
 * at that transition is what wedged the loop; name both, with the ended lane's run length. (`slackMs`
 * only widens the transition's admission window — the probe ticks once a second, so a transition up
 * to that far before the detected block cannot be ruled out by probe evidence.)
 */
function attribute(a, now, drift, { slackMs = 2000 } = {}) {
  const age = now - a.at;
  const transitioned = a.prevLabel != null && a.prevEndAt != null && a.prevEndAt >= now - drift - slackMs;
  if (transitioned && age < drift) {
    const label = a.label === 'idle' ? `idle (just-ended: ${a.prevLabel})` : `${a.prevLabel} → ${a.label}`;
    return { label, ranMs: a.prevEndAt - a.prevStartAt };
  }
  return { label: a.label, ranMs: age };
}

module.exports = { next, attribute };
