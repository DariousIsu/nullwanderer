/**
 * Cloud-drafted, locally-voiced answers (Front/Cortex) — "cloud THINKS, local SPEAKS" applied to the
 * ANSWER itself, for grounding-critical turns.
 *
 * Why: her chat replies run on the local 24B (Dans), which reliably carries her VOICE but
 * inconsistently OBEYS injected grounding — so on grounding-critical turns it confabulates over the
 * real context (e.g. narrating the plot it remembers instead of the captions it's actually seeing,
 * or reciting its self-narrative to "what are you watching?"). Directives alone hit the 24B's ceiling.
 *
 * Fix: when a turn MUST be grounded, the cloud drafts the SUBSTANCE of the correct answer (strictly
 * from the supplied grounding), and the front model just VOICES it — rephrase in her words, add no
 * facts. Rephrasing a given answer is far more reliable than grounding from scratch. Fail-safe: cloud
 * down / no draft → null → normal local flow. Deps-injected → offline smoke-testable.
 */
'use strict';
const cloud = require('./cloud_logic');
const models = require('./models');
const { complete } = require('./ollama');

function draftModel() {
  try { return require('./db').getMeta('model.drafter') || models.getModelFor('editor', null) || models.getModelFor('search', null) || 'gemma4:31b'; }
  catch { return 'gemma4:31b'; }
}

// A cloud complete bound to the drafter (utility) model — passed to cloud_logic.ask as deps.complete
// so the call is still cached/budgeted/TRACED, but on the fast utility model. Returns {text, model}.
async function _draftComplete(messages, opts = {}) {
  const src = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!src) return null;
  const model = draftModel();
  const text = await complete({
    model, messages, base: src.base,
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: opts.num_predict || 400 }
  });
  return { text: text || '', model };
}

// Draft the grounded answer SUBSTANCE (not her voice) for `userMessage`, built strictly from
// `grounding`. Returns the draft string, or null (→ caller uses the normal local flow).
async function draft({ userMessage, grounding, kind = 'general', deps = {} } = {}) {
  if (!userMessage || !grounding || !String(grounding).trim()) return null;
  const askFn = deps.ask || cloud.ask;
  const want = 'Output ONLY the substance of the correct answer, in 1-3 plain sentences, grounded '
    + 'STRICTLY in the GROUNDING below. No first-person voice, no preamble, no quotes, no labels. If '
    + 'the grounding does not actually answer the question, state exactly what IS known from it and that '
    + 'the rest is unclear. NEVER add facts, names, or specifics beyond the grounding.';
  let out = null;
  try {
    out = await askFn({
      task: 'answer_draft_' + kind, v: 1,
      input: { question: String(userMessage).slice(0, 800), grounding: String(grounding).slice(0, 4000) },
      want,
      validate: (raw) => {
        const t = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
        return t.length > 8 ? { valid: true, value: t } : { valid: false, error: 'draft too short' };
      },
      // skipBudget: a grounding-critical answer draft is USER-FACING reliability, not optional
      // background curation — it must NOT be silently skipped when the shared daily cloud cap is hit
      // (that's exactly when confabulation would creep back). Still cached + traced.
      deps: { complete: deps.complete || _draftComplete, skipBudget: true }
    });
  } catch (e) { console.error('[answer_draft] failed:', e.message); return null; }
  return (typeof out === 'string' && out.trim()) ? out.trim() : null;
}

// Assemble the grounding for a factual / shared-history turn from what the turn already retrieved
// (knowledge block + relevant past turns). Returns '' when there isn't enough REAL grounding — the
// caller then uses the normal flow (general knowledge from training, or the admit-the-gap directive)
// rather than drafting from thin air. Pure → testable; the >40-char floor keeps thin blocks out.
function factualGrounding({ knowledgeBlock = null, pastTurns = [] } = {}) {
  const parts = [];
  if (knowledgeBlock && String(knowledgeBlock).trim()) parts.push(String(knowledgeBlock).trim());
  const pt = (pastTurns || []).slice(0, 4)
    .map(t => `- ${(t && t.speaker) || ''}: ${String((t && t.content) || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter(l => l.length > 6);
  if (pt.length) parts.push('Relevant past conversation:\n' + pt.join('\n'));
  const g = parts.join('\n\n').slice(0, 4000);
  return g.trim().length > 40 ? g : '';
}

// The block that makes the front model VOICE the draft (rephrase as her, no new facts).
function buildVoiceBlock(draftText, userName = 'Lucas') {
  return `[ANSWER TO GIVE ${userName} — this is the accurate, grounded answer. Say THIS in your own voice, `
    + `naturally and briefly; rephrase it as you, but do NOT add any facts, names, or details beyond it, `
    + `and do NOT contradict it:\n${draftText}]`;
}

module.exports = { draft, buildVoiceBlock, factualGrounding, draftModel, _draftComplete };
