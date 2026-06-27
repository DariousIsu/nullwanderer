/* studio/puller_beliefs.js — Puller's belief-revision heart (PURE: no I/O, no DB, no model).
 *
 * Ports the Saga Prospecting playbook §3 (email derivation) + §4 (negative-signal feedback) to JS.
 * This is the "absorb next round info and update the refinement" engine: a per-domain email-pattern
 * belief is a Beta distribution; each verification result (hit/miss) nudges it; when the leading
 * pattern shifts, callers re-derive and propose a revision. Everything here is a pure transform over
 * plain state objects — persistence (lib/puller_db) and the verify/propose orchestration (Slice 4)
 * live elsewhere. Determinism law: this is a caged, deterministic component; no model involved.
 *
 * Pattern-belief state shape (per domain), mirroring playbook §4.2:
 *   { patterns: { "first.last": {hits, misses, prior}, ... }, is_catch_all: bool }
 */
'use strict';

// Candidate patterns in default-preference order (playbook §4.9 PATTERN_PRIORITY). first.m.last is a
// documented outlier (needs a middle name) and is intentionally NOT in the auto-ranked set.
const PATTERN_PRIORITY = ['first.last', 'flast', 'firstlast', 'f.last', 'first', 'last.first'];

const DEFAULT_PRIOR = 1 / PATTERN_PRIORITY.length;   // ~0.1667 — uniform when nothing is known
const PSEUDOCOUNT = 10;                              // prior strength: a 0.70 prior ≈ Beta(7,3) (§4.3)
const MIN_BELIEF = 0.10;                             // below this, don't bother deriving (§4.9)
const DEAD_MISSES = 3;                               // misses needed to consider abandoning (§4.4 r3)
const DEAD_BELIEF = 0.20;                            // ...alongside belief under this (§4.4 r3)

