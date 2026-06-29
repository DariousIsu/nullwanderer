/**
 * snapback — the manual recall lever for when Zoe is lost in thought.
 *
 * Two behaviours, by design (Lucas, 2026-06-23):
 *   - An EXPLICIT phrase ("earth to Zoe", "Zoe, come back", "Zoe, snap out of it")
 *     HARD-interrupts an in-flight thought so she drops it and answers now.
 *   - A NORMAL message while she's mid-thought gets a busy-lane PLACEHOLDER
 *     ("hang on a sec…") instead — her wandering is hers to keep; only the
 *     explicit phrase yanks her out.
 *
 * This module is just the (testable) detection + the placeholder lines; the
 * wiring (interrupt + prompt note + placeholder emit) lives in main.js.
 */

// Explicit "come back to me" phrases. Kept deliberately tight so an ordinary
// message never trips a hard interrupt (the busy placeholder handles those).
function detectHardPull(text) {
  if (!text) return false;
  const t = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;

  // Unambiguous standalone forms.
  if (t.includes('earth to zoe')) return true;
  if (t.includes('snap out of it')) return true;

  // "zoe" + a recall verb. Requires her name so generic chatter is safe.
  const hasZoe = /\bzoe\b/.test(t);
  if (hasZoe && (
    t.includes('come back') ||
    t.includes('snap out') ||
    t.includes('you there') ||
    t.includes('you with me') ||
    t.includes('pay attention') ||
    t.includes('wake up') ||
    t.includes('focus up')
  )) return true;

  return false;
}

// Canned busy-lane replies in her voice — instant, no model call, so they land
// the moment Lucas speaks even while a thought is still generating on the GPU.
const BUSY_LINES = [
  "hang on a second — I'm in the middle of something.",
  "one moment, I'm chasing a thought.",
  "give me a beat, I'm working through something.",
  "hold on — let me finish this thread and I'll be right with you.",
  "sec — I'm deep in something, be right there.",
];

// Deterministic pick (no Math.random — keeps behaviour reproducible). The caller
// passes a rotating integer (e.g. Date.now()) so consecutive busies vary.
function pickBusyLine(seed) {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return BUSY_LINES[n % BUSY_LINES.length];
}

// WORKING lines — placeholders for when she's acting on LUCAS'S request (a tool/agent run that takes
// a few seconds), not lost in her own thought. The BUSY_LINES above are self-focused ("I'm in the
// middle of something") and read as brushing him off when he just asked for something — exactly wrong
// the moment he assigns a task. These affirm she's ON IT. `task` picks an assignment-grade line.
const WORKING_LINES = [
  'on it — give me a sec to pull this together.',
  'on it; gathering what I need.',
  'looking into that now — one moment.',
  'starting on that — won\'t be long.',
];
const TASK_WORKING_LINES = [
  "on it — starting on that now; I'll pull the first findings together and keep at it.",
  "got it — I'm on this; let me start gathering and I'll keep working it.",
  "starting on that right now — I'll begin compiling and stay on it.",
];
function pickWorkingLine(seed, { task = false } = {}) {
  const arr = task ? TASK_WORKING_LINES : WORKING_LINES;
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return arr[n % arr.length];
}

module.exports = { detectHardPull, pickBusyLine, pickWorkingLine, BUSY_LINES, WORKING_LINES, TASK_WORKING_LINES };
