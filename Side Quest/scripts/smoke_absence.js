/* smoke_absence.js — P3 absence model: three-valued gaps vs asserted absence.
 *
 * The two invariants are the whole point of the module, so they get the most tests:
 *   #3 a failed lookup is ALWAYS `somevalue` and can NEVER auto-promote to `novalue`
 *   #4 first_observed_ts is FROZEN — re-reading a record never refreshes it (RFC 2308)
 * A regression in either one lets "we didn't find it" harden into "it doesn't exist", which is the
 * single worst failure this system can have.
 */
'use strict';
const a = require('../lib/absence');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── classifyLookup — what an outcome MEANS ─────────────────────────────────────────────────────
ok(a.classifyLookup({ found: true }).action === 'close', 'found → close the gap');
ok(a.classifyLookup({ found: false }).action === 'gap', 'not found → gap');
ok(a.classifyLookup({ found: false }).kind === a.KIND.SOME, 'INVARIANT #3: a miss is somevalue, never novalue');
ok(a.classifyLookup({ found: false, errored: true }).action === 'ignore',
  'INVARIANT: an ERROR records NOTHING — infrastructure trouble is not evidence of absence');
ok(a.classifyLookup({ found: true, errored: true }).action === 'ignore', 'error dominates found');

// ── canPromote — the evidentiary bar for asserting novalue ─────────────────────────────────────
ok(a.canPromote({}).ok === false, 'INVARIANT #3: no evidence → cannot promote');
ok(/failed search is not evidence/i.test(a.canPromote({}).reason), 'refusal names the reason plainly');
ok(a.canPromote({ evidenceKind: 'attempts', evidenceRef: '100 tries' }).ok === false,
  'INVARIANT #3: "we looked 100 times" is NOT admissible evidence');
ok(a.canPromote({ evidenceKind: 'timeout', evidenceRef: 'x' }).ok === false, 'a timeout is not evidence');
ok(a.canPromote({ evidenceKind: 'cardinality' }).ok === false, 'evidence kind without a ref is refused');
ok(a.canPromote({ evidenceKind: 'cardinality', evidenceRef: 'board has 7 seats, all 7 named' }).ok === true,
  'cardinality assertion + ref → admissible');
ok(a.canPromote({ evidenceKind: 'completeness-assertion', evidenceRef: 'roster complete as of 2026-01' }).ok === true,
  'completeness assertion → admissible');
ok(a.canPromote({ evidenceKind: 'authoritative-source', evidenceRef: 'parish charter §3: no such office' }).ok === true,
  'authoritative source stating absence → admissible');

// ── applyAttempt — INVARIANT #4, the frozen origin stamp ───────────────────────────────────────
{
  const t1 = 1_000_000;
  const first = a.applyAttempt(null, t1);
  ok(first.kind === a.KIND.SOME && first.attempts === 1, 'first sighting → somevalue, attempts 1');
  ok(first.first_observed_ts === t1 && first.last_attempt_ts === t1, 'first sighting stamps both');

  const t2 = t1 + 5_000_000;
  const second = a.applyAttempt(first, t2);
  ok(second.first_observed_ts === t1,
    'INVARIANT #4: first_observed_ts FROZEN across a re-attempt (never refreshed)');
  ok(second.last_attempt_ts === t2, 'last_attempt_ts DOES move (that is what expiry runs off)');
  ok(second.attempts === 2, 'attempts increments');

  // the RFC 2308 failure mode, stated directly: many re-observations must not make it look new
  let rec = null;
  for (let i = 0; i < 25; i++) rec = a.applyAttempt(rec, t1 + i * 1000);
  ok(rec.first_observed_ts === t1,
    'INVARIANT #4: 25 re-observations still cannot move the origin (no self-refreshing negative)');
  ok(rec.kind === a.KIND.SOME, 'INVARIANT #3: 25 misses is STILL somevalue — repetition never promotes');
}

// ── ttl — absence expires, and backs off, but never parks forever ──────────────────────────────
ok(a.ttlFor(1) === a.DEFAULT_TTL_S, 'first attempt → base TTL');
ok(a.ttlFor(2) > a.ttlFor(1), 'TTL backs off with repeated misses');
ok(a.ttlFor(99) === a.MAX_TTL_S, 'TTL is CAPPED — a gap is never parked forever (that would be novalue by the back door)');

// ── isFresh — expiry runs off last_attempt, not the frozen origin ──────────────────────────────
{
  const now = 10_000_000;
  const fresh = { first_observed_ts: 1, last_attempt_ts: now - 1000, ttl_s: 3600 };
  const stale = { first_observed_ts: 1, last_attempt_ts: now - (4000 * 1000), ttl_s: 3600 };
  ok(a.isFresh(fresh, now) === true, 'recent attempt → fresh');
  ok(a.isFresh(stale, now) === false, 'lapsed TTL → stale (re-check it)');
  ok(a.isFresh(null, now) === false, 'no record → not fresh');
  // the trap: an OLD origin with a RECENT attempt must read as fresh
  ok(a.isFresh({ first_observed_ts: 1, last_attempt_ts: now, ttl_s: 3600 }, now) === true,
    'an ancient origin with a recent attempt is FRESH — expiry must not use the frozen stamp');
}

// ── the DB edge is fail-soft (no db initialised here) ──────────────────────────────────────────
ok(a.recordMiss('x', 'y', { errored: true }) === null, 'recordMiss on an ERROR records nothing');
ok(a.get('nope', 'nope') === null, 'get with no db → null, never throws');
ok(Array.isArray(a.openGaps()), 'openGaps with no db → [] , never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
