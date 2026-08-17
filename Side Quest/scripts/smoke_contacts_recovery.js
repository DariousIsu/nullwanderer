'use strict';
/* smoke_contacts_recovery.js — recover a PROMISED-but-unfired "contacts on your canvas" (2026-08-17 audit).
 *
 * Live (#12335): "I put 183 Louisiana elected-official contacts on your canvas" — the contacts lane never fired
 * (the intent classifier read the turn as conversation), nothing landed, the anti-fab shipped a correction. This
 * organ (twin of lib/image_intent) detects the unfired claim and extracts the FILTER she meant so the harness
 * can actually place the held contacts. Proves: prefilter precision; filter extraction; FAIL CLOSED (NONE /
 * no-filter / throw all → null, never a whole-CRM dump); no-intent never calls the model.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contacts_recovery.js
 */
const cr = require('C:/Users/azrae/Desktop/Side Quest/lib/contacts_recovery');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // 1. PREFILTER — a committed "contacts on the canvas / in the DB" claim nominates; other shapes do not.
  ok(cr.looksLikeUnfiredContactsClaim('I put 183 Louisiana elected-official contacts on your canvas — all with emails.'), 'nominates the live #12335 claim (put … contacts … on your canvas)');
  ok(cr.looksLikeUnfiredContactsClaim('I added the Louisiana officials to your canvas.'), 'nominates "added the officials to your canvas"');
  ok(cr.looksLikeUnfiredContactsClaim('Those contacts are on your canvas now.'), 'nominates "those contacts are on your canvas now"');
  ok(!cr.looksLikeUnfiredContactsClaim('The weather looks clear in Baton Rouge tomorrow.'), 'does NOT nominate ordinary non-contacts chat');
  ok(!cr.looksLikeUnfiredContactsClaim('I can pull up the Louisiana officials if you want.'), 'does NOT nominate a mere OFFER (no placement claim)');

  const SAY = 'I put 183 Louisiana elected-official contacts on your canvas — all with emails, already in our records.';

  // 2. EXTRACTION — a claim + a model that returns a filter line → a usable contacts ask.
  const ask = await cr.recoverContactsFilter(SAY, { classify: async () => 'STATE=Louisiana | TYPE=elected | SECTORS=UNKNOWN | SUBJECT=Louisiana elected officials' });
  ok(ask && /louisiana/i.test(ask.state) && ask.type === 'elected' && ask.recovered === true, 'a committed claim + a real filter line → an ask {state:Louisiana, type:elected}');
  ok(ask && Array.isArray(ask.sectors) && ask.sectors.length === 0, 'SECTORS=UNKNOWN → empty sectors (field dropped, not guessed)');

  // 3. SECTORS parse
  const ask2 = await cr.recoverContactsFilter(SAY, { classify: async () => 'STATE=UNKNOWN | TYPE=activist | SECTORS=energy, healthcare | SUBJECT=activist orgs' });
  ok(ask2 && ask2.type === 'activist' && ask2.sectors.join(',') === 'energy,healthcare' && !ask2.state, 'a TYPE + SECTORS with no state still yields a usable ask (sectors parsed)');
  const ask3 = await cr.recoverContactsFilter(SAY, { classify: async () => 'STATE=Louisiana | TYPE=government | SECTORS=UNKNOWN | SUBJECT=gov officials' });
  ok(ask3 && ask3.type === 'gov', 'TYPE=government normalizes to "gov" (what cq.select branches on)');

  // 4. FAIL CLOSED — NONE, an all-UNKNOWN (no concrete filter), and a throw ALL → null (never a whole-CRM dump)
  ok((await cr.recoverContactsFilter(SAY, { classify: async () => 'NONE' })) === null, 'model says NONE → null');
  ok((await cr.recoverContactsFilter(SAY, { classify: async () => 'STATE=UNKNOWN | TYPE=UNKNOWN | SECTORS=UNKNOWN | SUBJECT=some contacts' })) === null, 'no concrete filter (all UNKNOWN) → null (never dump the whole CRM)');
  ok((await cr.recoverContactsFilter(SAY, { classify: async () => '' })) === null, 'empty model output → null (fail closed)');
  ok((await cr.recoverContactsFilter(SAY, { classify: async () => { throw new Error('cloud down'); } })) === null, 'model throws → null (fail closed)');

  // 5. NO INTENT → null WITHOUT calling the model (the prefilter is the cheap gate)
  let called = false;
  const noIntent = await cr.recoverContactsFilter('the report is coming together nicely', { classify: async () => { called = true; return 'STATE=Louisiana'; } });
  ok(noIntent === null && called === false, 'no contacts-placement claim → null and the model is NEVER called');
})().then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('threw:', e.stack || e.message); process.exit(1); });
