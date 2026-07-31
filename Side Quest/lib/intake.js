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
        + 'Output ONLY JSON: {"isProject":true|false,"kind":"entity"|"topical"|"forecast"|"argument","shape":"profile"|"discover"|"comparables"|"enrich","anchor":"the REFERENCE entity for a comparables task (the X in \'like X\'), else null","mode":"enrich"|"discover","target":"short — what to work on","facet":"specifically what to gather/produce","priority":"red"|"orange"|"yellow"|null,"deep":true|false,"budget":{"kind":"deadline"|"duration"|"none","value":"the deadline or duration text, else null"},"subset":"a named subset like \'the 5 most complete\', else null","clarify":["at most 2 SHORT questions, ONLY if genuinely ambiguous; else []"]}. '
        + 'kind is the RESEARCH TYPE — pick EXACTLY one (this decides which machine runs, so be careful): '
        + '"forecast" = the user wants a PREDICTION or ESTIMATE — "what will happen", "predict", "estimate", "odds/likelihood/chance of", "who will win", "will X happen", "forecast", "project/model the outcome", "what do you think happens with X". '
        + '"entity" = find or profile specific PEOPLE or ORGANIZATIONS, or gather CONTACTS / a roster / a dossier ("find AI companies", "profile Senator Y", "contacts for those orgs", "who are the players in X"). '
        + '"topical" = understand a SUBJECT or QUESTION — a briefing, background, analysis, or explainer on a topic or event ("brief me on the Strait of Hormuz situation", "research the state of AI policy", "what\'s going on with X"). This is the DEFAULT for research that is NOT about compiling a roster of people/orgs and is NOT a prediction. '
        + '"argument" = the user wants a CASE BUILT AND DEFENDED, not a neutral explainer — an op-ed, a position piece, a persuasive brief, "make the case that X", "argue that X", "I need to convince Y of X", "build the argument for X". The tell is that there is a CLAIM to defend and someone who will push back. If the user just wants to understand a subject, that is "topical"; if they want a specific claim to survive a sceptic, that is "argument". '
        + 'CRITICAL: do NOT default to "entity" — a request to understand a TOPIC, predict an OUTCOME, or defend a CLAIM is topical/forecast/argument, NOT a contact-gathering run. Only choose "entity" when the deliverable really is a set of named people/orgs (with their details/contacts). '
        + 'shape/anchor below apply ONLY when kind="entity" (for topical/forecast set shape=null). '
        + 'shape is the RUN SHAPE and it decides how an ENTITY run is scoped — pick EXACTLY one: '
        + '"profile" = a deep brief/dossier on a SPECIFIC named entity ("profile X", "background on Senator Y", "everything on Acme Corp") — the run is BOUNDED to that entity and target = that entity. '
        + '"discover" = find/list entities matching CRITERIA with no reference entity ("find AI datacenter companies in Texas", "identify energy think tanks") — OPEN; target = the criteria. '
        + '"comparables" = find entities LIKE / SIMILAR TO / competitors of a named entity ("companies similar to Emergence Water", "orgs like the Rainey Center", "Acme\'s competitors") — this is OPEN DISCOVERY, and the named entity is only a REFERENCE, NOT the thing to profile: set anchor = that entity ("Emergence Water") and target = the discovery description ("companies similar to Emergence Water"). Do NOT profile the anchor. '
        + '"enrich" = deepen/extend records we ALREADY hold ("more contacts for those 5", "flesh out the think-tank list"). '
        + 'mode MUST agree with shape: mode="enrich" iff shape="enrich"; otherwise mode="discover". '
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
  // RUN SHAPE (the systemic signal that drives scope+cap+termination). Validated to the known set, else null
  // → main.js falls back to the isConcreteTarget regex. anchor = the REFERENCE entity for a comparables run.
  const shape = ['profile', 'discover', 'comparables', 'enrich'].includes(decision.shape) ? decision.shape : null;
  const anchor = clean(decision.anchor, 120) || null;
  // KIND (the top-level research TYPE, above shape) — drives which subsystem runs:
  //   'entity'   = find/profile PEOPLE or ORGS + gather contacts (the Puller path; shape lives HERE).
  //   'topical'  = understand a SUBJECT/QUESTION → a researched brief (NO contact hunting).
  //   'forecast' = predict/estimate/"what will happen"/odds → run a forecast.
  //   'argument' = BUILD AND DEFEND A CASE (op-ed, brief, position) → research driven by where the
  //                case is weakest, against a named hostile reader. Narrower than topical on purpose:
  //                topical explains a subject neutrally, argument defends a claim under attack.
  // Default 'entity' only when the cloud didn't classify (regex/cloud-down fallback = prior behavior).
  const kind = ['entity', 'topical', 'forecast', 'argument'].includes(decision.kind) ? decision.kind : 'entity';
  // action agrees with shape when we have one (shape='enrich' ⇒ enrich); else fall back to the mode field.
  const action = (shape === 'enrich' || (!shape && decision.mode === 'enrich')) ? 'enrich' : 'discover';
  return { action, kind, shape, anchor, target, facet, deep, priority, subset, budget, clarify };
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
        + '   ⭐ DECOMPOSE COMPOUND NAMES. When a name CONTAINS other distinct named objects, emit the WHOLE **and** each embedded object as its own object, then connect them with relations — do not collapse them into one. E.g. "the Rainey LAMP Summit at Disney" → the event "Rainey LAMP Summit" (event) + "Rainey"/"Rainey Center" (organization) + "LAMP" (organization) + "Disney"/"Walt Disney World" (place), with relations {event located_in Disney}, {event hosted_by Rainey}, {event about LAMP}. The parts do NOT replace the whole; they enrich it, so a later question about any one of them lands. This applies to any embedding — a bill named for its sponsor, a program run by an org, a meeting named after its host.\n'
        + '     — Split out ONLY parts that are THEMSELVES distinct named entities (a real org, place, person, event). NEVER fragment a SINGLE multi-word proper name into its words: "Walt Disney World" is ONE place (emit it whole, never "Walt" + "Disney World"); "North Carolina", "Goldman Sachs", "Martin Luther King" are each ONE object.\n'
        + '     — When you DO split a compound, you MUST also emit the relations that tie the parts to the whole. Objects without the connecting edges are half the answer — the edge is what makes "the summit is AT Disney, hosted BY Rainey" reachable later.\n'
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

