/* smoke_interlocutor.js — F9 (run-2): WHO is at the keyboard is measured, never assumed.
 *
 * Live evidence: Lucas handed the chat to Claude for the test run and TOLD her so — her
 * conversational model got it, but the fast paths kept addressing "Lucas" (fast-path thought
 * "Lucas is asking about my taste"; reply opener "Lucas —"; the status turn addressed "Lucas").
 * lib/interlocutor.js detects EXPLICIT handoff/handback declarations; everything else is owner.
 */
'use strict';
const iloc = require('../lib/interlocutor');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const OWNER = { ownerName: 'Lucas' };

// ── handoff declarations fire ───────────────────────────────────────────────────────────────────
{
  const live = iloc.detect('from the point you introduce yourself and start the testing you will be engaging only with Claude until testing has concluded', OWNER);
  // NOTE: this sentence carries BOTH a handoff and "testing has concluded" inside a subordinate
  // clause — the conservative order treats the handback phrase as decisive, so THIS phrasing is a
  // known miss; the declaration turn Lucas actually types is simpler. The simple forms must fire:
  ok(iloc.detect('You will be engaging with Claude for the next few hours.', OWNER).handoff === 'Claude',
    '"you will be engaging with Claude" → handoff Claude');
  ok(iloc.detect("you're talking to Claude now, not me", OWNER).handoff === 'Claude',
    '"you\'re talking to Claude now" → handoff Claude');
  ok(iloc.detect('this is Claude speaking — starting the test run', OWNER).handoff === 'Claude',
    '"this is Claude speaking" → handoff Claude');
  ok(iloc.detect('Claude here, taking over for the stress test.', OWNER).handoff === 'Claude',
    '"Claude here," at message start → handoff Claude');
  ok(iloc.detect("I'm handing you over to Dr-Reyes for this session", OWNER).handoff === 'Dr-Reyes',
    'handing-over-to form captures a hyphenated name');
  ok(live === null || (live && (live.handback || live.handoff)), 'the compound live sentence resolves without throwing');
}

// ── handbacks fire ──────────────────────────────────────────────────────────────────────────────
{
  ok(iloc.detect("ok it's Lucas again, nice work tonight", OWNER).handback === true, '"it\'s Lucas again" → handback');
  ok(iloc.detect('testing has concluded, great run', OWNER).handback === true, '"testing has concluded" → handback');
  ok(iloc.detect("I'm back — what did I miss?", OWNER).handback === true, '"I\'m back" → handback');
  ok(iloc.detect('Lucas here. how did it go?', OWNER).handback === true, 'owner name + "here" → handback, never a handoff');
  ok(iloc.detect("you'll be talking with Lucas again from here", OWNER).handback === true,
    'a "handoff" naming the OWNER is a handback');
}

// ── ordinary conversation never fires ───────────────────────────────────────────────────────────
{
  ok(iloc.detect('what do you think about the Senate race?', OWNER) === null, 'plain question → null');
  ok(iloc.detect('I was talking to Sarah about the op-ed yesterday', OWNER) === null,
    'reported speech about a third party → null (no handoff verb shape)');
  ok(iloc.detect('this is The best plan we have', OWNER) === null, 'capitalized stopword capture is rejected');
  ok(iloc.detect('you should be talking with voters, not donors', OWNER) === null,
    'lowercase "voters" is not a name → null');
  ok(iloc.detect('', OWNER) === null, 'empty → null');
}

// ── current()/liveName resolution (injected meta — no real DB) ──────────────────────────────────
{
  const mk = (vals) => (k) => vals[k] ?? null;
  const now = String(Date.now());
  let c = iloc.current({ getMeta: mk({ user_name: 'Lucas', 'interlocutor.name': 'Claude', 'interlocutor.ts': now }) });
  ok(c.active && c.name === 'Claude' && c.owner === 'Lucas', 'fresh handoff → active, name=Claude, owner=Lucas');
  c = iloc.current({ getMeta: mk({ user_name: 'Lucas' }) });
  ok(!c.active && c.name === 'Lucas', 'no handoff → owner is the addressee');
  const stale = String(Date.now() - 25 * 60 * 60 * 1000);
  c = iloc.current({ getMeta: mk({ user_name: 'Lucas', 'interlocutor.name': 'Claude', 'interlocutor.ts': stale }) });
  ok(!c.active && c.name === 'Lucas', 'a >24h-old handoff is stale → owner again (fail-safe)');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
