/**
 * lib/research_preflight.js — P0 of ADAPTIVE_RESEARCH_DESIGN: the universal STEP ZERO.
 *
 * Lucas's base contract (2026-08-06): the very first step of any task is the question "do I know
 * the best practices and tools for this project?" — and the answer is EARNED, not assumed:
 *   (a) STUDY — if the class of project is unfamiliar, a bounded look at how it's done well
 *       (1-2 searches, folded into the verdict — cited method, not vibes);
 *   (b) TOOL SURVEY — the verdict is made AGAINST the real inventory she holds (operator menu +
 *       research lanes + skills/recipes), so tool choices name actual tools, never imagined ones;
 *   (c) GAP VERDICT — a capability she lacks is FILED (capability_needs) and SAID out loud.
 *       v1 is LOUD-NOT-BLOCKING: the run proceeds with the gap recorded in the plan rather than
 *       silently pretending completeness. (The full build-the-tool-first path — rehearsal lane,
 *       gated adoption — is P0b; the need it would consume is already being filed here.)
 * The verdict becomes planner guidance, so the ORIGIN PLAN records method + toolkit + sources.
 *
 * All deps injectable (ask / search / recordNeed / inventory parts) → offline-smokeable. Fail-open
 * by construction: any failure returns null and the plan generates exactly as before.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const _clean = (s, n = 300) => str(s).replace(/\s+/g, ' ').trim().slice(0, n);
const _arr = (v, max = 12) => (Array.isArray(v) ? v.map((x) => _clean(x, 200)).filter(Boolean).slice(0, max) : []);

// The inventory the verdict is made against — REAL names only, formatted compactly.
function inventoryText({ operatorToolNames = [], deepLane = [], webLane = [], skills = [], recipes = [] } = {}) {
  const parts = [];
  const fmt = (label, names) => { const n = _arr(names, 80); if (n.length) parts.push(`${label}: ${n.join(', ')}`); };
  fmt('OPERATOR TOOLS', operatorToolNames);
  fmt('RESEARCH DEEP LANE', deepLane);
  fmt('RESEARCH WEB LANE', webLane);
  fmt('PROVEN SKILLS', skills);
  fmt('RECIPES', recipes);
  parts.push('PLUS: the `echo` need-router reaches 500+ structured tools (FEC, court records, EDGAR, sanctions, nonprofit 990s, census, legislation…) — name the need in plain words.');
  return parts.join('\n');
}

function preflightInput({ goal = '', kind = 'entity', inventory = '', studyNotes = '', craftNotes = '' } = {}) {
  const o = { goal: _clean(goal, 600), kind: _clean(kind, 20), toolInventory: str(inventory).slice(0, 5000) };
  if (str(studyNotes).trim()) o.studyNotes = str(studyNotes).slice(0, 4000);
  if (str(craftNotes).trim()) o.knownCraft = str(craftNotes).slice(0, 1200);
  return o;
}

function preflightWant() {
  return `You are running PREFLIGHT for a research project — the step BEFORE planning. Answer from the tool inventory provided (real names only). Reply with ONE JSON object and nothing else:
{"knows_class": bool, "method": string, "study_queries": [string], "tool_picks": [{"tool": string, "for": string}], "missing_capabilities": [string], "quant_questions": [string]}
- knows_class: do you already know the best practices for THIS CLASS of project (not the subject — the craft)?
- method: 2-4 sentences: how professionals do this class of work well, and the method THIS run will follow.
- study_queries: 0-2 web queries to learn the craft FIRST — only when knows_class is false or the class is unusual; [] when you already know the craft (do not study for the sake of it).
- tool_picks: 3-8 tools FROM THE INVENTORY matched to this project's actual needs, each with what it's for. Include at least one quantitative pick (analyze_data / forecast_query / localdb) when any question is countable or probabilistic.
- missing_capabilities: capabilities this project genuinely needs that the inventory CANNOT provide (name them concretely, e.g. "state-level campaign finance filings for NC"); [] when the inventory suffices.
- quant_questions: 1-3 sub-questions this research should answer with a COMPUTED number or probability.
- If the input carries knownCraft, it is method learned from an EARLIER study pass on this class of work — build your method ON it (refine it, never ignore it).`;
}

function preflightValidator(raw) {
  try {
    const cleaned = str(raw).replace(/<(think|thoughts?|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const obj = JSON.parse(m[0]);
    if (typeof obj.knows_class !== 'boolean' || !Array.isArray(obj.tool_picks)) return { valid: false, error: 'not a preflight verdict' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// The verdict rendered as PLANNER GUIDANCE — what the origin plan must record.
function renderGuidance(verdict = {}, { studied = false, banked = false } = {}) {
  const lines = [];
  if (str(verdict.method).trim()) lines.push(`METHOD (preflight${studied ? ', informed by a study pass' : banked ? ', applying an earlier study pass' : ''}): ${_clean(verdict.method, 700)}`);
  const picks = (Array.isArray(verdict.tool_picks) ? verdict.tool_picks : [])
    .map((p) => p && p.tool ? `${_clean(p.tool, 60)} (${_clean(p.for, 120)})` : null).filter(Boolean).slice(0, 10);
  if (picks.length) lines.push(`TOOLKIT CHOSEN: ${picks.join('; ')}`);
  const qq = _arr(verdict.quant_questions, 3);
  if (qq.length) lines.push(`QUANTITATIVE QUESTIONS THIS RUN MUST COMPUTE: ${qq.join(' | ')}`);
  const miss = _arr(verdict.missing_capabilities, 5);
  if (miss.length) lines.push(`KNOWN CAPABILITY GAPS (filed as build needs — work around honestly, never pretend coverage): ${miss.join('; ')}`);
  return lines.join('\n');
}

// CRAFT MEMORY (Lucas 2026-08-06: "at no point have I seen her do outside research to learn best
// practices and implement new things she has learned"). Measured that same night: EVERY preflight
// said knows_class=true — a model asked to self-assess competence always claims it, so the study
// loop was unreachable in practice. The trigger is now STRUCTURAL, not self-assessed: a craft
// class with no FRESH banked study note gets a study pass (one query on the CRAFT, not the
// subject) even when the model claims competence. What the study yields is BANKED (deps.craftPut)
// and every later run of the class consumes it (deps.craftGet → knownCraft in the input) — the
// learning accumulates and is re-applied instead of evaporating with the run.
const CRAFT_TTL_MS = 7 * 24 * 3600 * 1000;   // a banked craft note goes stale after a week → restudy
function defaultStudyQuery(kind) {
  return {
    entity: 'investigative research methodology best practices for profiling organizations and people',
    topical: 'how professional analysts research and structure a subject briefing methodology best practices',
    forecast: 'forecasting best practices reference class base rates calibration superforecasting methodology',
    argument: 'how investigative journalists build and stress-test an argument verification methodology',
  }[str(kind)] || `research methodology best practices for ${str(kind) || 'general'} analysis`;
}

/**
 * Orchestrate the preflight. deps: ask (cloud_logic.ask-shaped), search (q → notes string, optional),
 * recordNeed (need → void, optional), craftGet (kind → {method, ts}|null, optional),
 * craftPut (kind, method — optional), inventory parts. Returns { verdict, guidance, studied } | null.
 * Fail-open: any throw/empty → null (the plan generates exactly as before).
 */
