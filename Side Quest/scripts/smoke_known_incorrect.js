/* smoke_known_incorrect.js — the inoculation record (§7).
 *
 * "Nothing is deleted, ever. A refuted claim stays, marked." The encounter log is append-only, so a
 * disproven value never leaves it — which is the problem, not the solution. Left alone it keeps being
 * re-encountered and re-learned by the next sweep, with no memory that it was already tested and failed.
 *
 * The two rules under test, and they pull against each other:
 *   REFUTED IS NOT STALE — an old address superseded by a newer one was TRUE when written (§5a decay).
 *   REFUTED CANNOT WIN   — ten documents repeating a bounced address make it a widely-published
 *                          mistake, not a deliverable one.
 *
 * Runs against an in-memory database.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_known_incorrect.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const ki = require('../lib/known_incorrect');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const KEY = enc.objectKey('person', 'Karen Knutson');
const BAD = 'karen.knutson@nexteraenergy.com';
const GOOD = 'kknutson@nexteraenergy.com';

// ── recording demands EVIDENCE ───────────────────────────────────────────────────────────────────
ok(ki.record({ objectKey: KEY, claimClass: 'contact', claimKey: 'email', claimValue: BAD, reason: `${BAD} bounced` }) > 0,
  'a refutation with a reason records');
ok(ki.record({ objectKey: KEY, claimClass: 'contact', claimKey: 'email', claimValue: BAD, reason: 'bounced again' }) === 0,
  'CRITICAL: re-testing the same bad address is not a second refutation');
ok(ki.record({ objectKey: KEY, claimClass: 'contact', claimKey: 'email', claimValue: 'x@y.com' }) === null,
  'CRITICAL: a refutation with NO REASON is refused — that is an opinion, and indistinguishable from decay');
ok(ki.record({ objectKey: KEY, claimClass: 'contact', claimValue: '', reason: 'r' }) === null
  && ki.record({}) === null, 'garbage in → null, never throws');

// ── case is not identity ─────────────────────────────────────────────────────────────────────────
ok(ki.refutedSet(KEY).has(ki.norm('Karen.Knutson@NexteraEnergy.com')),
  'CRITICAL: the same address in different case is the same bounce');
ok(ki.reasonFor(KEY, BAD.toUpperCase()) !== null, 'and the reason is retrievable — "that address bounced" is a useful answer');
ok(ki.reasonFor(KEY, GOOD) === null, 'a live value has no refutation on file');

// ── A REFUTED VALUE CANNOT WIN ───────────────────────────────────────────────────────────────────
{
  const src = (h, t, v) => ({
    object_type: 'person', object_label: 'Karen Knutson', claim_class: 'contact', claim_key: 'email',
    claim_value: v, source_kind: 'document', source_ref: `doc:${h}${t}`,
    origin_host: h, content_hash: require('../lib/origin').contentHash(t), authority: 'ordinary',
  });
  // The bad address is BETTER attested than the good one — three independent sources against one.
  enc.record(src('a.com', 't1', BAD));
  enc.record(src('b.org', 't2', BAD));
  enc.record(src('c.net', 't3', BAD));
  enc.record(src('d.gov', 't4', GOOD));

  const g = enc.gradeClaim(KEY, { claimClass: 'contact', claimKey: 'email' });
  ok(g.value === GOOD,
    `CRITICAL: the single-source LIVE address beats the triple-sourced bounced one (got ${g.value})`);
  ok(g.refuted === false, 'the winning value is not itself refuted');
  // …and the bad one is retained, not deleted — deleting is what lets it walk back in.
  const badRow = g.values.find((v) => v.value === BAD);
  ok(badRow && badRow.refuted === true, 'CRITICAL: the refuted value is RETAINED and marked, never dropped');
  ok(badRow && /bounced/.test(badRow.refutedReason || ''), 'it carries WHY it was refused');
  ok(badRow.sources === 3, 'its evidence is still counted honestly — it was genuinely well attested, and wrong');
}
{
  // Every value refuted: not "unsure" — we KNOW this is wrong and hold no replacement.
  const k2 = enc.objectKey('person', 'Gone Person');
  enc.record({ object_type: 'person', object_label: 'Gone Person', claim_class: 'contact', claim_key: 'email',
    claim_value: 'dead@x.com', source_kind: 'document', source_ref: 'doc:z', origin_host: 'x.com', content_hash: 'h9' });
  ki.record({ objectKey: k2, claimClass: 'contact', claimKey: 'email', claimValue: 'dead@x.com', reason: 'undeliverable' });
  const g = enc.gradeClaim(k2, { claimClass: 'contact', claimKey: 'email' });
  ok(g.refuted === true && /undeliverable/.test(g.refutedReason || ''),
    'CRITICAL: when the leading value is refuted the claim SAYS SO — silence would read as merely unverified');
}

// ── refuting one claim must not touch another ────────────────────────────────────────────────────
{
  const other = enc.objectKey('person', 'Someone Else');
  ok(ki.refutedSet(other).size === 0, 'refutations are scoped to their object');
  ok(ki.refutedSet(KEY, { claimClass: 'biographical' }).size === 0, '…and to their claim class');
  ok(ki.stats().total >= 2 && ki.stats().objects >= 2, 'stats report the store');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
