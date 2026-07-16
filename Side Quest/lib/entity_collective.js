'use strict';
/**
 * lib/entity_collective.js — Step 3 of the node-resolution-&-fusion gate: COLLECTIVE / RELATIONAL tie-break
 * (docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md §2 Tier-3; Bhattacharya & Getoor 2007).
 *
 * The Step-1 matcher returns REVIEW when a name alone is ambiguous (e.g. "City of Sacramento" → 3 duplicate
 * candidates). This stage breaks that tie using the GRAPH: it compares the RESOLVED IDENTITIES of the incoming
 * node's context (the entities it co-occurs with / links to) against each candidate's existing neighbors.
 *
 * THE precision guard — the paper's key result — is that overlap is computed on resolved entity IDS, never on
 * neighbor name-strings: two candidates both neighboring "a C. Chen" only helps when it is the SAME resolved
 * C. Chen. Only a clearly-DOMINANT candidate wins; anything ambiguous stays REVIEW (precision-first, so a
 * thin/absent context can never force a wrong merge). PURE + injected neighbor reader → offline-testable.
 */

function _idSet(x) {
  if (x instanceof Set) return x;
  if (Array.isArray(x)) return new Set(x.filter((v) => v != null));
  return new Set(x != null ? [x] : []);
}

// relationalSim(contextIds, neighborIds) → { shared, simR }. simR = the fraction of the incoming context that
// the candidate ALREADY connects to. Overlap is on RESOLVED ids (the precision guard), not strings.
function relationalSim(contextIds, neighborIds) {
  const ctx = _idSet(contextIds), nb = _idSet(neighborIds);
  if (!ctx.size || !nb.size) return { shared: 0, simR: 0 };
  let shared = 0;
  for (const id of ctx) if (nb.has(id)) shared++;
  return { shared, simR: shared / ctx.size };
}

// collectiveTieBreak(context, candidates, deps) → { decision:'match'|'review', target?, simR, reason, scored }.
//   context      — the incoming node's RESOLVED context: a Set/array of entity ids it co-occurs with / links to
//   candidates   — the REVIEW-tier candidates [{ id, ... }] handed up by Step 1
//   neighborsOf(cand) → Set/array of that candidate's resolved neighbor ids (INJECTED graph read; fail-soft)
//   minShared    — a winner needs ≥ this many shared resolved neighbors (default 1 — but a resolved id is a
//                  specific entity, so even one shared neighbor is real evidence)
//   minSimR      — optional floor on context-coverage fraction (default 0 — dominance carries precision)
//   dominance    — the top must beat the 2nd by ≥ this simR ratio, else it's still ambiguous (default 2×)
// A dominant winner → MATCH; otherwise REVIEW. Never returns no-match (absence of overlap ≠ evidence of
// difference — that stays a human/other-signal decision).
async function collectiveTieBreak(context, candidates = [], { neighborsOf, minShared = 1, minSimR = 0, dominance = 2 } = {}) {
  const ctx = _idSet(context);
  if (!ctx.size) return { decision: 'review', reason: 'no-context', simR: 0, scored: [] };

  const scored = [];
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    let nb = [];
    try { nb = (typeof neighborsOf === 'function') ? await neighborsOf(c) : []; } catch { nb = []; }
    const { shared, simR } = relationalSim(ctx, nb);
    scored.push({ cand: c, shared, simR });
  }
  scored.sort((a, b) => b.simR - a.simR || b.shared - a.shared);

  const top = scored[0], second = scored[1];
  if (!top || top.shared < minShared || top.simR < minSimR) {
    return { decision: 'review', reason: 'no-dominant-neighbor-overlap', simR: top ? top.simR : 0, scored };
  }
  if (second && second.shared > 0 && top.simR < dominance * second.simR) {
    return { decision: 'review', reason: 'ambiguous-overlap (no clear winner)', simR: top.simR, scored };
  }
  return { decision: 'match', target: top.cand, simR: top.simR, reason: `resolved-neighbor overlap (${top.shared} shared)`, scored };
}

module.exports = { relationalSim, collectiveTieBreak };
