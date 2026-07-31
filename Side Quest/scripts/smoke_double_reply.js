/* smoke_double_reply.js — one turn, one reply.
 *
 * Live failure 2026-07-20: a handler (ambiguity ASK, contacts route, doc-QA, status…) delivers a
 * complete user-facing reply through fireToolFollowup, and the turn then generated a SECOND one.
 * `followupFired` gates fifteen downstream blocks and never reached the reply generation itself.
 *
 * What Lucas saw: the wrong answer arrived first, and the RIGHT answer landed seconds later in the
 * UNPROMPTED rail — the renderer routes by whether a turn is still open, and the first reply had
 * already closed it. A real answer filed as an unprompted musing is the worst version of this: it
 * reads as her talking to herself, and leaves the visibly-wrong reply as the answer of record.
 *
 * Two invariants, both source-asserted (this is main.js turn control flow, not a unit):
 *   1. the gate keys on io._spoke — a follow-up that DELIVERED — not on followupFired, a handler
 *      that merely ran. A follow-up that fired and said nothing must still fall through and answer;
 *      a silent turn would be worse than the duplicate.
 *   2. the early return RESUMES the idle loops. runChatTurn pauses them at its start and every
 *      other early return resumes; missing it would leave the monologue/heartbeat/continuity/
 *      reflection rails paused until restart — silently, because a paused loop just never ticks.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// ── the gate exists, and is placed BEFORE any reply is generated ────────────────────────────────
{
  ok(/if \(followupFired && io && io\._spoke\)/.test(src),
    'the turn short-circuits when a follow-up already delivered a reply');
  ok(/answeredByFollowup: true/.test(src), 'and reports why it produced no say');

  const gate = src.indexOf('if (followupFired && io && io._spoke)');
  const cloudReply = src.indexOf('THE CLOUD WRITES THE REPLY (V1)');
  const localReply = src.indexOf('else await streamChat({');
  ok(gate > 0 && cloudReply > gate, 'the gate precedes the CLOUD reply');
  ok(gate > 0 && localReply > gate, 'the gate precedes the LOCAL reply');
}

// ── ⭐ keyed on DELIVERY, not on a handler having run ────────────────────────────────────────────
{
  ok(!/if \(followupFired\)\s*\{\s*\r?\n\s*console\.log\('\[main\] turn already answered/.test(src),
    'REGRESSION: not gated on followupFired alone — a fired-but-silent follow-up must still answer');
  const spokeSet = src.match(/if \(io\) io\._spoke = true;/g) || [];
  ok(spokeSet.length === 1, '_spoke is set in exactly one place');
  // …and that place must be inside the branch that actually delivered text.
  const at = src.indexOf('if (io) io._spoke = true;');
  // Window widened 2026-07-31: the guard sits 608 chars back, and a 600-char window failed by eight.
  // A distance-sensitive assertion is a bad guard for a stable fact, so the real check is the
  // absence test below — this one just locates the nearest enclosing branch.
  const before = src.slice(Math.max(0, at - 1400), at);
  // ⭐ Tightened 2026-07-31: the guard was `if (sayOut)`, a TRUTHY test, and "…" is truthy — she
  // marked the turn as spoken having shown Lucas a single ellipsis (#10384). SUBSTANCE, not
  // truthiness: at least one letter or digit.
  ok(/if \(voice\.isSubstantive\(sayOut\)\) \{/.test(before),
    '_spoke is set only where she said something SUBSTANTIVE — punctuation alone is not speaking');
  // Distance-independent, and the one that actually matters: the truthy guard must be GONE, or a
  // punctuation-only reply can mark the turn spoken again from some other branch.
  ok(!/if \(sayOut\) \{/.test(src),
    '⭐ no reply branch gates on truthiness — "…" must never count as having spoken');
}

// ── ⭐ the early return resumes the idle loops ───────────────────────────────────────────────────
{
  const at = src.indexOf('if (followupFired && io && io._spoke)');
  const block = src.slice(at, at + 900);
  for (const fn of ['resumeMonologue()', 'resumeHeartbeat()', 'resumeContinuity()', 'resumeReflection()', 'selfDialogue.resume()']) {
    ok(block.includes(fn), `the early return calls ${fn} — runChatTurn paused them at its start`);
  }
  ok(block.indexOf('resumeMonologue()') < block.indexOf('return {'),
    'resumed BEFORE returning, not after (unreachable)');
}

// ── the flag is turn-scoped: `io` is built fresh per chat:send, so it cannot leak ────────────────
{
  // Window widened + `await` allowed since the turn-watchdog (setTimeout + try/finally clearTimeout)
  // now sits between the handler open and the call, and the call is `return await runChatTurn(...)`
  // so finally can clear the timer. io is still the inline object literal built per chat:send.
  ok(/ipcMain\.handle\('chat:send'[\s\S]{0,1300}?return await runChatTurn\(userMessage, attachments, \{/.test(src),
    'io is constructed inline per chat:send — _spoke cannot survive into the next turn');
  ok(!/^\s*let _spoke/m.test(src) && !/global\._spoke/.test(src),
    'no module-level or global _spoke that would leak across turns');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
