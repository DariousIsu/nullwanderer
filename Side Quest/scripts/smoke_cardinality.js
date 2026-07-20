/* smoke_cardinality.js — P5 per-body cardinality (seat counts).
 *
 * The load-bearing tests are the REFUSALS. A seat count is a claim about the world, and a wrong one
 * is harmful in BOTH directions: too high manufactures phantom gaps that can never close, too low
 * declares a roster finished while members are missing. So: no source → refused, implausible value →
 * refused, and an unknown cardinality makes NO completeness claim rather than a convenient guess.
 */
'use strict';
const c = require('../lib/cardinality');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── plausibility — a bad parse must never become an authoritative-looking number ────────────────
ok(c.isPlausible(70) === true, '70 seats → plausible');
ok(c.isPlausible(400) === true, '400 (NH House, the real maximum) → plausible');
ok(c.isPlausible(0) === false, '0 → implausible (a parse failure, not a body)');
ok(c.isPlausible(-5) === false, 'negative → implausible');
ok(c.isPlausible(2026) === false, 'CRITICAL: a YEAR must not pass as a seat count');
ok(c.isPlausible(1.5) === false, 'fractional → implausible');
// Numeric strings ARE accepted (a count from text/JSON arrives as "70"); the bounds still apply
// after coercion, which is what keeps the guard meaningful.
ok(c.isPlausible('70') === true, 'numeric string → coerced and accepted');
ok(c.isPlausible('2026') === false, 'CRITICAL: a year as a STRING is still rejected by the bounds');
ok(c.isPlausible('7 seats') === false, 'unparseable string → NaN → rejected');
ok(c.isPlausible('') === false, 'empty string → 0 → rejected');
ok(c.isPlausible(null) === false && c.isPlausible(undefined) === false, 'null/undefined → implausible');

// ── validate — a seat count REQUIRES a source ──────────────────────────────────────────────────
ok(c.validate({ seats: 70 }).ok === false, 'CRITICAL: no source → refused');
ok(/needs one|no source/i.test(c.validate({ seats: 70 }).reason), 'refusal explains why');
ok(c.validate({ seats: 70, sourceKind: 'inferred', sourceRef: 'the model said so' }).ok === false,
  'CRITICAL: "inferred" is NOT an admissible source — we never guess a cardinality');
ok(c.validate({ seats: 70, sourceKind: 'official' }).ok === false, 'source kind without a ref → refused');
ok(c.validate({ seats: 70, sourceKind: 'official', sourceRef: 'idaho.gov/legislature' }).ok === true,
  'official + ref → admissible');
ok(c.validate({ seats: 2026, sourceKind: 'official', sourceRef: 'x' }).ok === false,
  'a perfect source cannot rescue an implausible value');

// ── conflicts: surfaced, never silently resolved ───────────────────────────────────────────────
{
  const prev = { seats: 70, source_kind: 'official' };
  ok(c.shouldReplace(null, { seats: 70, sourceKind: 'secondary' }).replace === true, 'no incumbent → store');
  const same = c.shouldReplace(prev, { seats: 70, sourceKind: 'secondary' });
  ok(same.replace === false && same.agrees === true && same.conflict === false, 'same value → agrees, no conflict');
  const weaker = c.shouldReplace(prev, { seats: 105, sourceKind: 'secondary' });
  ok(weaker.replace === false && weaker.conflict === true,
    'CRITICAL: a weaker source disagreeing does NOT overwrite — incumbent stands, conflict flagged');
  const better = c.shouldReplace({ seats: 70, source_kind: 'secondary' }, { seats: 105, sourceKind: 'official' });
  ok(better.replace === true && better.conflict === true, 'a strictly better source supersedes, still flags the conflict');
  const equal = c.shouldReplace(prev, { seats: 105, sourceKind: 'official' });
  ok(equal.replace === false && equal.conflict === true, 'equal-strength disagreement → keep incumbent, flag it');
}

// ── reconcile — the payoff, and its honest unknown ─────────────────────────────────────────────
{
  const r = c.reconcile({ seats: 70, held: 41 });
  ok(r.known === true && r.missing === 29, 'THE PAYOFF: 70 seats, 41 held → 29 missing (arithmetic, not inference)');
  ok(r.complete === false && /29 missing/.test(r.text), 'renders the countable gap');

  const done = c.reconcile({ seats: 70, held: 70 });
  ok(done.complete === true && done.missing === 0 && /all 70/.test(done.text), 'all seats filled → complete');

  const unknown = c.reconcile({ held: 41 });
  ok(unknown.known === false, 'unknown cardinality → known:false');
  ok(unknown.complete === null && unknown.missing === null,
    'CRITICAL: unknown size makes NO completeness claim (null, not false, not true)');
  ok(/cannot be stated/i.test(unknown.text), 'unknown says so plainly rather than guessing');

  const over = c.reconcile({ seats: 70, held: 75 });
  ok(over.over === true && over.complete === false,
    'CRITICAL: holding MORE than the seat count is NOT complete — it means duplicates or a stale count');
  ok(/duplicates|stale/i.test(over.text), 'over-count names the likely cause instead of reporting a tidy 100%');

  ok(c.reconcile({ seats: 70, held: -3 }).held === 0, 'negative held clamps to 0');
  ok(c.reconcile({}).known === false, 'empty input → unknown, never throws');
}

// ── db edge is fail-soft with no db initialised ────────────────────────────────────────────────
ok(c.get('nobody') === null, 'get with no db → null, never throws');
ok(c.record('x', { seats: 70 }).ok === false, 'record without a source → refused before touching the db');
ok(Array.isArray(c.conflicts()), 'conflicts() with no db → [], never throws');
ok(c.gapFor('unknown-body', 5).known === false, 'gapFor an unknown body → honest unknown');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