async function run({ goal = '', kind = 'entity', deps = {} } = {}) {
  if (!goal || typeof deps.ask !== 'function') return null;
  try {
    const inv = inventoryText(deps);
    // Banked craft (fresh) rides the FIRST ask, so the earned method is applied, not re-derived.
    let banked = null;
    if (typeof deps.craftGet === 'function') {
      try { const b = deps.craftGet(kind); if (b && str(b.method).trim() && (Date.now() - (Number(b.ts) || 0)) < CRAFT_TTL_MS) banked = b; } catch { /* bank miss = no craft */ }
    }
    const ask1 = await deps.ask({
      task: 'research_preflight', v: 1, numPredict: 700,
      input: preflightInput({ goal, kind, inventory: inv, craftNotes: banked ? banked.method : '' }),
      want: preflightWant(), validate: preflightValidator,
    });
    if (!ask1) return null;
    let verdict = ask1, studied = false;
    const queries = _arr(ask1.study_queries, 2);
    // Structural trigger: the model's own queries when it admits unfamiliarity, OR a forced single
    // craft query when nothing fresh is banked — self-declared competence no longer skips school.
    const mustStudy = !banked && !queries.length;
    if ((queries.length || mustStudy) && typeof deps.search === 'function') {
      const qs = queries.length ? queries : [defaultStudyQuery(kind)];
      let notes = '';
      for (const q of qs) {
        try { const r = await deps.search(q); if (str(r).trim()) notes += `\n## ${q}\n${str(r).slice(0, 1800)}`; } catch { /* one dry query never sinks the study */ }
      }
      if (notes.trim()) {
        studied = true;
        const ask2 = await deps.ask({
          task: 'research_preflight', v: 1, numPredict: 700,
          input: preflightInput({ goal, kind, inventory: inv, studyNotes: notes, craftNotes: banked ? banked.method : '' }),
          want: preflightWant(), validate: preflightValidator,
        });
        if (ask2) verdict = ask2;
        // BANK what the study earned — the next run of this class starts from it.
        if (typeof deps.craftPut === 'function' && str(verdict.method).trim()) { try { deps.craftPut(kind, verdict.method); } catch { /* banking is additive */ } }
      }
    }
    if (typeof deps.recordNeed === 'function') {
      for (const need of _arr(verdict.missing_capabilities, 3)) { try { deps.recordNeed(need); } catch { /* filing is additive */ } }
    }
    return { verdict, guidance: renderGuidance(verdict, { studied, banked: !!banked }), studied };
  } catch (e) { try { console.error('[preflight] failed (fail-open):', e.message); } catch {} return null; }
}

