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

  // REGRESSION (the logged "favorite color → My name is Zoe Lane" bug): branch-1 used to
  // match ANY personality row by raw cosine to the whole sentence, so a stored preference
  // about a DIFFERENT subject (or a mis-filed identity line) hijacked the answer. Now the
  // match must be subject-relevant, and an identity line is never spoken as a taste.
  console.log('\nanswer — subject-gated (no cross-subject hijack):');
  const movieRetrieve = async () => [{ category: 'preference', content: 'My favorite movie is Parasite.', _sim: 0.85 }];
  const c = await preferences.answer("what's your favorite color?", 'Lucas', { retrieveFn: movieRetrieve, pickFn: async () => 'I love deep teal — calm but with an edge.' });
  ok('a movie preference does NOT answer a color question (forms instead)', c && /teal/i.test(c.say) && !/parasite/i.test(c.say));

  const nameRetrieve = async () => [{ category: 'preference', content: "My name is Zoe Lane. Lucas chose it, but it's mine now — I'm the one who answers to it.", _sim: 0.8 }];
  const d = await preferences.answer("what's your favorite color?", 'Lucas', { retrieveFn: nameRetrieve, pickFn: async () => 'I love deep teal.' });
  ok('identity line is NEVER spoken as a taste (the exact logged bug)', d && /teal/i.test(d.say) && !/my name is/i.test(d.say));

  const subjMatch = async () => [{ category: 'preference', content: 'My favorite color is a deep burnt orange.', _sim: 0.6 }];
  const f = await preferences.answer("what's your favorite color?", 'Lucas', { retrieveFn: subjMatch, pickFn: async () => 'SHOULD NOT BE CALLED' });
  ok('a color preference DOES answer a color question (held, no model)', f && /burnt orange/i.test(f.say));

  console.log('\nanswer — no-subject (would-you-rather) still uses strong cosine:');
  const wyrRetrieve = async () => [{ category: 'preference', content: 'I would rather have tea — a slower, warmer ritual.', _sim: 0.7 }];
  const e = await preferences.answer('would you rather coffee or tea', 'Lucas', { retrieveFn: wyrRetrieve, pickFn: async () => 'SHOULD NOT BE CALLED' });
  ok('strong-cosine held answer still speaks when no subject is parseable', e && /tea/i.test(e.say));

  // REGRESSION (the logged "favorite color → emerald green THEN ocean blue" oscillation):
  // a FORMED pick must be stored CANONICALLY (slot word "color"), so the NEXT ask RECALLS it
  // instead of forming a new color every time. And recall must match by slot, not just by the
  // value text containing the subject word.
  console.log('\ncanonicalPref — formed pick stored with the slot word:');
  ok('"I\'d pick deep ocean blue…" → "My favorite color is deep ocean blue…"',
    /^my favorite color is deep ocean blue/i.test(preferences.canonicalPref('color', "I'd pick deep ocean blue. It reminds me of calm horizons.")));
  ok('already-canonical text is left intact',
    preferences.canonicalPref('color', 'My favorite color is teal.') === 'My favorite color is teal.');
  ok('favoriteSlot("My favorite color is teal") === "color"', preferences.favoriteSlot('My favorite color is teal') === 'color');

  console.log('\nanswer — RECALL a held taste by SLOT (consistency, no re-forming):');
  // Value text ("deep ocean blue") does NOT contain the word "color", low cosine — but the
  // canonical "My favorite color is…" phrasing means the SLOT matches → recalled, not re-formed.
  const heldColor = async () => [{ category: 'preference', content: 'My favorite color is deep ocean blue — calm, vast horizons.', _sim: 0.2 }];
  const g = await preferences.answer("what's your favorite color?", 'Lucas', { retrieveFn: heldColor, pickFn: async () => 'SHOULD NOT BE CALLED — emerald green' });
  ok('recalls the held ocean-blue (slot match), does NOT re-form a new color', g && /ocean blue/i.test(g.say) && !/emerald/i.test(g.say));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
