'use strict';
/**
 * lib/entropy.js — Wave 2 of the pre-hard-testing scope (docs/PRE_HARD_TESTING_SCOPE_2026-08-18.md):
 * the ONE governed source of behavioral randomness. Reproducibility is the prerequisite for hard
 * testing — you cannot diff two runs of a non-deterministic agent — so every expressive coin flip,
 * weighted pick, and jitter that used to reach for Math.random() draws from HERE instead: one
 * seedable PRNG, split into independent per-lane sub-streams, logged, and collapsible to a canonical
 * branch for byte-comparable drills.
 *
 * THE FIREWALL — the one invariant this module exists to honor:
 *   Smooth DYNAMICS and STRATEGY — how a value moves, which approach is tried, when a behavior fires.
 *   NEVER smooth SOURCE — where a fact comes from. This module must never be imported by the
 *   epistemic path (retrieval / confidence / verification / ranking / citation / extraction). That
 *   boundary is a GATE, not a hope: scripts/smoke_epistemic_firewall.js fails the build if a
 *   fact-path module ever `require('./entropy')`. Randomness here decides expressive behavior only.
 *
 * PER-LANE SUB-STREAMS. Every call names a `lane` (a required string). Each lane owns its own PRNG
 * state, seeded from splitmix64(masterSeed ^ fnv1a64(lane)). This is the property that keeps
 * reproducibility ROBUST under change: adding a new draw in one lane cannot shift the sequence any
 * OTHER lane sees, so a behavioral edit in the mood lane can't silently perturb interest selection.
 *
 * MODES (env ZOE_ENTROPY_MODE, or configure({mode})):
 *   prod (default) — seed from ZOE_ENTROPY_SEED if set, else a crypto-random seed LOGGED ONCE on first
 *                    use (so any production session is replayable post-hoc by re-feeding the seed).
 *   seeded         — real sampling, fixed default seed when none is given: reproducible variety, for
 *                    BEHAVIORAL drills (same seed twice → identical choices).
 *   deterministic  — the SEMANTIC helpers (pick/int/bernoulli/jitter/epsilonGreedy/softmax) collapse
 *                    to their canonical branch (first / midpoint / modal / base / argmax) and
 *                    temperature() → 0, so a GROUNDING drill diff shows only fact-path changes. The
 *                    raw stream (float / stream) still advances a pinned-seed PRNG — reproducible and
 *                    seed-independent — so injected-rng consumers never hit a constant-value pathology.
 */

// ── 64-bit primitives (BigInt; the draw cadence is human/idle, so the cost is irrelevant) ──────────
const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9E3779B97F4A7C15n;
const MIX1 = 0xBF58476D1CE4E5B9n;
const MIX2 = 0x94D049BB133111EBn;
const FNV_OFFSET = 0xCBF29CE484222325n;
const FNV_PRIME = 0x100000001B3n;
const TWO53 = 9007199254740992; // 2^53

const _u64 = (x) => x & MASK64;

// splitmix64: advance the state by the golden gamma, mix, return the 64-bit output + the new state.
function _splitmix64(state) {
  const next = _u64(state + GOLDEN);
  let z = next;
  z = _u64((z ^ (z >> 30n)) * MIX1);
  z = _u64((z ^ (z >> 27n)) * MIX2);
  z = z ^ (z >> 31n);
  return { value: _u64(z), state: next };
}

// fnv1a over the lane name → a well-mixed 64-bit lane offset (so lanes don't collide or correlate).
function _fnv1a64(str) {
  let h = FNV_OFFSET;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = _u64((h ^ BigInt(s.charCodeAt(i))) * FNV_PRIME);
  return h;
}

// Accept a seed as bigint | finite number | hex/decimal string | any string (hashed). null = "none".
function _normalizeSeed(input) {
  if (input == null) return null;
  if (typeof input === 'bigint') return _u64(input);
  if (typeof input === 'number' && Number.isFinite(input)) return _u64(BigInt(Math.trunc(input)));
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;
    try {
      if (/^0x[0-9a-f]+$/i.test(s)) return _u64(BigInt(s));
      if (/^\d+$/.test(s)) return _u64(BigInt(s));
    } catch { /* fall through to hashing */ }
    return _fnv1a64(s);
  }
  return null;
}

