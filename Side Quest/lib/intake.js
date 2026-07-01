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

// ─── Slice 2 (object-memory): the DECOMPOSITION front door ───────────────────
// Generalizes this gate from "is this a project + which mode" into the full parse:
// utterance → {objects, relations, intent, constraints}. Every content token sorts into ONE bucket
// (object / constraint-binder / intent-action) — that sort replaces the pile of per-scenario recognizers.
// Spec: docs/SLICE2_DECOMPOSITION_SPEC.md. 2a = the parse contract + PURE route, offline-tested, NO wiring.
// Object types + relation predicates are Echo-native (config.toml [graph]) so the plan resolves cleanly.
const INTENTS = ['research', 'monitor', 'extract_from_doc', 'schedule', 'answer', 'status', 'stop', 'expand', 'chat'];
const ENTITY_TYPES = ['person', 'organization', 'place', 'bill', 'committee', 'government_body', 'event', 'document', 'claim', 'concept'];
const CONSTRAINT_KINDS = ['temporal', 'speaker', 'location', 'other'];

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

// DECOMPOSE one utterance into the {objects, relations, intent, constraints} plan (the cloud seam).
// Returns the raw parse object, or null (cloud down / invalid → caller falls back to classify()/regex).
// Never throws. deps.ask injectable. Runs on the FAST model with headroom (same reason as classify).
async function decompose(message, { recent = '', activeFocus = '', existingRecords = '', deps = {} } = {}) {
  const ask = deps.ask || cloud.ask;
  const s = String(message || '').trim();
  if (s.length < 6) return { intent: 'chat', objects: [], relations: [], constraints: [], deliverable: null, clarify: [] };
  const fastModel = (() => { try { return require('./models').getModelFor('editor', null); } catch { return null; } })();
  try {
    return await ask({
      task: 'decompose', v: 1, model: fastModel, numPredict: 900,
      input: { user: s.slice(0, 900), recent: String(recent).slice(0, 400), active_task: String(activeFocus).slice(0, 160), existing_records: String(existingRecords).slice(0, 700) },
      want: 'You are Zoe\'s decomposition front door. Parse ONE user utterance into a structured plan. Sort every meaningful token into EXACTLY ONE bucket:\n'
        + '1) OBJECTS — things to look up or act on (a person, org, place, bill, committee, government_body, event, document, claim, concept). op="resolve" if we likely already hold it, op="create" if it is new. salient=true for the ones central to the request. Use the MOST COMPLETE identifier for the mention (resolve "his team"/"the meeting"/"they" to what they refer to — never leave a dangling pronoun).\n'
        + '2) CONSTRAINTS — binders that FILTER an object but are NOT themselves lookups: kind="temporal" (e.g. "tomorrow","last week"), "speaker" (who is talking / who it is for, e.g. "we","I"), "location", or "other". `binds` names which object mention it constrains.\n'
        + '3) INTENT — the ONE action the user wants, from: research (a sustained gather/find/compile/build/produce-a-deliverable task about the OUTSIDE world) | monitor (watch/alert over time) | extract_from_doc (pull/list/summarize/find FROM a document they already gave you — "from the notes/transcript/what I dropped/on the canvas") | schedule (calendar create/change) | answer (a plain question) | status (how is X going) | stop (halt a running task) | expand (extend/deepen an existing task) | chat (social).\n'
        + 'Also give `deliverable` (short phrase, e.g. "prep sheet", when a rendered artifact is wanted, else null) and `relations` between objects using a predicate verb (e.g. attends, works_for, about, scheduled_for, member_of, located_in, or a legislative one like AMENDS/CITES).\n'
        + 'BIAS TOWARD CLARIFYING: if the intent OR any salient object is genuinely ambiguous (which person? which meeting? unclear what is wanted), put up to 3 SHORT questions in `clarify` — Lucas would rather answer an extra question than get a wrong answer. Do NOT ask about things you can reasonably infer.\n'
        + 'Output ONLY JSON: {"intent":"...","objects":[{"mention":"...","type":"person|organization|place|bill|committee|government_body|event|document|claim|concept","op":"resolve|create","salient":true|false}],"relations":[{"source":"mention","type":"predicate","target":"mention"}],"constraints":[{"kind":"temporal|speaker|location|other","value":"...","binds":"mention or null"}],"deliverable":"phrase or null","clarify":["..."]}',
      validate: (raw) => {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no json' };
        try { const o = JSON.parse(m[0]); return (o && typeof o.intent === 'string') ? { valid: true, value: o } : { valid: false, error: 'no intent' }; }
        catch (e) { return { valid: false, error: e.message }; }
      },
      deps
    });
  } catch (e) { console.error('[decompose] failed:', e.message); return null; }
}

// PURE: normalize a raw parse into a safe plan for main.js. Fail-safe — null/invalid → an inert chat plan
// (never fires an action on a bad parse). Unknown intent → 'answer' (respond, don't trigger heavy machinery).
function routeDecomposition(parsed) {
  const empty = { ok: false, intent: 'chat', objects: [], relations: [], constraints: [], deliverable: null, clarify: [] };
  if (!parsed || typeof parsed !== 'object' || typeof parsed.intent !== 'string') return empty;
  const clean = (x, n = 200) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const intent = INTENTS.includes(parsed.intent) ? parsed.intent : 'answer';
  const objects = (Array.isArray(parsed.objects) ? parsed.objects : []).map(o => {
    const mention = clean(o && o.mention, 120);
    if (!mention) return null;
    const type = ENTITY_TYPES.includes(o && o.type) ? o.type : null;
    return { mention, type, op: (o && o.op === 'create') ? 'create' : 'resolve', salient: (o && o.salient === true) };
  }).filter(Boolean);
  const relations = (Array.isArray(parsed.relations) ? parsed.relations : []).map(r => {
    const source = clean(r && r.source, 120), type = clean(r && r.type, 40), target = clean(r && r.target, 120);
    return (source && type && target) ? { source, type, target } : null;
  }).filter(Boolean);
  const constraints = (Array.isArray(parsed.constraints) ? parsed.constraints : []).map(c => {
    const value = clean(c && c.value, 120);
    if (!value) return null;
    const kind = CONSTRAINT_KINDS.includes(c && c.kind) ? c.kind : 'other';
    const binds = clean(c && c.binds, 120) || null;
    return { kind, value, binds };
  }).filter(Boolean);
  const deliverable = clean(parsed.deliverable, 80) || null;
  // Bias toward clarifying: allow up to 3 (vs intake's 2) — an extra question beats a wrong answer.
  const clarify = Array.isArray(parsed.clarify) ? parsed.clarify.map(q => clean(q, 120)).filter(Boolean).slice(0, 3) : [];
  return { ok: true, intent, objects, relations, constraints, deliverable, clarify };
}

// The salient objects a plan should resolve first (the Slice-1 object pull consumes these in 2b).
function salientTargets(plan) {
  return (plan && Array.isArray(plan.objects) ? plan.objects : []).filter(o => o.salient && o.op === 'resolve');
}

module.exports = { classify, route, subsetTopN, decompose, routeDecomposition, salientTargets, INTENTS, ENTITY_TYPES };
