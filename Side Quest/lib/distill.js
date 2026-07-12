/**
 * Context distillation (Front/Cortex architecture, Phase 1) — stop drowning the front model.
 *
 * Every chat turn injects a firehose (retrieved knowledge, past turns, recent thoughts/readings,
 * open threads, positions, reflections…). A local model chokes on it → flat, off-voice replies.
 * This routes the BULKY VARIABLE context through a fast cloud "utility" model that returns a TIGHT
 * BRIEF — only what bears on THIS turn — which the front model then voices from. Anchors (awareness,
 * persona, self-narrative, protocols) are NOT distilled; they stay verbatim.
 *
 * Principle: cloud THINKS (distills), local SPEAKS. The distiller emits a brief (facts+guidance),
 * never her words. Every call flows through cloud_logic.ask → cached, budgeted, and TRACED as
 * training data (cloud-think → local-voice pairs). Fail-safe: cloud down/error → null → caller uses
 * the full local context unchanged. Deps injectable → fully offline-testable.
 */

'use strict';
const cloud = require('./cloud_logic');
const models = require('./models');
const { complete } = require('./ollama');
const db = require('./db');

// Raised: distillation was compressing normal conversation, stripping her interior + the long arc
// (the cohesion loss). Dans's 8k window comfortably holds a rich conversational context, so only
// distill when the bulky context is GENUINELY heavy; let ordinary turns keep the full thread.
const DEFAULT_MIN_CONTEXT = 3500;   // chars of bulky context below which a turn keeps full rich context

function mode() { try { return (db.getMeta('distill.mode') || 'auto').trim(); } catch { return 'auto'; } }
function minContextChars() { try { return parseInt(db.getMeta('distill.minContextChars') || '', 10) || DEFAULT_MIN_CONTEXT; } catch { return DEFAULT_MIN_CONTEXT; } }

// The distiller cloud model (utility tier — fast). Configurable; defaults to the proven gemma4:31b.
function distillerModel() {
  try { return db.getMeta('model.distiller') || models.getModelFor('distiller', null) || models.getModelFor('search', null) || 'gemma4:31b-cloud'; }
  catch { return 'gemma4:31b-cloud'; }
}

// A cloud complete bound to the distiller model (passed to cloud_logic.ask as deps.complete so the
// trace/cache/budget still apply but the model is the fast utility one, not the curator/reasoner).
async function _distillComplete(messages, opts = {}) {
  const src = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!src) return null;
  const model = distillerModel();
  const text = await complete({
    model, messages, base: src.base,
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: opts.num_predict || 600 }
  });
  return { text: text || '', model };   // cloud_logic.ask reads result.text — must return {text, model}
}

// Pack the bulky variable blocks into ONE capped string for the distiller.
function _packContext({ knowledge, monologue = [], readings = [], pastTurns = [], threads = [], commitments = [], reflections = [] } = {}) {
  const parts = [];
  if (knowledge && String(knowledge).trim()) parts.push('MEMORY / KNOWLEDGE:\n' + String(knowledge).slice(0, 2500));
  const fmt = (arr, label, n, len) => {
    const a = (arr || []).slice(-n).map(x => '• ' + String((x && x.content) || x || '').replace(/\s+/g, ' ').slice(0, len)).filter(s => s.length > 2);
    if (a.length) parts.push(label + ':\n' + a.join('\n'));
  };
  fmt(pastTurns, 'RELEVANT PAST TURNS', 4, 240);
  fmt(monologue, 'RECENT THOUGHTS', 4, 240);
  fmt(readings, 'THINGS YOU READ ON YOUR OWN', 2, 240);
  fmt(threads, 'OPEN THREADS', 3, 160);
  fmt(commitments, 'POSITIONS YOU HAVE TAKEN', 4, 160);
  fmt(reflections, 'NOTES TO SELF', 3, 200);
  return parts.join('\n\n');
}

function contextSize(blocks) { return _packContext(blocks).length; }

// Should we distill THIS turn? auto = only heavy turns; always = anything non-trivial; off = never.
function shouldDistill(blocks) {
  const m = mode();
  if (m === 'off') return false;
  const size = contextSize(blocks);
  if (m === 'always') return size > 200;
  return size >= minContextChars();   // auto
}

// Distill the bulky context into a tight brief for THIS user turn. Returns the brief string, or
// null (→ caller keeps the full context). deps.ask / deps.complete injectable for tests.
async function distill({ userMessage, blocks, deps = {} } = {}) {
  if (!userMessage || !String(userMessage).trim()) return null;
  const inputStr = _packContext(blocks || {});
  if (!inputStr) return null;
  const askFn = deps.ask || cloud.ask;
  const want = 'Output ONLY a tight brief — no preamble, no JSON, no quotes. 4–8 short bullet lines '
    + 'capturing ONLY what is relevant to answering the user\'s message right now: the few facts, '
    + 'memories, or positions that matter; the user\'s actual ask; and one short tone cue. Omit '
    + 'everything irrelevant. Do NOT write the reply itself and do NOT use first-person voice — '
    + 'this is a brief FOR the assistant, not the answer.';
  let brief = null;
  try {
    brief = await askFn({
      task: 'distill_context', v: 1,
      input: { user: String(userMessage).slice(0, 800), context: inputStr },
      want,
      validate: (raw) => {
        const t = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
        return t.length > 15 ? { valid: true, value: t } : { valid: false, error: 'brief too short' };
      },
      deps: { complete: deps.complete || _distillComplete }
    });
  } catch (e) { console.error('[distill] failed:', e.message); return null; }
  return (typeof brief === 'string' && brief.trim()) ? brief.trim() : null;
}

module.exports = { distill, shouldDistill, contextSize, mode, distillerModel, _packContext };
