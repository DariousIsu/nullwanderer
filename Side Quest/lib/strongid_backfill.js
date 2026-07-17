'use strict';
/**
 * lib/strongid_backfill.js — the STRONG-ID BACKFILL fusion lever (node-resolution & fusion gate, follow-on).
 *
 * The precision matcher (entity_match) correctly HOLDS a non-person duplicate like
 *   "UNIVERSITY OF MONTANA [lda_client:161050]"  vs  "University of Montana [Q2302336]"
 * because non-persons only auto-merge on a SHARED strong id — and the lda-client variant never got a QID. So
 * the authoritative wikidata_target twin sits un-fused next to it, which is exactly the endpoint ambiguity that
 * (a) holds ~half the [grow] lane's residual edge rejects and (b) throttles the promote-up bridge.
 *
 * This is the missing, precision-bounded rule: a no-QID node that UNIQUELY matches a wikidata-bearing anchor by
 * (type, normKey, compatible jurisdiction) — with NO conflicting strong id — ADOPTS that anchor's identity
 * (fuses into it). It is deliberately NOT a general name-merge:
 *   • PERSONS are excluded — same-name people are the Howell/LAMP false-merge trap the north-star protects.
 *   • UNIQUENESS is required — if >1 QID anchor shares the (type, normKey), the name is ambiguous → skip.
 *   • JURISDICTION must be compatible (entity_match.jurisdictionCompatible).
 *   • A CONFLICTING strong id (a different id in the same system) is provably a different entity → skip.
 *   • The anchor (the QID-bearer) is ALWAYS the survivor — it's the authoritative identity node.
 *
 * PURE + offline-testable: takes a list of terminal entity rows, returns a reviewable merge manifest. Nothing is
 * written here — the batch dry-run (scripts/sweep_strongid_backfill.js) emits the manifest for operator sign-off,
 * then the SAME merge_entities apply path used for every other fusion set crosses it (reversible).
 */
const EM = require('./entity_match');

const _anchorKey = (p) => `${p.type || ''}|${p.normKey}`;

// buildAnchorIndex(anchorRows, opts) → { index: Map(`type|normKey` → [{r,p}]), anchorCount, anchorTypes }
// The anchor set (nodes carrying the anchor-system strong id) is SMALL, so it lives in memory; candidates can
// then be STREAMED past it (see scripts/sweep_strongid_backfill.js) without holding the whole corpus.
function buildAnchorIndex(anchorRows, { anchorSystem = 'wikidata', includePersons = false } = {}) {
  const index = new Map();
  const types = new Set();
  let anchorCount = 0;
  for (const r of (anchorRows || [])) {
    const p = EM.parseEntity({ name: r.name, type: r.entity_type });
    if (!p.normKey || !p.ids[anchorSystem]) continue;
    if (!includePersons && p.isPerson) continue;
    const k = _anchorKey(p);
    let arr = index.get(k); if (!arr) { arr = []; index.set(k, arr); }
    arr.push({ r, p });
    types.add(p.type || '');
    anchorCount++;
  }
  return { index, anchorCount, anchorTypes: [...types] };
}

// matchNode(nodeRow, index, opts) → { anchorId, anchor } on a confident backfill, else { skip: <reason> }.
// The precision-bounded rule: a non-person, no-anchor-id node that UNIQUELY matches one anchor by
// (type, normKey, compatible jurisdiction) with no conflicting strong id adopts that anchor.
function matchNode(nodeRow, index, { anchorSystem = 'wikidata', includePersons = false } = {}) {
  const p = EM.parseEntity({ name: nodeRow.name, type: nodeRow.entity_type });
  if (!p.normKey) return { skip: 'no-normkey' };
  if (p.ids[anchorSystem]) return { skip: 'has-id' };                 // already resolved to the anchor system
  if (!includePersons && p.isPerson) return { skip: 'person' };       // persons never backfill (name-collision trap)
  const cands = index.get(_anchorKey(p));
  if (!cands || !cands.length) return { skip: 'no-anchor' };
  const compat = cands.filter((a) => a.r.id !== nodeRow.id && EM.jurisdictionCompatible(p, a.p));
  if (compat.length === 0) return { skip: 'no-anchor' };
  if (compat.length > 1) return { skip: 'ambiguous' };                // >1 QID anchor shares the name → ambiguous
  const a = compat[0];
  if (EM.conflictingStrongId(p, a.p)) return { skip: 'conflict' };    // a differing same-system id → provably distinct
  return { anchorId: a.r.id, anchor: a };
}

// findBackfillMerges(rows, opts) → { manifest, stats }. Convenience for tests / small sets: rows contains BOTH
// anchors and candidates. canonicalId is ALWAYS the anchor (QID-bearer) — merge_entities folds duplicateIds in.
function findBackfillMerges(rows, opts = {}) {
  const { index, anchorCount } = buildAnchorIndex(rows, opts);
  const byAnchor = new Map();
  let ambiguous = 0, conflicts = 0;
  for (const r of (rows || [])) {
    const m = matchNode(r, index, opts);
    if (m.anchorId != null) {
      let g = byAnchor.get(m.anchorId); if (!g) { g = { anchor: m.anchor, folds: [] }; byAnchor.set(m.anchorId, g); }
      g.folds.push({ r });
    } else if (m.skip === 'ambiguous') ambiguous++;
    else if (m.skip === 'conflict') conflicts++;
  }
  const manifest = [];
  for (const [anchorId, g] of byAnchor) {
    if (!g.folds.length) continue;
    manifest.push({
      canonical: g.anchor.r.name, canonicalId: anchorId, mergeCount: g.folds.length,
      members: [g.anchor, ...g.folds].map((m) => ({ id: m.r.id, name: m.r.name, type: m.r.entity_type, degree: m.r.degree })),
      duplicateIds: g.folds.map((f) => f.r.id),
    });
  }
  manifest.sort((a, b) => b.mergeCount - a.mergeCount);
  const totalFolds = manifest.reduce((s, c) => s + c.mergeCount, 0);
  return { manifest, stats: { considered: totalFolds + ambiguous + conflicts, anchors: anchorCount, mergeClusters: manifest.length, totalFolds, ambiguous, conflicts } };
}

module.exports = { buildAnchorIndex, matchNode, findBackfillMerges };
