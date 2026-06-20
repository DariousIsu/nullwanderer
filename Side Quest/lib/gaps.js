/**
 * Capability gaps — the "seek new capabilities" half of the redesign.
 *
 * During idle time Zoe may discover something she genuinely can't do yet. Instead
 * of looping on it or silently failing, she names it with a tag; we store it with
 * her proposed solution; and when the user returns after being away we surface the
 * most useful one as a PROACTIVE PROPOSAL ("while you were gone I hit X — I think
 * we could solve it by Y, want me to try?"). This is the gap → research-plan →
 * acquire loop from the research (Voyager skill-creation / CoALA procedural growth),
 * kept to PROPOSAL-ONLY here — she never autonomously builds/installs a capability.
 *
 * Anti-sprawl (the open_threads lesson — 27 runaway threads once): dedup on insert
 * by normalized signature, and the curator ages stale open gaps to 'dismissed'.
 *
 * Tag forms (any of):
 *   <gap>what I can't do :: how I'd solve it</gap>
 *   <gap solution="how I'd solve it">what I can't do</gap>
 *   <gap>what I can't do</gap>
 */

const db = require('./db');
const blackboard = require('./blackboard');

const GAP_RE = /<gap(?:\s+solution\s*=\s*(["']?)([\s\S]*?)\1)?\s*>([\s\S]*?)<\/gap>/gi;

function parseTags(text) {
  if (!text) return [];
  const out = [];
  let m;
  GAP_RE.lastIndex = 0;
  while ((m = GAP_RE.exec(text)) !== null) {
    const attrSolution = (m[2] || '').trim();
    let body = (m[3] || '').trim();
    let solution = attrSolution;
    if (!solution && body.includes('::')) {
      const parts = body.split('::');
      body = parts[0].trim();
      solution = parts.slice(1).join('::').trim();
    }
    if (body.length >= 6) out.push({ description: body, solution: solution || null });
  }
  return out;
}

function stripTags(text) {
  return (text || '').replace(GAP_RE, '').trim();
}

// Parse + persist any gaps in `text`. Dedups by signature against active gaps so
// the same missing capability isn't logged every tick. Returns the count stored.
function record(text, { sourceContext = null } = {}) {
  const gaps = parseTags(text);
  let stored = 0;
  for (const g of gaps) {
    const sig = blackboard.signature(g.description);
    if (db.findActiveCapabilityGapBySignature(sig)) continue; // already open/proposed
    db.insertCapabilityGap({ description: g.description, proposedSolution: g.solution, sourceContext, signature: sig });
    stored++;
    console.log(`[gaps] logged capability gap: ${g.description.slice(0, 70)}`);
  }
  return stored;
}

// Record a single gap directly (e.g. derived from a blocked focus). Deduped.
function recordOne(description, solution = null, sourceContext = null) {
  if (!description || description.length < 6) return false;
  const sig = blackboard.signature(description);
  if (db.findActiveCapabilityGapBySignature(sig)) return false;
  db.insertCapabilityGap({ description, proposedSolution: solution, sourceContext, signature: sig });
  console.log(`[gaps] logged capability gap (derived): ${description.slice(0, 70)}`);
  return true;
}

// Build the on-return proposal context block for the single most recent open gap,
// and mark it 'proposed' so it isn't re-surfaced. Returns the block string or null.
// She DECIDES whether to raise it — the block invites, doesn't force.
function buildReturnProposalBlock(userName = 'them') {
  const open = db.getOpenCapabilityGaps(1);
  if (!open || open.length === 0) return null;
  const g = open[0];
  db.markCapabilityGapStatus(g.id, 'proposed');
  let block = `\n\nWHILE ${userName.toUpperCase?.() ? userName : 'they'} WAS AWAY you ran into something you can't do yet:\n  • ${g.description}`;
  if (g.proposed_solution) block += `\n  Your idea for solving it: ${g.proposed_solution}`;
  block += `\nIf it fits naturally in this conversation, PROPOSE it — offer to pursue or build toward it, don't just mention it in passing. If it doesn't fit right now, let it go; don't force it.`;
  return block;
}

function markResolved(id) { return db.markCapabilityGapStatus(id, 'resolved'); }

module.exports = { parseTags, stripTags, record, recordOne, buildReturnProposalBlock, markResolved, GAP_RE };
