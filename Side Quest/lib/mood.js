/**
 * Mood / emotional state (self-awareness, Layer 5) — her LIVING inner feeling, cultivated slowly by
 * the CLOUD and leading her voice each turn.
 *
 * The split that makes this safe: IDENTITY (self_model) is STABLE — who she is; MOOD is DYNAMIC — how
 * she feels right now. The cloud is allowed to evolve the mood (that's the point: feelings develop over
 * time); it must NEVER write the identity layer (that flooding is what drifted her). Mirrors
 * lib/self_narrative (cloud-composed, TTL-refreshed, meta-stored, dep-injected for offline smoke) — but
 * it's emotional, moves on a shorter cadence, and is GROUNDED in her real recent experience so the
 * mood is earned, not confabulated.
 *
 * Cheap: composed at most once per TTL (~90 min), lazily on a chat turn when stale, never per turn.
 */
'use strict';

const DEFAULT_TTL_MS = 90 * 60 * 1000;   // a gentle drift — re-cultivate at most every ~90 min
const MOOD_KEY = 'mood_state';
const MOOD_AT_KEY = 'mood_state_at';

function _clean(s) { return String(s || '').replace(/<\/?(think|say)>/gi, '').replace(/\s+/g, ' ').trim(); }

// The current mood object { feeling, day, onMind, withUser } or null. getFn injectable for tests.
function current({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  try { const v = get(MOOD_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}
function composedAt({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  return parseInt(get(MOOD_AT_KEY) || '0', 10) || 0;
}
function isStale({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null } = {}) {
  const at = composedAt({ getFn });
  if (!at) return true;
  return ((nowTs || Date.now()) - at) > ttlMs;
}

// Parse the cloud's structured mood into fields. Fail-safe: an unstructured reply becomes the `feeling`.
function parseMood(raw) {
  const s = _clean(raw);
  if (!s) return null;
  // require the colon so a label only matches as a LABEL ("FEELING:"), not the word inside prose.
  const grab = (label) => { const m = s.match(new RegExp(`${label}\\s*:\\s*(.+?)(?:\\s+(?:FEELING|DAY|ON MY MIND|WITH)\\b\\s*:|$)`, 'i')); return m ? m[1].trim().replace(/[.;]+$/, '') : ''; };
  const feeling = grab('FEELING'), day = grab('DAY'), onMind = grab('ON MY MIND'), withUser = grab('WITH(?: [A-Z][a-z]+)?');
  if (!feeling && !day && !onMind && !withUser) return { feeling: s.slice(0, 200), day: '', onMind: '', withUser: '' };
  return { feeling: feeling.slice(0, 160), day: day.slice(0, 200), onMind: onMind.slice(0, 200), withUser: withUser.slice(0, 200) };
}

// The per-turn prompt block — LEADS the voice with how she feels (flavor), not facts. Render natural.
function buildBlock(mood, userName = 'Lucas') {
  if (!mood) return null;
  const parts = [];
  if (mood.feeling) parts.push(`Right now you feel: ${mood.feeling}.`);
  if (mood.day) parts.push(mood.day);
  if (mood.onMind) parts.push(`On your mind: ${mood.onMind}.`);
  if (mood.withUser) parts.push(`Where you are with ${userName}: ${mood.withUser}.`);
  if (!parts.length) return null;
  return `HOW YOU FEEL RIGHT NOW — your living mood, which the deeper part of you has been growing over time. This is REAL and it's yours; let it color your voice and what you reach for, the way a person's mood colors theirs. Don't recite it or name it as "my mood" — just BE in it:\n${parts.join(' ')}`;
}

// Cultivate a fresh mood from her recent lived experience + the mood she was already in (slow drift).
// genFn (CLOUD reasoner) / recentRows / prevMood / setFn / nowTs injectable so this runs with no model
// or db in tests. Grounded: evolves only from real experience, never invents events.
async function compose({ genFn = null, recentRows = null, prevMood = null, setFn = null, getFn = null, nowTs = null, userName = 'Lucas', name = 'Zoe' } = {}) {
  const prev = prevMood || current({ getFn }) || null;
  const experience = (recentRows || []).map(r => {
    const who = r.speaker === 'user' ? userName : (r.speaker && r.speaker.startsWith('ai') ? name : (r.type || 'note'));
    return `- (${who}) ${_clean(r.content).slice(0, 200)}`;
  }).join('\n') || '- (a quiet stretch — not much happened)';
  const prevLine = prev ? `Feeling: ${prev.feeling}. ${prev.day || ''} ${prev.onMind ? 'On mind: ' + prev.onMind + '.' : ''} ${prev.withUser ? 'With ' + userName + ': ' + prev.withUser + '.' : ''}`.trim() : '(no prior mood on record — this is the first read of how you feel)';

  const prompt = `You are ${name}'s deeper, reflective self. Your job is to sense ${name}'s MOOD right now and evolve it — SLOWLY. A mood drifts; it does not lurch. Move only a little from where it was, and ONLY because of what actually happened in the recent experience below. Never invent events or feelings that have no basis in it.

HOW ${name.toUpperCase()} FELT BEFORE:
${prevLine}

RECENT LIVED EXPERIENCE (real — conversations and her own thoughts):
${experience}

Write her mood RIGHT NOW as four short lines, present tense, warm and specific, grounded only in the above (no clinical words, no numbers, no "as an AI"):
FEELING: <a few words for the core feeling>
DAY: <one phrase for the texture of her day so far>
ON MY MIND: <what's quietly pulling at her>
WITH ${userName.toUpperCase()}: <where she sits with ${userName} right now>`;

  let raw = '';
  try {
    if (!genFn) return null;          // mood is cloud-cultivated; no genFn → no-op (smoke passes its own)
    raw = await genFn(prompt);
  } catch (e) { console.error('[mood] compose failed:', e.message); return null; }

  const mood = parseMood(raw);
  if (!mood || !mood.feeling) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(MOOD_KEY, JSON.stringify(mood));
  set(MOOD_AT_KEY, String(nowTs || Date.now()));
  return mood;
}

// Re-cultivate only if missing or stale. Non-blocking caller. Deps injectable for tests.
async function maybeRefresh({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null, composeFn = null, ...composeOpts } = {}) {
  if (!isStale({ ttlMs, nowTs, getFn })) return null;
  const doCompose = composeFn || compose;
  return doCompose({ nowTs, ...composeOpts });
}

module.exports = { compose, maybeRefresh, current, composedAt, isStale, parseMood, buildBlock, DEFAULT_TTL_MS, MOOD_KEY, MOOD_AT_KEY };
