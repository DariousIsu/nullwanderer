/* Smoke: lib/poll — the interface poll router (route to the right grounded source, deterministic-first).
 * Pure, no model/db. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_poll.js
 */
'use strict';
const poll = require('../lib/poll');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// sources: a deterministic deliverable source, a deterministic activity source, a cloud fallback.
const deliverable = { name: 'research-deliverable', kind: 'deliverable', tier: 'deterministic', match: (q) => /how many|the list|who leads/i.test(q) };
const activity = { name: 'current-activity', kind: 'activity', tier: 'deterministic', match: (q) => /what are you doing|working on/i.test(q) };
const cloudSyn = { name: 'cloud-synthesis', kind: 'synthesis', tier: 'cloud', match: (q) => /what do you think|opinion/i.test(q) ? 0.5 : 0 };
const sources = [deliverable, activity, cloudSyn];

// --- routing to the right source ---
ok(poll.route('how many think tanks?', sources).top.name === 'research-deliverable', '"how many" → deliverable source');
ok(poll.route('what are you doing right now?', sources).top.name === 'current-activity', '"what are you doing" → activity source');
ok(poll.route('what do you think of MIRI?', sources).top.name === 'cloud-synthesis', 'opinion → cloud-synthesis source');
ok(poll.route('lets get pizza', sources).handled === false, 'unrelated turn → not handled (falls to normal reply)');

// --- deterministic beats cloud on a tie of score ---
const detTie = { name: 'det', kind: 'x', tier: 'deterministic', match: () => 1 };
const cloudTie = { name: 'cl', kind: 'x', tier: 'cloud', match: () => 1 };
ok(poll.route('q', [cloudTie, detTie]).top.name === 'det', 'equal score → DETERMINISTIC wins over cloud');

// --- higher score wins regardless of tier ---
const weakDet = { name: 'weakdet', tier: 'deterministic', match: () => 0.3 };
const strongCloud = { name: 'strongcloud', tier: 'cloud', match: () => 0.9 };
ok(poll.route('q', [weakDet, strongCloud]).top.name === 'strongcloud', 'higher score wins even if cloud-tier');

// --- registration order breaks a full tie ---
const a = { name: 'a', tier: 'deterministic', match: () => 1 };
const b = { name: 'b', tier: 'deterministic', match: () => 1 };
ok(poll.route('q', [a, b]).top.name === 'a', 'full tie → registration order (first registered wins)');

// --- multiple matches are all returned, ranked ---
const multi = poll.route('how many — and what are you doing', sources);
ok(multi.matched.length === 2 && multi.matched.every(m => m.tier === 'deterministic'), 'multi-match returns all matching sources');

// --- fail-safe: a source whose match() throws is a non-match, never crashes ---
const boom = { name: 'boom', tier: 'deterministic', match: () => { throw new Error('x'); } };
ok(poll.route('how many?', [boom, deliverable]).top.name === 'research-deliverable', 'a throwing source is skipped, not fatal');
ok(poll.route('q', []).handled === false, 'empty registry → not handled');

// pick() convenience
ok(poll.pick('how many?', sources).kind === 'deliverable', 'pick() returns the winning source descriptor');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
