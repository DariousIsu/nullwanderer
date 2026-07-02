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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
