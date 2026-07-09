'use strict';
/**
 * lib/ingest_lane.js — F2: the gate-less GROUNDED auto-promote lane, on a chunked drain-until-empty worker.
 *
 * The landing gap was that staged proposals sat unpromoted because promotion was operator-gated. F2 removes
 * that gate for the grounded promote-band: a proposal that is (a) calibrated at/above the promote floor AND
 * (b) GROUNDED (carries a real external citation) auto-promotes — no human. Below-bar proposals don't just
 * park: the mid-band is routed to RESEARCH (F3, close the gap then re-judge); only the genuinely thin ones
 * park (left staged / exception tray).
 *
 * THREE outcomes (Lucas): promote / research / park. This module is the PURE decision + drain-control core
 * (the actual Echo promotion + reversible log is the injected chunk-runner). Heavily unit-testable.
 *
 *   promote  — classify:promote AND grounded          → auto-promote (reversible + logged, Echo-side)
 *   research — classify:promote-but-UNGROUNDED, OR classify:review (mid-band) → F3
 *   park     — classify:hold (below floor)             → left staged for the periodic/exception lane
 */
const promoteGate = require('./promote_gate');

// GROUNDING — the anti-collapse anchor: a proposal may only auto-promote if it carries a real external
// citation (a source in its provenance). A calibrated confidence at the promote floor already implies a
// graded source, but this is the explicit structural check so an ungrounded high number can't slip through.
function isGrounded(p) {
  if (!p) return false;
  const md = p.metadata || p.relation_metadata || (typeof p.meta === 'object' ? p.meta : null) || {};
  const ss = md.source_set || p.source_set;
  if (Array.isArray(ss) && ss.some((s) => s && String(s).trim())) return true;
  const url = p.url || md.url || null;
  return !!(url && String(url).trim());
}

// threeBand(proposal, {promoteFloor, reviewFloor}) → 'promote' | 'research' | 'park'
function threeBand(p, opts = {}) {
  const g = promoteGate.classify(p, opts);
  if (g.decision === 'promote') return isGrounded(p) ? 'promote' : 'research';   // grounded gate on the promote band
  if (g.decision === 'review') return 'research';                                 // mid-band → close the gap
  return 'park';                                                                  // hold / no-confidence
}

// planBands(proposals) → { promote:[], research:[], park:[], counts } — pure partition of a queue.
function planBands(proposals, opts = {}) {
  const out = { promote: [], research: [], park: [], counts: { promote: 0, research: 0, park: 0 } };
  for (const p of (Array.isArray(proposals) ? proposals : [])) {
    const band = threeBand(p, opts);
    out[band].push(p);
    out.counts[band] += 1;
  }
  return out;
}

// drainUntilEmpty(runChunk, {maxIters}) — the chunked drain-until-empty controller. `runChunk(i)` promotes
// ONE bounded chunk (Echo-side, reversible) and reports { promoted, remaining }. We loop until the queue is
// drained (remaining <= 0), or a chunk makes no progress (the promotable band is exhausted — stop rather
// than spin on the park remainder), or a hard iteration cap (runaway backstop), or an error (fail-soft).
async function drainUntilEmpty(runChunk, { maxIters = 50 } = {}) {
  const trace = [];
  let totalPromoted = 0, iters = 0, stopped = 'drained';
  for (let i = 0; i < maxIters; i++) {
    iters = i + 1;
    let r;
    try { r = await runChunk(i); } catch (e) { stopped = 'error'; trace.push({ i, error: String((e && e.message) || e) }); break; }
    const promoted = Number((r && r.promoted) || 0);
    const remaining = (r && r.remaining != null) ? Number(r.remaining) : 0;
    totalPromoted += promoted;
    trace.push({ i, promoted, remaining });
    if (remaining <= 0) { stopped = 'drained'; break; }
    if (promoted === 0) { stopped = 'no-progress'; break; }   // band exhausted (only park-remainder left)
    if (iters >= maxIters) { stopped = 'max-iters'; break; }
  }
  return { totalPromoted, iters, stopped, trace };
}

module.exports = { isGrounded, threeBand, planBands, drainUntilEmpty };
