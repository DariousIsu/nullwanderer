'use strict';
/**
 * lib/resolution_gate.js — the composed NODE RESOLUTION & FUSION GATE (design §7). Runs the four proven
 * stages in order for ONE incoming node:
 *   1) BLOCK      (entity_block.generateCandidates)      — gather candidates (recall)
 *   2) MATCH      (entity_match.resolveAgainst)          — precision decision + anti-fan
 *   3) COLLECTIVE (entity_collective.collectiveTieBreak) — break the REVIEW tier via resolved-neighbor overlap
 *   4) CANONICAL  (entity_fuse.canonicalForm)            — pick the surviving form on a merge
 * → returns ONE decision the caller applies: MERGE into an existing node, MINT a new one, or QUEUE for review.
 *
 * The SAME gate runs on the write path (per node) and as a batch backlog sweep — identical, because match/merge
 * are order-independent (Swoosh ICAR). PURE orchestration over injected deps (blocking lookups, collective
 * context + neighbor reader) → exhaustively offline-testable. No stage can auto-merge a Howell/LAMP case: a
 * given-name conflict MINTS (never merges into the wrong person), and an unbreakable ambiguity → REVIEW.
 */
const block = require('./entity_block');
const match = require('./entity_match');
const collective = require('./entity_collective');
const fuse = require('./entity_fuse');

// resolveNode(incoming, deps) → { action:'merge'|'mint'|'review', target?, canonicalName?, tier, reason, candidates, ranked? }
//   deps.byStrongId / byNameKey / byBlock / byAnn / cap / annK  — blocking (Stage 1)
//   deps.context (Set/array of resolved ids the incoming co-occurs with) + deps.neighborsOf(cand)  — Stage 3
async function resolveNode(incoming, deps = {}) {
  // 1) BLOCK
  const blocked = await block.generateCandidates(incoming, deps);
  const candidates = blocked.candidates;
  if (!candidates.length) return { action: 'mint', tier: 'none', reason: 'no-candidates', candidates: [] };

  // 2) MATCH (+ anti-fan)
  const m = match.resolveAgainst(incoming, candidates);
  if (m.action === 'merge') {
    const canon = fuse.canonicalForm([incoming, m.target]);
    return { action: 'merge', target: m.target, canonicalName: canon.canonicalName, tier: m.tier, reason: m.reason, candidates };
  }
  if (m.action === 'mint') return { action: 'mint', tier: 'none', reason: m.reason, candidates };

  // 3) COLLECTIVE tie-break — only on REVIEW, and only when a context + neighbor reader are supplied
  if (m.action === 'review' && deps.context && typeof deps.neighborsOf === 'function') {
    const reviewCands = (m.ranked || [])
      .filter((r) => r.decision === 'review' || r.decision === 'match')
      .map((r) => r.cand);
    if (reviewCands.length) {
      const tb = await collective.collectiveTieBreak(deps.context, reviewCands, { neighborsOf: deps.neighborsOf });
      if (tb.decision === 'match') {
        const canon = fuse.canonicalForm([incoming, tb.target]);
        return { action: 'merge', target: tb.target, canonicalName: canon.canonicalName, tier: 'collective', reason: tb.reason, candidates };
      }
    }
  }

  // still ambiguous → human review (never auto-merge)
  return { action: 'review', tier: m.tier, reason: m.reason, candidates, ranked: m.ranked };
}

module.exports = { resolveNode };