// deterministic mode is seed-INDEPENDENT by design: a pinned constant so any tester gets the same
// bytes without knowing a seed. `seeded` mode gets a fixed default so it's reproducible out of the box.
const DETERMINISTIC_SEED = 0xD37E4211n;
const SEEDED_DEFAULT = 0x5A0E5EEDn;
const JOURNAL_CAP = 512;
const _LOG = /^(1|true|yes|on)$/i.test(String(process.env.ZOE_ENTROPY_LOG || ''));

// ── module state (per-process; a restart re-resolves the seed) ─────────────────────────────────────
let _masterSeed = null;      // BigInt once resolved
let _mode = 'prod';
const _lanes = new Map();     // lane name → { state: BigInt }
let _seq = 0;                 // monotonic decision counter (for the journal)
const _journal = [];          // capped ring of {seq, lane, dist, out}
let _onSample = null;         // optional per-decision hook
let _seedLogged = false;

function _normMode(x) {
  const s = String(x || '').toLowerCase();
  return (s === 'prod' || s === 'seeded' || s === 'deterministic') ? s : null;
}

function _cryptoSeed() {
  try { return _u64(require('crypto').randomBytes(8).readBigUInt64BE(0)); }
  catch { return _u64(BigInt(Date.now()) ^ GOLDEN); }   // last-resort; prod-only path
}

function _logSeedOnce() {
  if (_seedLogged) return;
  _seedLogged = true;
  try {
    const hex = '0x' + _masterSeed.toString(16);
    console.log(`[entropy] mode=${_mode} seed=${hex} — set ZOE_ENTROPY_SEED=${hex} to replay this session`);
  } catch { /* never let logging break a draw */ }
}

// Resolve mode + master seed. `fromBoot` also consults the environment (configure() overrides win).
function _resolve({ seed, mode } = {}, { fromBoot = false } = {}) {
  const m = _normMode(mode);
  if (m) _mode = m;
  else if (fromBoot) { const em = _normMode(process.env.ZOE_ENTROPY_MODE); if (em) _mode = em; }

  let s = (seed !== undefined) ? _normalizeSeed(seed) : undefined;
  if (s === undefined && fromBoot) s = _normalizeSeed(process.env.ZOE_ENTROPY_SEED);

  if (s != null) _masterSeed = s;
  else if (_mode === 'deterministic') _masterSeed = DETERMINISTIC_SEED;
  else if (_mode === 'seeded') _masterSeed = SEEDED_DEFAULT;
  else { _masterSeed = _cryptoSeed(); if (fromBoot) _logSeedOnce(); }

  _lanes.clear(); _seq = 0; _journal.length = 0;   // a new seed re-primes every sub-stream
  return { seed: _masterSeed, mode: _mode };
}

function _master() { if (_masterSeed == null) _resolve({}, { fromBoot: true }); return _masterSeed; }
function _isDet() { _master(); return _mode === 'deterministic'; }

function _laneState(lane) {
  let st = _lanes.get(lane);
  if (!st) { st = { state: _u64(_master() ^ _fnv1a64(lane)) }; _lanes.set(lane, st); }
  return st;
}

// one raw draw in [0,1) from the lane's sub-stream (top 53 bits of a splitmix64 output).
function _next01(lane) {
  const st = _laneState(lane);
  const r = _splitmix64(st.state);
  st.state = r.state;
  return Number(r.value >> 11n) / TWO53;
}

function _requireLane(lane) {
  if (!lane || typeof lane !== 'string') throw new Error('[entropy] every draw must name a lane (non-empty string)');
  return lane;
}

function _log(lane, dist, out) {
  _seq++;
  const entry = { seq: _seq, lane, dist, out };
  _journal.push(entry);
  if (_journal.length > JOURNAL_CAP) _journal.shift();
  if (_onSample) { try { _onSample(entry); } catch { /* a bad hook never breaks a draw */ } }
  if (_LOG) { try { console.log(`[entropy] #${_seq} ${lane} ${dist} → ${out}`); } catch {} }
}

// ── raw stream (does NOT collapse in deterministic mode — pinned-seed PRNG, always advancing) ───────
function float(lane) {
  _requireLane(lane);
  const v = _next01(lane);
  _log(lane, 'float', v);
  return v;
}

// a Math.random-compatible () => [0,1) bound to a lane. This is the drop-in for an injectable `rng`.
function stream(lane) {
  _requireLane(lane);
  return () => float(lane);
}

// ── semantic helpers (collapse to a canonical branch in deterministic mode) ────────────────────────
function int(lane, lo, hi) {
  _requireLane(lane);
  lo = Math.ceil(Number(lo)); hi = Math.floor(Number(hi));
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const out = _isDet() ? Math.floor((lo + hi) / 2) : (lo + Math.floor(_next01(lane) * (hi - lo + 1)));
  _log(lane, 'int', out);
  return out;
}

