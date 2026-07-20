/* smoke_convo_encounters.js — conversation as an encounter stream (living conversational memory, C1).
 *
 * The load-bearing tests are about EVIDENTIARY WEIGHT. Lucas's rule (2026-07-20): "user input
 * non-validating without documentation — it would still create the object as an unverified and then
 * seek to validate with a real source." So the thing that must never regress is that a name said in
 * conversation creates an object and grades NOTHING, however many times it is said. If that broke, a
 * mis-extracted name would wear the principal's own authority as its evidence, which is worse than
 * not extracting at all.
 */
'use strict';
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_ce_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const ce = require('../lib/convo_encounters');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }
const ON = () => '1', OFF = () => '0';

(async () => {
  // ── the pure shaping ─────────────────────────────────────────────────────────────────────────
  {
    const spans = [
      { text: 'Marcy Delaney', kgType: 'person', score: 0.99 },
      { text: 'Acadia Parish', kgType: 'place', score: 0.95 },
    ];
    const rows = ce.toEncounters(spans, 42);
    ok(rows.length === 2, 'one encounter per distinct object');
    ok(rows.every(r => r.authority === 'stated'), 'SAFETY: every conversational encounter is authority=stated');
    ok(rows.every(r => r.claim_class === 'existence'), 'existence only — we record that it was mentioned, not what was claimed');
    ok(rows.every(r => r.source_ref === 'turn:42' && r.source_kind === 'conversation'), 'sourced to the turn');
    ok(rows.every(r => r.observed_at), 'observed_at set — for conversation the utterance IS the source date');

    // dedup within a turn: saying a name three times is ONE encounter
    const dup = ce.toEncounters([
      { text: 'Marcy Delaney', kgType: 'person' }, { text: 'marcy  delaney', kgType: 'person' }, { text: 'Marcy Delaney', kgType: 'person' },
    ], 43);
    ok(dup.length === 1, 'repeating a name in one turn yields ONE encounter');

    ok(ce.toEncounters([{ text: 'Zoe', kgType: 'person' }, { text: 'Lucas', kgType: 'person' }], 44).length === 0,
      'the participants themselves are not recorded as objects');
    ok(ce.toEncounters([{ text: 'AI', kgType: 'organization' }], 45).length === 0, 'too-short spans dropped');
    ok(ce.toEncounters([{ text: 'Something', kgType: null }], 46).length === 0, 'untyped spans dropped');
    ok(ce.toEncounters(null, 47).length === 0 && ce.toEncounters([], 48).length === 0, 'junk in → [], no throw');
    ok(ce.toEncounters(Array.from({ length: 30 }, (_, i) => ({ text: `Person Number ${i}`, kgType: 'person' })), 49).length === ce.MAX_PER_TURN,
      'capped per turn — a paste is not a conversation');
  }

  // ── flag gate ────────────────────────────────────────────────────────────────────────────────
  {
    let called = false;
    const n = await ce.fromUserTurn(1, 'Marcy Delaney runs the council', { getMeta: OFF, detect: async () => { called = true; return []; } });
    ok(n === 0 && !called, 'flag off → no extraction at all');
  }

  // ── ⭐ THE RULE: stated creates the object and grades NOTHING ─────────────────────────────────
  {
    const detect = async () => [{ text: 'Marcy Delaney', kgType: 'person', score: 0.99 }];
    // said in three separate turns, across three separate "sessions"
    for (const id of [101, 102, 103]) await ce.fromUserTurn(id, 'Marcy Delaney again', { getMeta: ON, detect });

    const key = enc.objectKey('person', 'Marcy Delaney');
    const g = enc.gradeClaim(key, { claimClass: 'existence' });
    ok(g.count === 3, 'all three mentions are recorded — the object is known');
    ok(g.grade === null, 'SAFETY: three conversational mentions grade to NOTHING');
    ok(g.unverified === true, 'SAFETY: flagged unverified — this is work to do, not a fact held');
    ok(g.sources === 0, 'SAFETY: sources=0 — "two sources" can never mean "he said it twice"');
    ok(g.stated === 3, 'the stated count is visible for the go-look-for-it signal');

    // ...and one real document moves it
    enc.record({
      object_type: 'person', object_label: 'Marcy Delaney', claim_class: 'existence',
      claim_value: 'Marcy Delaney', source_kind: 'web', source_ref: 'doc:9',
      origin: 'https://acadiaparish.gov/council', authority: 'official',
    });
    const g2 = enc.gradeClaim(key, { claimClass: 'existence' });
    ok(g2.grade === 'A-', 'ONE official source grades it A- (the stated ones never did)');
    ok(g2.unverified === false, 'no longer unverified once real evidence exists');
    ok(g2.sources === 1, 'only the real source counts toward independence');
  }

  // ── idempotence + failure safety ─────────────────────────────────────────────────────────────
  {
    const detect = async () => [{ text: 'Bobby Wilson', kgType: 'person', score: 0.9 }];
    await ce.fromUserTurn(200, 'Bobby Wilson', { getMeta: ON, detect });
    const before = enc.gradeClaim(enc.objectKey('person', 'Bobby Wilson'), { claimClass: 'existence' }).count;
    await ce.fromUserTurn(200, 'Bobby Wilson', { getMeta: ON, detect });   // same turn replayed
    const after = enc.gradeClaim(enc.objectKey('person', 'Bobby Wilson'), { claimClass: 'existence' }).count;
    ok(before === after, 're-recording the same turn is idempotent, not inflationary');

    const n = await ce.fromUserTurn(300, 'anything', { getMeta: ON, detect: async () => { throw new Error('model down'); } });
    ok(n === 0, 'SAFETY: a failing extractor returns 0 rather than throwing into the turn');
    ok(await ce.fromUserTurn(0, 'no turn id', { getMeta: ON, detect }) === 0, 'no turn id → no-op');
    ok(await ce.fromUserTurn(301, '   ', { getMeta: ON, detect }) === 0, 'empty text → no-op');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
