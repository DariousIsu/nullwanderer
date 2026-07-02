/* Smoke: lib/mention.js chain helpers (pure — no model/cloud, gate-safe).
 * The tiered detectMention (NER → cloud decompose) is proven live via probe; the offline gate covers the
 * deterministic escalation/selection logic.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_mention.js
 */
'use strict';
const m = require('../lib/mention');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// _shouldEscalate — escalate a tier-1 miss unless the text is trivially short.
ok(m._shouldEscalate('who is john curtis?') === true, 'escalate a real question');
ok(m._shouldEscalate('hi') === false, 'skip too-short input');
ok(m._shouldEscalate('') === false, 'skip empty');

// _pickObject — salient resolve target first, then any resolve, then salient, then first.
ok(m._pickObject({ objects: [] }) === null, 'no objects → null');
ok(m._pickObject(null) === null, 'null plan → null');
ok(m._pickObject({ objects: [
  { mention: 'the op-ed', type: 'document', op: 'create', salient: false },
  { mention: 'Rebecca Dow', type: 'person', op: 'resolve', salient: true },
] }).mention === 'Rebecca Dow', 'salient resolve target wins');
ok(m._pickObject({ objects: [
  { mention: 'Acme', type: 'organization', op: 'resolve', salient: false },
  { mention: 'a new report', type: 'document', op: 'create', salient: false },
] }).mention === 'Acme', 'first resolve target when none salient');
ok(m._pickObject({ objects: [
  { mention: 'X', type: null, op: 'create', salient: false },
] }).mention === 'X', 'falls back to first object');

// _expandFromContext — conversational coreference: a bare partial name binds to the fuller name just used
// in the dialogue (the "what does Lee do?" → Lee Zeldin fix), most-recent-wins, and declines when there's
// no antecedent or the mention is already full.
const CTX = 'Lucas: who are his cabinet members?\nZoe: Marco Rubio is Secretary of State. It also includes Lee Zeldin, Ryan Zinke, and Lori Chavez-DeRemer.';
ok(m._expandFromContext('Lee', CTX) === 'Lee Zeldin', 'bare surname → fuller name from context');
ok(m._expandFromContext('Marco', CTX) === 'Marco Rubio', 'bare given name → fuller name from context');
ok(m._expandFromContext('Ryan', CTX) === 'Ryan Zinke', 'another antecedent in the same turn');
ok(m._expandFromContext('Lee Zeldin', CTX) === null, 'already-full mention → no expansion');
ok(m._expandFromContext('Biden', CTX) === null, 'no antecedent in context → null');
ok(m._expandFromContext('Lee', '') === null, 'no context → null');
ok(m._expandFromContext('Lee', 'Lucas: tell me about lee') === null, 'no capitalized full-name antecedent → null');
// most-recent-wins: two full names carry the surname; the later (more recent) one binds.
ok(m._expandFromContext('Lee', 'Zoe: Spike Lee directed it.\nLucas: and Lee Zeldin?') === 'Lee Zeldin', 'most-recent antecedent wins');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
