/**
 * research_plan — the STRUCTURED PLAN that becomes PAGE 1 of every research deliverable (Pillar 0).
 *
 * Lucas's vision: "page one of the research document should be the plan followed by the product." The
 * cloud authors a plan object at project start { objective, approach, targets[], databases[], facets[],
 * estimate } — it is reviewable (surfaced in the readback, editable by the correction handler) and is
 * rendered as page 1 at finalize. This module is PURE: the cloud call + the focus.<id>.plan store live
 * in main.js (generateResearchPlan); here are the input/want packaging, the validator/normalizer, a
 * fully deterministic FALLBACK (so a plan ALWAYS exists even with the cloud down), and the page-1
 * renderer. Fail-safe by construction — every function returns a value and never throws.
 */
'use strict';

// The data sources a grounded run checks FIRST (known→unknown, [[research-execution-and-enrich]]). Named
// in the plan so "check ALL databases" is a concrete promise on page 1, not a vague intention.
const DEFAULT_DATABASES = [
  "Zoe's own memory — prior dossiers, notes, captured facts",
  'Echo knowledge graph — entities & relationships we already hold',
  'Echo vault / knowledge base — our saved documents',
  'IRS 990 nonprofit filings — leadership, board, finances',
  'Federal funding — grants & contracts (USAspending)',
  'FEC — affiliated committees & PACs',
  'Open web — organization sites & reputable sources',
];

