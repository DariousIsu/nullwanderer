/* Smoke: unprompted_gate — structural backstops for autonomous utterances.
 * Rule A (pending user turn → block, even inbound) + Rule B (unprompted streak → block, inbound exempt).
 * Pure: pass a synthetic turn tape, no db. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_unprompted_gate.js
 */
'use strict';
const gate = require('../lib/unprompted_gate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const U = (content) => ({ speaker: 'user', content, unprompted: 0 });
const A = (content) => ({ speaker: 'ai_said', content, unprompted: 0 });   // prompted reply
const R = (content) => ({ speaker: 'ai_said', content, unprompted: 1 });   // unprompted reflection
const T = (content) => ({ speaker: 'ai_thought', content });

// --- Rule A: pending user turn (unanswered) blocks autonomous surfacing ---
ok(gate.evaluate({ turns: [U('what is the UK PM background?')] }).reason === 'pending-user-turn',
  'A: bare unanswered user question → pending-user-turn block');
ok(gate.evaluate({ turns: [U('q'), T('thinking...')] }).reason === 'pending-user-turn',
  'A: user turn followed only by ai_thought (no reply) → still pending');
ok(gate.evaluate({ turns: [U('q'), A('here is the answer')] }).allow === true,
  'A: user turn WITH a prompted reply after it → allowed');
// A pending user turn blocks even an inbound (an "you got mail" ping still buries a live question).
ok(gate.evaluate({ turns: [U('q')], isInbound: true }).allow === false,
  'A: pending user turn blocks even inbound');

// --- Rule B: unprompted streak into an empty room ---
ok(gate.evaluate({ turns: [U('hi'), A('hello'), R('r1'), R('r2')] }).allow === true,
  'B: 2 unprompted after a reply (< cap 3) → allowed');
ok(gate.evaluate({ turns: [U('hi'), A('hello'), R('r1'), R('r2'), R('r3')] }).reason.startsWith('unprompted-streak'),
  'B: 3 unprompted since user spoke (>= cap 3) → streak block');
// Inbound is exempt from B (real external event, not her own musing) — but only when no pending turn.
ok(gate.evaluate({ turns: [U('hi'), A('hello'), R('r1'), R('r2'), R('r3')], isInbound: true }).allow === true,
  'B: inbound is exempt from the streak cap');
// A fresh user turn RESETS the streak (she may surface again once he is back).
ok(gate.evaluate({ turns: [R('r1'), R('r2'), R('r3'), U('back'), A('welcome')] }).allow === true,
  'B: a new user turn + reply resets the streak → allowed again');
// maxStreak override.
ok(gate.evaluate({ turns: [U('hi'), A('hello'), R('r1')], maxStreak: 1 }).reason.startsWith('unprompted-streak'),
  'B: maxStreak override honored');

// --- fail-open / edge cases ---
ok(gate.evaluate({ turns: [] }).allow === true, 'edge: empty tape → allow (empty-tape)');
ok(gate.evaluate({ turns: [R('r1'), R('r2')] }).allow === true,
  'edge: no user turn in-window, streak < cap → allow');
ok(gate.evaluate({ turns: [A('a reply with no preceding user in-window')] }).allow === true,
  'edge: reply-only window, no user → allow');

// --- logDecision returns a structured record and never throws ---
{
  const rec = gate.logDecision('heartbeat', { allow: false, reason: 'pending-user-turn' });
  ok(rec && rec.source === 'heartbeat' && rec.outcome === 'suppressed' && rec.reason === 'pending-user-turn',
    'logDecision: suppressed record shape');
  const rec2 = gate.logDecision('continuity', { allow: true, outcome: 'surfaced', reason: 'ok' });
  ok(rec2 && rec2.outcome === 'surfaced', 'logDecision: surfaced record shape');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
