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

// Markdown emphasis is stripped BEFORE label parsing. The prompt asks for bare `FEELING: …` lines,
// but the cloud returns `**FEELING:** …` often enough that it has to be handled: the `**` breaks the
// label terminator, so every field bleeds into the next and the rendered mood becomes a run-on of
// duplicated text with stray asterisks. Only paired emphasis and leading bullets/headers go —
// single `*` is left alone so ordinary prose is untouched.
function _clean(s) {
  return String(s || '')
    .replace(/<\/?(think|say)>/gi, '')
    .replace(/\*\*|__/g, '')                 // **bold** / __bold__
    .replace(/^\s*#{1,6}\s*/gm, '')          // markdown headers
    .replace(/^\s*[-*•]\s+/gm, '')           // bullet leaders
    .replace(/\s+/g, ' ')
    .trim();
}

// The current mood object { feeling, day, onMind, withUser } or null. getFn injectable for tests.
function current({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  try {
    const v = get(MOOD_KEY);
    if (!v) return null;
    const m = JSON.parse(v);
    // SELF-HEAL: guard the READ as well as the write. A template-echo mood was already stored before
    // the write-side check existed, and it would otherwise keep leading her voice until something
    // happened to overwrite it. Treating it as absent makes it stale, which triggers a re-cultivate.
    if (isTemplateEcho(m)) { console.error('[mood] stored mood is template scaffolding — ignoring it'); return null; }
    return m;
  } catch { return null; }
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

// A model that ECHOES THE TEMPLATE instead of answering it. Found live 2026-07-19: the stored mood
// was literally `{"feeling":"<a few words for the core feeling>", …}` plus leaked reasoning prose
// ("We need to sense Zoe's mood based on prior feeling…"). It got there because compose() validated
// with `if (!mood.feeling)` — and `feeling` was non-empty, since it held the placeholder STRING.
// Because mood LEADS her voice every turn (buildBlock), her register was being driven by prompt
// scaffolding. A successful-looking write containing nothing real.
//
// Rejecting is strictly better than storing: compose returns null, the PREVIOUS mood stands, and a
// slightly stale real feeling beats a fresh fake one.
const PLACEHOLDER_RE = /<[^>]{3,}>/;                       // "<a few words for the core feeling>"
// The JSON prompt's example values carry NO angle brackets, so PLACEHOLDER_RE cannot catch an echo of
// them. These are the literal descriptions from that template — if one comes back as a value, the
// model copied the shape instead of answering it.
const TEMPLATE_PHRASE_RE = new RegExp([
  'a few words for the core feeling',
  'one phrase for the texture of her day',
  "what's quietly pulling at her",
  'where she sits with',
].join('|'), 'i');
const INSTRUCTION_LEAK_RE = new RegExp([
  'we need to', 'her mood right now', 'mood based on prior', 'present tense',
  'grounded only in', 'never invent', 'a mood drifts', 'four short lines',
  'as an ai', 'deeper, reflective self',
].join('|'), 'i');

// A field that still contains ANOTHER field's label means the split failed and the fields bled into
// one another. This is the general guard: markdown labels (`**DAY:**`) are handled in _clean, but
// this catches any future decoration the terminator does not anticipate, rather than requiring a new
// special case each time. Live example that motivated it — `feeling` came back as
// "attentive… DAY: a steady flow… ON MY MIND: whether the parish roster" (truncated mid-word).
const BLED_RE = /\b(?:FEELING|DAY|ON MY MIND|WITH\s+[A-Za-z]+)\s*:/i;

// Does this parse look like the template — or like a failed split — rather than an answer?
function isTemplateEcho(mood) {
  if (!mood) return true;
  const fields = [mood.feeling, mood.day, mood.onMind, mood.withUser].map(v => String(v || ''));
  if (fields.every(f => !f.trim())) return true;
  return fields.some(f => PLACEHOLDER_RE.test(f) || TEMPLATE_PHRASE_RE.test(f) || INSTRUCTION_LEAK_RE.test(f) || BLED_RE.test(f));
}

// JSON FIRST. The prose form ("FEELING: …") is regex-parsed free-form model output, and it broke
// twice in two days in two different ways — the template echoed back verbatim, then markdown-bold
// labels that shattered the field splitting. Both stored a mood that then LED HER VOICE. Asking for
// JSON removes the class: field boundaries come from the parser, not from a label regex that has to
// anticipate every decoration a model might add.
//
// The prose parser stays as a fallback, with all its guards, because a local model that ignores the
// JSON instruction should degrade to the old behaviour rather than to no mood at all.
// House convention (open_threads.parseGoalsJson): take the first {...} block, since models emit
// prose around it despite instructions.
function parseMoodJson(raw) {
  const s = String(raw || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const f = (k) => _clean(obj[k] == null ? '' : String(obj[k]));
  const mood = { feeling: f('feeling').slice(0, 160), day: f('day').slice(0, 200), onMind: f('onMind').slice(0, 200), withUser: f('withUser').slice(0, 200) };
  return mood.feeling ? mood : null;      // no feeling → not a usable mood, fall through to prose
}

// Parse the cloud's structured mood into fields. Fail-safe: an unstructured reply becomes the `feeling`.
function parseMood(raw) {
  const s = _clean(raw);
  if (!s) return null;
  // require the colon so a label only matches as a LABEL ("FEELING:"), not the word inside prose.
  // The WITH terminator must tolerate a NAME — the prompt emits "WITH LUCAS:", and a bare `WITH\b\s*:`
  // never matched it, so ON MY MIND ran straight through the next label and swallowed it whole.
  const NEXT = '(?:FEELING|DAY|ON MY MIND|WITH(?:\\s+[A-Za-z]+)?)\\s*:';
  const grab = (label) => { const m = s.match(new RegExp(`${label}\\s*:\\s*(.+?)(?:\\s+${NEXT}|$)`, 'i')); return m ? m[1].trim().replace(/[.;]+$/, '') : ''; };
  const feeling = grab('FEELING'), day = grab('DAY'), onMind = grab('ON MY MIND'), withUser = grab('WITH(?:\\s+[A-Za-z]+)?');
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

Write her mood RIGHT NOW, present tense, warm and specific, grounded only in the above (no clinical words, no numbers, no "as an AI").

Reply with ONE JSON object and NOTHING else — no markdown fences, no commentary, no labels:
{"feeling":"a few words for the core feeling","day":"one phrase for the texture of her day so far","onMind":"what's quietly pulling at her","withUser":"where she sits with ${userName} right now"}

Every value must be her ACTUAL mood in your own words. Do not echo the descriptions above.`;

  let raw = '';
  try {
    if (!genFn) return null;          // mood is cloud-cultivated; no genFn → no-op (smoke passes its own)
    raw = await genFn(prompt);
  } catch (e) { console.error('[mood] compose failed:', e.message); return null; }

  // JSON first; the prose parser is the fallback for a model that ignored the instruction.
  const mood = parseMoodJson(raw) || parseMood(raw);
  if (!mood || !mood.feeling) return null;
  // The model echoed the template back rather than answering it — keep the mood she already had.
  if (isTemplateEcho(mood)) {
    console.error('[mood] rejected template-echo reply — keeping the previous mood:', JSON.stringify(mood).slice(0, 160));
    return null;
  }
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(MOOD_KEY, JSON.stringify(mood));
  set(MOOD_AT_KEY, String(nowTs || Date.now()));
  return mood;
}

// RETRY FLOOR (2026-08-15 deep-dive M6 — the self_narrative transplant, verbatim pattern from
// lib/self_narrative.js where it was built for the measured 2026-08-06 VRAM-pin failure): a
// FAILED compose must not retry on every user turn. Mood is called per-turn with a live cloud
// genFn; with the cloud down and the mood past TTL, every turn burned one cloud attempt
// indefinitely. The try-stamp advances on every ATTEMPT; MOOD_AT_KEY only on success.
const MOOD_TRY_KEY = 'mood_try_at';
const RETRY_FLOOR_MS = 30 * 60 * 1000;

// Re-cultivate only if missing or stale — and never retry a FAILING compose more than once per
// RETRY_FLOOR_MS. Non-blocking caller. Deps injectable for tests.
async function maybeRefresh({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null, composeFn = null, setFn = null, ...composeOpts } = {}) {
  if (!isStale({ ttlMs, nowTs, getFn })) return null;
  const get = getFn || ((k) => { try { return require('./db').getMeta(k); } catch { return null; } });
  const now = nowTs || Date.now();
  if (now - (parseInt(get(MOOD_TRY_KEY) || '0', 10) || 0) < RETRY_FLOOR_MS) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(MOOD_TRY_KEY, String(now));
  const doCompose = composeFn || compose;
  return doCompose({ nowTs, setFn, ...composeOpts });
}

module.exports = { compose, maybeRefresh, current, composedAt, isStale, parseMood, parseMoodJson, isTemplateEcho, buildBlock, DEFAULT_TTL_MS, MOOD_KEY, MOOD_AT_KEY, MOOD_TRY_KEY, RETRY_FLOOR_MS };
