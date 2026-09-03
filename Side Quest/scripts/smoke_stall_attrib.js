/* smoke_stall_attrib.js — the stall attributor names the lane that blocked the loop (lib/stall_attrib).
 *
 * Freeze cut 5 (2026-09-03): a lane whose sync block ends by marking ANOTHER lane in the same macrotask
 * was never named — boot_p256's 47 decompose-sweep stalls all read `"decompose doc#N" (3ms)`. Pure
 * functions, no db. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stall_attrib.js
 */
'use strict';
const S = require('../lib/stall_attrib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const T = 1_000_000;
const idle0 = { label: 'idle', at: T - 60000 };

// A lane that is STILL running when the probe wakes is named plainly, with its own run length.
{
  const a = S.next(idle0, 'decompose-sweep', T);
  const r = S.attribute(a, T + 5000, 4000);
  ok(r.label === 'decompose-sweep' && r.ranMs === 5000, 'a lane active across the whole blocked window is named plainly');
}
// THE BLIND SPOT: the block ends by marking a different lane in the same macrotask.
{
  const sweep = S.next(idle0, 'decompose-sweep', T);
  const doc = S.next(sweep, 'decompose doc#51151', T + 4500);      // findUndecomposed returned; the pick starts
  const r = S.attribute(doc, T + 4600, 3500);                       // the probe wakes 100ms later
  ok(r.label === 'decompose-sweep → decompose doc#51151' && r.ranMs === 4500,
    'CRITICAL: a transition INSIDE the blocked window names the lane that ENDED there, with its run length — not the 3ms-old newcomer');
}
// The original idle case keeps its shape.
{
  const sweep = S.next(idle0, 'docfts-sync', T);
  const idle = S.next(sweep, 'idle', T + 3000);
  const r = S.attribute(idle, T + 3100, 2000);
  ok(r.label === 'idle (just-ended: docfts-sync)' && r.ranMs === 3000, 'a lane that went idle at the end of the block is named as just-ended');
}
// Idle that predates the window, with no transition inside it: honest "idle".
{
  const r = S.attribute({ label: 'idle', at: T - 13689 }, T, 3711);
  ok(r.label === 'idle' && r.ranMs === 13689, 'a stall under a long-standing idle stays "idle" (unmarked work — the slow-sync probe names the statement)');
}
// A repeated mark carries the stamp forward; a stale transition (long before the window) does not name anything.
{
  const lane = S.next(idle0, 'metabolism', T);
  const i1 = S.next(lane, 'idle', T + 1000);
  const i2 = S.next(i1, 'idle', T + 2000);
  ok(i2.prevLabel === 'metabolism' && i2.prevEndAt === T + 1000, 'consecutive idle marks carry the just-ended stamp forward');
  const r = S.attribute(i2, T + 60000, 3000);
  ok(r.label === 'idle', 'a transition long BEFORE the window is not blamed for it');
  const y = S.next(i2, 'autonomy-tick', T + 3000);
  const r2 = S.attribute(y, T + 30000, 5000);
  ok(r2.label === 'autonomy-tick' && r2.ranMs === 27000, 'a lane that started long before the window is the plain culprit even though it has a prev');
}
// A lane that STARTED at the end of an unmarked block: the block belongs to what preceded it.
{
  const y = S.next({ label: 'idle', at: T - 9000 }, 'directed-tick', T);
  const r = S.attribute(y, T + 50, 4000);
  ok(r.label === 'idle → directed-tick' && r.ranMs === 9000, 'a lane 50ms old is not blamed for a 4s block — the block preceded it under idle');
}
ok(S.next(null, 'x', T).label === 'x' && S.next(null, undefined, T).label === 'idle', 'a missing prev / label degrade to idle');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
