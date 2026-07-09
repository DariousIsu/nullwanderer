/* studio/puller_beliefs.js — Puller's belief-revision heart (PURE: no I/O, no DB, no model).
 *
 * Ports the Saga Prospecting playbook §3 (email derivation) + §4 (negative-signal feedback) to JS,
 * extended for negative-signal v2: 11 pattern templates (incl. middle-name forms), a `nextCandidate`
 * that skips non-derivable patterns, and `looksInfraBlocked` (gateway-block vs pattern-miss). A
 * per-domain email-pattern belief is a Beta distribution; each verification result nudges it; when the
 * leading pattern shifts, callers re-derive and propose a revision. Pure transforms over plain state;
 * persistence + orchestration live elsewhere. Determinism law: caged, deterministic, no model.
 *
 * Pattern-belief state shape (per domain): { patterns: { "first.last": {hits, misses, prior}, ... },
 *   is_catch_all: bool }
 */
'use strict';

// Candidate patterns in default-preference order. Common forms first; bare first/last and middle-name
// forms (need a middle token) rank last. Used for tiebreaks + as the derivation menu.
const PATTERN_PRIORITY = [
  'first.last', 'flast', 'f.last', 'firstlast', 'first_last', 'last.first',
  'firstm.last', 'first.m.last', 'first.middle.last', 'first', 'last',
];

const DEFAULT_PRIOR = 0.15;     // un-seeded prior — fixed (NOT 1/N) so it stays above MIN_BELIEF as the
                                // pattern menu grows; explicit seeds (seed_priors) override per domain.
const PSEUDOCOUNT = 10;         // prior strength: a 0.70 prior ≈ Beta(7,3) (§4.3)
const MIN_BELIEF = 0.10;        // below this, don't bother deriving (§4.9 / strategy.ABANDON_PATTERN_BELIEF)
const DEAD_MISSES = 3;          // misses needed to consider abandoning (§4.4 r3)
const DEAD_BELIEF = 0.20;       // ...alongside belief under this (§4.4 r3)

// Infra-vs-pattern (gateway-block) signal: a domain we were CONFIDENT about (strong prior) that only
// ever bounces is almost certainly a sender-reputation/infra problem, not a pattern error — pausing
// beats burning retests + corrupting beliefs (NEGATIVE_SIGNAL_ANALYSIS: Apple/MSFT/IBM/OpenAI @ 100%).
const INFRA_MIN_MISSES = 3;
const INFRA_MIN_PRIOR = 0.55;

const DELIVERABLE = new Set(['valid', 'deliverable']);
const UNDELIVERABLE = new Set(['invalid', 'undeliverable']);
const CATCH_ALL = new Set(['accept_all', 'catch_all', 'catch-all', 'catchall']);

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
// Post-nominal CREDENTIALS/degrees (usually after a comma) — never part of an email local-part. The
// "Sean I. Plasynski, Ph.D." → sean.ph.d.@… bug: the degree was taken as the surname.
const CREDENTIALS = new Set(['phd', 'md', 'jd', 'mba', 'esq', 'cfa', 'cpa', 'pe', 'rn', 'dds', 'dvm', 'mph', 'msc', 'edd', 'psyd', 'llm', 'do', 'faia']);
// Leading HONORIFICS — "Dr. Kam Ghaffarian" must derive kam.ghaffarian, not dr.ghaffarian.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'hon', 'rev', 'sen', 'rep', 'gov', 'the']);
const _norm = (p) => String(p || '').toLowerCase().replace(/\./g, '');   // "Ph.D." → "phd", "Jr." → "jr"

