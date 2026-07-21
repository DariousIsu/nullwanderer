/* smoke_wikidata_type.js — a QID's P31 → our type vocabulary (design §2a-ii step 1).
 *
 * The pure half of the Wikidata rung: no network here, so the mapping is testable on its own. The live
 * fetch lives in scripts/backfill_wikidata_types.js.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_wikidata_type.js
 */
'use strict';
const wt = require('../lib/wikidata_type');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── the real cases, taken from live P31 responses ────────────────────────────────────────────────
ok(wt.typeFromP31(['Q5']).type === 'person', 'Q5 human → person');
ok(wt.typeFromP31(['Q4830453', 'Q6881511', 'Q891723']).type === 'organization',
  'Duke Energy’s real P31 set (business + enterprise + public company) agrees on organization');
ok(wt.typeFromP31(['Q23002039', 'Q3918']).type === 'organization', 'a public US university → organization');

// A GOVERNMENT IS NOT A COMPANY — the distinction T1 exists to preserve, carried through here.
ok(wt.typeFromP31(['Q20857065']).type === 'government_body', 'a US federal agency → government_body, NOT organization');
ok(wt.typeFromP31(['Q20857065']).type !== wt.typeFromP31(['Q4830453']).type,
  'CRITICAL: an agency and a business do not collapse into one type');
ok(wt.typeFromP31(['Q498162']).type === 'location', 'a census-designated place → location');

// ── unmapped is a HOLD, not a guess ──────────────────────────────────────────────────────────────
ok(wt.typeFromP31(['Q99999999']) === null,
  'CRITICAL: an unrecognised class returns null and the row keeps its placeholder — Wikidata has hundreds of thousands of classes and this maps dozens');
ok(wt.typeFromP31(['Q99999999', 'Q5']).type === 'person', 'an unmapped class alongside a mapped one does not block the mapped one');

// ── disagreement is refused, never voted on ──────────────────────────────────────────────────────
{
  const r = wt.typeFromP31(['Q5', 'Q43229']);
  ok(r && r.type === null && /disagree/.test(r.why),
    'CRITICAL: both a person and an organisation means a fused row or a bad id — refused, not resolved by majority');
  ok(Array.isArray(r.classes) && r.classes.length === 2, 'and it reports which classes conflicted');
}

// ── shape and garbage ────────────────────────────────────────────────────────────────────────────
ok(wt.typeFromP31(['q5']).type === 'person', 'case-insensitive');
ok(wt.typeFromP31('Q5').type === 'person', 'a bare string is accepted as a single class');
ok(wt.typeFromP31([]) === null && wt.typeFromP31(null) === null && wt.typeFromP31() === null,
  'no P31 → null, never throws');
ok(wt.typeFromP31([null, '', undefined]) === null, 'empty members are ignored, not mapped');

// ── the map itself must not blur government into organization ────────────────────────────────────
{
  const govs = Object.entries(wt.P31_TYPE).filter(([, v]) => v === 'government_body').length;
  ok(govs >= 8, 'the government classes are enumerated rather than folded into organization');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
