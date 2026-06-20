/**
 * Backtest — preference interceptor (the "ghost command").
 *  - detect fires on taste questions, NOT on substantive "your take on X" (capability guard)
 *  - answer() speaks a HELD preference when one matches (no model)
 *  - answer() FORMS + STORES one when none is held (develops interests)
 * Temp DB; pickFn/retrieveFn injected so no model/network.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_preferences.js
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_pref_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const memory = require('../lib/memory');
const preferences = require('../lib/preferences');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  console.log('detect (must fire on taste, NOT on analysis):');
  ok('"what\'s your favorite flower?" → fires', preferences.detectPreferenceIntent("what's your favorite flower?"));
  ok('"would you rather coffee or tea" → fires', preferences.detectPreferenceIntent('would you rather coffee or tea'));
  ok('"are you a fan of jazz?" → fires', preferences.detectPreferenceIntent('are you a fan of jazz?'));
  ok('"what\'s your take on permitting reform?" → does NOT fire', !preferences.detectPreferenceIntent("what's your take on permitting reform?"));
  ok('"research permit reform for me" → does NOT fire', !preferences.detectPreferenceIntent('research permit reform for me'));
  ok('"summarize this 1000 page report" → does NOT fire', !preferences.detectPreferenceIntent('summarize this 1000 page report'));

  console.log('\nidentity detect (must fire on name/self, NOT on "what are you doing"):');
  ok('"what is your full name?" → fires', preferences.detectIdentityIntent('what is your full name?'));
  ok('"who are you?" → fires', preferences.detectIdentityIntent('who are you?'));
  ok('"what are you working on?" → does NOT fire', !preferences.detectIdentityIntent('what are you working on?'));
  ok('"what are you reading?" → does NOT fire', !preferences.detectIdentityIntent('what are you reading?'));

  console.log('\nidentity answer — name is deterministic + owned (no disclaimer):');
  D.setMeta('user_name', 'Lucas'); D.setMeta('chosen_name', 'Zoe Lane');
  const idn = await preferences.answerIdentity('what is your full name?', 'Lucas');
  ok('name answer states "Zoe Lane"', idn && /zoe lane/i.test(idn.say));
  ok('name answer does NOT disclaim a self', idn && !/(don'?t have|no (self|identity|preferences)|just an ai|programmed|assigned to me)/i.test(idn.say));
  console.log('   say: ' + (idn && idn.say));

  console.log('\nanswer — HELD preference (no model):');
  const heldRetrieve = async () => [{ category: 'preference', content: 'My favorite flower is the ranunculus — a rose that stopped trying to be perfect.', _sim: 0.92 }];
  const a = await preferences.answer("what's your favorite flower?", 'Lucas', { retrieveFn: heldRetrieve, pickFn: async () => 'SHOULD NOT BE CALLED' });
  ok('speaks the held ranunculus entry', a && /ranunculus/i.test(a.say));

  console.log('\nanswer — FORM + STORE (develops interests):');
  const before = D.countSelfModel();
  const emptyRetrieve = async () => [];
  const b = await preferences.answer("what's your favorite movie?", 'Lucas', { retrieveFn: emptyRetrieve, pickFn: async () => 'My favorite movie is Parasite — it blends dark humor and class commentary better than anything.' });
  ok('forms + speaks a movie pick', b && /parasite/i.test(b.say));
  ok('stored the new preference to self_model', D.countSelfModel() === before + 1);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
