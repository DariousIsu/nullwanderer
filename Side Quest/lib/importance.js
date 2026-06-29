/**
 * Importance ("poignancy") scoring — Generative Agents (Park et al. 2023).
 *
 * Each thought/reading gets a 1–10 significance score. Two consumers:
 *   • the heartbeat SURFACING GATE — don't interrupt Lucas with trivia (only speak
 *     when the candidate utterance scores ≥ a threshold), the direct noise-killer;
 *   • the Phase-D retrieval scorer — importance is one of recency×relevance×
 *     importance, so high-signal memories outrank idle noticing.
 *
 * Cost control: a deterministic fast path returns without any model call for the
 * obvious-trivial cases (empty, very short, silence-essay filler, bare openers),
 * and results are cached by normalized signature so identical text is scored once.
 * Only genuinely ambiguous text reaches the (tiny, num_predict≈4) LLM call.
 */

const { streamChat } = require('./ollama');
const blackboard = require('./blackboard');
const config = require('./config');

const MODEL = config.extractionModel();
const DEFAULT_SCORE = 5;
const CACHE_MAX = 500;
const _cache = new Map(); // signature → score

// Trivial-filler patterns → score low without a model call. Kept deliberately
// small (the silence-essay regexes already live in monologue.js); this is just a
// cheap guard so atmosphere/openers never cost an inference.
const TRIVIAL_RE = [
  /^\s*(okay|alright|well|hmm+|so|anyway|right)\b[\s.,…-]*$/i,
  /\bthe (silence|quiet|emptiness|stillness)\b/i,
  /\b(dust motes|pale amber|fading light|sepia)\b/i
];

function clamp(n) { return Math.max(1, Math.min(10, n)); }

// Parse the model's reply into an int 1–10. Exported for deterministic testing.
function parseScore(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(?:10|[1-9])/); // first 1..10 token
  if (!m) return null;
  return clamp(parseInt(m[0], 10));
}

// The no-model fast path. Returns a score, or null meaning "ask the model".
function quickScore(text) {
  const t = (text || '').trim();
  if (!t) return 1;
  if (/^skip\.?$/i.test(t)) return 1;
  if (t.length < 25) return 2;                     // a fragment can't be weighty
  for (const re of TRIVIAL_RE) if (re.test(t)) return 2;
  return null;                                     // needs the model
}

function _cachePut(sig, score) {
  if (!sig) return;
  if (_cache.size >= CACHE_MAX) { const k = _cache.keys().next().value; _cache.delete(k); }
  _cache.set(sig, score);
}

/**
 * Score `text` 1–10. Async (may call the model). `userName` only flavors the
 * prompt. Never throws — returns DEFAULT_SCORE on any model/parse failure so a
 * scoring hiccup never blocks the loop.
 */
async function score(text, { userName = 'them', kind = 'thought' } = {}) {
  const quick = quickScore(text);
  if (quick != null) return quick;

  const sig = blackboard.signature(text);
  if (sig && _cache.has(sig)) return _cache.get(sig);

  const subject = kind === 'reading'
    ? `something the companion read on its own`
    : `a private thought of ${userName}'s companion`;
  const messages = [{
    role: 'user',
    content: `On a scale of 1 to 10, rate the SIGNIFICANCE of ${subject} below — 1 = purely mundane (idle noticing, small talk, atmosphere), 5 = a real but ordinary point, 10 = a key insight, an important decision, or something urgent/weighty to its goals and understanding of ${userName}.\n\n"${String(text).slice(0, 500)}"\n\nReply with ONLY the integer (1-10).`
  }];

  let raw = '';
  try {
    await streamChat({
      model: MODEL,
      messages,
      // num_ctx MUST match every other call site (8192). A different ctx forces
      // Ollama to reload the 17GB model on the 20GB card → reload thrash/hang.
      options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 4 },
      onToken: (tk) => { raw += tk; }
    });
  } catch (e) {
    console.error('[importance] score call failed:', e.message);
    return DEFAULT_SCORE;
  }

  const parsed = parseScore(raw);
  const final = parsed == null ? DEFAULT_SCORE : parsed;
  _cachePut(sig, final);
  return final;
}

module.exports = { score, quickScore, parseScore, DEFAULT_SCORE };
