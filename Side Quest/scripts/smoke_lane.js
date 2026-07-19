/* smoke_lane.js — the ambient lane (which run does this Echo call belong to?).
 *
 * The load-bearing test is CONCURRENT ISOLATION. A module-level flag would pass every other test
 * here and still be wrong in production, because up to 3 operator runs are in flight at once and a
 * foreground chat turn racing two background passes would read whichever flag was set last — the
 * exact confusion this flag exists to prevent. So the interleaving test below is the whole point.
 */
'use strict';
const lane = require('../lib/lane');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }
const tick = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── outside any run ──────────────────────────────────────────────────────────────────────────
  ok(typeof lane.current() === 'object', 'current() outside a run → object');
  ok(lane.isAutonomous(undefined) === false, 'no ambient lane → not autonomous');

  // ── explicit always wins ─────────────────────────────────────────────────────────────────────
  ok(lane.isAutonomous(true) === true, 'explicit true wins');
  ok(lane.isAutonomous(false) === false, 'explicit false wins');
  await lane.run({ autonomous: true }, async () => {
    ok(lane.isAutonomous(undefined) === true, 'ambient autonomous read inside run');
    ok(lane.isAutonomous(false) === false, 'SAFETY: explicit false is NOT overridden by ambient true');
  });

  // ── survives await boundaries (the reason a plain variable is not enough) ─────────────────────
  await lane.run({ autonomous: true }, async () => {
    await tick(5);
    ok(lane.isAutonomous(undefined) === true, 'ambient survives an await');
    await (async () => { await tick(5); ok(lane.isAutonomous(undefined) === true, 'ambient survives nesting'); })();
  });
  ok(lane.isAutonomous(undefined) === false, 'ambient does not leak after the run ends');

  // ── THE POINT: concurrent runs do not contaminate each other ─────────────────────────────────
  {
    const seen = {};
    const mk = (name, autonomous, delay) => lane.run({ autonomous }, async () => {
      await tick(delay);                       // interleave: each run yields mid-flight
      seen[name] = lane.isAutonomous(undefined);
      await tick(delay);
      seen[name + '2'] = lane.isAutonomous(undefined);
    });
    await Promise.all([mk('bgA', true, 12), mk('fg', false, 6), mk('bgB', true, 3)]);
    ok(seen.bgA === true && seen.bgA2 === true, 'background run A stays autonomous throughout');
    ok(seen.bgB === true && seen.bgB2 === true, 'background run B stays autonomous throughout');
    ok(seen.fg === false && seen.fg2 === false,
      'SAFETY: the FOREGROUND run is never mislabelled by concurrent background runs');
  }

  // ── fail-soft ────────────────────────────────────────────────────────────────────────────────
  ok(lane.run(null, () => 'ran') === 'ran', 'run() with null ctx still executes fn');
  ok(lane.run({ autonomous: true }, () => 42) === 42, 'run() returns fn value synchronously');
  let threw = false;
  try { lane.run({ autonomous: true }, null); } catch { threw = true; }
  ok(!threw, 'run() with a non-function does not throw');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
