/**
 * lib/correction.js — receive a CORRECTION to an ACTIVE run and re-shape it live.
 *
 * The gap: a run, once created, was unsteerable — clarifications were only folded in as guidance text;
 * nothing changed the actual work-list / facet / depth. So Lucas's "money"→"many" misread (and "just the
 * 5") had no way to take effect. This makes a correction RESHAPE the active focus: rewrite the facet,
 * narrow the org work-list, or change depth — the driver reads that meta each tick, so it just continues
 * on the corrected scope.
 *
 * classify() is the cloud seam (deps.ask injectable). applyPlan() is PURE + offline-testable. Fail-safe:
 * cloud null / nothing changed → { changed:false } → caller leaves the run untouched.
 */
'use strict';
const cloud = require('./cloud_logic');

const _clean = (x, n = 200) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);

// Cloud: is this turn a CORRECTION to the active run, and what changes? activeRun = { goal, facet, orgs, deep }.
async function classify(message, { activeRun = {}, deps = {} } = {}) {
  const ask = deps.ask || cloud.ask;
  const s = String(message || '').trim();
  if (s.length < 3) return { isCorrection: false };
  const fastModel = (() => { try { return require('./models').getModelFor('editor', null); } catch { return null; } })();
  try {
    return await ask({
      task: 'run_correction', v: 1, model: fastModel, numPredict: 500,
      input: {
        user: s.slice(0, 500),
        current_goal: _clean(activeRun.goal, 200), current_facet: _clean(activeRun.facet, 200),
        current_orgs: (Array.isArray(activeRun.orgs) ? activeRun.orgs : []).slice(0, 40), deep: !!activeRun.deep
      },
      want: 'A research run is ALREADY ACTIVE (its current_goal / current_facet / current_orgs / deep are in the input). Decide whether the user is CORRECTING or REFINING that ACTIVE run — changing WHAT to gather, NARROWING which organizations, changing DEPTH, or fixing a misread goal — as opposed to chatting, asking a question, or starting a brand-new task. '
        + 'Output ONLY JSON: {"isCorrection":true|false,"newFacet":"the corrected thing-to-gather, or null","subsetOrgs":["exact names copied FROM current_orgs to KEEP","..."],"deep":true|false|null,"note":"one short line on what changed"}. '
        + 'newFacet: set ONLY if they changed WHAT to gather (e.g. they clarify a typo "money"→"many", or "all contact info not just funding"); copy their corrected intent; else null. '
        + 'subsetOrgs: set ONLY if they narrowed to specific organizations — copy the matching names EXACTLY from current_orgs; else []. '
        + 'deep: only if they changed depth; else null. isCorrection=false for a question, status check, unrelated chat, or a clearly new project.',
      validate: (raw) => {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no json' };
        try { const o = JSON.parse(m[0]); return (o && typeof o.isCorrection === 'boolean') ? { valid: true, value: o } : { valid: false, error: 'no isCorrection' }; }
        catch (e) { return { valid: false, error: e.message }; }
      },
      deps
    });
  } catch (e) { console.error('[correction] classify failed:', e.message); return null; }
}

// PURE: turn a decision into concrete meta changes for the active focus. Resolves subsetOrgs back to the
// canonical current_orgs names (tolerant match). Returns { changed, changes:{facet?,orgs?,deep?}, summary }.
function applyPlan(decision, activeRun = {}) {
  if (!decision || decision.isCorrection !== true) return { changed: false };
  const curOrgs = (Array.isArray(activeRun.orgs) ? activeRun.orgs : []).map(String);
  const changes = {}; const parts = [];

  const nf = _clean(decision.newFacet);
  if (nf && nf.toLowerCase() !== _clean(activeRun.facet).toLowerCase() && nf.length > 2) { changes.facet = nf; parts.push(`facet → "${nf.slice(0, 60)}"`); }

  if (Array.isArray(decision.subsetOrgs) && decision.subsetOrgs.length) {
    const match = (name) => curOrgs.find(c => {
      const a = c.toLowerCase(), b = String(name).toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    });
    const canon = decision.subsetOrgs.map(match).filter(Boolean);
    const uniq = Array.from(new Set(canon));
    if (uniq.length && uniq.length < curOrgs.length) { changes.orgs = uniq; parts.push(`scope → ${uniq.length} org(s)`); }
  }

  if (decision.deep === true || decision.deep === false) {
    if (!!decision.deep !== !!activeRun.deep) { changes.deep = !!decision.deep; parts.push(`depth → ${changes.deep ? 'deep' : 'standard'}`); }
  }

  if (!Object.keys(changes).length) return { changed: false };
  return { changed: true, changes, summary: parts.join('; ') };
}

module.exports = { classify, applyPlan };
