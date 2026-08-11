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

const MODEL = config.importanceModel();
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
      // A single 1–10 score over short text — its own CLOUD model (gemma4:31b-cloud), so num_ctx
      // stays small and nothing reloads locally. NB: gpt-oss:20b-cloud was tried here and returned
      // EMPTY at num_predict 4/16/64 even with think:false (its output never reaches the content
      // channel via streamChat) → score silently defaulted to 5 every time. gemma4:31b-cloud emits
      // the integer directly ("9" in 336ms). think:false kept (harmless; direct output either way).
      options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 4 },
      think: false,
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

// ── DOCUMENT IMPORTANCE (Spine 4 / C1 — docs/INTEGRATED_BUILD_TRACK_2026-08-10.md §C1) ──────────────────────
// The CHEAP, DETERMINISTIC analog of score() for the doc_store LANDING. score() is model-assisted and tuned
// for SHORT thoughts/readings; documents land at ~600/day (the browser_download web-capture flood is ~76% of
// that), so a per-doc model call is both unaffordable and unnecessary — a document's significance is legible
// from its SHAPE. Source/kind sets the base; length modulates; the bulk flood scores LOW so the downstream
// consumers (promotion triage in C2, the reflection trigger in C3) can favor deliverables/meetings over
// scraped pages. PURE, no I/O, no model call. Returns 1..10 (same scale as score()).
const _DOC_BASE = {
  deliverable: 8, research: 8,
  meeting: 8, meeting_transcript: 7,
  conversation: 6,
  canvas_drop: 5, notes: 5, media_watch: 5,
  newsletter: 3, news: 3,
  browser_download: 2,   // the flood — legible-low by shape, no inference spent on it
};
function scoreDocument({ source = null, body = '', title = null, origin = null } = {}) {
  const src = String(source || '').toLowerCase().trim();
  let s = _DOC_BASE[src] != null ? _DOC_BASE[src] : 5;   // default = an ordinary document
  const len = String(body || '').trim().length;
  if (len < 200) s -= 2;                 // a thin stub can't be weighty (score()'s <25 guard, doc-scaled)
  else if (len > 8000) s += 1;           // a substantial, worked document
  // A SYNTHESIZED deliverable/research (origin===null — derived from many pages, not fetched from one) is
  // higher signal than a raw fetched page; a browser_download WITH an origin stays bulk.
  if ((src === 'research' || src === 'deliverable') && !origin) s += 1;
  return clamp(Math.round(s));
}

module.exports = { score, quickScore, parseScore, scoreDocument, DEFAULT_SCORE };
