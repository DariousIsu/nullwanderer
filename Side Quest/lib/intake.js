/**
 * lib/intake.js — the INTAKE GATE: the systemic front door for work assignments.
 *
 * The disease this cures: project recognition lived in brittle regexes (operator.isDirectedTask,
 * condense.detectExpandOrder). They kept missing Lucas's real words ("spin up a red-tagged project on
 * generating contacts for those 5" → isDirectedTask=false → NO run created → she confabulated "I have
 * initiated it"). Three live non-executions in a row. A keyword list can never enumerate how a person
 * actually assigns work.
 *
 * The fix: ONE cloud comprehension pass decides — is this a sustained task, and HOW should it run
 * (discover new vs enrich what we hold, deep?, priority/red-tag, time budget, which subset) — and a
 * DETERMINISTIC router turns that into a real run. The cloud COMPREHENDS; the program CREATES the run
 * and only ACKs what it actually started (killing the confabulation). The regexes are demoted to a
 * fail-safe fallback (cloud down/over-budget → classify() returns null → caller uses the old detector).
 *
 * classify() is the cloud seam (deps.ask injectable). route() is PURE + fully offline-testable.
 */
'use strict';
const cloud = require('./cloud_logic');

// Cloud classification of one turn. Returns the decision object, or null (cloud down / invalid / over
// budget → caller falls back to the regex). Never throws.
async function classify(message, { recent = '', activeFocus = '', existingRecords = '', deps = {} } = {}) {
  const ask = deps.ask || cloud.ask;
  const s = String(message || '').trim();
  if (s.length < 6) return { isProject: false };   // trivially not a project; skip the cloud call
  // Intake is a mechanical classification → run it on the FAST non-reasoning model (gemma) with token
  // headroom, so a reasoning model can't spend the budget on hidden "thinking" and return empty JSON.
  const fastModel = (() => { try { return require('./models').getModelFor('editor', null); } catch { return null; } })();
  try {
    return await ask({
      task: 'work_intake', v: 3, model: fastModel, numPredict: 700,
      input: { user: s.slice(0, 800), recent: String(recent).slice(0, 400), active_task: String(activeFocus).slice(0, 160), existing_records: String(existingRecords).slice(0, 700) },
      want: 'You are the intake gate for Zoe. Decide whether the user is ASSIGNING A SUSTAINED TASK/PROJECT — work Zoe should carry out over time (research, gather, find, compile, generate, build, monitor, produce a deliverable) — as opposed to asking a question, a status check, or chatting. '
        + 'CRITICAL: isProject=false when the user asks to EXTRACT / PULL / LIST / SUMMARIZE / FIND something FROM a document they already gave you (phrases like "from the notes", "in the meeting notes", "out of this document", "from the transcript", "what I dropped/gave you", "on the canvas") — that is a ONE-SHOT extraction answered immediately by READING that document, NOT a sustained research project. Only "research/gather/find/compile X" about the OUTSIDE WORLD (not from a doc they handed you) is a project. '
        + 'Output ONLY JSON: {"isProject":true|false,"mode":"enrich"|"discover","target":"short — what to work on","facet":"specifically what to gather/produce","priority":"red"|"orange"|"yellow"|null,"deep":true|false,"budget":{"kind":"deadline"|"duration"|"none","value":"the deadline or duration text, else null"},"subset":"a named subset like \'the 5 most complete\', else null","clarify":["at most 2 SHORT questions, ONLY if genuinely ambiguous; else []"]}. '
        + 'mode="enrich" when it DEEPENS or EXTENDS research/records we ALREADY hold (refers to "those", "the 5", "the think tanks", an existing dossier/list/the ones we have); mode="discover" for brand-new research. '
        + 'CRITICAL: if the input includes EXISTING_RECORDS and the user\'s target topic or named organizations APPEAR in those existing records, choose mode="enrich" (we already have them — deepen/extend, do not start over). '
        + 'priority: ONLY for an explicit tag ("red tag"/"red-tagged"/"top priority"/"drop everything"→red; "orange"/"high"→orange; "yellow"/"when you can"→yellow); else null. '
        + 'deep:true when they ask for thorough/deep/exhaustive/comprehensive/"as much as you can". '
        + 'Be decisive. isProject=false for a plain question, a "how is X going" status check, or chat. Do NOT ask to clarify things you can reasonably infer.',
      validate: (raw) => {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no json' };
        try { const o = JSON.parse(m[0]); return (o && typeof o.isProject === 'boolean') ? { valid: true, value: o } : { valid: false, error: 'no isProject' }; }
        catch (e) { return { valid: false, error: e.message }; }
      },
      deps
    });
  } catch (e) { console.error('[intake] classify failed:', e.message); return null; }
}

// PURE: turn a decision into a concrete action for main.js. Fail-safe — null/!isProject → {action:'none'}.
//   action: 'enrich' | 'discover' | 'none'
function route(decision) {
  if (!decision || decision.isProject !== true) return { action: 'none' };
  const clean = (x, n = 200) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const facet = clean(decision.facet);
  const target = clean(decision.target);
  const deep = decision.deep === true;
  const priority = ['red', 'orange', 'yellow'].includes(decision.priority) ? decision.priority : null;
  const subset = clean(decision.subset, 80) || null;
  const budget = (decision.budget && decision.budget.kind && decision.budget.kind !== 'none')
    ? { kind: decision.budget.kind, value: clean(decision.budget.value, 60) } : null;
  const clarify = Array.isArray(decision.clarify) ? decision.clarify.map(q => clean(q, 120)).filter(Boolean).slice(0, 2) : [];
  const action = decision.mode === 'enrich' ? 'enrich' : 'discover';
  return { action, target, facet, deep, priority, subset, budget, clarify };
}

// "N most complete / top N" subset → the integer N, or null (so main.js can pick that many by completeness).
function subsetTopN(subset) {
  const s = String(subset || '').toLowerCase();
  if (!/\b(most complete|best|top|richest|deepest|fullest|strongest)\b/.test(s)) return null;
  const map = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  let m = s.match(/\b(\d{1,2})\b/); if (m) { const n = +m[1]; return (n > 0 && n <= 50) ? n : null; }
  m = s.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/); return m ? map[m[1]] : null;
}

module.exports = { classify, route, subsetTopN };
