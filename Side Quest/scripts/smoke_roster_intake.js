/* Smoke: lib/roster_intake (named-list contacts ask → per-person rows) + the main.js routing GUARD that
 * keeps such an ask from being derailed into a single-entity "which one?" disambiguation.
 *
 * Live regression 2026-08-05 (turns #10879/#10882): the exact 10-person Louisiana paste — newlines intact
 * in the stored turn — parsed to 10 people offline, yet the live reply was a CATEGORY DUMP ("top 200 LA
 * government contacts") + a spurious "'Devante Lewis Tom Arceneaux' came back as multiple people". recall()
 * collapsed the multiline list, pulled an ambiguous span across two adjacent lines, and the ambiguity ASK
 * fired FIRST (followupFired=true), starving the roster handler. Fix: the ambiguity gate is guarded with
 * `!_rosterAsk.ok`. This smoke pins BOTH halves: the parser on the verbatim paste, and the guard in source.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_roster_intake.js
 */
const fs = require('fs');
const path = require('path');
const R = require('../lib/roster_intake');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// The VERBATIM stored paste (turn #10879) — note the Unicode apostrophe in SWEPCO’s and the "Gerhart-" dash.
const PASTE = [
  'I need you to find me contact information for the following people please. Just email is great',
  'Melissa Gage, SWEPCO’s Vice President, Regulatory & Finance',
  'LPSC Executive Secretary Brandon Frey ',
  'LPSC Commissioner Jean Paul Coussan',
  'LPSC Commissioner Devante Lewis',
  'Tom Arceneaux, Shreveport Mayor',
  'Tyler Gray, Director of Energy Innovation, LSU Energy Institute',
  'Greg Upton Jr., Director of the LSU Center for Energy Studies',
  'Norby Chabert, Southern Renewable Energy Alliance ',
  'Monika Gerhart- Executive Director, Gulf States Renewable Energy Industries Assoc.',
  'Tommy Faucheaux, Louisiana Mid-Continent Oil & Gas Association',
].join('\n');

const r = R.parseRosterAsk(PASTE);
ok(r.ok, 'the verbatim 10-person paste → ok');
ok(r.ok && r.people.length === 10, `all 10 people parsed (got ${r.ok ? r.people.length : 0})`);
const names = r.ok ? r.people.map((p) => p.name) : [];
for (const n of ['Melissa Gage', 'Brandon Frey', 'Jean Paul Coussan', 'Devante Lewis', 'Tom Arceneaux',
  'Tyler Gray', 'Greg Upton Jr.', 'Norby Chabert', 'Monika Gerhart', 'Tommy Faucheaux']) {
  ok(names.includes(n), `parsed "${n}"`);
}
// The two adjacent names must be DISTINCT rows — never the "Devante Lewis Tom Arceneaux" blob recall() made.
ok(!names.some((n) => /Devante Lewis Tom Arceneaux/i.test(n)), 'adjacent lines stay separate (no "Devante Lewis Tom Arceneaux" blob)');
ok(r.ok && R.surnameOf('Greg Upton Jr.') === 'Upton', 'surname skips the Jr. suffix');

// FP guard: an ordinary two-name sentence with no list cue must NOT be treated as a roster.
ok(!R.parseRosterAsk('can you email Bob and Alice about lunch').ok, 'FP: casual 2-name sentence → not a roster');
ok(!R.parseRosterAsk('what is the weather today').ok, 'FP: unrelated → not a roster');

// SOURCE GUARD: the ambiguity gate in main.js must consult !_rosterAsk.ok so a named list is never
// derailed into a single "which one?" (the live #10879 root cause).
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/const _rosterAsk = \(\(\) => \{ try \{ return require\('\.\/lib\/roster_intake'\)\.parseRosterAsk\(userMessage\)/.test(src),
  '_rosterAsk is computed once before the ambiguity gate');
ok(/recallResult\.ambiguous[\s\S]{0,160}?&& !_rosterAsk\.ok\)/.test(src),
  'the ambiguity ASK gate is guarded by !_rosterAsk.ok (roster asks are not derailed)');
ok(/const _ros = _rosterAsk;/.test(src), 'the roster handler REUSES the single parse (no double-parse drift)');

// CASCADE WIRING (the fill uses ALL tools + Puller escalation, Lucas 2026-08-05) — source-pinned so the
// finders can't silently drop out of _defaultListLookup.
ok(/runContactCascade\(person, \{ finders: \[pullerdbFinder, patternFinder, hunterFinder, webFinder\]/.test(src),
  'fill cascade runs finders [pullerdb, pattern, hunter, web] in order');
ok(/name: 'hunter'[\s\S]{0,900}?hunter_find_email/.test(src), 'the hunter finder dispatches Echo hunter_find_email');
ok(/createTarget\(\{ kind: 'person'/.test(src), 'a total miss escalates the person to the Puller (createTarget)');
// The Echo-side Hunter tool exists + is exported.
try {
  const csrc = fs.readFileSync('C:/Users/azrae/Desktop/NX ECHO/nx-echo/echo/mcp/external/contacts.py', 'utf8');
  ok(/@external\.tool\(\)\s*\ndef hunter_find_email\(/.test(csrc), 'Echo exposes hunter_find_email as an @external.tool');
  ok(/'hunter_find_email'/.test(csrc), 'hunter_find_email is in contacts.py __all__');
} catch { ok(false, 'could not read Echo contacts.py to verify hunter_find_email'); }

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
