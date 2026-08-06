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

function preflightInput({ goal = '', kind = 'entity', inventory = '', studyNotes = '' } = {}) {
  const o = { goal: _clean(goal, 600), kind: _clean(kind, 20), toolInventory: str(inventory).slice(0, 5000) };
  if (str(studyNotes).trim()) o.studyNotes = str(studyNotes).slice(0, 4000);
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
- quant_questions: 1-3 sub-questions this research should answer with a COMPUTED number or probability.`;
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
function renderGuidance(verdict = {}, { studied = false } = {}) {
  const lines = [];
  if (str(verdict.method).trim()) lines.push(`METHOD (preflight${studied ? ', informed by a study pass' : ''}): ${_clean(verdict.method, 700)}`);
  const picks = (Array.isArray(verdict.tool_picks) ? verdict.tool_picks : [])
    .map((p) => p && p.tool ? `${_clean(p.tool, 60)} (${_clean(p.for, 120)})` : null).filter(Boolean).slice(0, 10);
  if (picks.length) lines.push(`TOOLKIT CHOSEN: ${picks.join('; ')}`);
  const qq = _arr(verdict.quant_questions, 3);
  if (qq.length) lines.push(`QUANTITATIVE QUESTIONS THIS RUN MUST COMPUTE: ${qq.join(' | ')}`);
  const miss = _arr(verdict.missing_capabilities, 5);
  if (miss.length) lines.push(`KNOWN CAPABILITY GAPS (filed as build needs — work around honestly, never pretend coverage): ${miss.join('; ')}`);
  return lines.join('\n');
}

/**
 * Orchestrate the preflight. deps: ask (cloud_logic.ask-shaped), search (q → notes string, optional),
 * recordNeed (need → void, optional), inventory parts. Returns { verdict, guidance, studied } | null.
 * Fail-open: any throw/empty → null (the plan generates exactly as before).
 */
async function run({ goal = '', kind = 'entity', deps = {} } = {}) {
  if (!goal || typeof deps.ask !== 'function') return null;
  try {
    const inv = inventoryText(deps);
    const ask1 = await deps.ask({
      task: 'research_preflight', v: 1, numPredict: 700,
      input: preflightInput({ goal, kind, inventory: inv }),
      want: preflightWant(), validate: preflightValidator,
    });
    if (!ask1) return null;
    let verdict = ask1, studied = false;
    const queries = _arr(ask1.study_queries, 2);
    if (queries.length && typeof deps.search === 'function') {
      let notes = '';
      for (const q of queries) {
        try { const r = await deps.search(q); if (str(r).trim()) notes += `\n## ${q}\n${str(r).slice(0, 1800)}`; } catch { /* one dry query never sinks the study */ }
      }
      if (notes.trim()) {
        studied = true;
        const ask2 = await deps.ask({
          task: 'research_preflight', v: 1, numPredict: 700,
          input: preflightInput({ goal, kind, inventory: inv, studyNotes: notes }),
          want: preflightWant(), validate: preflightValidator,
        });
        if (ask2) verdict = ask2;
      }
    }
    if (typeof deps.recordNeed === 'function') {
      for (const need of _arr(verdict.missing_capabilities, 3)) { try { deps.recordNeed(need); } catch { /* filing is additive */ } }
    }
    return { verdict, guidance: renderGuidance(verdict, { studied }), studied };
  } catch (e) { try { console.error('[preflight] failed (fail-open):', e.message); } catch {} return null; }
}

module.exports = { inventoryText, preflightInput, preflightWant, preflightValidator, renderGuidance, run };
