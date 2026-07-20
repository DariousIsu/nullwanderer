/* smoke_place_key.js — one identity per place (O2).
 *
 * Almost every test here is a REFUSAL. A false merge is the one unrecoverable failure, and place names
 * are full of pairs that look like duplicates and are not: there are Adams Counties in a dozen states,
 * Washington is a state and a city and thirty-odd counties, and Kansas City is not in Kansas.
 *
 * The single merge this module performs — a state code to its state name — is closed-set and has no
 * second reading. Everything else is case/punctuation folding, which cannot join two things that were
 * genuinely different.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_place_key.js
 */
'use strict';
const pk = require('../lib/place_key');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const same = (a, b) => pk.placeKey(a) === pk.placeKey(b);

// ── THE ONE MERGE: state codes ───────────────────────────────────────────────────────────────────
// Measured live: AL/ALABAMA/Alabama were two objects, AZ/ARIZONA two, AR/ARKANSAS two.
ok(same('AL', 'Alabama') && same('AZ', 'ARIZONA') && same('AR', 'Arkansas'),
  'CRITICAL: a state code and its state name are ONE place');
ok(same('ALABAMA', 'Alabama') && same('  alabama  ', 'Alabama'), 'case and whitespace fold');
ok(same('LA', 'Louisiana') && same('la', 'louisiana'), 'the code is case-insensitive too');
ok(pk.placeKey('DC') === 'district of columbia' && pk.placeKey('PR') === 'puerto rico', 'DC and PR are covered');

// ── THE REFUSALS — every one of these is a real trap ─────────────────────────────────────────────
ok(!same('Adams', 'Adams County'),
  'CRITICAL: "Adams" is not "Adams County" — there are Adams Counties in a dozen states, and Adams alone is as likely a person');
ok(!same('Orange', 'Orange County'), 'CRITICAL: a county is not the thing it is named after');
ok(!same('Washington', 'Washington County'), 'CRITICAL: a state, a city and thirty counties share this name');
ok(!same('Kansas City', 'Kansas'), 'CRITICAL: a city that begins with a state name is not that state');
ok(!same('Acadia', 'Acadia Parish'), 'a parish is not its bare name');
ok(!same('Jefferson Parish', 'Jefferson County'), 'CRITICAL: different division types are different places');
ok(!same('St. Johns, Arizona', 'St. Johns'),
  'CRITICAL: a comma-qualified place stays distinct — dropping the state would merge every St. Johns in the country');
ok(!same('Portland', 'Portland, Oregon'), 'the qualifier is part of the identity, never noise');
ok(!same('Virginia', 'West Virginia'), 'CRITICAL: one name contained in another is not the same place');
ok(!same('North Dakota', 'South Dakota'), 'and neither are siblings');

// ── Saint, but only at the front ─────────────────────────────────────────────────────────────────
ok(same('St. Johns', 'Saint Johns') && same('St Charles Parish', 'Saint Charles Parish'),
  'a leading St. is Saint — the same place written two ways');
ok(same('Ste. Genevieve', 'Sainte Genevieve'), 'Ste. too');
ok(pk.placeKey('Main St.') === 'main st' && pk.placeKey('Main St.') !== 'main saint',
  'CRITICAL: a TRAILING St. is Street — expanding it would rename a road');
ok(!same('St. Louis', 'Saint Paul'), 'expansion does not blur different saints');

// ── divisions are reported, never acted on ───────────────────────────────────────────────────────
ok(pk.isDivision('Adams County') && pk.isDivision('Acadia Parish') && pk.isDivision('City of Sacramento'),
  'division words are recognised');
ok(!pk.isDivision('Alabama') && !pk.isDivision('Portland'), 'a bare place is not a division');
ok(pk.placeKey('Adams County').includes('county'),
  'CRITICAL: the division word is KEPT in the key — stripping it is what would merge Orange with Orange County');

// ── safety helper + edges ────────────────────────────────────────────────────────────────────────
ok(pk.safeToMerge('AZ', 'Arizona') === true, 'safeToMerge agrees on the closed-set case');
ok(pk.safeToMerge('Adams', 'Adams County') === false, 'and refuses the trap');
ok(pk.placeKey('') === null && pk.placeKey(null) === null && pk.placeKey('   ') === null,
  'empty → null, never throws');
ok(pk.placeKey('...') === null, 'punctuation-only → null, not an empty-string object');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
