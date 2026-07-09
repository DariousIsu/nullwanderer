'use strict';
/**
 * lib/research_lane.js — F3: research-to-close-the-gap. The third outcome of the ingest pipeline.
 *
 * A proposal that is short of the promote bar does NOT just park (left for the periodic cleans, Lucas #3):
 * the RESEARCH band is actively worked — diagnose WHY it's short, dispatch bounded targeted research to
 * close that specific gap, fold the result in, and RE-JUDGE. Only if research still can't lift it over the
 * bar does it park.
 *
 * THE GAPS (what research must close):
 *   'citation'      — classify says promote but it's UNGROUNDED → find + VERIFY an external citation
 *   'corroboration' — mid-band confidence → find INDEPENDENT external sources to raise calibrated P(true)
 *   'none'          — already promote-eligible → nothing to do
 *   'park'          — below even the review floor → too weak to research
 *
 * ANTI-COLLAPSE GUARDS: research must return EXTERNAL sources (a model re-asserting the claim is NOT a
 * source — only distinct registrable domains raise corroboration, mirror-collapsed by the confidence
 * engine); bounded retries (maxAttempts) then park; the executors (web_search / citation-verify) are
 * INJECTED so the whole loop is pure + offline-testable. The person/org ENRICH arm is the Puller lane
 * (its own design session) — not wired here.
 */
const ingestLane = require('./ingest_lane');
const promoteGate = require('./promote_gate');

function _clone(p) { try { return JSON.parse(JSON.stringify(p || {})); } catch { return { ...(p || {}) }; } }
function _md(p) { return (p && (p.metadata || p.relation_metadata)) || {}; }
function _subject(p) { return (p && (p.name || p.source_name)) || null; }
function _object(p) { return (p && p.target_name) || null; }
function _claim(p) {
  const s = _subject(p), r = (p && (p.relation || p.relation_type)) || 'related to', o = _object(p);
  return o ? `${s} ${String(r).toLowerCase().replace(/_/g, ' ')} ${o}` : String(s || '');
}
function _query(p) { return [_subject(p), _object(p)].filter(Boolean).join(' '); }

// diagnoseGap(p) → why isn't this in the promote band, i.e. what must research close?
function diagnoseGap(p, opts = {}) {
  const band = ingestLane.threeBand(p, opts);
  if (band === 'promote') return 'none';
  if (band === 'park') return 'park';
  // research band splits two ways: a promote-confidence-but-ungrounded fact needs a CITATION; an otherwise
  // mid-band fact needs more independent CORROBORATION to raise its calibrated confidence.
  const g = promoteGate.classify(p, opts);
  if (g.decision === 'promote' && !ingestLane.isGrounded(p)) return 'citation';
  return 'corroboration';
}

// planResearch(p, gap) → the research action for the injected executor to run.
function planResearch(p, gap) {
  if (gap === 'citation') return { action: 'verify-citation', subject: _subject(p), object: _object(p), claim: _claim(p) };
  if (gap === 'corroboration') return { action: 'corroborate', subject: _subject(p), object: _object(p), query: _query(p) };
  return null;
}

// mergeResearch(p, result) → a NEW proposal with the research folded into provenance. Only EXTERNAL sources
// are unioned into source_set (independence is enforced downstream by the confidence engine's
// mirror-collapse); the stale corroboration key is dropped so effectiveConfidence recomputes.
function mergeResearch(p, result) {
  const preConf = promoteGate.classify(p).confidence;   // the confidence already established for this fact
  const next = _clone(p);
  const md = next.metadata || next.relation_metadata || {};
  const existing = Array.isArray(md.source_set) ? md.source_set.slice() : [];
  const found = (result && Array.isArray(result.sources) ? result.sources : [])
    .concat(result && result.citation_url ? [result.citation_url] : [])
    .filter((s) => s && String(s).trim());
  md.source_set = [...new Set(existing.concat(found.map(String)))];
  delete md.corroboration;                       // force recompute from the merged set
  // PRESERVE the established confidence: once a source_set exists, effectiveConfidence recomputes from the
  // GRADE (default B) — which would DOWNGRADE a high stored confidence (a citation-gap fact was already
  // promote-band; grounding it must not lower it). If there's no grade, stamp one from the pre-merge conf.
  if (!md.grade && Number.isFinite(preConf)) {
    md.grade = preConf >= 0.95 ? 'A' : preConf >= 0.85 ? 'B' : preConf >= 0.65 ? 'C' : preConf >= 0.45 ? 'D' : 'E';
  }
  if (result && result.verified) md.verified_citation = true;
  next.metadata = md;                            // effectiveConfidence reads .metadata
  if (next.relation_metadata) next.relation_metadata = md;
  return next;
}

function rejudge(p, opts = {}) { return ingestLane.threeBand(p, opts); }

// runResearchItem — the bounded close-the-gap loop for ONE proposal. Injected executors:
//   search(plan)          → { sources: [url, ...] }              (independent external corroboration)
//   verifyCitation(plan)  → { verified: bool, citation_url }     (fetch + confirm the claim)
// Returns { outcome: 'promote'|'park', proposal, attempts, reason?, trace }.
async function runResearchItem(p, { search, verifyCitation, maxAttempts = 2, opts = {} } = {}) {
  let cur = p;
  const trace = [];
  for (let i = 0; i < Math.max(1, maxAttempts); i++) {
    const gap = diagnoseGap(cur, opts);
    if (gap === 'none') return { outcome: 'promote', proposal: cur, attempts: i, trace };
    if (gap === 'park') return { outcome: 'park', proposal: cur, attempts: i, reason: 'too-weak', trace };
    const plan = planResearch(cur, gap);
    let result = null;
    try {
      if (plan.action === 'verify-citation' && typeof verifyCitation === 'function') result = await verifyCitation(plan);
      else if (plan.action === 'corroborate' && typeof search === 'function') result = await search(plan);
    } catch (e) { trace.push({ i, gap, error: String((e && e.message) || e) }); break; }
    const found = (result && Array.isArray(result.sources) ? result.sources.length : 0) + (result && result.citation_url ? 1 : 0);
    trace.push({ i, gap, action: plan.action, found, verified: !!(result && result.verified) });
    // a citation gap needs a VERIFIED citation; nothing verified/found on this avenue → park (fail-soft)
    if (gap === 'citation' && !(result && result.verified && result.citation_url)) {
      return { outcome: 'park', proposal: cur, attempts: i + 1, reason: 'citation-unverified', trace };
    }
    if (found === 0) return { outcome: 'park', proposal: cur, attempts: i + 1, reason: 'no-external-found', trace };
    cur = mergeResearch(cur, result);
    if (rejudge(cur, opts) === 'promote') return { outcome: 'promote', proposal: cur, attempts: i + 1, trace };
  }
  return { outcome: 'park', proposal: cur, attempts: Math.max(1, maxAttempts), reason: 'exhausted', trace };
}

module.exports = { diagnoseGap, planResearch, mergeResearch, rejudge, runResearchItem };
