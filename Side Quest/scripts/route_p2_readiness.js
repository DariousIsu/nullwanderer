/* scripts/route_p2_readiness.js — the P2 GO/NO-GO analysis.
 *
 * P1 derives route templates and reports a savings CEILING. A ceiling is not a reason to build
 * replay. Minton's utility rule says a route library with a low hit rate is a net TAX — match cost
 * is paid on every attempt including misses, while savings are collected only on hits. So before
 * building the risky part (serving a remembered path instead of asking), measure from data already
 * collected whether replay would actually pay.
 *
 * Three questions, answered from the local log only (no engine calls — this must be runnable while
 * the companion is live without competing for the engine or GPU):
 *
 *   1. STABILITY — does a route return the same KIND of answer every time? A route whose tail is
 *      reliably a hit is replayable. One whose tail flips between hit and miss is not: replaying it
 *      would serve an answer that was only sometimes right. This is the single most important
 *      input, and it is the one the ceiling number completely ignores.
 *   2. WASTE — routes whose tail reliably MISSES. These are not caching opportunities at all; they
 *      are work to stop doing. P1 surfaced this accidentally and it may be worth more than replay.
 *   3. REALISTIC SAVINGS — the ceiling restricted to routes that are actually stable AND
 *      cross-episode. This is the number the go/no-go should be argued from.
 *
 * Read-only. Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/route_p2_readiness.js [hours]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const rd = require('../lib/route_derive');

const HOURS = Number(process.argv[2]) || 24;
const STABLE_AT = 0.90;      // tail-hit rate at/above which a route is "reliably lands"
const FUTILE_AT = 0.70;      // tail-miss rate at/above which a route is "reliably empty"
const MIN_N = 5;             // below this, a rate is noise

db.init();
const d = db.getDb();
const since = Date.now() - HOURS * 3600 * 1000;

const rows = d.prepare(
  `SELECT id, focus_id, tool, arg_shape, outcome, latency_ms, seq, parent_id
   FROM route_obs WHERE ts > ? AND seq IS NOT NULL ORDER BY ts`).all(since);

if (!rows.length) { console.log('No linked observations in window.'); process.exit(0); }

const rep = rd.derive(rows);
const t = rep.templates.filter(x => x.count >= MIN_N);

const tailRate = (x, k) => (x.tail.hit + x.tail.miss + x.tail.err) ? x[k === 'hit' ? 'tail' : 'tail'][k] / (x.tail.hit + x.tail.miss + x.tail.err) : 0;
const hitRate = (x) => tailRate(x, 'hit');
const missRate = (x) => tailRate(x, 'miss');

const stable = t.filter(x => hitRate(x) >= STABLE_AT);
const futile = t.filter(x => missRate(x) >= FUTILE_AT);
const mixed = t.filter(x => hitRate(x) < STABLE_AT && missRate(x) < FUTILE_AT);

console.log(`\nP2 GO/NO-GO — last ${HOURS}h, ${rep.linkedObservations} linked obs, ${rep.chains} chains`);
console.log(`${'='.repeat(78)}`);
console.log(`templates with n>=${MIN_N}: ${t.length}   (stable ${stable.length} | futile ${futile.length} | mixed ${mixed.length})`);

// ── 1. STABLE + CROSS-EPISODE = the actual replay candidates ────────────────────────────────────
const candidates = stable.filter(x => x.crossEpisode);
console.log(`\n1. REPLAY CANDIDATES — tail lands >=${STABLE_AT * 100}% AND recurs across >1 focus`);
if (!candidates.length) console.log('   (none)');
for (const x of candidates.slice(0, 12))
  console.log(`   ${String(x.count).padStart(5)}x  ${x.focusCount} foci  hit ${(100 * hitRate(x)).toFixed(0)}%  ceil ${String(Math.round(x.savingsCeilingMs / 1000)).padStart(5)}s  ${x.key}`);

// ── 2. WASTE — reliably-empty routes. Not a cache target; a stop-doing-this target. ─────────────
console.log(`\n2. FUTILE ROUTES — tail is EMPTY >=${FUTILE_AT * 100}% of the time (work to ELIMINATE, not cache)`);
if (!futile.length) console.log('   (none)');
let futileMs = 0, futileN = 0;
for (const x of futile) { futileMs += x.totalMs; futileN += x.count; }
for (const x of futile.slice(0, 12))
  console.log(`   ${String(x.count).padStart(5)}x  miss ${(100 * missRate(x)).toFixed(0)}%  ${String(Math.round(x.totalMs / 1000)).padStart(5)}s spent  ${x.key}`);
console.log(`   → ${futileN} chains, ${Math.round(futileMs / 1000)}s spent on routes that reliably return nothing`);

// ── 3. MIXED — the replay HAZARD. Same path, different answer-kind: caching these serves an ──────
//    answer that was only sometimes right.
console.log(`\n3. MIXED-OUTCOME ROUTES — replay HAZARD (same path, inconsistent result)`);
if (!mixed.length) console.log('   (none)');
for (const x of mixed.slice(0, 8))
  console.log(`   ${String(x.count).padStart(5)}x  hit ${(100 * hitRate(x)).toFixed(0)}% / miss ${(100 * missRate(x)).toFixed(0)}%  ${x.key}`);

// ── the verdict ─────────────────────────────────────────────────────────────────────────────────
const ceilAll = rep.templates.reduce((a, x) => a + x.savingsCeilingMs, 0);
const ceilReal = candidates.reduce((a, x) => a + x.savingsCeilingMs, 0);
console.log(`\n${'='.repeat(78)}\nVERDICT INPUTS`);
console.log(`  raw ceiling (all templates) .................. ${Math.round(ceilAll / 1000)}s`);
console.log(`  ceiling restricted to STABLE + CROSS-EPISODE .. ${Math.round(ceilReal / 1000)}s  ← argue P2 from THIS`);
console.log(`  waste recoverable by ELIMINATION instead ...... ${Math.round(futileMs / 1000)}s`);
console.log(`
  Replay must beat its own match cost on every attempt (Minton). The stable+cross-episode figure is
  still an upper bound — it assumes zero invalidation. If elimination recovers comparable time with
  none of replay's staleness risk, do that FIRST and re-judge replay afterwards.`);
process.exit(0);
