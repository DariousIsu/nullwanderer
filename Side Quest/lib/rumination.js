/**
 * Rumination guard — the semantic-loop counterpart to the (lexical) StuckDetector.
 *
 * Live soak finding: the exact-signature StuckDetector catches VERBATIM loops but
 * is blind to RUMINATION — the same preoccupation restated in different words,
 * tick after tick (measured live: 0 exact-signature dupes yet 0.805 avg pairwise
 * cosine). That semantic spiral is SQ's signature failure, and it persists because
 * she has the focus tool to resolve a preoccupation but ruminates instead of using
 * it. So: detect the spiral by embedding similarity, then AUTO-ESCALATE it into a
 * focus — converting circling into directed action that the focus guards
 * (novelty/strikes/caps/stuck) drive to resolved-or-stalled.
 *
 * Only fires in FREE-ASSOCIATION mode — never during an active focus (that's
 * intentional deepening, which the focus guards already bound). Dependency-
 * injected (embedFn / nameFn) for offline testing.
 */

const db = require('./db');
const memory = require('./memory');
const focusLib = require('./focus');
const { streamChat } = require('./ollama');
const config = require('./config');

const MODEL = config.model();
const K = 4;            // how many recent free-association thoughts to consider
const THRESHOLD = 0.80; // avg pairwise cosine that counts as circling one theme

// Recent free-association thoughts (kind='thought', not tied to a focus), oldest→newest.
function recentFreeThoughts(k = K) {
  return db.getRecentAgentEvents(40).filter(e => e.kind === 'thought' && !e.focus_id).slice(-k);
}

/**
 * Detect rumination. Returns { ruminating, avg, thoughts }. Never fires during an
 * active focus. embedFn injectable for tests.
 */
async function detect({ k = K, threshold = THRESHOLD, embedFn = memory.embed } = {}) {
  if (focusLib.isActive()) return { ruminating: false, reason: 'focus-active' };
  const thoughts = recentFreeThoughts(k);
  if (thoughts.length < k) return { ruminating: false, reason: 'too-few', thoughts };
  const vecs = [];
  for (const t of thoughts) { try { vecs.push(await embedFn(t.content)); } catch { vecs.push(null); } }
  let sum = 0, n = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
    if (!vecs[i] || !vecs[j]) continue;
    sum += memory.cosine(vecs[i], vecs[j]); n++;
  }
  const avg = n ? sum / n : 0;
  return { ruminating: avg >= threshold, avg, thoughts };
}

// Name the recurring preoccupation as one actionable goal (the focus content).
async function nameTheme(thoughts, userName = 'them') {
  const list = thoughts.map((t, i) => `${i + 1}. ${(t.content || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
  const messages = [{
    role: 'user',
    content: `These recent private thoughts keep circling ONE unresolved preoccupation, restated in different words:\n${list}\n\nName it as a single CONCRETE, ACTIONABLE goal (imperative, 4–12 words) that — if pursued — would resolve the circling for ${userName}. Reply with ONLY the goal line, no quotes, no preamble.`
  }];
  let raw = '';
  // num_ctx pinned to 8192 (matches every call site — avoids model reload thrash).
  await streamChat({ model: MODEL, messages, options: { temperature: 0.3, top_p: 0.9, num_ctx: 8192, num_predict: 24 }, onToken: (t) => { raw += t; } });
  const goal = (raw.split('\n').map(s => s.trim()).find(Boolean) || '').replace(/^["'`]+|["'`]+$/g, '').trim();
  return goal;
}

/**
 * Escalate a detected rumination into a focus. Names the theme, then routes
 * through focus.setFromText so the SPAWN GATE applies (won't re-spawn a focus
 * tombstoned in the last 24h). Returns the focus object, or null if naming failed
 * or the spawn-gate suppressed it. nameFn injectable for tests.
 */
async function escalate(thoughts, userName = 'them', { nameFn = nameTheme } = {}) {
  let goal = null;
  try { goal = await nameFn(thoughts, userName); } catch (e) { console.error('[rumination] nameTheme failed:', e.message); }
  if (!goal || goal.length < 6) return null;
  const set = await focusLib.setFromText(`<focus>${goal}</focus>`);
  if (set) console.log(`[rumination] escalated circling → focus #${set.focus.id}: ${goal.slice(0, 70)}`);
  return set;
}

module.exports = { detect, escalate, nameTheme, recentFreeThoughts, K, THRESHOLD };
