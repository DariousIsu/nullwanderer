/* Smoke: lib/intent_parse.js — the model-based turn intent parse (model-primary, regex fallback).
 * Offline: the model path is exercised with an injected `ask`; the fallback with ask→null.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_intent_parse.js
 */
'use strict';
const ip = require('../lib/intent_parse');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // ── _validate — parse + coerce the model's JSON ──
  const v1 = ip._validate('{"kind":"office_holder","topic":"President of the United States","needs_fresh":true}');
  ok(v1.valid && v1.value.kind === 'office_holder' && /President/.test(v1.value.topic) && v1.value.needs_fresh === true, '_validate: clean JSON → structured intent');
  const v2 = ip._validate('Sure! {"kind":"entity","topic":"Marie Curie","needs_fresh":false} hope that helps');
  ok(v2.valid && v2.value.kind === 'entity' && v2.value.needs_fresh === false, '_validate: JSON embedded in prose → extracted');
  ok(ip._validate('not json at all').valid === false, '_validate: non-JSON → invalid (→ caller falls back)');
  const v3 = ip._validate('{"kind":"office_holder","topic":"CEO of Nvidia"}');
  ok(v3.valid && v3.value.needs_fresh === true, '_validate: office_holder with needs_fresh omitted → defaults true');
  const v4 = ip._validate('{"kind":"banana","topic":"x","needs_fresh":true}');
  ok(v4.valid && v4.value.kind === 'other', '_validate: unknown kind → coerced to "other"');

  // ── _regexIntent — the FALLBACK (must degrade to the old behavior when the model is down) ──
  ok(ip._regexIntent("who's the president?").kind === 'office_holder', 'fallback: "who\'s the president?" → office_holder');
  ok(ip._regexIntent('who is the CEO of Nvidia?').kind === 'office_holder', 'fallback: "who is the CEO of Nvidia?" → office_holder');
  ok(ip._regexIntent('who is president now?').needs_fresh === true, 'fallback: "who is president now?" → needs_fresh');
  ok(ip._regexIntent('what is the latest news on X?').kind === 'current_fact', 'fallback: "latest news" → current_fact');
  ok(ip._regexIntent('good morning!').kind === 'chitchat', 'fallback: greeting → chitchat');
  ok(ip._regexIntent('who is Marie Curie?').kind === 'other' && ip._regexIntent('who is Marie Curie?').needs_fresh === false, 'fallback: timeless "who is Marie Curie?" → other, not fresh');

  // ── parseIntent — model PRIMARY, regex FALLBACK ──
  const askModel = async ({ input }) => { ok(/country/i.test(String(input.question)), 'parseIntent: passes the question to the model'); return { kind: 'office_holder', topic: 'President of the United States', needs_fresh: true }; };
  const r1 = await ip.parseIntent("who runs the country?", { ask: askModel });
  ok(r1.source === 'model' && r1.kind === 'office_holder' && /President/.test(r1.topic), 'parseIntent: MODEL path → structured intent (handles "who runs the country?" — no office word)');
  const r2 = await ip.parseIntent('who is the CEO of Nvidia?', { ask: async () => null });
  ok(r2.source === 'fallback' && r2.kind === 'office_holder', 'parseIntent: model returns null → REGEX FALLBACK still classifies office_holder');
  const r3 = await ip.parseIntent('', { ask: askModel });
  ok(r3.kind === 'other' && r3.source === 'fallback', 'parseIntent: empty message → safe default, no model call');
  const r4 = await ip.parseIntent('who is president?', { ask: async () => { throw new Error('cloud exploded'); } });
  ok(r4.source === 'fallback' && r4.needs_fresh === true, 'parseIntent: ask throws → fail-safe to regex fallback (never throws into a turn)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
