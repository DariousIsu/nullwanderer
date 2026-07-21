/* smoke_mint_type.js — T5: stop minting `concept` for things nobody typed.
 *
 * The bug this closes, in one line: `recordEntity({ name, type = 'concept' })` where the graph-walk's
 * caller never passes a type. 13,033 entities are typed `concept` not because anything decided they
 * were, but because a JavaScript default fired 13,033 times. Lucas asked whether a model or a
 * classification run chose those labels; the answer was neither.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_mint_type.js
 */
'use strict';
const mt = require('../lib/mint_type');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A stand-in for T3's typeOf, so this stays pure.
const lookup = (map) => (name) => map[String(name).toLowerCase()] || { settled: false };

// ── 1. THE CALLER KNOWS — an extractor's type is used as given, with zero inference ──────────────
ok(mt.decideType('Appling County Board', 'government_body').type === 'government_body', 'a supplied type is used as given');
ok(mt.decideType('X', 'GOVERNMENT_BODY').type === 'government_body', 'and normalised to lower case');
ok(mt.decideType('X', 'person').why === 'supplied', 'the reason says it came from the caller');

// ── 2. NOBODY SAID → `unknown`, NEVER `concept` ─────────────────────────────────────────────────
ok(mt.decideType('Some New Thing', undefined).type === 'unknown',
  'CRITICAL: an absent type mints `unknown` — this is the exact default that produced 13,033 concepts');
ok(mt.decideType('Some New Thing', null).type === 'unknown', 'null is also "nobody said"');
ok(mt.decideType('Some New Thing', '').type === 'unknown', 'so is an empty string');
ok(mt.decideType('Some New Thing').why === 'nobody said', 'and it is recorded AS a fallback, not as a decision');
ok(mt.decideType('Some New Thing').type !== 'concept',
  'CRITICAL: `concept` is never the fallback — a claim nobody made is the worst input to an evidence system');

// …but an explicit `concept` is a real assertion and is honoured.
ok(mt.decideType('An Idea', 'concept').type === 'concept' && mt.decideType('An Idea', 'concept').why === 'supplied',
  'CRITICAL: a caller genuinely SAYING concept still gets concept — the fix is about defaults, not the word');

// ── 3. THE EVIDENCE KNOWS (T3) — a settled claim beats guessing ──────────────────────────────────
{
  const l = lookup({ 'fulton county': { settled: true, type: 'government_body', grade: 'A' } });
  const d = mt.decideType('Fulton County', null, { lookup: l });
  ok(d.type === 'government_body', 'CRITICAL: the mint gate ASKS what sources said instead of inventing a type');
  ok(/settled-claim/.test(d.why), 'and says so');
}
{
  // An UNSETTLED claim must not be stamped on a new object — a mint is where a wrong type gets sticky.
  const l = lookup({ 'atkinson county': { settled: false, type: 'location', grade: 'C' } });
  ok(mt.decideType('Atkinson County', null, { lookup: l }).type === 'unknown',
    'CRITICAL: a contested or single-C type is NOT stamped at mint time');
}
{
  // A caller's own assertion still outranks the claim store — rule 1 is first for a reason.
  const l = lookup({ 'x co': { settled: true, type: 'organization', grade: 'A' } });
  ok(mt.decideType('X Co', 'person', { lookup: l }).type === 'person', 'an explicit caller type wins over the claim store');
}
{
  // A lookup that throws must never take the mint down with it.
  const bad = () => { throw new Error('store down'); };
  ok(mt.decideType('Anything', null, { lookup: bad }).type === 'unknown', 'a failing claim store degrades to unknown, never throws');
}

// ── 4. A STRONG ID PROVES IT IS NOT A CONCEPT ────────────────────────────────────────────────────
for (const n of ['GARMIN INTERNATIONAL, INC. [lda_client:59154]', 'Duke Energy [Q1264404]', 'Richard Nixon [N000116]']) {
  const d = mt.decideType(n, null);
  ok(d.type === 'unknown' && /strong-id/.test(d.why),
    `CRITICAL: "${String(n).slice(0, 28)}…" is provably not a concept — a concept has no lobbying-client id`);
}
ok(mt.hasStrongId('Microsoft [Q2283]') && !mt.hasStrongId('Microsoft'), 'strong ids are detected off the label');

// ── placeholders: `unknown` must not be stickier than the `concept` it replaced ──────────────────
ok(mt.isPlaceholder('concept') && mt.isPlaceholder('unknown') && mt.isPlaceholder(''),
  'CRITICAL: `unknown` is a PLACEHOLDER too — a real type must be able to upgrade it');
ok(!mt.isPlaceholder('person') && !mt.isPlaceholder('gov'), 'a real type is not a placeholder');
ok(mt.isPlaceholder(null) && mt.isPlaceholder(undefined), 'absent counts as placeholder');

// ── garbage ──────────────────────────────────────────────────────────────────────────────────────
ok(mt.decideType(null, null).type === 'unknown' && mt.decideType().type === 'unknown', 'garbage in → unknown, never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
