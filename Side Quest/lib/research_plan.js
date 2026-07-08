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
const oneLine = (s, n = 600) => str(s).replace(/\s+/g, ' ').trim().slice(0, n);
function _arr(v, max = 40) {
  if (Array.isArray(v)) return v.map(x => oneLine(x, 200)).filter(Boolean).slice(0, max);
  const s = oneLine(v, 1200);
  if (!s) return [];
  return s.split(/\s*[;\n]\s*/).map(x => x.trim()).filter(Boolean).slice(0, max);
}

// The compact, ID-light input handed to the cloud planner. Small payload = cheap call.
// Default facets PER RESEARCH KIND. entity = the org/people profiling set (contacts included). topical =
// aspects of a SUBJECT (no contact hunting). forecast = the components of an actual prediction.
const KIND_FACETS = {
  entity: ['Leadership & key staff (full names + roles)', 'Direct contacts (work email, phone, LinkedIn)', 'Policy positions / notable work', 'Funding & affiliations'],
  topical: ['Current state & key developments', 'Drivers & causes', 'Timeline of key events', 'Positions of the main actors', 'Implications & what to watch', 'Sources & evidence'],
  forecast: ['The question & how it resolves (outcome + horizon)', 'Base rate / reference class', 'Key drivers & their current signals', 'Scenarios & their probabilities', 'The estimate — probability + range', 'What would change the forecast', 'Sources & evidence'],
};
const normKind = (k) => (['entity', 'topical', 'forecast'].includes(k) ? k : 'entity');

function planInput({ goal = '', targets = [], facet = '', deep = false, estimate = '', kind = 'entity', databases = DEFAULT_DATABASES } = {}) {
  return {
    goal: oneLine(goal, 800),
    kind: normKind(kind),
    knownTargets: _arr(targets, 60),
    facet: oneLine(facet, 200),
    deep: !!deep,
    estimate: oneLine(estimate, 120),
    databasesAvailable: _arr(databases, 12),
  };
}

// The response contract (the `want` for cloud_logic.ask). JSON only — keep it terse. KIND-SPECIFIC so a
// topical brief or a forecast is NOT planned as an org/contact-profiling run (the misroute this fixes).
function planWant(kind = 'entity') {
  const k = normKind(kind);
  const common = `Produce the RESEARCH PLAN as a single JSON object and nothing else:
{"objective": string, "approach": string, "targets": [string], "databases": [string], "facets": [string], "estimate": string}
- objective: one clear paragraph restating what this research will deliver.
- databases: which of databasesAvailable you'll check first (subset or all).
- estimate: copy the provided estimate string (or your own brief estimate if none).`;
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
function normalizePlan(obj = {}, { goal = '', targets = [], facet = '', deep = false, estimate = '', kind = 'entity', databases = DEFAULT_DATABASES } = {}) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const k = normKind(kind);
  const knownTargets = _arr(targets, 60);
  let tgts = _arr(o.targets, 60);
  // default target phrasing depends on kind — topical/forecast are NOT "entities to discover"
  const defaultTarget = k === 'topical' ? 'To be scoped from the subject'
    : k === 'forecast' ? 'The key drivers of the outcome'
      : 'To be identified during discovery';
  if (!tgts.length) tgts = knownTargets.length ? knownTargets : [defaultTarget];
  let dbs = _arr(o.databases, 12);
  if (!dbs.length) dbs = _arr(databases, 12);
  let facets = _arr(o.facets, 24);
  if (!facets.length) {
    facets = facet ? [oneLine(facet, 160)] : KIND_FACETS[k].slice();
  }
  const defObjective = k === 'topical' ? 'Produce a clear, sourced briefing on the requested subject.'
    : k === 'forecast' ? 'Produce a calibrated forecast — a probability with an honest range — for the requested question.'
      : 'Produce a complete, sourced research dossier for the requested task.';
  const defApproach = k === 'topical'
    ? `Research the subject — ground first in what we already hold (known→unknown), then reputable web sources — and synthesize a briefing. Every claim is sourced.`
    : k === 'forecast'
      ? `Frame the question and how it resolves, establish a base rate, gather the key drivers and their current signals, then estimate a probability with an honest range. Every input is sourced.`
      : `Work each target in depth, one at a time, grounding first in what we already hold (known→unknown) before searching outward${deep ? ', running a parallel web + structured-data pass on each' : ''}. Every claim is sourced.`;
  return {
    objective: oneLine(o.objective, 1200) || oneLine(goal, 1200) || defObjective,
    approach: oneLine(o.approach, 1200) || defApproach,
    kind: k,
    targets: tgts,
    databases: dbs,
    facets,
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
  return [
    `# Research plan`,
    ``,
    `**Objective** — ${p.objective}`,
    ``,
    `**Approach** — ${p.approach}`,
    ``,
    `**Targets** (${p.targets.length})`,
    list(p.targets),
    ``,
    `**Databases & sources checked first** (known→unknown)`,
    list(p.databases),
    ``,
    `**${p.kind === 'topical' ? 'Aspects covered' : p.kind === 'forecast' ? 'Forecast components' : 'Gathered on each target'}**`,
    list(p.facets),
    ``,
    `**Estimated time to a complete deliverable** — ${p.estimate}`,
  ].join('\n');
}

module.exports = {
  DEFAULT_DATABASES, KIND_FACETS,
  planInput, planWant, planValidator, normalizePlan, fallbackPlan, renderPlanPage,
};
