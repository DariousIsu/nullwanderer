/* smoke_encounters.js — the encounter log and per-claim-class grading.
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2, §5, §6, §7.
 *
 * The load-bearing tests are the ones where a grade must be WITHHELD: an inflated grade is worse than a
 * missing one because it looks rigorous. Specifically — re-scanning a document must not cast a second
 * vote, interpretive claims must never be graded as truth, and a pile of weak sources must never
 * dethrone a well-attested one.
 *
 * Runs against an in-memory database so it can never touch sq.db.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_encounters.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const src = (n, host, text, extra = {}) => ({
  object_type: 'person', object_label: n, source_kind: 'document',
  source_ref: `doc:${host}:${text}`, origin_host: host, content_hash: require('../lib/origin').contentHash(text),
  ...extra,
});

// ── identity ─────────────────────────────────────────────────────────────────────────────────────
ok(enc.objectKey('person', 'Melissa  Bosch') === enc.objectKey('person', 'melissa bosch.'),
  'whitespace/case/punctuation converge on one key');
ok(enc.objectKey('person', 'A B') !== enc.objectKey('place', 'A B'), 'type is part of identity');
ok(enc.objectKey('person', '') === null && enc.objectKey('person', null) === null, 'empty label → no key');

// ── write ────────────────────────────────────────────────────────────────────────────────────────
ok(enc.record({ ...src('Ann Roe', 'a.gov', 't1'), claim_class: 'existence' }) > 0, 'an encounter records');
ok(enc.record({ object_type: 'person', object_label: 'X', claim_class: 'nonsense' }) === null,
  'an unknown claim class is refused, not silently stored');
ok(enc.record({ claim_class: 'existence' }) === null, 'no object → refused');

// THE IDEMPOTENCE RULE (§3): a document may never corroborate a claim it is itself the origin of.
{
  const again = enc.record({ ...src('Ann Roe', 'a.gov', 't1'), claim_class: 'existence' });
  ok(again === 0, 'CRITICAL: re-recording the same source+claim is a no-op, not a second vote');
  ok(enc.forObject(enc.objectKey('person', 'Ann Roe')).length === 1,
    'CRITICAL: re-scanning a document does not inflate the count');
}

// ── independence flows through to the grade ──────────────────────────────────────────────────────
{
  const key = enc.objectKey('person', 'Bea Poe');
  // Three DIFFERENT publishers, three different texts = three real sources.
  for (const [h, t] of [['a.com', 't1'], ['b.org', 't2'], ['c.net', 't3']]) {
    enc.record({ ...src('Bea Poe', h, t), claim_class: 'contact', claim_key: 'email', claim_value: 'bea@x.gov' });
  }
  const g = enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'email' });
  ok(g.grade === 'A' && g.sources === 3, `3 independent sources on a contact → A (got ${g.grade}/${g.sources})`);
  ok(g.contested === false, 'one value, no rival');
}
{
  // The same claim carried by five sites from one wire story is ONE source, and must not reach A.
  const key = enc.objectKey('person', 'Cal Doe');
  for (const h of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']) {
    enc.record({ ...src('Cal Doe', h, 'one wire story'), claim_class: 'contact', claim_key: 'email', claim_value: 'cal@x.gov' });
  }
  const g = enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'email' });
  ok(g.sources === 1 && g.grade === 'C',
    `CRITICAL: 5 outlets carrying 1 text is 1 source → C, not A (got ${g.grade}/${g.sources})`);
}
{
  // Unknown provenance — most of the legacy corpus. Held at the floor and FLAGGED, never zeroed.
  const key = enc.objectKey('person', 'Dee Foe');
  for (const t of ['t1', 't2', 't3']) {
    enc.record({ object_type: 'person', object_label: 'Dee Foe', claim_class: 'existence',
      source_kind: 'document', source_ref: `doc:legacy:${t}`, content_hash: require('../lib/origin').contentHash(t) });
  }
  const g = enc.gradeClaim(key, { claimClass: 'existence' });
  ok(g.sources === 1 && g.unproven === true,
    'CRITICAL: unknown origins floor at 1 and flag unproven — evidence never erased, never invented');
}

// ── the ladders differ per class (§5) ────────────────────────────────────────────────────────────
{
  const rows1 = [{ origin_host: 'a.gov', content_hash: 'h1', authority: 'official' }];
  const rows2 = rows1.concat([{ origin_host: 'b.com', content_hash: 'h2', authority: 'ordinary' }]);
  ok(enc.gradeValue('biographical', rows1).grade === 'A-', 'biographical: official record alone = A-');
  ok(enc.gradeValue('biographical', rows2).grade === 'A+', 'biographical: official + 1 = A+');
  // The SAME evidence grades lower for contact, because contact decays and documents cannot prove a
  // number still rings. This is the divergence Lucas was explicit about.
  ok(enc.gradeValue('contact', rows2).grade === 'A-', 'contact: official + 1 = A-, NOT A+');
  ok(enc.gradeValue('contact', [{ authority: 'verified', origin_host: 'a.gov', content_hash: 'h1' }]).grade === 'A+',
    'contact: only VERIFICATION reaches A+ — one live check outranks any number of documents');
  const three = ['a', 'b', 'c'].map((x) => ({ origin_host: `${x}.com`, content_hash: x, authority: 'ordinary' }));
  ok(enc.gradeValue('contact', three).grade === 'A' && enc.gradeValue('biographical', three).grade === 'B+',
    'CRITICAL: 3 ordinary sources = A for contact but only B+ for biography — different ladders, same evidence');
}

// ── the OPERATOR is a source class (Lucas handing her a document) ────────────────────────────────
{
  // A drop has no URL and never will. Its provenance is still KNOWN, and better than most of the web,
  // so it must not fall through to `unknown` — the highest-authority material in the system would
  // otherwise grade lowest.
  const opRow = [{ authority: 'operator', content_hash: 'h1' }];
  ok(enc.gradeValue('biographical', opRow).grade === 'A-',
    'CRITICAL: an operator-dropped document grades like an official record, not like an unknown one');
  ok(enc.gradeValue('biographical', [{ authority: 'unknown', content_hash: 'h1' }]).grade === 'C',
    '…which an unattributed document does not');
  ok(enc.record({ object_type: 'document', object_label: 'Memo A', claim_class: 'existence',
    source_kind: 'canvas_drop', source_ref: 'drop:tab1', authority: 'operator' }) > 0,
    'a dropped document is recorded as an encountered OBJECT (§3: both object and source)');
  ok(enc.gradeClaim(enc.objectKey('document', 'Memo A'), { claimClass: 'existence' }).official === true,
    'and reads as an authoritative source');
}

// ── INTERPRETIVE claims are never graded as truth (§5e) ──────────────────────────────────────────
{
  const key = enc.objectKey('event', 'Speech 1');
  for (const [h, t] of [['a.com', 't1'], ['b.org', 't2'], ['c.net', 't3'], ['d.io', 't4']]) {
    enc.record({ object_type: 'event', object_label: 'Speech 1', claim_class: 'interpretive',
      claim_key: 'about', claim_value: 'election integrity',
      source_kind: 'news', source_ref: `n:${h}`, origin_host: h, content_hash: require('../lib/origin').contentHash(t) });
  }
  const g = enc.gradeClaim(key, { claimClass: 'interpretive', claimKey: 'about' });
  ok(g.grade === null,
    'CRITICAL: 4 sources agreeing on an interpretation yields NO grade — consensus of summarisers is not a fact');
  ok(g.characterizations === 4, 'it is stored as "N sources characterized it this way" — a fact about discourse');
}

// ── conflicts: grade gates replacement, nothing is deleted (§7) ──────────────────────────────────
{
  const key = enc.objectKey('person', 'Eve Coe');
  // A well-attested official title…
  enc.record({ ...src('Eve Coe', 'a.gov', 'r1', { authority: 'official' }), claim_class: 'biographical', claim_key: 'title', claim_value: 'Parish President' });
  enc.record({ ...src('Eve Coe', 'b.org', 'r2'), claim_class: 'biographical', claim_key: 'title', claim_value: 'Parish President' });
  // …against a single weak blog.
  enc.record({ ...src('Eve Coe', 'blog.example', 'r3'), claim_class: 'biographical', claim_key: 'title', claim_value: 'Council Member' });
  const g = enc.gradeClaim(key, { claimClass: 'biographical', claimKey: 'title' });
  ok(g.value === 'Parish President' && g.grade === 'A+',
    `CRITICAL: the best-attested claim leads — a weak source cannot outrank a well-sourced one (got ${g.value})`);
  ok(g.values.length === 2 && g.values[1].value === 'Council Member', 'both values survive with their own grades');
  // Biography ACCUMULATES (§5b) — holding two titles is history, not disagreement.
  ok(g.contested === false && g.multi === true,
    'CRITICAL: a second biographical title is accumulation, NOT a conflict');
  ok(g.cleaning === false, 'and therefore never spends a cleaning-research pass');
}
{
  // The live case that caught this: Bobby Wilson is `WARD 1` AND `CATAHOULA PARISH POLICE JURY`. Both
  // true. Structural edges are plural, so competing them against each other is a modelling error.
  const key = enc.objectKey('person', 'Hal Roe');
  enc.record({ ...src('Hal Roe', 'a.gov', 'r1'), claim_class: 'structural', claim_key: 'affiliated_with', claim_value: 'WARD 1' });
  enc.record({ ...src('Hal Roe', 'b.gov', 'r2'), claim_class: 'structural', claim_key: 'affiliated_with', claim_value: 'PARISH POLICE JURY' });
  const g = enc.gradeClaim(key, { claimClass: 'structural', claimKey: 'affiliated_with' });
  ok(g.contested === false && g.multi === true && g.values.length === 2,
    'CRITICAL: two affiliations are both held, never contested');
}
{
  // …but a phone number CAN only be one thing, so contact still conflicts. Same shape, opposite answer.
  const key = enc.objectKey('person', 'Ida Coe');
  enc.record({ ...src('Ida Coe', 'a.gov', 'r1'), claim_class: 'contact', claim_key: 'phone', claim_value: '555-1' });
  enc.record({ ...src('Ida Coe', 'b.gov', 'r2'), claim_class: 'contact', claim_key: 'phone', claim_value: '555-2' });
  ok(enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'phone' }).contested === true,
    'CRITICAL: contact is single-truth — two phone numbers DO compete');
}
{
  // The cleaning FLOOR: two unresearched C claims are not a dispute worth verifying, they are an object
  // nobody has looked at — which the low grade already says.
  const key = enc.objectKey('person', 'Jay Poe');
  enc.record({ ...src('Jay Poe', 'a.com', 'r1'), claim_class: 'contact', claim_key: 'email', claim_value: 'a@x.gov' });
  enc.record({ ...src('Jay Poe', 'b.com', 'r2'), claim_class: 'contact', claim_key: 'email', claim_value: 'b@x.gov' });
  const g = enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'email' });
  ok(g.contested === true && g.cleaning === false,
    'CRITICAL: C vs C is retained but does not trigger a research pass');
}
{
  // Two comparable claims IS a real dispute — this is the one that should trigger the cleaning phase.
  const key = enc.objectKey('person', 'Fay Loe');
  for (const [h, t] of [['a.com', 't1'], ['b.org', 't2'], ['c.net', 't3']]) {
    enc.record({ ...src('Fay Loe', h, t), claim_class: 'contact', claim_key: 'phone', claim_value: '555-0001' });
  }
  for (const [h, t] of [['d.com', 't4'], ['e.org', 't5'], ['f.net', 't6']]) {
    enc.record({ ...src('Fay Loe', h, t), claim_class: 'contact', claim_key: 'phone', claim_value: '555-0002' });
  }
  const g = enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'phone' });
  ok(g.cleaning === true, 'CRITICAL: two equally-attested values flag for a cleaning pass');
  ok(g.contested === true && g.values.length === 2, 'both retained, side by side, with their sources');
}
{
  // Contact DECAYS: at equal grade the newer source wins. Biography does not work this way.
  const key = enc.objectKey('person', 'Gus Moe');
  enc.record({ ...src('Gus Moe', 'a.com', 't1', { observed_at: 1000 }), claim_class: 'contact', claim_key: 'email', claim_value: 'old@x.gov' });
  enc.record({ ...src('Gus Moe', 'b.com', 't2', { observed_at: 9000 }), claim_class: 'contact', claim_key: 'email', claim_value: 'new@x.gov' });
  ok(enc.gradeClaim(key, { claimClass: 'contact', claimKey: 'email' }).value === 'new@x.gov',
    'contact: equal grades → the newer supersedes');
}

// ── profile + stats ──────────────────────────────────────────────────────────────────────────────
{
  const p = enc.profile(enc.objectKey('person', 'Eve Coe'));
  ok(p && p.type === 'person' && p.claims.length >= 1, 'profile assembles the object from its log');
  ok(enc.profile('person:nobody at all') === null, 'an object never encountered has no profile');
  ok(enc.stats().encounters > 0 && enc.stats().objects > 0, 'stats report the log');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
