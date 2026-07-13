/* Smoke: lib/contacts_intent — the LLM-PRIMARY contacts-list classifier. Fully offline: deps.ask is
 * injected to return canned (already-validated) objects, mirroring cloud.ask's contract (validated value
 * or null). Proves the sanitization to the ask shape + the fallback precedence.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contacts_intent.js
 */
'use strict';
const ci = require('../lib/contacts_intent');
const mk = (obj) => ({ ask: async () => obj });   // cloud.ask returns the validated value (or null) directly

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // positive → shaped into the same ask object detect() produces
  let r = await ci.classify('create a sheet of our grade C corporate tech contacts', {
    deps: mk({ isList: true, type: 'corporate', grade: 'C', gradeDir: 'gte', state: null, sectors: ['tech'], company: null, limit: null }),
  });
  ok(r && r.isQuery === true && r.type === 'corporate' && r.grade === 'C' && r.gradeDir === 'gte' && r.sectors.join() === 'tech', 'positive: LLM list decision → shaped ask (type/grade/sectors)');

  // both-types + state + limit
  r = await ci.classify('build a sheet of all Louisiana contacts, gov and private, top 100', {
    deps: mk({ isList: true, type: null, grade: null, gradeDir: 'gte', state: 'LA', sectors: [], company: null, limit: 100 }),
  });
  ok(r.isQuery && r.type === null && r.state === 'LA' && r.limit === 100, 'positive: both-types (type null) + state LA + limit 100');

  // not-a-list → honored (isQuery false), NOT null
  r = await ci.classify('how is the project going', { deps: mk({ isList: false }) });
  ok(r && r.isQuery === false, 'LLM says not-list → { isQuery:false } (honored, not a fallback)');

  // cloud down (ask → null) → classify returns null → caller uses the regex fallback
  r = await ci.classify('list our contacts', { deps: mk(null) });
  ok(r === null, 'cloud down (ask→null) → classify null (signals regex fallback)');

  // sanitization: never trust the model's fields
  r = await ci.classify('list all our contacts please', {
    deps: mk({ isList: true, type: 'bogus', grade: 'Z', gradeDir: 'sideways', state: 'Louisiana', sectors: ['tech', 'notasector'], company: 'x', limit: 99999 }),
  });
  ok(r.type === null, 'sanitize: bogus type → null');
  ok(r.grade === null, 'sanitize: invalid grade Z → null');
  ok(r.gradeDir === 'gte', 'sanitize: bad gradeDir → gte default');
  ok(r.state === null, 'sanitize: "Louisiana" (not 2-letter) → null');
  ok(r.sectors.join() === 'tech', 'sanitize: unknown sector dropped, real one kept');
  ok(r.company === null, 'sanitize: 1-char company → null');
  ok(r.limit === null, 'sanitize: limit 99999 (>5000) → null');

  // valid state code + lte grade
  r = await ci.classify('grade D or lower elected officials in TX', {
    deps: mk({ isList: true, type: 'elected', grade: 'D', gradeDir: 'lte', state: 'tx', sectors: [], company: null, limit: null }),
  });
  ok(r.type === 'elected' && r.grade === 'D' && r.gradeDir === 'lte' && r.state === 'TX', 'positive: elected + grade D lte + state tx→TX');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('threw:', e.message); process.exit(1); });
