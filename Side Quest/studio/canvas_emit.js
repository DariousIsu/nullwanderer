/* studio/canvas_emit.js — Zoe Canvas DRIVE (Slice 2), PURE payload/key builders. main.js's
 * canvasEmit() calls the saga_canvas_* tools with what these return; keeping the shaping pure makes
 * the determinism boundary one tested function. No I/O, no model.
 *
 * Determinism law: the orchestrator (the Zoe program) decides WHEN to emit; the BLOCK CONTENT is
 * produced upstream by caged cloud leaves (the organize / condense reasoner) in professional
 * register. Dans (local voice) never produces a canvas block. These builders only shape that
 * already-generated content into the saga add_block contract.
 */
'use strict';

const MODES = new Set(['DOC', 'ILLUSTRATIVE', 'RESEARCH', 'JOB']);
const str = (v) => (v == null ? '' : String(v));
const clip = (s, n) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// Deterministic tab key for a directed focus run, so re-opens are idempotent and the tab re-attaches
// after a restart (saga_canvas_open_tab takes a pre-assigned tab_key for exactly this).
function tabKeyForFocus(focusId) { return `directed-${str(focusId)}`; }
function tabTitleForGoal(goal) { return clip(goal, 60) || 'Directed research'; }

function mode(m) { const u = String(m || '').toUpperCase(); return MODES.has(u) ? u : 'DOC'; }

// per-org organized section — already professional-register markdown from the organize leaf.
function orgSectionBlock(section) { return { blockType: 'paragraph', data: { markdown: str(section).trim() } }; }
// final condensed dossier markdown (from the condense leaf).
function dossierBlock(markdown) { return { blockType: 'paragraph', data: { markdown: str(markdown).trim() } }; }
// run's completed-count headline — a heading renders today (metric_card has no renderer yet → fallback).
function countHeading(n, label = 'organizations') { const k = Math.max(0, Number(n) || 0); return { blockType: 'heading', data: { level: 2, text: `${k} ${label} researched` } }; }

// ── CONTRACT + TODO (Slice 1: the research contract STARTS the document) ─────────────────────────────────
// Stable block ids so the contract header + the progress checklist live-update IN PLACE (canvasUpsertBlock)
// as the run advances, instead of appending duplicates each pass.
function contractBlockId(focusId) { return `contract-${str(focusId)}`; }
function todoBlockId(focusId) { return `todo-${str(focusId)}`; }

// The PORTIONS a run's progress tracks: the plan's facets (a deep single-target brief) else its targets
// (a multi-org run). These become the checklist items. Pure.
function portionsFromPlan(plan) {
  const facets = (plan && Array.isArray(plan.facets)) ? plan.facets : [];
  const clean = (a) => a.map((x) => str(x).trim()).filter(Boolean);
  const f = clean(facets);
  if (f.length) return f;
  const targets = (plan && Array.isArray(plan.targets)) ? plan.targets : [];
  return clean(targets);
}

// The CONTRACT header block — objective / approach / estimate / sources, so the document is meaningful the
// instant the run starts (before any section lands). Content is the already-authored plan (a caged leaf).
function contractBlock(plan, goal) {
  const p = plan || {};
  const parts = ['# Research contract'];
  if (goal) parts.push(`**Task:** ${clip(goal, 240)}`);
  if (p.objective) parts.push(`**Objective:** ${clip(p.objective, 400)}`);
  if (p.approach) parts.push(`**Approach:** ${clip(p.approach, 400)}`);
  if (p.estimate) parts.push(`**Estimate:** ${clip(p.estimate, 60)}`);
  const dbs = Array.isArray(p.databases) ? p.databases : [];
  if (dbs.length) parts.push(`**Sources:** ${dbs.map((d) => clip(d, 60)).join(' · ')}`);
  return { blockType: 'paragraph', data: { markdown: parts.join('\n\n') } };
}

// The CONTACTS facet resolves to the Puller workbench sub-tree (per-exec email/phone/verify/grade) — Lucas's
// "every executive's phone and email" pipeline. Any facet whose text is about reaching people expands into it.
const CONTACT_FACET_RE = /\b(contact|contacts|email|phone|reach|outreach|directory)\b/i;
const PULLER_SUBTASKS = [
  'Enumerate executive staff (web / Echo KG)',
  'Per exec — email (domain pattern → Hunter/Apollo verify)',
  'Per exec — phone',
  'Per exec — title / role',
  'Confidence-grade each (grade-A source for 100%)',
];

// PROGRESS checklist markdown — each planned portion as a checkbox; done items are checked. The contacts
// facet nests the Puller sub-tree. `done` = portion labels already complete (Slice 2 drives the checkoff).
function facetTodoMarkdown(plan, done = []) {
  const portions = portionsFromPlan(plan);
  const doneSet = new Set((Array.isArray(done) ? done : []).map((x) => str(x).toLowerCase().trim()));
  const box = (label) => (doneSet.has(str(label).toLowerCase().trim()) ? 'x' : ' ');
  const lines = ['## Progress'];
  if (!portions.length) { lines.push('- [ ] (plan pending)'); return lines.join('\n'); }
  for (const f of portions) {
    lines.push(`- [${box(f)}] ${f}`);
    if (CONTACT_FACET_RE.test(f)) for (const sub of PULLER_SUBTASKS) lines.push(`  - [${box(sub)}] ${sub}`);
  }
  return lines.join('\n');
}

module.exports = {
  MODES, tabKeyForFocus, tabTitleForGoal, mode, orgSectionBlock, dossierBlock, countHeading,
  contractBlockId, todoBlockId, portionsFromPlan, contractBlock, facetTodoMarkdown,
  CONTACT_FACET_RE, PULLER_SUBTASKS,
};
