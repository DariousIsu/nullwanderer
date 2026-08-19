/* smoke_recent_turns_session_scope.js — the cross-session context-bleed guard (2026-08-19).
 *
 * Proves db.getRecentTurns(n, sessionId) scopes the window to ONE conversation — the cure for the
 * 08-19 bleed where an s1188 "Louisiana / unwinding" conversation contaminated an s1195 "summarize
 * the book" reply (twice, verbatim), because the reply-context window was GLOBAL and interleaved
 * sessions sat pinned at its top. The primary reply path was fixed in db10345; this guard covers the
 * whole KIND — every callsite that feeds a user-facing reply or resolves user anaphora against turn
 * content now passes its sessionId (referent/demonstrative resolution, recall excludeIds, canvas
 * build/edit orders, research-subject derivation, delivery-promise context, tool-followup context,
 * action-step context). Test the CLASS, not the one phrase that tripped it.
 *
 * The global form (no sessionId) MUST still interleave — that is the diagnosis, and the background
 * affect/telemetry lanes (mood cultivation, dashboard metrics, turn counts) legitimately keep it.
 *
 * Isolated: runs against a throwaway temp DB (SQ_DB_PATH), never the live store — safe any time.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_recent_turns_session_scope.js
 */
'use strict';
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_rtscope_${process.pid}`, 'sq.db');
const db = require('../lib/db'); db.init();

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Two conversations, inserted A,B,A,B,… so a global window NECESSARILY mixes them (the bleed shape).
const A = db.startSession();
const B = db.startSession();
for (let i = 0; i < 10; i++) {
  db.insertTurn({ sessionId: A, speaker: i % 2 ? 'ai_said' : 'user', content: `A-${i} louisiana parish unwinding` });
  db.insertTurn({ sessionId: B, speaker: i % 2 ? 'ai_said' : 'user', content: `B-${i} summarize the book` });
}

console.log('getRecentTurns(n, sessionId) — scoped to ONE conversation:');
const scopedB = db.getRecentTurns(8, B);
ok('returns turns from ONLY the requested session', scopedB.length > 0 && scopedB.every(t => t.session_id === B));
ok('contains NO foreign-session turns', !scopedB.some(t => t.session_id === A));
ok('content is all B ("the book"), zero A bleed ("louisiana")',
   scopedB.every(t => /the book/.test(t.content)) && !scopedB.some(t => /louisiana/.test(t.content)));
ok('window is oldest-first (ASC by id), same order contract as global',
   scopedB.every((t, i, a) => i === 0 || a[i - 1].id < t.id));

console.log('\nglobal getRecentTurns(n) — the pre-fix behavior the affect/telemetry lanes still use:');
const global8 = db.getRecentTurns(8);
ok('DOES interleave both sessions (proves scoping is load-bearing, not cosmetic)',
   global8.some(t => t.session_id === A) && global8.some(t => t.session_id === B));

console.log('\nnull / undefined sessionId falls back to global (pass-through callers never crash):');
ok('explicit null → global', db.getRecentTurns(4, null).length === 4);
ok('explicit undefined → global (default param, undefined == null)', db.getRecentTurns(4, undefined).length === 4);

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
