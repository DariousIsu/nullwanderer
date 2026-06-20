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
const voice = require('./voice');
const { streamChat } = require('./ollama');
const config = require('./config');

const MODEL = config.model();
const K = 4;            // how many recent free-association thoughts to consider
const THRESHOLD = 0.80; // avg pairwise cosine that counts as circling one theme

// CIRCUIT BREAKER: escalation assumes naming the theme as a focus RESOLVES it. But
// a sticky meta-preoccupation (e.g. "stop overanalyzing his typo") resolves in one
// tick then instantly re-ruminates, reworded just enough to dodge the spawn gate —
// an eternal spin (observed: focuses #56→#57→#58, cosine climbing 0.899→0.928). So
// if escalation fires repeatedly in a short window, the theme is NOT escalation-
// resolvable: stop trying and drop into a long cooldown so the normal loops (free-
// browse, thread-review) get the airtime back instead.
const ESC_WINDOW_MS = 20 * 60 * 1000;          // rolling window for counting escalations
const ESC_MAX = 2;                             // escalations in-window before the breaker trips
const ESC_BREAKER_COOLDOWN_MS = 2 * 60 * 60 * 1000;  // then suppress escalation this long

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
  // Cooldown: after an escalation was SUPPRESSED (theme tombstoned in the last
  // 24h), back off entirely for a while — otherwise each new thought on that same
  // tombstoned theme re-fires detect→escalate→suppress, burning a naming call.
  const cooldownUntil = parseInt(db.getMeta('rumination_cooldown_until') || '0', 10);
  if (Date.now() < cooldownUntil) return { ruminating: false, reason: 'cooldown' };
  const thoughts = recentFreeThoughts(k);
  if (thoughts.length < k) return { ruminating: false, reason: 'too-few', thoughts };
  // STALE-WINDOW GUARD: don't re-fire on the same thoughts. After an escalation
  // attempt (esp. a suppressed/tombstoned one) the window doesn't change — without
  // this the guard spins every tick, burning an embed + naming call to be skipped.
  // Only consider it if there's a NEW thought since the last attempt.
  const maxId = Math.max(...thoughts.map(t => t.id || 0));
  const lastId = parseInt(db.getMeta('rumination_last_id') || '0', 10);
  if (maxId <= lastId) return { ruminating: false, reason: 'no-new-thoughts', thoughts };
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
  // Mark this thought-window consumed FIRST (success OR suppression), so detect()
  // won't re-fire on the same stale thoughts next tick. This is what stops the
  // suppressed-escalation spin observed in the live log.
  try { const ids = (thoughts || []).map(t => t.id || 0); if (ids.length) db.setMeta('rumination_last_id', String(Math.max(...ids))); } catch {}
  let goal = null;
  try { goal = await nameFn(thoughts, userName); } catch (e) { console.error('[rumination] nameTheme failed:', e.message); }
  if (!goal || goal.length < 6) return null;
  const set = await focusLib.setFromText(`<focus>${goal}</focus>`);
  if (set) {
    console.log(`[rumination] escalated circling → focus #${set.focus.id}: ${goal.slice(0, 70)}`);
    // CIRCUIT BREAKER bookkeeping: record this escalation; if too many fired in the
    // window, the theme isn't escalation-resolvable — trip a long cooldown so we
    // stop respawning near-identical focuses on it.
    try {
      const now = Date.now();
      const arr = JSON.parse(db.getMeta('rumination_escalations') || '[]').filter(t => now - t < ESC_WINDOW_MS);
      arr.push(now);
      db.setMeta('rumination_escalations', JSON.stringify(arr));
      if (arr.length >= ESC_MAX) {
        db.setMeta('rumination_cooldown_until', String(now + ESC_BREAKER_COOLDOWN_MS));
        console.log(`[rumination] circuit breaker tripped: ${arr.length} escalations in ${Math.round(ESC_WINDOW_MS / 60000)}m on a sticky theme — suppressing escalation for ${Math.round(ESC_BREAKER_COOLDOWN_MS / 60000)}m`);
      }
    } catch (e) { console.error('[rumination] breaker bookkeeping failed:', e.message); }
  } else {
    // Spawn-gate suppressed it (theme tombstoned recently) — back off for 30 min so
    // we don't re-name + re-suppress on every new thought about the same dead theme.
    try { db.setMeta('rumination_cooldown_until', String(Date.now() + 30 * 60 * 1000)); } catch {}
  }
  return set;
}

// Is the circling a CAPABILITY DOUBT — re-litigating something the permissions table
// already settles ("I can't access external chats", "I don't have the ability to…")?
// Reuses the voice detector (same capability-denial patterns). Such a spiral must NOT
// be escalated to a focus — that legitimizes a false premise; it should be resolved.
function isCapabilityDoubt(thoughts) {
  return (thoughts || []).some(t => voice.isSelfDisclaimer(t.content || ''));
}

// Resolve a capability-doubt spiral instead of escalating it: consume the window,
// drop into a cooldown so it stops re-firing, and return ONE settled note (grounded
// in her granted capabilities) for the caller to surface — its new, non-doubting
// content also breaks the cosine spiral. The note is deliberately NOT a disclaimer,
// so it can never re-trip the voice guard or re-seed the loop.
function resolveCapabilityDoubt(thoughts) {
  try { const ids = (thoughts || []).map(t => t.id || 0); if (ids.length) db.setMeta('rumination_last_id', String(Math.max(...ids))); } catch {}
  try { db.setMeta('rumination_cooldown_until', String(Date.now() + 30 * 60 * 1000)); } catch {}
  return `I keep circling whether I can actually use the browser and chat sites — re-litigating it like it's unsettled. It isn't. I have my own browser and full web access; I can open and interact with sites and chats, and I already opened one. That's a settled capability, not an open question. Dropping it.`;
}

module.exports = { detect, escalate, nameTheme, recentFreeThoughts, isCapabilityDoubt, resolveCapabilityDoubt, K, THRESHOLD };
