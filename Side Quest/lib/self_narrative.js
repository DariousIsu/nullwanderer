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

const { streamCognition } = require('./ollama');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // recompose at most every ~6h
const NARR_KEY = 'self_narrative';
const NARR_AT_KEY = 'self_narrative_at';
const NARR_TRY_KEY = 'self_narrative_try_at';
// A FAILED compose must not retry on every chat turn. Measured (2026-08-06, the VRAM-pin hunt):
// the local front (gemma4:12b) answered this prompt on its reasoning channel, so the content came
// back empty → compose returned null → the AT stamp never advanced → the narrative sat 13 days
// stale and EVERY turn past the TTL re-ran the call — each one loading + 24h-pinning 8.4GB of
// VRAM for a compose that always failed. The floor bounds the damage of any future failure shape.
const RETRY_FLOOR_MS = 30 * 60 * 1000;

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

  let raw = '', thought = '';
  try {
    if (genFn) raw = await genFn(prompt);
    else {
      // CLOUD-FIRST (M2.5.3, the c22f4e0 tier): streamCognition routes to the warm cloud
      // subconscious model and only falls back to the local front if no cloud is reachable — so
      // an identity recompose never loads (and 24h-pins) the demoted local model. think:false +
      // the reasoning-channel salvage below cover the models that answer on the thinking channel
      // anyway (that silent-empty was why the narrative stopped refreshing).
      await streamCognition({
        messages: [{ role: 'user', content: prompt }],
        options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 220 },
        think: false, lane: 'idle',
        onToken: (t) => { raw += t; },
        onThinking: (t) => { thought += t; },
      });
      if (_clean(raw).length < 20 && _clean(thought).length >= 20) raw = thought;
    }
  } catch (e) { console.error('[self_narrative] compose failed:', e.message); return null; }

  const text = _clean(raw);
  if (text.length < 20) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(NARR_KEY, text);
  set(NARR_AT_KEY, String(nowTs || Date.now()));
  return text;
}

// Recompose only if missing or stale — and never retry a FAILING compose more than once per
// RETRY_FLOOR_MS (the try-stamp advances on every attempt; the AT stamp only on success).
// Non-blocking caller expected. Deps injectable for tests.
async function maybeRefresh({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null, composeFn = null, setFn = null, ...composeOpts } = {}) {
  if (!isStale({ ttlMs, nowTs, getFn })) return null;
  const get = getFn || ((k) => { try { return require('./db').getMeta(k); } catch { return null; } });
  const now = nowTs || Date.now();
  if (now - (parseInt(get(NARR_TRY_KEY) || '0', 10) || 0) < RETRY_FLOOR_MS) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(NARR_TRY_KEY, String(now));
  const doCompose = composeFn || compose;
  return doCompose({ nowTs, setFn, ...composeOpts });
}

module.exports = { compose, maybeRefresh, current, composedAt, isStale, buildBlock, DEFAULT_TTL_MS, RETRY_FLOOR_MS, NARR_KEY, NARR_AT_KEY, NARR_TRY_KEY };