// ── P4b RE-ENTRY AUDIT (the acceptance test) ─────────────────────────────────────────────────────
// A run that adopts an EXISTING deliverable enters through JUDGMENT, not accretion: audit the
// document against the paper bar FIRST — does it deliver its own stated objective? where is it
// shallow? what is uncited? what was never computed? — and the gap list becomes the plan. The
// honest assessment is also SAID (the steering wire), so "this document is flawed" is a conclusion
// she reaches and states, not one Lucas has to supply.

function auditInput({ goal = '', title = '', body = '' } = {}) {
  return { goal: _clean(goal, 500), documentTitle: _clean(title, 200), documentBody: str(body).slice(0, 18000) };
}

function auditWant() {
  return `You are AUDITING an existing research document against a submission-grade bar before continuing the work. Judge it honestly — flattering a flawed document wastes the whole run. Reply with ONE JSON object and nothing else:
{"meets_bar": bool, "assessment": string, "depth_score": number, "citation_coverage": "none"|"sparse"|"partial"|"full", "gaps": [{"section": string, "missing": string}], "uncomputed": [string]}
- meets_bar: is this already a complete, deep, cited research document that delivers its own stated objective? (Expect false for drafts/notes.)
- assessment: 2-3 blunt sentences: what the document is today and what it is not yet.
- depth_score: 1-10 — 10 = every section evidenced and analyzed; 3 = organized notes; 1 = an outline.
- citation_coverage: how much of the load-bearing content carries a real source.
- gaps: the CONCRETE holes, per section or theme — each "missing" specific enough to research directly (empty only if meets_bar).
- uncomputed: questions the document should answer with a computed number/probability but doesn't.`;
}

function auditValidator(raw) {
  try {
    const cleaned = str(raw).replace(/<(think|thoughts?|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const obj = JSON.parse(m[0]);
    if (typeof obj.meets_bar !== 'boolean' || !Array.isArray(obj.gaps)) return { valid: false, error: 'not an audit verdict' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// Audit verdict → planner guidance: the gaps ARE the work.
function renderAuditGuidance(verdict = {}) {
  if (!verdict || verdict.meets_bar) return '';
  const lines = [`RE-ENTRY AUDIT of the existing document (depth ${Number(verdict.depth_score) || '?'}/10, citations ${_clean(verdict.citation_coverage, 20) || 'unknown'}): ${_clean(verdict.assessment, 500)}`];
  const gaps = (Array.isArray(verdict.gaps) ? verdict.gaps : [])
    .map((g) => g && g.missing ? `${_clean(g.section, 80) || 'general'} — ${_clean(g.missing, 200)}` : null).filter(Boolean).slice(0, 10);
  if (gaps.length) lines.push(`THE GAPS ARE THE PLAN — research these directly: ${gaps.join(' | ')}`);
  const un = _arr(verdict.uncomputed, 4);
  if (un.length) lines.push(`NEVER COMPUTED (do it this run): ${un.join(' | ')}`);
  lines.push('The deliverable REVISES this same document to the bar — deepen and cite every section; never restate what it already holds.');
  return lines.join('\n');
}

// Orchestrate the audit; fail-open like run(). Returns { verdict, guidance } | null.
async function auditDocument({ goal = '', title = '', body = '', deps = {} } = {}) {
  if (!str(body).trim() || typeof deps.ask !== 'function') return null;
  try {
    const verdict = await deps.ask({
      task: 'doc_reentry_audit', v: 1, numPredict: 900,
      input: auditInput({ goal, title, body }),
      want: auditWant(), validate: auditValidator,
    });
    if (!verdict) return null;
    return { verdict, guidance: renderAuditGuidance(verdict) };
  } catch (e) { try { console.error('[preflight] doc audit failed (fail-open):', e.message); } catch {} return null; }
}

module.exports = { inventoryText, preflightInput, preflightWant, preflightValidator, renderGuidance, run, defaultStudyQuery, CRAFT_TTL_MS, auditInput, auditWant, auditValidator, renderAuditGuidance, auditDocument };
