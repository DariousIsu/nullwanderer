/**
 * Surfacing LANES — HERS / YOURS / OURS (Lucas's reframe of the surfacing gate).
 *
 * The old gate asked one question: "is this significant?" (importance ≥ 8). It was
 * lane-blind — a deep thought about HER research and a finding about LUCAS's work cleared
 * the exact same bar, so her own chatter surfaced as readily as his deliverables. Lanes
 * make the gate importance × WHOSE-LANE:
 *   • HERS  — her research / curiosity / byline / play. Near-silent (high bar): lives in
 *             her head + the sheep panel, rarely pops. This is the DEFAULT.
 *   • YOURS — things Lucas actually ASSIGNED her (and the deliverables they imply). Low
 *             bar: these are what he's waiting for, so they surface readily.
 *   • OURS  — her own research that OVERLAPS his work. Best proactive surfacing.
 *
 * "His domains" are DERIVED FROM HISTORY (Lucas's choice): we embed the open threads that
 * originated from his turns (db.getUserAssignedThreads) + her held commitments to him, and
 * match a candidate against that profile. NO free-form LLM "is this relevant to Lucas?"
 * call (that misfires + over-surfaces) — just one cheap CPU embed + cosine against the
 * cached profile. Anything we can't confidently place stays HERS and stays quiet.
 *
 * classify() is the only model-free hot path; buildDomains() is cached (rebuilt ~2h).
 */

const db = require('./db');
const memoryLib = require('./memory');

// Similarity bars (bge-small cosine). Calibrated against real embeddings: a clearly
// on-topic paraphrase of an assignment lands ~0.70–0.82, while unrelated HER-research
// topics top out ~0.41–0.47 — a wide gap, so bars in the ~0.58–0.62 band separate them
// cleanly with margin. (bge-small inflates low-end cosine, hence not 0.3.) Tunable live.
const YOURS_SIM = 0.62;   // candidate matches an ACTIVE assignment → a direct deliverable
const OURS_SIM = 0.58;    // candidate matches the broader assignment-history profile
const DOMAIN_TTL_MS = 2 * 60 * 60 * 1000;   // rebuild the domain profile at most every 2h

// Per-lane surfacing thresholds (the importance score an unprompted utterance must clear).
// HERS = 9 keeps her near-silent on her own stuff (was a flat 8 for everything); YOURS/OURS
// drop the bar so his deliverables + overlapping research surface. Tunable live.
const LANE_THRESHOLD = { hers: 9, ours: 6, yours: 5 };

let _domains = null;   // { ts, active:[{text,emb}], all:[{text,emb}] }

async function _embedSafe(t) { try { return await memoryLib.embed(t); } catch { return null; } }

/**
 * Build the domain profile from what Lucas has ASSIGNED: user-origin open threads (the
 * broad profile, any status) + her held commitments to him; the active/pending subset is
 * the set of DIRECT deliverables. Cached; rebuilt at most every DOMAIN_TTL_MS (force to
 * refresh now — e.g. right after a new assignment lands).
 */
async function buildDomains(force = false) {
  const now = Date.now();
  if (_domains && !force && (now - _domains.ts) < DOMAIN_TTL_MS) return _domains;
  const all = [], active = [];
  try {
    for (const t of (db.getUserAssignedThreads(60) || [])) {
      const emb = await _embedSafe(t.content); if (!emb) continue;
      const item = { text: t.content, emb };
      all.push(item);
      if (t.status === 'active' || t.status === 'pending') active.push(item);
    }
    for (const c of (db.getHeldCommitments(20) || [])) {
      const emb = await _embedSafe(c.claim); if (emb) all.push({ text: c.claim, emb });
    }
  } catch (e) { console.error('[lanes] buildDomains failed:', e.message); }
  _domains = { ts: now, all, active };
  return _domains;
}

function _maxSim(qv, items) {
  let best = 0;
  for (const it of items) { const s = memoryLib.cosine(qv, it.emb); if (s > best) best = s; }
  return best;
}

/**
 * Classify a candidate utterance into a lane. Pass `qv` to reuse a precomputed embedding.
 * Defaults to 'hers' on any uncertainty (no assignments yet, embed failure, no match) — so
 * the gate never gets LOUDER by accident; it only lowers the bar on a confident his-work match.
 */
async function classify(text, { qv = null } = {}) {
  if (!text || !String(text).trim()) return 'hers';
  const dom = await buildDomains();
  if (!dom.all.length) return 'hers';                       // nothing assigned yet → all hers
  if (!qv) qv = await _embedSafe(text);
  if (!qv) return 'hers';
  if (dom.active.length && _maxSim(qv, dom.active) >= YOURS_SIM) return 'yours';
  if (_maxSim(qv, dom.all) >= OURS_SIM) return 'ours';
  return 'hers';
}

function thresholdFor(lane) {
  return LANE_THRESHOLD[lane] != null ? LANE_THRESHOLD[lane] : LANE_THRESHOLD.hers;
}

// Invalidate the cached profile (call after a new assignment so OURS/YOURS pick it up
// without waiting out the TTL).
function invalidate() { _domains = null; }

module.exports = { buildDomains, classify, thresholdFor, invalidate, LANE_THRESHOLD, YOURS_SIM, OURS_SIM, DOMAIN_TTL_MS };
