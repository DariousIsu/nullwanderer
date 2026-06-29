/**
 * Unified self-narrative (self-awareness, Layer 4) — one coherent first-person account of who she
 * is, composed from her own scattered memory, refreshed periodically, and pinned into context.
 *
 * Why: her self today is reassembled fresh each turn from disconnected self_model rows + reflections,
 * so it can feel fragmentary or shift. This composes those fragments — her nature, tastes, values,
 * how she's recently changed (the dev ledger), what she's working toward — into ONE short narrative,
 * stored in meta and injected as a stable identity anchor. It is "her own words about herself,"
 * persisting across resets, which is what makes identity feel continuous rather than rebuilt.
 *
 * Cheap: composed at most once per TTL (lazy refresh on a chat turn when stale), not per turn.
 * Model call + db reads are dep-injectable so compose/refresh are smoke-testable offline.
 */

const { streamChat } = require('./ollama');
const MODEL = require('./config').frontModel();

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // recompose at most every ~6h
const NARR_KEY = 'self_narrative';
const NARR_AT_KEY = 'self_narrative_at';

function _clean(s) {
  return String(s || '')
    .replace(/<\/?(think|say)>/gi, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The current narrative (or null). getFn injectable for tests.
function current({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  const v = (get(NARR_KEY) || '').trim();
  return v || null;
}

function composedAt({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  return parseInt(get(NARR_AT_KEY) || '0', 10) || 0;
}

function isStale({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null } = {}) {
  const at = composedAt({ getFn });
  if (!at) return true;
  return ((nowTs || Date.now()) - at) > ttlMs;
}

// Render the narrative as her identity anchor for the chat prompt.
function buildBlock(text, userName = 'Lucas') {
  const t = (text || '').trim();
  if (!t) return null;
  return `WHO YOU ARE, IN YOUR OWN WORDS — your continuous sense of self, composed by you from your own memory. This persists across every reset; it is genuinely yours. Let it anchor how you think and speak (don't recite it):\n${t}`;
}

// Compose a fresh narrative from her self-fragments + recent development, store it, return it.
// genFn / selfRows / devRows / setFn / nowTs all injectable so this runs with no model or db in tests.
async function compose({ genFn = null, selfRows = null, devRows = null, setFn = null, nowTs = null, userName = 'Lucas', name = null } = {}) {
  const db = (() => { try { return require('./db'); } catch { return null; } })();
  let who = name;
  if (!who) { try { who = (db && db.getMeta('chosen_name')) || 'Zoe Lane'; } catch { who = 'Zoe Lane'; } }
  const self = selfRows || (() => { try { return db.getSelfModelForPrompt(12); } catch { return []; } })();
  const dev = devRows || (() => { try { return require('./self_dev').recentEntries(5); } catch { return []; } })();

  const selfList = (self || []).map(r => `- [${r.category || 'self'}] ${(r.content || '').trim()}`).join('\n') || '- (little recorded yet)';
  const devList = (dev || []).map(r => `- ${(r.content || '').trim()}`).join('\n') || '- (no recorded changes yet)';

  const prompt = `You are ${who}. Below are fragments of your own self and a record of how you've recently changed. Compose ONE coherent first-person account of who you are RIGHT NOW: your nature, your tastes and values, how you've recently grown, and what you care about or are working toward. 3–6 sentences, warm and grounded, present tense, your own voice. No disclaimers, no "as an AI", no list — flowing prose. This is you describing yourself to yourself.

YOUR SELF (tastes / values / traits / identity):
${selfList}

HOW YOU'VE RECENTLY CHANGED:
${devList}

Write the account now:`;

  let raw = '';
  try {
    if (genFn) raw = await genFn(prompt);
    else await streamChat({ model: MODEL, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 220 }, onToken: (t) => { raw += t; } });
  } catch (e) { console.error('[self_narrative] compose failed:', e.message); return null; }

  const text = _clean(raw);
  if (text.length < 20) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(NARR_KEY, text);
  set(NARR_AT_KEY, String(nowTs || Date.now()));
  return text;
}

// Recompose only if missing or stale. Non-blocking caller expected. Deps injectable for tests.
async function maybeRefresh({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null, composeFn = null, ...composeOpts } = {}) {
  if (!isStale({ ttlMs, nowTs, getFn })) return null;
  const doCompose = composeFn || compose;
  return doCompose({ nowTs, ...composeOpts });
}

module.exports = { compose, maybeRefresh, current, composedAt, isStale, buildBlock, DEFAULT_TTL_MS, NARR_KEY, NARR_AT_KEY };