function pick(lane, arr) {
  _requireLane(lane);
  if (!Array.isArray(arr) || !arr.length) { _log(lane, 'pick', 'empty'); return undefined; }
  const i = _isDet() ? 0 : Math.floor(_next01(lane) * arr.length);
  _log(lane, 'pick', `[${i}/${arr.length}]`);
  return arr[i];
}

function bernoulli(lane, p) {
  _requireLane(lane);
  p = Math.max(0, Math.min(1, Number(p) || 0));
  const out = _isDet() ? (p >= 0.5) : (_next01(lane) < p);
  _log(lane, 'bernoulli', `${out}(p=${p})`);
  return out;
}

function jitter(lane, base, spread) {
  _requireLane(lane);
  base = Number(base) || 0; spread = Math.abs(Number(spread) || 0);
  const out = _isDet() ? base : base + (_next01(lane) * 2 - 1) * spread;
  _log(lane, 'jitter', out);
  return out;
}

function _argmax(items, sc) { let bi = 0; for (let i = 1; i < items.length; i++) if (sc(items[i]) > sc(items[bi])) bi = i; return bi; }
function _scoreFn(score) { return typeof score === 'function' ? score : (x) => Number(x) || 0; }

// ε explore the pool, else exploit the argmax. Deterministic → always the greedy pick.
function epsilonGreedy(lane, items, { epsilon = 0.1, score } = {}) {
  _requireLane(lane);
  if (!Array.isArray(items) || !items.length) { _log(lane, 'epsilonGreedy', 'empty'); return undefined; }
  const sc = _scoreFn(score);
  let i;
  if (_isDet()) i = _argmax(items, sc);
  else if (_next01(lane) < epsilon) i = Math.floor(_next01(lane) * items.length);   // explore
  else i = _argmax(items, sc);                                                       // exploit
  _log(lane, 'epsilonGreedy', `[${i}/${items.length}]`);
  return items[i];
}

// sample ∝ exp(score/τ). Deterministic → argmax (the τ→0 limit).
function softmax(lane, items, { tau = 1, score } = {}) {
  _requireLane(lane);
  if (!Array.isArray(items) || !items.length) { _log(lane, 'softmax', 'empty'); return undefined; }
  const sc = _scoreFn(score);
  if (_isDet()) { const bi = _argmax(items, sc); _log(lane, 'softmax', `[${bi}/${items.length}]det`); return items[bi]; }
  const t = Number(tau) || 1e-6;
  const ws = items.map((x) => Math.exp(sc(x) / t));
  const sum = ws.reduce((a, b) => a + b, 0) || 1;
  let r = _next01(lane) * sum, i = 0;
  for (; i < items.length; i++) { r -= ws[i]; if (r <= 0) break; }
  if (i >= items.length) i = items.length - 1;
  _log(lane, 'softmax', `[${i}/${items.length}]`);
  return items[i];
}

// the LLM-temperature lever: the real temp normally, 0 (greedy) in deterministic mode so model output
// is byte-reproducible. Migrating hardcoded temps to entropy.temperature(lane, base) collapses them all.
function temperature(lane, base) {
  _requireLane(lane);
  const out = _isDet() ? 0 : Number(base);
  _log(lane, 'temperature', out);
  return out;
}

// ── control surface ────────────────────────────────────────────────────────────────────────────────
function configure({ seed, mode, onSample } = {}) {
  if (onSample !== undefined) _onSample = (typeof onSample === 'function') ? onSample : null;
  if (seed === undefined && mode == null) { _master(); return { seed: _masterSeed, mode: _mode }; }
  return _resolve({ seed, mode }, { fromBoot: false });
}
function reseed(seed) { return _resolve({ seed }, { fromBoot: false }); }
function getSeed() { return _master(); }
function getMode() { _master(); return _mode; }
function journal() { return _journal.slice(); }
function clearJournal() { _journal.length = 0; _seq = 0; }

module.exports = {
  float, int, pick, bernoulli, jitter, epsilonGreedy, softmax, temperature, stream,
  configure, reseed, getSeed, getMode, journal, clearJournal,
  // exposed for the smoke / firewall self-check:
  _fnv1a64, _splitmix64, _normalizeSeed, DETERMINISTIC_SEED, SEEDED_DEFAULT,
};
