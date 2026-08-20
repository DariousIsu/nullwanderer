/* smoke_dual_emission.js — the dual-emission backstop (run-2b, resurfaced 2026-08-19).
 *
 * Live: a VERBATIM say landed in the transcript twice, 5 seconds apart (the forecast-probe turn).
 * The replay-gate only STAMPS near-verbatim repeats for the voice rail — the store still took both
 * copies, and everything downstream (context windows, audits, run reviews) read a stutter.
 *
 * The guard in db.insertTurn: an IDENTICAL substantive ai_said (≥40ch) in the SAME session within
 * 30s is one utterance emitted twice by racing paths — the first row is kept and returned; the copy
 * is never inserted. Short acks, different sessions, and different texts all still insert.
 *
 * Isolated temp DB (SQ_DB_PATH) — never the live store.
 */
'use strict';
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_dualemit_${process.pid}`, 'sq.db');
const db = require('../lib/db'); db.init();

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const S = db.startSession();
const LONG = 'The forecast engine currently holds a 47.4% probability of Democratic control with 217 seats.';

// the live shape: identical substantive say, seconds apart, same session → ONE row
const first = db.insertTurn({ sessionId: S, speaker: 'ai_said', content: LONG });
const second = db.insertTurn({ sessionId: S, speaker: 'ai_said', content: LONG });
ok('the duplicate returns the ORIGINAL row id', second.id === first.id);
ok('the duplicate is flagged deduped', second.deduped === true);
const count = db.getDb().prepare("SELECT COUNT(*) n FROM turns WHERE speaker='ai_said' AND content = ?").get(LONG).n;
ok('the store holds exactly ONE copy', count === 1);

// a DIFFERENT substantive say still inserts
const other = db.insertTurn({ sessionId: S, speaker: 'ai_said', content: 'A different reply about the Louisiana Senate District 14 vacancy timeline and its sourcing.' });
ok('a different say inserts normally', other.id !== first.id && !other.deduped);

// a SHORT ack ("Done.") may legitimately repeat — never deduped
const a1 = db.insertTurn({ sessionId: S, speaker: 'ai_said', content: 'Done.' });
const a2 = db.insertTurn({ sessionId: S, speaker: 'ai_said', content: 'Done.' });
ok('short identical acks both insert (two real answers to two quick orders)', a2.id !== a1.id && !a2.deduped);

// the same text in a DIFFERENT session is a different conversation — inserts
const S2 = db.startSession();
const x = db.insertTurn({ sessionId: S2, speaker: 'ai_said', content: LONG });
ok('the same text in another session inserts (session-scoped guard)', x.id !== first.id && !x.deduped);

// user turns are never deduped (a user may paste the same thing twice on purpose)
const u1 = db.insertTurn({ sessionId: S, speaker: 'user', content: LONG });
const u2 = db.insertTurn({ sessionId: S, speaker: 'user', content: LONG });
ok('identical user turns both insert', u2.id !== u1.id && !u2.deduped);

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
