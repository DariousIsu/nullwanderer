'use strict';
// lib/priorities.js — durable, operator-grounded RESEARCH PRIORITY anchor.
//
// The idle graph-builder's active set (monologue.activeSetNames) LEADS with these, so the relevant-frontier
// window (idle_anchors._RELEVANT_MAX_NAMES) is built around Lucas's DECLARED work FIRST — the reactive
// sources (his recent reading via doc-decomp, the capped puller) fill in behind. This is the positive-anchor
// fix for idle-research DRIFT: steering the walk onto his neighborhood beats blocking off-domain sources one
// region at a time (Africa → LatAm → …).
//
// GROUNDED, not auto-accreted (the old rootless "interest agenda" was deleted for good reason). The seed is
// assembled from his focus.*.intended_targets (things he explicitly directed her to research) + his named
// interests/orgs + Echo projects. Meta-backed + operator-editable via set()/add()/remove(); falls back to the
// curated seed when unset. Leads with his WORK entities — the broad intellectual interests (physics,
// economics, philosophy) are deliberately NOT seeded here (they were bleeding "market mechanics/entropy" into
// her work-research); add them explicitly if that's wanted.

const META_KEY = 'research_priorities';

// Curated grounded seed (2026-07-12). Names use the graph's canonical form where known (e.g. the "(US)"/"(NM)"
// disambiguation) so the relevant-frontier name match resolves them; orgs match directly.
const SEED = [
  // people he directed her to research / actively tracks
  'John Curtis (US)', 'Rebecca Dow (NM)', 'Mike Lee', 'Pam Bondi', 'Eryn Witcher Tillman',
  // orgs / entities in his work (real graph forms where they exist; the rest get BUILT by the walk)
  'Environmental Law Institute', 'Nuclear Innovation Alliance', 'R Street Institute',
  'Joseph Rainey Center for Public Policy', 'LAMP Network', 'Emergence Water', 'Florida Top Dog All-Stars',
  // topical foci he named
  'AI Arms Race', 'energy permitting reform',
];

function _read(db) {
  try {
    const raw = (db && db.getMeta) ? db.getMeta(META_KEY) : null;
    if (raw) { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(x => x.length >= 2); }
  } catch { /* fall through to seed */ }
  return null;
}

// The active priority list — operator override (meta) if set + non-empty, else the grounded seed.
function getActive(db) { const m = _read(db); return (m && m.length) ? m : SEED.slice(); }

function set(db, list) { try { db.setMeta(META_KEY, JSON.stringify((Array.isArray(list) ? list : []).map(x => String(x || '').trim()).filter(Boolean))); return true; } catch { return false; } }
function add(db, item) {
  const cur = getActive(db); const k = String(item || '').trim();
  if (k && !cur.some(c => c.toLowerCase() === k.toLowerCase())) { cur.push(k); set(db, cur); }
  return getActive(db);
}
function remove(db, item) {
  const k = String(item || '').trim().toLowerCase();
  const cur = getActive(db).filter(c => c.toLowerCase() !== k); set(db, cur); return cur;
}

module.exports = { getActive, set, add, remove, SEED, META_KEY };