// RESOLVE-BEFORE-DECOMPOSE (Slice 2b): resolve each salient object to its Echo record via resolveFn
// (default → echo_suit.resolveMention, type-directed) BEFORE it becomes a sub-task, so downstream carries
// canonical objects, not dangling pronouns. Bias-toward-clarifying: any nil/ambiguous salient target yields
// a "which X?" question (merged with the parse's own clarify, capped). resolveFn injectable for offline tests.
async function resolvePlan(plan, { resolveFn = null } = {}) {
  const resolve = resolveFn || ((mention, opts) => { try { return require('./echo_suit').resolveMention(mention, opts); } catch { return Promise.resolve({ status: 'error', mention }); } });
  const targets = salientTargets(plan || {});
  const resolved = [];
  for (const o of targets) {
    let r; try { r = await resolve(o.mention, { preferType: o.type || null }); } catch { r = { status: 'error', mention: o.mention }; }
    resolved.push({ ...o, resolution: r || { status: 'error', mention: o.mention } });
  }
  const clar = [];
  for (const r of resolved) {
    const res = r.resolution || {};
    if (res.status === 'ambiguous') clar.push(`Which "${r.mention}" do you mean${Array.isArray(res.candidates) && res.candidates.length ? ` — ${res.candidates.slice(0, 3).join('; ')}?` : '?'}`);
    else if (res.status === 'nil') clar.push(`I don't have a clear match for "${r.mention}" — can you point me to who or what you mean?`);
  }
  const clarifications = [...(Array.isArray(plan && plan.clarify) ? plan.clarify : []), ...clar].slice(0, 3);
  return { ...plan, resolved, clarifications, needsClarification: clarifications.length > 0 };
}

// From a resolved plan → the RUN SEED (Slice 2 activation): the resolved entities' canonical names become
// known targets (so a "profile Sen. Curtis" run starts FROM his object, not a blind discovery walk), their
// objects ride along as prior knowledge, and any clarify questions surface (bias-to-clarify). Pure/offline.
function buildAssignmentSeed(resolvedPlan) {
  const resolved = (resolvedPlan && Array.isArray(resolvedPlan.resolved)) ? resolvedPlan.resolved : [];
  const objects = resolved.filter(r => r.resolution && r.resolution.status === 'resolved' && r.resolution.object).map(r => r.resolution.object);
  const targets = [...new Set(objects.map(o => String(o.name || '').trim()).filter(Boolean))].slice(0, 12);
  // intendedTargets = EVERY salient named entity the user asked us to work (resolved canonical name when we
  // have it, else the raw mention). This is the run's SCOPE. bounded = the assignment named specific entities
  // → research is confined to THEM and the run TERMINATES when they're covered (no open-ended discovery).
  const intendedTargets = [...new Set(resolved.map(r => { const o = r.resolution && r.resolution.object; return String((o && o.name) || r.mention || '').trim(); }).filter(Boolean))].slice(0, 12);
  const clarify = (resolvedPlan && Array.isArray(resolvedPlan.clarifications)) ? resolvedPlan.clarifications.slice(0, 2) : [];
  return { targets, objects, intendedTargets, bounded: intendedTargets.length > 0, clarify };
}

module.exports = { classify, route, subsetTopN, decompose, routeDecomposition, salientTargets, resolvePlan, buildAssignmentSeed, INTENTS, ENTITY_TYPES };
