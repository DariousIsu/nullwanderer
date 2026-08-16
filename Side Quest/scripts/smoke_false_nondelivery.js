/* smoke_false_nondelivery.js — the T10 false-non-delivery guard (2026-08-16 drill).
 * The operator BUILT + saved a deliverable ("Headline: $7.6 Million …", saved to notes) but the reply
 * DENIED it ("I couldn't pin down the data … I can't build you a brief from data I don't hold") — a stale
 * pre-operator "searched-miss" draft beat the operator's late success. The structural drop (main.js) makes
 * operator success authoritative; this smoke locks the two pure pieces:
 *   (1) delivery.claimsNonDelivery — the denial SHAPE, straight AND curly apostrophes, with a real-result exemption.
 *   (2) referent.resolveDemonstrative — "those numbers" anchors to a DURABLE ai_said delivery, never the ai_thought rail.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_false_nondelivery.js
 */
'use strict';
const { claimsNonDelivery } = require('../lib/delivery');
const { resolveDemonstrative } = require('../lib/referent');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

console.log('claimsNonDelivery — the denial shape (straight + curly), real-result EXEMPT:');
// TRUE — the two live T10 sentences, straight AND curly (the cloud writer re-voices with U+2019)
ok(claimsNonDelivery("I couldn't pin down 2024 FEC independent expenditure data for Florida House races."),
  'straight: "couldn\'t pin down … data" → denial');
ok(claimsNonDelivery('I couldn’t pin down 2024 FEC independent expenditure data for Florida House races.'),
  'curly: "couldn’t pin down …" → denial (U+2019)');
ok(claimsNonDelivery("I can't build you a brief from data I don't hold."),
  'straight: "can\'t build … data I don\'t hold" → denial');
ok(claimsNonDelivery('I can’t build you a brief from data I don’t hold.'),
  'curly: "can’t build … don’t hold" → denial');
// FALSE — a real result / partial is NEVER a denial (exempt via _RESULT_STRONG)
ok(!claimsNonDelivery('**Headline: $7.6 Million in Independent Expenditures Flooded Florida House Races**'),
  '$7.6 Million headline (decimal payload) → NOT a denial');
ok(!claimsNonDelivery('The analysis ran but returned 0 rows for that filter.'),
  '"0 rows" partial → NOT a denial');
ok(!claimsNonDelivery('| Committee | Total |\n| Florida Patriots PAC | $3,077,324 |'),
  'a table-row delivery → NOT a denial');
ok(!claimsNonDelivery("I couldn't get every district, but here are the top 5: 1. NEA $391M; 2. CTA $214M."),
  'a partial that says "couldn\'t" but CARRIES numbers → NOT a denial (exempt)');
// FALSE — non-denial shapes
ok(!claimsNonDelivery('Which cycle did you mean — 2022 or 2024?'), 'a clarifying question → NOT a denial');
ok(!claimsNonDelivery(''), 'empty → NOT a denial');
ok(!claimsNonDelivery('Here are the 12 union presidents: Alice, Bob, and Carol.'), 'a names roster → NOT a denial');

console.log('\nresolveDemonstrative — "those numbers" anchors to the DELIVERY, never the thought rail:');
const table = 'FEC Independent Expenditures — Florida House Races, 2024 Cycle. Top 15 committees: FLORIDA PATRIOTS PAC $3,077,324; WelcomePAC $918,761; …';
{
  // The non-terminal "Those search results dont get me the data … Let me run that now" fragment is NOT
  // stored as ai_said (terminality gate at main.js:12229), so `turns` carries only the delivered TABLE.
  const turns = [
    { speaker: 'user', content: 'pull me the FEC independent expenditures for Florida House races 2024' },
    { speaker: 'ai_said', content: table },
    { speaker: 'user', content: 'take those florida house numbers you just pulled and build me a brief' },
  ];
  const r = resolveDemonstrative('take those florida house numbers you just pulled and build me a brief', turns);
  ok(r && r.speaker === 'ai_said' && /FLORIDA PATRIOTS PAC/.test(r.text),
    '"those florida house numbers" → the delivered TABLE (ai_said)');
}
{
  // Regression: even if an ai_thought musing (carrying the same keys) sits AFTER the delivery, the speaker
  // filter skips it — else the referent poison migrates to the thought rail.
  const turns = [
    { speaker: 'ai_said', content: table },
    { speaker: 'ai_thought', content: 'the florida house numbers still are not structured the way I want them' },
    { speaker: 'user', content: 'take those florida house numbers and build me a brief' },
  ];
  const r = resolveDemonstrative('take those florida house numbers and build me a brief', turns);
  ok(r && r.speaker === 'ai_said', 'the ai_thought musing is SKIPPED → resolves to the ai_said delivery (speaker filter)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