const str = (v) => (v == null ? '' : String(v));
// The plan is authored on a REASONING model (deepReasonerModel), so its raw output can carry a <think>…
// </think> block or stray tags that must NEVER bleed into the objective/approach/targets shown on the
// canvas + page 1 (the project-description thought-leak). oneLine is the single choke-point for every plan
// field, so strip reasoning blocks + tag-shaped artifacts here. Safe on normal prose ("< $1M" isn't a tag).
const oneLine = (s, n = 600) => str(s)
  .replace(/<(think|thoughts?|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/?[a-zA-Z][\w-]*\b[^>]*>/g, ' ')
  .replace(/<\/?[a-zA-Z][\w-]*\b[^>]*$/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, n);
function _arr(v, max = 40) {
  if (Array.isArray(v)) return v.map(x => oneLine(x, 200)).filter(Boolean).slice(0, max);
  const s = oneLine(v, 1200);
  if (!s) return [];
  return s.split(/\s*[;\n]\s*/).map(x => x.trim()).filter(Boolean).slice(0, max);
}

// The compact, ID-light input handed to the cloud planner. Small payload = cheap call.
// Default facets PER RESEARCH KIND. entity = the org/people profiling set (contacts included). topical =
// aspects of a SUBJECT (no contact hunting). forecast = the components of an actual prediction.
// ⭐ ARGUMENT (methodology parity, docs/METHODOLOGY_PARITY_SCOPE.md). The other three kinds organise a
// run around a SUBJECT — targets and the aspects to gather. An argument run is organised around a CLAIM
// TO BE DEFENDED and the READER WHO WILL ATTACK IT, which is the one primitive her research had no
// representation for. Its facets are not topic coverage: each one is a dossier answering a specific
// VULNERABILITY in the case, so the research is driven by where the argument is weakest rather than by
// what is easy to gather. These defaults apply only when the planner names no vulnerabilities of its own.
const KIND_FACETS = {
  entity: ['Leadership & key staff (full names + roles)', 'Direct contacts (work email, phone, LinkedIn)', 'Policy positions / notable work', 'Funding & affiliations'],
  topical: ['Current state & key developments', 'Drivers & causes', 'Timeline of key events', 'Positions of the main actors', 'Implications & what to watch', 'Sources & evidence'],
  forecast: ['The question & how it resolves (outcome + horizon)', 'Base rate / reference class', 'Key drivers & their current signals', 'Scenarios & their probabilities', 'The estimate — probability + range', 'What would change the forecast', 'Sources & evidence'],
  argument: ['The thesis stated precisely, and what would falsify it', "The hostile reader's strongest objection, at full strength", 'Counter-evidence that cuts against the thesis', 'Claims that do NOT survive scrutiny (named so they stay out of every draft)', 'The load-bearing facts and where each one comes from', 'Sources & evidence'],
};
const normKind = (k) => (['entity', 'topical', 'forecast', 'argument'].includes(k) ? k : 'entity');

function planInput({ goal = '', targets = [], facet = '', deep = false, estimate = '', kind = 'entity', databases = DEFAULT_DATABASES, thesis = '', hostileReader = '', preflight = '' } = {}) {
  const o = {
    goal: oneLine(goal, 800),
    kind: normKind(kind),
    knownTargets: _arr(targets, 60),
    facet: oneLine(facet, 200),
    deep: !!deep,
    estimate: oneLine(estimate, 120),
    databasesAvailable: _arr(databases, 12),
  };
  // Only sent when the operator already framed the case — a re-plan must not lose the thesis or the
  // adversary it was built against. Omitted entirely otherwise, so the payload stays small.
  if (oneLine(thesis, 400)) o.thesis = oneLine(thesis, 400);
  if (oneLine(hostileReader, 300)) o.hostileReader = oneLine(hostileReader, 300);
  // P0 PREFLIGHT (research_preflight.run → guidance): the earned method + toolkit + quant questions
  // + known gaps. Multi-line by design — the planner must HONOR it, so it rides the input verbatim.
  if (str(preflight).trim()) o.preflightGuidance = str(preflight).slice(0, 2500);
  return o;
}

// The response contract (the `want` for cloud_logic.ask). JSON only — keep it terse. KIND-SPECIFIC so a
// topical brief or a forecast is NOT planned as an org/contact-profiling run (the misroute this fixes).
function planWant(kind = 'entity') {
  const k = normKind(kind);
  const common = `Produce the RESEARCH PLAN as a single JSON object and nothing else:
{"objective": string, "approach": string, "targets": [string], "databases": [string], "facets": [string], "estimate": string}
- objective: one clear paragraph restating what this research will deliver.
- databases: which of databasesAvailable you'll check first (subset or all).
- estimate: copy the provided estimate string (or your own brief estimate if none).
- In approach or facets, name at least ONE QUANTITATIVE sub-question this research should answer with a COMPUTED number or probability (a cross-tab, a flow total, a base rate, an explicit likelihood) — research that never computes is a summary, not an analysis.
- THE REQUESTER IS THE AUDIENCE, NEVER THE SUBJECT: a goal phrased "research X for <name>" or "over the course of the night for <name>" means DELIVER X to that person — it never means investigate that person, their finances, or their affairs. Plan the requester as a research subject ONLY when the goal explicitly and unambiguously names them as the thing to be researched. (Measured failure: "financial forensic investigation for Lucas" was planned as an investigation OF Lucas.)
- If preflightGuidance is provided, HONOR it: fold its method into approach, keep its tool choices and quantitative questions, and carry its named capability gaps honestly (plan around them, never paper over them).`;
  if (k === 'topical') {
    return `${common}
- approach: 2-3 sentences on HOW you'll research the SUBJECT — ground first in what we already hold (known→unknown), then web + reputable sources; synthesize into a briefing.
- targets: the key SUB-TOPICS / threads to cover (NOT a roster of organizations or people).
- facets: the aspects of the SUBJECT to gather — e.g. current state & key developments, drivers, timeline, positions of the main actors, implications. This is a BRIEFING: do NOT gather personal contact details (emails/phones) unless the user explicitly asked for contacts.`;
  }
  if (k === 'forecast') {
    return `${common}
- approach: 2-3 sentences on HOW you'll FORECAST — frame the question + how it resolves, establish a base rate / reference class, gather the key drivers and their current signals, then estimate.
- targets: the key DRIVERS / factors that determine the outcome (NOT organizations to profile).
- facets: the components of the forecast — the question & resolution (outcome + horizon), base rate, drivers & signals, scenarios & their probabilities, the estimate (a PROBABILITY with a range), and what would change it. Produce an actual probability with honest uncertainty, never a bare guess and never a contact roster.`;
  }
  if (k === 'argument') {
    // The ONE contract that asks for more than the six common fields. The adversary is requested FIRST
    // because everything downstream is derived from it: a vulnerability is a weak point in a case as a
    // particular reader will attack it, and "counter-evidence" is undefined without a thesis to cut
    // against. Facets are the vulnerabilities, so the run researches where it is weakest.
    return `${common}
- approach: 2-3 sentences on HOW you'll build the case — verify the facts FIRST and only then draft, grounding in what we already hold (known→unknown) before searching outward. Facts before prose, never a persuasive sentence hunting for support afterwards.
- targets: the key CLAIMS the case rests on (NOT a roster of organizations to profile).
- ALSO produce these three fields:
  "thesis": the single claim this work will defend, stated in one sentence, precisely enough that it could be shown false.
  "hostile_reader": WHO will attack this and what they already believe — a specific sceptic, not "a general audience". Name what would make THEM concede.
  "vulnerabilities": [string] — the 3-6 places this case is weakest AGAINST THAT READER. Be honest and specific: the claim that will not survive scrutiny, the number the opposition will cite, the causal story that is actually reversed, the evidence we do not yet have.
- facets: ONE PER VULNERABILITY — each facet is the dossier that answers it. Do not pad with generic coverage; a facet that defends nothing does not belong here.
Discipline for the whole run: carry counter-evidence at FULL STRENGTH and never omit it, concede the opposition's best number out loud rather than hiding it, and name any claim that does not survive scrutiny so it stays out of every draft EVEN IF IT FLATTERS THE THESIS.`;
  }
  return `${common}
- approach: 2-3 sentences on HOW you'll proceed — depth-first per entity, grounding in what we already know first (known→unknown), and a two-lane web+structured pass when the task is deep.
- targets: the named organizations/people to profile. Use knownTargets if given; if empty, ["To be identified during discovery"].
- facets: what to gather on EACH target (e.g. leadership & key staff, direct contacts, policy positions, funding & affiliations).`;
}

// Validate/parse the cloud reply → {valid, value}. Accepts a JSON object with the expected keys.
function planValidator(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object in response' };
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, error: 'not a JSON object' };
    if (!obj.objective && !obj.approach && !(obj.targets && obj.targets.length)) return { valid: false, error: 'plan empty' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// Coerce ANY plan-ish object into the canonical shape, filling gaps from what we already know. Used on
// both the cloud result and the fallback so page 1 is uniform regardless of source.
// `kind` defaults to '' rather than 'entity' so an ABSENT context kind can fall through to the plan's
// own — with 'entity' as the default, `kind || o.kind` never reached o.kind and the fix below was inert.
// normKind('') is still 'entity', so a caller that passes nothing gets exactly the old behaviour.
function normalizePlan(obj = {}, { goal = '', targets = [], facet = '', deep = false, estimate = '', kind = '', databases = DEFAULT_DATABASES, thesis = '', hostileReader = '' } = {}) {
  const o = obj && typeof obj === 'object' ? obj : {};
  // The context wins, but an ALREADY-NORMALIZED plan carries its own kind and must not lose it. This
  // read was `normKind(kind)`, so renderPlanPage — which calls normalizePlan(plan, {}) to tolerate a
  // partial plan — collapsed every plan back to 'entity'. A topical plan has been rendering under the
  // heading "Gathered on each target" ever since kinds were added, and an argument plan would have
  // dropped its thesis on the way to page 1.
  const k = normKind(kind || o.kind);
  const knownTargets = _arr(targets, 60);
  let tgts = _arr(o.targets, 60);
  // default target phrasing depends on kind — topical/forecast are NOT "entities to discover"
  const defaultTarget = k === 'topical' ? 'To be scoped from the subject'
    : k === 'forecast' ? 'The key drivers of the outcome'
      : k === 'argument' ? 'The claims the case rests on'
        : 'To be identified during discovery';
  if (!tgts.length) tgts = knownTargets.length ? knownTargets : [defaultTarget];
  let dbs = _arr(o.databases, 12);
  if (!dbs.length) dbs = _arr(databases, 12);
  // THE ARGUMENT (S0). Accepted on every kind so a plan can never silently drop a thesis the operator
  // set, but only ever REQUESTED for kind='argument' — the other three stay exactly as they were.
  const _thesis = oneLine(o.thesis, 400) || oneLine(thesis, 400);
  const _hostile = oneLine(o.hostile_reader || o.hostileReader, 300) || oneLine(hostileReader, 300);
  const _vulns = _arr(o.vulnerabilities, 8);
  let facets = _arr(o.facets, 24);
  if (!facets.length) {
    // ⭐ ONE DOSSIER PER VULNERABILITY. This is the whole point of the kind: research driven by where
    // the case is weakest, not by what is easy to gather. A named vulnerability outranks both the
    // single-facet shorthand and the generic defaults, because the generic list defends nothing.
    if (k === 'argument' && _vulns.length) facets = _vulns.slice();
    else facets = facet ? [oneLine(facet, 160)] : KIND_FACETS[k].slice();
  }
  const defObjective = k === 'topical' ? 'Produce a clear, sourced briefing on the requested subject.'
    : k === 'forecast' ? 'Produce a calibrated forecast — a probability with an honest range — for the requested question.'
      : k === 'argument' ? 'Build a case that survives a hostile reader — facts verified first, every claim carrying its provenance.'
        : 'Produce a complete, sourced research dossier for the requested task.';
  const defApproach = k === 'topical'
    ? `Research the subject — ground first in what we already hold (known→unknown), then reputable web sources — and synthesize a briefing. Every claim is sourced.`
    : k === 'forecast'
      ? `Frame the question and how it resolves, establish a base rate, gather the key drivers and their current signals, then estimate a probability with an honest range. Every input is sourced.`
      : k === 'argument'
        ? `Verify the facts BEFORE drafting anything, one dossier per vulnerability, grounding first in what we already hold (known→unknown). Carry counter-evidence at full strength, concede the opposition's best number rather than hiding it, and keep any claim that does not survive scrutiny out of every draft.`
        : `Work each target in depth, one at a time, grounding first in what we already hold (known→unknown) before searching outward${deep ? ', running a parallel web + structured-data pass on each' : ''}. Every claim is sourced.`;
  return {
    objective: oneLine(o.objective, 1200) || oneLine(goal, 1200) || defObjective,
    approach: oneLine(o.approach, 1200) || defApproach,
    kind: k,
    targets: tgts,
    databases: dbs,
    facets,
    thesis: _thesis,
    hostile_reader: _hostile,
    vulnerabilities: _vulns,
    estimate: oneLine(o.estimate, 160) || oneLine(estimate, 160) || 'to be determined as the run develops',
    deep: !!deep,
  };
}

// Fully deterministic plan — used when the cloud is unavailable so a plan ALWAYS exists (fail-safe).
function fallbackPlan(ctx = {}) { return normalizePlan({}, ctx); }

// Render the plan as PAGE 1 markdown — professional, clean, the first thing in the deliverable.
function renderPlanPage(plan = {}) {
  const p = normalizePlan(plan, {});   // tolerate a raw/partial plan
  const list = (arr) => (arr.length ? arr.map(x => `- ${x}`).join('\n') : '- (none)');
  // THE CASE, stated on page 1 before anything else. A reader (and a fact-checker) should be able to
  // see what is being argued and who it is being defended against before they see a single finding —
  // and a thesis printed up front is one that can be held to.
  const argBlock = (p.thesis || p.hostile_reader || p.vulnerabilities.length) ? [
    `**Thesis** — ${p.thesis || '(not yet stated)'}`,
    ``,
    `**Hostile reader** — ${p.hostile_reader || '(not yet named)'}`,
    ``,
    `**Vulnerabilities this research must answer** (${p.vulnerabilities.length})`,
    list(p.vulnerabilities),
    ``,
  ] : [];
  const facetHeading = p.kind === 'topical' ? 'Aspects covered'
    : p.kind === 'forecast' ? 'Forecast components'
      : p.kind === 'argument' ? 'Dossiers — one per vulnerability'
        : 'Gathered on each target';
  return [
    `# Research plan`,
    ``,
    `**Objective** — ${p.objective}`,
    ``,
    `**Approach** — ${p.approach}`,
    ``,
    ...argBlock,
    `**${p.kind === 'argument' ? 'Claims the case rests on' : 'Targets'}** (${p.targets.length})`,
    list(p.targets),
    ``,
    `**Databases & sources checked first** (known→unknown)`,
    list(p.databases),
    ``,
    `**${facetHeading}**`,
    list(p.facets),
    ``,
    `**Estimated time to a complete deliverable** — ${p.estimate}`,
  ].join('\n');
}

// ── P1 THE LIVING PLAN (ADAPTIVE_RESEARCH_DESIGN §G3) ────────────────────────────────────────────
// The plan is provisional by contract: every few syntheses, the run re-tests it against what was
// just learned (correct? complete? tools sufficient?) and MUTATES it — versioned, conservative by
// default ("no changes" is a valid and common verdict). Pure contract + pure delta application, so
// the whole revalidate step is offline-testable; the cloud call and the meta writes live in main.js.

function revalidateInput({ plan = {}, synthesis = '', covered = [], goal = '' } = {}) {
  return {
    goal: String(goal || '').slice(0, 400),
    plan: {
      objective: String(plan.objective || '').slice(0, 1200),
      approach: String(plan.approach || '').slice(0, 1200),
      targets: _arr(plan.targets, 40),
      facets: _arr(plan.facets, 20),
    },
    covered: _arr(covered, 30),
    latestSynthesis: String(synthesis || '').slice(0, 6000),
  };
}

function revalidateWant() {
  return `You are RE-VALIDATING a research plan against what the run just learned — the scientific method applied to the plan itself: new evidence re-tests it. Reply with ONE JSON object and nothing else:
{"correct": bool, "complete": bool, "tools_sufficient": bool, "reason": string, "add_targets": [string], "drop_targets": [string], "approach_update": string|null, "tool_needs": [string]}
- correct: does the plan still point at the right objective given the findings?
- complete: does it now cover everything the findings show matters — people, orgs, money flows, the quantitative checks?
- tools_sufficient: can the current toolkit answer the open questions (python analysis, probability models, structured DBs included)? A missing capability goes in tool_needs, named concretely.
- tool_needs discipline: name ONLY capabilities the FINDINGS prove missing — a specific database, portal, filing type, or format the run could not access. NEVER generic infrastructure ("web access", "browsing", "search", "python") — the program already has all of those; you simply cannot see the toolkit from here. An empty array is the common, correct answer.
- add_targets / drop_targets: CONCRETE target changes the findings justify (empty arrays if none).
- approach_update: a REPLACEMENT approach paragraph ONLY if tactics should genuinely change; else null.
- reason: one sentence on the verdict.
Be conservative: {"correct":true,"complete":true,"tools_sufficient":true,...empty arrays, approach_update null} is a valid and common verdict. Change the plan only when the evidence demands it.`;
}

// Validate the cloud verdict → {valid, value}. `correct` must be present as a boolean.
function revalidateValidator(raw) {
  try {
    // Reasoning models wrap output in <think> blocks — strip BEFORE locating the JSON span, or a
    // brace inside the reasoning poisons the match (the planValidator lesson).
    const cleaned = String(raw || '').replace(/<(think|thoughts?|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const obj = JSON.parse(m[0]);
    if (typeof obj.correct !== 'boolean') return { valid: false, error: 'no boolean verdict' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// PURE delta application: returns { plan, changed, notes } — never throws, never mutates the input.
function applyPlanDelta(plan = {}, verdict = {}) {
  const p = { ...plan, targets: _arr(plan.targets, 60), facets: _arr(plan.facets, 20) };
  const notes = [];
  const drop = new Set(_arr(verdict.drop_targets, 20).map((t) => t.toLowerCase()));
  if (drop.size) {
    const before = p.targets.length;
    p.targets = p.targets.filter((t) => !drop.has(String(t).toLowerCase()));
    if (p.targets.length !== before) notes.push(`dropped ${before - p.targets.length} target(s)`);
  }
  const adds = _arr(verdict.add_targets, 20).filter((t) => !p.targets.some((x) => String(x).toLowerCase() === t.toLowerCase()));
  if (adds.length) { p.targets = p.targets.concat(adds).slice(0, 60); notes.push(`added target(s): ${adds.slice(0, 4).join(', ')}${adds.length > 4 ? '…' : ''}`); }
  const au = verdict.approach_update && String(verdict.approach_update).trim();
  if (au && au.length > 20 && au !== p.approach) { p.approach = au.slice(0, 1200); notes.push('tactics revised'); }
  return { plan: p, changed: notes.length > 0, notes };
}

// REV→WALK SYNC (#3890 boot_p34): applyPlanDelta revises the PLAN, but a bounded run's coverage
// walk starts and terminates on focus.<id>.intended_targets — a rev-added target that never
// enters that set is never started, and ALL-COVERED fires with plan-revision work still pending.
// Apply the SAME delta to the walkable set: adds extend it, explicit drops release it. Pure,
// never mutates its input.
function applyDeltaToIntended(intended = [], verdict = {}) {
  const list = _arr(intended, 60);
  const drop = new Set(_arr(verdict.drop_targets, 20).map((t) => t.toLowerCase()));
  const kept = drop.size ? list.filter((t) => !drop.has(String(t).toLowerCase())) : list;
  const adds = _arr(verdict.add_targets, 20).filter((t) => !kept.some((x) => String(x).toLowerCase() === t.toLowerCase()));
  return { intended: kept.concat(adds).slice(0, 60), changed: adds.length > 0 || kept.length !== list.length };
}

module.exports = {
  DEFAULT_DATABASES, KIND_FACETS,
  planInput, planWant, planValidator, normalizePlan, fallbackPlan, renderPlanPage,
  revalidateInput, revalidateWant, revalidateValidator, applyPlanDelta, applyDeltaToIntended,
};