// Split a display name into {first, middle, last}, dropping honorifics, generational suffixes, and
// post-nominal credentials + apostrophes (playbook §3). middle = the second of 3+ tokens. Returns null
// if fewer than two usable parts (mononyms can't be derived).
function nameParts(name) {
  let s = String(name || '').replace(/['’]/g, '');
  s = s.split(',')[0];                                   // drop everything after the first comma (credentials/suffixes)
  let parts = s.split(/\s+/).filter(Boolean).filter(p => { const k = _norm(p); return !NAME_SUFFIXES.has(k) && !CREDENTIALS.has(k); });
  while (parts.length && HONORIFICS.has(_norm(parts[0]))) parts.shift();   // strip leading honorific(s)
  if (parts.length < 2) return null;
  const clean = (p) => p.toLowerCase().replace(/\.$/, '');
  return {
    first: clean(parts[0]),
    last: clean(parts[parts.length - 1]),
    middle: parts.length >= 3 ? clean(parts[1]) : null,
  };
}

// Derive a candidate email for a name at a domain under a given pattern (playbook §3 + v2 templates).
// Middle-name patterns return '' when there's no middle token. Unknown pattern → first.last fallback;
// a KNOWN-but-not-derivable pattern returns '' (so callers can skip it rather than mis-fallback).
function deriveEmail(name, domain, pattern) {
  const np = nameParts(name);
  if (!np || !domain) return '';
  const { first, last, middle } = np;
  const f1 = first[0];
  const m1 = middle ? middle[0] : null;
  const map = {
    'first.last': `${first}.${last}@${domain}`,
    'flast': `${f1}${last}@${domain}`,
    'f.last': `${f1}.${last}@${domain}`,
    'firstlast': `${first}${last}@${domain}`,
    'first_last': `${first}_${last}@${domain}`,
    'last.first': `${last}.${first}@${domain}`,
    'first': `${first}@${domain}`,
    'last': `${last}@${domain}`,
    'firstm.last': m1 ? `${first}${m1}.${last}@${domain}` : '',
    'first.m.last': m1 ? `${first}.${m1}.${last}@${domain}` : '',
    'first.middle.last': middle ? `${first}.${middle}.${last}@${domain}` : '',
  };
  return Object.prototype.hasOwnProperty.call(map, pattern) ? map[pattern] : `${first}.${last}@${domain}`;
}

// Reverse of deriveEmail: given an observed email + the person's name, infer which pattern produced
// it (playbook §4.6) so the right (domain, pattern) belief gets credit/blame.
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

// COLD-START size prior (research 2026-07-09): company SIZE is the ONE real predictor of email format
// (name-collision pressure forces last-name-bearing forms as headcount grows). Per-bucket top-pattern
// distributions from the Interseller 5M-company dataset. Used only to SEED a cold domain's first-guess
// ORDER — the prior is discarded the moment one address verifies (the domain becomes frequentist). NOT a
// trained model: size is the only feature with real lift; industry / mail-provider are folklore (the admin,
// not Google/Microsoft, picks the local-part). Our flat default already leads with first.last (right for
// mid/large B2B); this mainly rescues the SMALL-company case where {first}@ dominates.
const SIZE_PRIORS = [
  { max: 49,       priors: { first: 0.55, flast: 0.20, 'first.last': 0.20 } },   // <50: {first}@ dominant
  { max: 200,      priors: { flast: 0.42, 'first.last': 0.30, first: 0.17 } },
  { max: 1000,     priors: { flast: 0.45, 'first.last': 0.35, first: 0.07 } },
  { max: 5000,     priors: { 'first.last': 0.48, flast: 0.35 } },
  { max: Infinity, priors: { 'first.last': 0.56, flast: 0.22 } },                 // enterprise: first.last wins
];

// The bucket's {pattern: prior} for an employee count, or null if unknown/invalid (→ caller keeps the flat
// DEFAULT_PRIOR + PATTERN_PRIORITY order, which is already B2B-appropriate).
function sizeBucketPriors(employeeCount) {
  const n = Number(employeeCount);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const b of SIZE_PRIORS) if (n <= b.max) return { ...b.priors };
  return null;
}

// Seed a COLD domain's pattern priors from the org's employee count. Only seeds patterns with NO observation
// (never overrides learned frequentist data). No/invalid count → unchanged. PURE (returns a new state).
function seedSizePriors(state, employeeCount) {
  const priors = sizeBucketPriors(employeeCount);
  if (!priors) return cloneState(state);
  let next = cloneState(state);
  for (const [pattern, prior] of Object.entries(priors)) {
    const e = next.patterns[pattern];
    if (e && (((e.hits | 0) > 0) || ((e.misses | 0) > 0))) continue;   // real data present → don't override
    next = seedPrior(next, pattern, prior);
  }
  return next;
}

// Fold one verification result into the belief. PURE — returns a new state. (playbook §4.3)
function updateBelief(state, pattern, result, prior) {
  const next = cloneState(state);
  const r = String(result || '').toLowerCase();
  if (CATCH_ALL.has(r)) { next.is_catch_all = true; return next; }
  const p = _entry(next, pattern, prior);
  if (DELIVERABLE.has(r)) p.hits += 1;
  else if (UNDELIVERABLE.has(r)) p.misses += 1;
  return next;
}

// Posterior mean of the Beta(α, β): α = prior·N + hits, β = (1−prior)·N + misses.
function currentBelief(state, pattern) {
  const p = (state && state.patterns && state.patterns[pattern]) || { hits: 0, misses: 0, prior: DEFAULT_PRIOR };
  const prior = typeof p.prior === 'number' ? p.prior : DEFAULT_PRIOR;
  const alpha = prior * PSEUDOCOUNT + (p.hits | 0);
  const beta = (1 - prior) * PSEUDOCOUNT + (p.misses | 0);
  return (alpha + beta) > 0 ? alpha / (alpha + beta) : prior;
}

// A pattern is "dead" for a domain after enough misses AND a collapsed belief (§4.4 rule 3).
function isPatternDead(state, pattern) {
  const p = state && state.patterns && state.patterns[pattern];
  if (!p) return false;
  return (p.misses | 0) >= DEAD_MISSES && currentBelief(state, pattern) < DEAD_BELIEF;
}

function isCatchAll(state) { return !!(state && state.is_catch_all); }

// Gateway-block detector: a domain where some pattern had a STRONG prior (we were confident) but the
// domain only ever bounces (0 hits, ≥N misses) → likely infra/sender-reputation, not a pattern miss.
// Uses the prior (original confidence), not current belief (which the misses already dragged down).
function looksInfraBlocked(state, { minMisses = INFRA_MIN_MISSES, minPrior = INFRA_MIN_PRIOR } = {}) {
  if (!state || !state.patterns) return false;
  let hits = 0, misses = 0, strongPrior = false;
  for (const k of Object.keys(state.patterns)) {
    const e = state.patterns[k];
    hits += e.hits | 0;
    misses += e.misses | 0;
    if ((typeof e.prior === 'number' ? e.prior : DEFAULT_PRIOR) >= minPrior) strongPrior = true;
  }
  return strongPrior && hits === 0 && misses >= minMisses;
}

// Rank not-yet-tried patterns by current belief, best above the floor; null when all tried/too weak.
// Ties break toward higher PATTERN_PRIORITY index (deterministic). (§4.9 best_unused_pattern)
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

function bestPattern(state) { return bestUnusedPattern(state, []); }

// The next email to actually try for a person: the highest-belief untried pattern that DERIVES a
// non-empty address for this name (skips middle-name patterns when there's no middle token). Returns
// { pattern, email } or null when nothing derivable remains.
function nextCandidate(state, name, domain, alreadyTried) {
  const tried = new Set((alreadyTried || []).map(String));
  const ranked = [];
  PATTERN_PRIORITY.forEach((p, i) => {
    if (tried.has(p)) return;
    const b = currentBelief(state, p);
    if (b >= MIN_BELIEF) ranked.push({ p, b, i });
  });
  ranked.sort((a, b) => (b.b - a.b) || (a.i - b.i));
  for (const { p } of ranked) {
    const email = deriveEmail(name, domain, p);
    if (email) return { pattern: p, email };
  }
  return null;
}

module.exports = {
  PATTERN_PRIORITY, DEFAULT_PRIOR, PSEUDOCOUNT, MIN_BELIEF, DEAD_MISSES, DEAD_BELIEF,
  INFRA_MIN_MISSES, INFRA_MIN_PRIOR,
  nameParts, deriveEmail, detectPatternUsed,
  emptyState, cloneState, seedPrior, updateBelief,
  currentBelief, isPatternDead, isCatchAll, looksInfraBlocked,
  bestUnusedPattern, bestPattern, nextCandidate,
  SIZE_PRIORS, sizeBucketPriors, seedSizePriors,
};