const DELIVERABLE = new Set(['valid', 'deliverable']);
const UNDELIVERABLE = new Set(['invalid', 'undeliverable']);
const CATCH_ALL = new Set(['accept_all', 'catch_all', 'catch-all', 'catchall']);

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Split a display name into [first, last], dropping generational suffixes + apostrophes (playbook §3).
// Returns null if fewer than two usable parts (single mononyms can't be derived).
function nameParts(name) {
  const parts = String(name || '').replace(/['’]/g, '').split(/\s+/)
    .filter(Boolean)
    .filter(p => !NAME_SUFFIXES.has(p.toLowerCase().replace(/\.$/, '')));
  if (parts.length < 2) return null;
  return { first: parts[0].toLowerCase(), last: parts[parts.length - 1].toLowerCase() };
}

// Derive a candidate email for a name at a domain under a given pattern (playbook §3 derive_email).
// Unknown pattern falls back to first.last (the ~70% default). Empty string if name isn't derivable.
function deriveEmail(name, domain, pattern) {
  const np = nameParts(name);
  if (!np || !domain) return '';
  const { first, last } = np;
  const f1 = first[0];
  const map = {
    'first.last': `${first}.${last}@${domain}`,
    'flast': `${f1}${last}@${domain}`,
    'f.last': `${f1}.${last}@${domain}`,
    'firstlast': `${first}${last}@${domain}`,
    'first': `${first}@${domain}`,
    'last.first': `${last}.${first}@${domain}`,
  };
  return map[pattern] || `${first}.${last}@${domain}`;
}

// Reverse of deriveEmail: given an observed email + the person's name, infer which pattern produced
// it (playbook §4.6 detect_pattern_used) so the right (domain, pattern) belief gets the credit/blame.
function detectPatternUsed(email, name, domain) {
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  if (!local) return null;
  for (const p of PATTERN_PRIORITY) {
    const e = deriveEmail(name, domain, p);
    if (e && e.split('@')[0].toLowerCase() === local) return p;
  }
  return null;
}

// ---- belief state (pure) -------------------------------------------------------------------------

function emptyState() { return { patterns: {}, is_catch_all: false }; }

function cloneState(s) {
  const src = s || {};
  const out = { patterns: {}, is_catch_all: !!src.is_catch_all };
  for (const k of Object.keys(src.patterns || {})) {
    const p = src.patterns[k] || {};
    out.patterns[k] = {
      hits: p.hits | 0,
      misses: p.misses | 0,
      prior: typeof p.prior === 'number' ? p.prior : DEFAULT_PRIOR,
    };
  }
  return out;
}

function _entry(state, pattern, prior) {
  if (!state.patterns[pattern]) {
    state.patterns[pattern] = { hits: 0, misses: 0, prior: typeof prior === 'number' ? prior : DEFAULT_PRIOR };
  } else if (typeof prior === 'number') {
    state.patterns[pattern].prior = prior;   // allow seeding/refreshing a prior (e.g. from rocketreach)
  }
  return state.patterns[pattern];
}

// Seed a domain pattern's prior (e.g. a rocketreach "66.4%" reading) before any observations (§4.2).
function seedPrior(state, pattern, prior) {
  const next = cloneState(state);
  _entry(next, pattern, prior);
  return next;
}

// Fold one verification result into the belief. PURE — returns a new state. (playbook §4.3)
//   deliverable → α (hits)++ ; undeliverable → β (misses)++ ; catch-all → mark domain untrustworthy ;
//   unknown/risky → no update (kept deterministic; the playbook's weak update is intentionally omitted).
function updateBelief(state, pattern, result, prior) {
  const next = cloneState(state);
  const r = String(result || '').toLowerCase();
  if (CATCH_ALL.has(r)) { next.is_catch_all = true; return next; }
  const p = _entry(next, pattern, prior);
  if (DELIVERABLE.has(r)) p.hits += 1;
  else if (UNDELIVERABLE.has(r)) p.misses += 1;
  return next;
}

// Posterior mean of the Beta(α, β) for a (domain, pattern): α = prior·N + hits, β = (1−prior)·N + misses.
function currentBelief(state, pattern) {
  const p = (state && state.patterns && state.patterns[pattern]) || { hits: 0, misses: 0, prior: DEFAULT_PRIOR };
  const prior = typeof p.prior === 'number' ? p.prior : DEFAULT_PRIOR;
  const alpha = prior * PSEUDOCOUNT + (p.hits | 0);
  const beta = (1 - prior) * PSEUDOCOUNT + (p.misses | 0);
  return (alpha + beta) > 0 ? alpha / (alpha + beta) : prior;
}

// A pattern is "dead" for a domain after enough misses AND a collapsed belief (§4.4 rule 3) — never
// derive with it again.
function isPatternDead(state, pattern) {
  const p = state && state.patterns && state.patterns[pattern];
  if (!p) return false;
  return (p.misses | 0) >= DEAD_MISSES && currentBelief(state, pattern) < DEAD_BELIEF;
}

function isCatchAll(state) { return !!(state && state.is_catch_all); }

// Rank the not-yet-tried patterns by current belief and return the best one above the floor; null when
// every remaining pattern is tried or too weak (playbook §4.9 best_unused_pattern). Ties break toward
// the higher-priority pattern so ordering is fully deterministic.
function bestUnusedPattern(state, alreadyTried) {
  const tried = new Set((alreadyTried || []).map(String));
  const scored = [];
  PATTERN_PRIORITY.forEach((p, i) => {
    if (tried.has(p)) return;
    const b = currentBelief(state, p);
    if (b >= MIN_BELIEF) scored.push({ p, b, i });
  });
  if (!scored.length) return null;
  scored.sort((a, b) => (b.b - a.b) || (a.i - b.i));
  return scored[0].p;
}

// Highest-belief pattern overall (the one to derive first). (§4.9 best_pattern)
function bestPattern(state) { return bestUnusedPattern(state, []); }

module.exports = {
  PATTERN_PRIORITY, DEFAULT_PRIOR, PSEUDOCOUNT, MIN_BELIEF, DEAD_MISSES, DEAD_BELIEF,
  nameParts, deriveEmail, detectPatternUsed,
  emptyState, cloneState, seedPrior, updateBelief,
  currentBelief, isPatternDead, isCatchAll, bestUnusedPattern, bestPattern,
};
