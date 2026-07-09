/* Smoke: lib/civic_domain — anti-drift denylist filter (offline).
 * Proof: rejects the live off-domain drift the audit found (sports/entertainment),
 * keeps civic entities including tricky ones with club-ish tokens.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_civic_domain.js
 */
'use strict';
const CD = require('../lib/civic_domain');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- REJECT the live drift the audit surfaced ---
ok(!CD.isCivicDomain('Dave Bowen (footballer)'), 'reject: "(footballer)" parenthetical');
ok(!CD.isCivicDomain('Lionel Messi leads Argentina past Egypt in World Cup thriller'), 'reject: World Cup story');
ok(!CD.isCivicDomain('United States coach Mauricio Pochettino reacts to World Cup elimination'), 'reject: World Cup context (even w/ "United States")');
ok(!CD.isCivicDomain('Stoke City F.C.'), 'reject: football club "F.C."');
ok(!CD.isCivicDomain('Taylor Swift (singer)'), 'reject: "(singer)"');
ok(!CD.isCivicDomain('Some Guy', 'the veteran midfielder scored twice'), 'reject: sport-role in context');
ok(!CD.isCivicDomain('Manchester United FC'), 'reject: club name + FC');

// --- KEEP civic entities, including tricky club-ish tokens ---
ok(CD.isCivicDomain('United States'), 'keep: United States');
ok(CD.isCivicDomain('Kansas City'), 'keep: Kansas City (has "City" but no sports co-token)');
ok(CD.isCivicDomain('New York City Council'), 'keep: NYC Council');
ok(CD.isCivicDomain('Florida Democratic Party'), 'keep: state party');
ok(CD.isCivicDomain('Graham Platner drops out of Maine U.S. Senate race'), 'keep: senate-race story');
ok(CD.isCivicDomain('Mitch McConnell'), 'keep: legislator');
ok(CD.isCivicDomain('HR 2670 (US, 118)'), 'keep: a bill');
ok(CD.isCivicDomain('Joseph Rainey Center for Public Policy'), 'keep: policy org');

// --- shape + edge cases ---
ok(CD.isCivic({ name: '' }).civic === false && CD.isCivic({ name: '' }).reason === 'empty', 'empty name → not civic (reason=empty)');
ok(CD.isCivic({ name: 'Dave Bowen (footballer)' }).reason === 'paren-role', 'reason tag surfaced (paren-role)');
ok(CD.isCivicDomain('United States of America'), 'keep-exact guard: United States of America');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
