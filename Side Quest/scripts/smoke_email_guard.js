/* Smoke: the D-email inbox-suppression gate (2026-08-16 drill). The unread-email digest must NOT front-load
 * into a directed-task / status / control / lookup reply (3 emails hijacked a task answer, T8). The guard is
 * inline in main.js (~9903); this pins its pure logic AND the real turn_router.isConversational dependency it
 * reads. Defer-not-drop: a suppressed email keeps consumed_ts NULL (the main.js edit reuses ONE _promptInbounds
 * set at both the inject arg and the consume loop), so it re-surfaces via the heartbeat.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_email_guard.js
 */
'use strict';
const { isConversational } = require('../lib/turn_router');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// Mirror of the inline main.js guard — one filtered set reused by inject + consume (defer, never drop).
const gate = (route, inbounds, { routerOn = true } = {}) => {
  const emailOK = !routerOn || (isConversational(route) && route !== 'lookup');
  return emailOK ? inbounds : (inbounds || []).filter((i) => i.source !== 'email');
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const email = { id: 1, source: 'email' }, chat = { id: 2, source: 'chat-watcher' };

// ── suppression set: directed-task / status / control / lookup → defer email, keep chat ──
ok(eq(gate('status', [email, chat]), [chat]), 'status: email deferred, chat surfaced (T6/T8)');
ok(gate('control', [email]).length === 0, 'control: email suppressed (T7 re-stamped to control)');
ok(gate('task', [email]).length === 0, 'task: email suppressed');
ok(gate('lookup', [email]).length === 0, 'lookup: carved out of the OK set → email deferred (heartbeat recovers)');

// ── conversational turns unchanged (byte-identical to before) ──
ok(eq(gate('converse', [email, chat]), [email, chat]), 'converse: both surfaced');
ok(eq(gate('answer', [email]), [email]), 'answer: conversational → email shown');

// ── router OFF → legacy always-inject preserved ──
ok(eq(gate('status', [email], { routerOn: false }), [email]), 'router OFF: legacy always-inject preserved');

// ── the real dependency: the conversational classification that defines the suppression set ──
ok(!isConversational('status') && !isConversational('control') && !isConversational('task') && !isConversational('contacts'),
  'suppression set: status/control/task/contacts are NOT conversational');
ok(isConversational('lookup') && isConversational('converse') && isConversational('answer'),
  'lookup/converse/answer ARE conversational (lookup is carved out of the email-OK set separately)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
