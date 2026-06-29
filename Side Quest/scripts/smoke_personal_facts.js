/* Smoke: lib/personal_facts — durable capture of user personal facts + retrieve-or-admit guard.
 * Deterministic: model + store injected, no DB / network.
 * Guards the diagnostic fix for the "what's my daughter's name? → fabricated 'Kate'" failure.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_personal_facts.js
 */
const pf = require('../lib/personal_facts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // --- A) CAPTURE: a real personal statement → stored as retrievable knowledge ---
  const calls = [];
  const storeFn = async (rec) => { calls.push(rec); return { action: 'add', id: calls.length }; };
  const gen = async () => JSON.stringify({ facts: [
    "Lucas's youngest daughter is Alice, age 12, in elite competitive cheerleading",
    "Lucas's oldest child is Raegan, who also goes by Jay, age 16, exploring filmmaking"
  ] });
  const stored = await pf.extractFromUserTurn({
    userMessage: 'My youngest is Alice, 12, doing elite cheer. My oldest is Raegan (Jay), 16, into film.',
    sourceTurnId: 42, userName: 'Lucas', storeFn, _genFn: gen
  });
  ok(stored.length === 2, 'two durable facts captured');
  ok(calls.every(c => c.source === 'personal_fact'), "stored under source 'personal_fact'");
  ok(calls.every(c => c.kind === 'reference' && c.importance >= 0.8), 'stored as high-importance reference');
  ok(calls.every(c => c.provenance === 'turn:42'), 'provenance carries the source turn');
  ok(/Alice/.test(calls[0].content), 'fact text names Alice');

  // --- A) CONFAB GUARD (the core fix): an invented fact must be DROPPED before storage ---
  // The real failure: "Lucas has a dog named Zo" confabulated from the nickname "Zo".
  const callsZo = [];
  const genDog = async () => JSON.stringify({ facts: ['Lucas has a dog named Zo'] });
  const dogRes = await pf.extractFromUserTurn({ userMessage: 'How we doing Zo?', userName: 'Lucas', storeFn: async (r) => { callsZo.push(r); return { action: 'add' }; }, _genFn: genDog });
  ok(dogRes.length === 0 && callsZo.length === 0, 'confabulated "dog named Zo" from a nickname → DROPPED, never stored');
  // _grounded unit checks
  ok(pf._grounded('Lucas has a dog named Zo', 'How we doing Zo?', 'Lucas') === false, 'invented pet (no "dog" in msg) → ungrounded');
  ok(pf._grounded("Lucas's daughter Kate is 10", 'how are the kids', 'Lucas') === false, 'invented NAME (Kate not in msg) → ungrounded');
  ok(pf._grounded("Lucas's youngest daughter is Alice, in competitive cheerleading", 'My youngest is Alice, doing elite cheer', 'Lucas') === true, 'legit enrichment (youngest→daughter, Alice in msg) → grounded');
  ok(pf._grounded('Lucas has a dog named Rex', 'we got a dog, Rex, last week', 'Lucas') === true, 'real pet stated in msg → grounded (guard is precision, not blanket-no-pets)');

  // --- A) NEGATIVE: transient plans / no durable fact → nothing stored ---
  const calls2 = [];
  const storeFn2 = async (rec) => { calls2.push(rec); return { action: 'add' }; };
  const genEmpty = async () => JSON.stringify({ facts: [] });
  const none = await pf.extractFromUserTurn({ userMessage: 'taking Alice to the gym then back to work', storeFn: storeFn2, _genFn: genEmpty });
  ok(none.length === 0 && calls2.length === 0, 'transient/no-fact message stores nothing');

  // --- A) parser robustness ---
  ok(pf.parseFactsJson('garbage { "facts": ["x is y"] } trailing').length === 1, 'parses JSON embedded in noise');
  ok(pf.parseFactsJson('not json at all').length === 0, 'non-JSON → empty');
  ok(pf.parseFactsJson('{ "facts": "nope" }').length === 0, 'facts must be an array');

  // --- B) DETECT personal-fact questions (positives) ---
  ok(pf.detectPersonalFactQuestion("Hey zoe what's my youngest daughter's name?"), 'daughter name question → fires (the logged case)');
  ok(pf.detectPersonalFactQuestion('who is my wife'), 'wife question → fires');
  ok(pf.detectPersonalFactQuestion('when is my son’s birthday'), 'son birthday → fires');
  ok(pf.detectPersonalFactQuestion('do you remember my dog’s name'), 'recall-framed pet name → fires');
  ok(pf.detectPersonalFactQuestion('how old is my daughter'), 'how old is my daughter → fires');

  // --- B) DETECT negatives (must NOT fire on work / non-personal) ---
  ok(!pf.detectPersonalFactQuestion("what's my next task"), 'work "my next task" → does NOT fire');
  ok(!pf.detectPersonalFactQuestion('what is the price of oil'), 'live-info question → does NOT fire');
  ok(!pf.detectPersonalFactQuestion('who is the president'), 'general-knowledge question → does NOT fire');
  ok(!pf.detectPersonalFactQuestion('can you explain how STDP works'), 'concept question → does NOT fire');

  // --- B) directive content (anti-confabulation contract) ---
  const d = pf.groundingDirective('Lucas');
  ok(/do NOT invent/i.test(d) && /just mentioned/i.test(d), 'directive forbids inventing + fake "just mentioned"');
  ok(/don'?t have it/i.test(d) || /admitting you don'?t know/i.test(d), 'directive tells her to admit when she lacks it');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
