/* smoke_object_type.js — T3: type is a graded claim (docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §5).
 *
 * The case this exists for, end to end: the LDA feed says Fulton County is an `organization` — loudly,
 * from many filings, and by its own schema's lights truthfully, because in that feed every client is an
 * organization. A single county roster says `government_body`. The roster has to win, the LDA claim has
 * to be KEPT, and nobody may decide it at write time.
 *
 * Runs against an in-memory database.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_object_type.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const ot = require('../lib/object_type');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── the subject is TYPE-FREE, or the claim is circular ───────────────────────────────────────────
ok(ot.typeSubject('Fulton County') === 'name:fulton county', 'the subject is a bare name');
ok(ot.typeSubject('FULTON COUNTY') === ot.typeSubject('fulton  county.'),
  'case, spacing and punctuation converge on one subject');
ok(ot.typeSubject('Duke Energy [Q1264404]') === ot.typeSubject('Duke Energy'),
  'CRITICAL: a strong-id tag is identity, not name — a tagged and untagged row assert about ONE subject');
ok(ot.typeSubject('') === null && ot.typeSubject(null) === null, 'an empty label has no subject');
ok(!ot.typeSubject('Fulton County').startsWith('org:') && !ot.typeSubject('Fulton County').startsWith('gov:'),
  'CRITICAL: the subject carries NO type — hanging it off org:/gov: could only return the type we assumed');

// ── THE FULTON COUNTY CASE ───────────────────────────────────────────────────────────────────────
{
  // The LDA feed, many filings, genuinely independent documents — and ordinary authority.
  for (let i = 0; i < 5; i++) {
    ot.recordType({ label: 'Fulton County', type: 'organization', sourceRef: `lda:${i}`,
      originHost: `filing${i}.example.com`, contentHash: `h${i}`, authority: 'ordinary' });
  }
  const before = ot.typeOf('Fulton County');
  ok(before.type === 'organization', 'with only the LDA feed talking, organization leads — which is honest, not wrong');

  // One county roster.
  ot.recordType({ label: 'Fulton County', type: 'government_body', sourceRef: 'doc:roster',
    originHost: 'fultoncountyga.gov', contentHash: 'roster', authority: 'official' });

  const after = ot.typeOf('Fulton County');
  ok(after.type === 'government_body',
    `CRITICAL: ONE official roster beats FIVE ordinary filings (got ${after.type}) — volume is how loud a feed is, not what a thing is`);
  ok(after.official === true && after.grade === 'A', 'the winner is graded A on a single official source');
  const loser = after.values.find((v) => v.value === 'organization');
  ok(loser && loser.sources === 5,
    'CRITICAL: the LDA claim is RETAINED with its five sources counted honestly — it was well attested, and it lost');
  ok(after.contested === true, 'the claim is marked contested, because a rival genuinely exists');
}

// ── single-truth: a type CONFLICTS, it does not accumulate ───────────────────────────────────────
ok(enc.SINGLE_TRUTH ? enc.SINGLE_TRUTH.has('type') : true, 'type is single-truth where the module exposes it');
{
  const t = ot.typeOf('Fulton County');
  ok(t.values.length === 2 && t.multi !== true, 'two competing values, not two accumulated ones');
}

// ── the cleaning signal: a close rival is NOT settled ────────────────────────────────────────────
{
  // Two official sources disagreeing is a real dispute — and must not silently resolve to whichever
  // landed first. This is the state the 8 labels T1 refused to migrate are in.
  ot.recordType({ label: 'State of Florida', type: 'government_body', sourceRef: 'd1', originHost: 'myflorida.gov', contentHash: 'f1', authority: 'official' });
  ot.recordType({ label: 'State of Florida', type: 'organization', sourceRef: 'd2', originHost: 'other.gov', contentHash: 'f2', authority: 'official' });
  const t = ot.typeOf('State of Florida');
  ok(t.contested && t.cleaning, 'CRITICAL: two official sources disagreeing sets the CLEANING signal — go and verify');
  ok(t.settled === false, 'CRITICAL: and it is NOT settled, so T4 must not act on it');
}
{
  // A TIE IS NOT A WIN — caught by reading the live backfill, not by the suite. `Atkinson County`
  // landed as location(C×1) vs government_body(C×1), where the winner is whichever row the sort left on
  // top. `cleaning` does not fire (two C claims sit below its floor by design), so without this guard
  // `settled` would report an arbitrary coin-flip as an answer — first-writer-wins by another route.
  ot.recordType({ label: 'Atkinson County', type: 'location', sourceRef: 'o1', originHost: 'a.com', contentHash: 'a1', authority: 'ordinary' });
  ot.recordType({ label: 'Atkinson County', type: 'government_body', sourceRef: 'o2', originHost: 'b.com', contentHash: 'a2', authority: 'ordinary' });
  const t = ot.typeOf('Atkinson County');
  ok(t.contested === true && t.cleaning === false, 'two single-source C claims are contested but below the cleaning floor');
  ok(t.settled === false, 'CRITICAL: a dead tie is NOT settled — an arbitrary winner must never read as an answer');
}
{
  // …and one more source breaking the tie DOES settle it.
  ot.recordType({ label: 'Atkinson County', type: 'government_body', sourceRef: 'o3', originHost: 'atkinsonco.gov', contentHash: 'a3', authority: 'official' });
  const t = ot.typeOf('Atkinson County');
  ok(t.type === 'government_body' && t.settled === true, 'evidence breaking the tie settles it, without anyone editing a column');
}
{
  // A lone C is a single source having looked once — not enough to rewrite an object's identity on.
  ot.recordType({ label: 'Thin Evidence Co', type: 'organization', sourceRef: 'z1', originHost: 'z.com', contentHash: 'z1' });
  const t = ot.typeOf('Thin Evidence Co');
  ok(t.type === 'organization' && t.grade === 'C' && t.settled === false,
    'CRITICAL: a single unofficial source is recorded but NOT settled — T4 must not act on a C');
}
{
  // Nobody has said anything at all.
  const t = ot.typeOf('Never Heard Of This');
  ok(t.type === null && t.settled === false, 'an unknown name has no type and is not settled — never guessed');
}
{
  // SAID, not evidenced. Lucas mentioning a name creates the object and proves nothing about its kind.
  ot.recordType({ label: 'Mentioned Thing', type: 'organization', sourceKind: 'conversation', sourceRef: 'turn:1', authority: 'stated' });
  const t = ot.typeOf('Mentioned Thing');
  ok(t.unverified === true && t.settled === false,
    'CRITICAL: a type known only because it was SAID is unverified and unsettled — it is work to do, not an answer');
  ok(t.grade === null, 'and it carries no grade at all, because nobody has looked yet');
}

// ── one clean source IS settled ──────────────────────────────────────────────────────────────────
{
  ot.recordType({ label: 'Apache County', type: 'government_body', sourceRef: 'doc:az', originHost: 'apachecountyaz.gov', contentHash: 'az1', authority: 'official' });
  const t = ot.typeOf('Apache County');
  ok(t.type === 'government_body' && t.settled === true && !t.contested, 'an uncontested official claim is settled');
}

// ── the work list ────────────────────────────────────────────────────────────────────────────────
{
  const c = ot.contested();
  const labels = c.map((x) => x.label);
  ok(labels.includes('State of Florida') && labels.includes('Fulton County'), 'contested() lists the disputes');
  ok(!labels.includes('Apache County'), 'and does not list the settled ones');
}

// ── refusals and garbage ─────────────────────────────────────────────────────────────────────────
ok(ot.recordType({ label: 'X' }) === null && ot.recordType({ type: 'org' }) === null,
  'a claim with no type, or no subject, is refused');
ok(ot.recordType({}) === null && ot.recordType() === null, 'garbage in → null, never throws');
{
  const r = ot.recordMany([{ label: 'A Co', type: 'organization', sourceRef: 's1', originHost: 'a.com', contentHash: 'x' }, {}]);
  ok(r.added === 1 && r.refused === 1, 'recordMany counts what landed and what was refused');
}
{
  // Append-only + idempotent: the same source asserting twice is not two sources.
  ot.recordType({ label: 'Idem Corp', type: 'organization', sourceRef: 'doc:9', originHost: 'i.com', contentHash: 'ic' });
  ot.recordType({ label: 'Idem Corp', type: 'organization', sourceRef: 'doc:9', originHost: 'i.com', contentHash: 'ic' });
  ok(ot.typeOf('Idem Corp').sources === 1, 'CRITICAL: one source asserting twice is still one source');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
