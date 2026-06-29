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

module.exports = { MODES, tabKeyForFocus, tabTitleForGoal, mode, orgSectionBlock, dossierBlock, countHeading };
