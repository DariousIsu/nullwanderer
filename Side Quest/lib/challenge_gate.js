'use strict';
/*
 * lib/challenge_gate.js — THE ADVERSARIAL STEP (stage 4.5, 2026-09-04; merge map §"The adversarial
 * step, from Alpha", part 1): "The validator, a proposer-and-challenger review of the assembled
 * output. The challenger is a different model family from the workhorse that produced the output,
 * which is what makes the review adversarial rather than a self-check. Verdict, score and correction
 * notes on a schema; up to three iterations; auto-approve only when no challenger is available."
 *
 * The challenger ROLE already exists as a registry manifest (data/agents/challenger.toml, qwen3.5 —
 * a family no producer in the fleet uses). This module is the GATE that runs an assembled deliverable
 * through it and loops on the verdict. Every swarm plan that produces a deliverable ends here.
 *
 * PURE by construction: parseVerdict / decide / corrections take strings and return objects; runGate
 * takes `produce(corrections)` and `challenge(output)` injected, so the whole loop is offline-testable
 * with no model, no engine. The live producer is paper_finalize's section pass; the live challenger is
 * the challenger role dispatched through the executor machinery (main.js). P11's confidence levels
 * (lib/tier_law.CONFIDENCE) label the score; the schema is Alpha's validator verdict, character for
 * character (verdict / score / correction_notes[{area, issue, instruction}]).
 */

const MAX_ITERATIONS = 3;   // Alpha's cap: a third revision request PASSES WITH CAVEATS, never blocks.

// Parse the challenger's reply into the verdict schema. Tolerant of prose-before-JSON (the reasoning
// models emit it) and markdown fences. An UNPARSEABLE reply is NOT a block — it auto-approves with a
// note (a broken challenger must never wedge a deliverable; that is the whole auto-approve principle).
function parseVerdict(text) {
  const s = String(text || '');
  let obj = null;
  // first {...} block containing "verdict"; fall back to the first {...} at all
  const cands = s.match(/\{[\s\S]*?\}/g) || [];
  for (const c of cands) { if (/verdict/i.test(c)) { try { obj = JSON.parse(c); break; } catch {} } }
  if (!obj) { const m = s.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  if (!obj || typeof obj !== 'object') {
    return { verdict: 'approved', score: null, correction_notes: [], parsed: false,
             why: 'challenger reply unparseable — auto-approved (a broken challenger never blocks)' };
  }
  const v = String(obj.verdict || '').toLowerCase();
  const verdict = /revision|reject|revise|fail/.test(v) ? 'revision_needed' : 'approved';
  let score = Number(obj.score);
  if (!Number.isFinite(score)) score = null; else score = Math.max(0, Math.min(1, score));
  const notes = Array.isArray(obj.correction_notes) ? obj.correction_notes
    : (obj.correction_notes && typeof obj.correction_notes === 'object' ? [obj.correction_notes] : []);
  const correction_notes = notes.map((n) => (typeof n === 'string' ? { area: '', issue: n, instruction: '' }
    : { area: String((n && n.area) || ''), issue: String((n && n.issue) || ''), instruction: String((n && n.instruction) || '') }))
    .filter((n) => n.issue || n.instruction);
  return { verdict, score, correction_notes, parsed: true };
}

// P11's confidence label for a score (lib/tier_law.CONFIDENCE — one copy).
function label(score) { try { return require('./tier_law').confidenceLabel(score); } catch { return 'uncertain'; } }

/**
 * decide({ verdict, score, iteration, maxIterations, challengerAvailable }) → { action, label, why }
 *   action: 'approve' | 'revise' | 'pass_with_caveats'
 *   - no challenger available → approve (auto-approve principle)
 *   - approved → approve
 *   - revision_needed and iterations left → revise
 *   - revision_needed on the last allowed iteration → pass_with_caveats (Alpha: never block on the third)
 */
function decide({ verdict, score = null, iteration = 1, maxIterations = MAX_ITERATIONS, challengerAvailable = true } = {}) {
  const lab = label(score);
  if (!challengerAvailable) return { action: 'approve', label: lab, why: 'no challenger available — auto-approved' };
  if (verdict !== 'revision_needed') return { action: 'approve', label: lab, why: `challenger approved (${lab})` };
  if (iteration >= maxIterations) return { action: 'pass_with_caveats', label: lab, why: `revision still requested after ${maxIterations} iterations — passing with caveats` };
  return { action: 'revise', label: lab, why: `revision requested (iteration ${iteration}/${maxIterations})` };
}

// The compact correction block the producer folds into its next pass (Alpha: corrections return to
// the area agent for a full re-run). Empty string when there is nothing to fold.
function corrections(verdict) {
  const notes = (verdict && verdict.correction_notes) || [];
  if (!notes.length) return '';
  const lines = notes.map((n, i) => `${i + 1}. ${n.area ? `[${n.area}] ` : ''}${n.issue}${n.instruction ? ` → ${n.instruction}` : ''}`);
  return `The adversarial reviewer requested revisions — address each before finalizing:\n${lines.join('\n')}`;
}

/**
 * runGate({ task, produce, challenge, maxIterations, challengerAvailable }) → the loop.
 *   produce(correctionText|null) → { output, ...meta }  (the assembled deliverable; correctionText
 *                                    is null on the first pass, the fold block on a re-run)
 *   challenge(output, task)      → reply text (the challenger's verdict JSON), or null when absent
 * Returns { outcome, output, produced, verdict, iterations, history }.
 *   outcome: 'approved' | 'passed_with_caveats' | 'no_challenger'
 * The producer's first result is always kept; a revise re-runs it with the corrections folded in.
 */
async function runGate({ task = '', produce, challenge, maxIterations = MAX_ITERATIONS, challengerAvailable = true } = {}) {
  if (typeof produce !== 'function') throw new Error('runGate needs produce()');
  const history = [];
  let correctionText = null, produced = null, lastVerdict = null;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    produced = await produce(correctionText);
    const output = (produced && (produced.output != null ? produced.output : produced)) || '';
    const avail = challengerAvailable && typeof challenge === 'function';
    if (!avail) { history.push({ iteration, action: 'approve', why: 'no challenger' }); return { outcome: 'no_challenger', output, produced, verdict: null, iterations: iteration, history }; }
    let replyText = null;
    try { replyText = await challenge(output, task); } catch (e) { replyText = null; }
    if (replyText == null) { history.push({ iteration, action: 'approve', why: 'challenger did not answer — auto-approved' }); return { outcome: 'no_challenger', output, produced, verdict: null, iterations: iteration, history }; }
    const verdict = parseVerdict(replyText);
    lastVerdict = verdict;
    const d = decide({ verdict: verdict.verdict, score: verdict.score, iteration, maxIterations, challengerAvailable: true });
    history.push({ iteration, action: d.action, label: d.label, score: verdict.score, why: d.why, notes: verdict.correction_notes.length });
    if (d.action === 'approve') return { outcome: 'approved', output, produced, verdict, iterations: iteration, history };
    if (d.action === 'pass_with_caveats') return { outcome: 'passed_with_caveats', output, produced, verdict, iterations: iteration, history };
    correctionText = corrections(verdict);   // revise → fold and loop
  }
  const output = (produced && (produced.output != null ? produced.output : produced)) || '';
  return { outcome: 'passed_with_caveats', output, produced, verdict: lastVerdict, iterations: maxIterations, history };
}

module.exports = { MAX_ITERATIONS, parseVerdict, label, decide, corrections, runGate };
