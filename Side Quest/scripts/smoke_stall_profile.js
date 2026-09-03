/* smoke_stall_profile.js — the stall profiler names the function that held the main thread (lib/stall_profile).
 *
 * Freeze cut 8 (2026-09-03): the 1.5–2s tail after cuts 1–7 is unmarked JS with no slow statement. V8's
 * sampling profiler samples on its own thread while the loop is wedged; a block's window is attributed to
 * the frames whose self-time fell inside it. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stall_profile.js
 */
'use strict';
const P = require('../lib/stall_profile');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

function hogTheLoopForTheSmoke(ms) {           // a NAMED synchronous hog — the profiler must name it
  const end = Date.now() + ms; let x = 0;
  while (Date.now() < end) { for (let i = 0; i < 5000; i++) x += Math.sqrt(i); }
  return x;
}
function quietHelperForTheSmoke(ms) { return hogTheLoopForTheSmoke(ms); }
// A NAMED caller whose time is spent in a NATIVE leaf (better-sqlite3 Statement.get) — the shape of the
// live blocks the self-time line could not name (`30% get · 24% Statement · 11% all`, no repo frame).
function stormOfGetsForTheSmoke(ms) {
  const Database = require('better-sqlite3');
  const d = new Database(':memory:');
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'); d.prepare("INSERT INTO t (v) VALUES ('x')").run();
  const stmt = d.prepare('SELECT v FROM t WHERE id = ?');
  const end = Date.now() + ms; let n = 0;
  while (Date.now() < end) { for (let i = 0; i < 200; i++) { stmt.get(1); n++; } }
  d.close();
  return n;
}

(async () => {
  const a = await P.arm({ windowMs: 5000 });
  ok(a.armed === true, `arm: the inspector session profiles this process (${a.why || 'ok'})`);
  ok((await P.arm()).armed === true && P.armed(), 'arm is idempotent');

  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  quietHelperForTheSmoke(400);
  const t1 = Date.now();
  const r = await P.attribute({ endMs: t1, driftMs: t1 - t0 });
  ok(r && r.sampledMs >= 200, `the blocked window was SAMPLED while the loop was wedged (${r && r.sampledMs}ms of ${t1 - t0}ms)`);
  ok(r && r.top.length && /hogTheLoopForTheSmoke/.test(r.top[0].label) && r.top[0].pct >= 60,
    `CRITICAL: the top frame is the hog itself, by name, with the majority share (${r && r.top[0] && r.top[0].label} ${r && r.top[0] && r.top[0].pct}%)`);
  ok(r && /smoke_stall_profile\.js:\d+/.test(r.top[0].label), 'the frame carries its repo-relative file and line');
  ok(r && /ms sampled in the \d+ms block: \d+% hogTheLoopForTheSmoke/.test(r.line), 'the log line reads as one sentence: share, function, file:line');

  // ⭐ cut 16 — WHO PAID: a storm of small calls is charged to the repo caller (nearest) and the lane (outermost)
  // by INCLUSIVE time, whatever the leaf. (A quiet 1.2s first, so the slack window holds only the storm.)
  await new Promise((res) => setTimeout(res, 1200));
  const g0 = Date.now(); stormOfGetsForTheSmoke(400); const g1 = Date.now();
  const g = await P.attribute({ endMs: g1, driftMs: g1 - g0 });
  console.log('  storm: ' + (g && g.line));
  ok(g && /scripts\/smoke_stall_profile\.js:\d+/.test(g.top[0].label), '⭐ frames are REPO-RELATIVE again (the profile URL is percent-encoded — `Side%20Quest` — and must be decoded before the repo-root test; every `via` had silently vanished since cut 10)');
  ok(g && g.paidBy && g.paidBy.length && /^stormOfGetsForTheSmoke \(scripts\/smoke_stall_profile\.js:\d+\)$/.test(g.paidBy[0].label) && g.paidBy[0].pct >= 60,
    `CRITICAL: the storm's own function is named as the NEAREST frame that paid (${g && g.paidBy ? g.paidBy.map((x) => x.pct + '% ' + x.label).join(' · ') : 'none'})`);
  ok(g && g.under && g.under.length && /\(scripts\/smoke_stall_profile\.js:\d+\)$/.test(g.under[0].label) && g.under[0].pct >= 60,
    `the OUTERMOST repo frame (the lane) is named under it (${g && g.under ? g.under.map((x) => x.pct + '% ' + x.label).join(' · ') : 'none'})`);
  const natives = g ? g.top.filter((r) => !/\((?:scripts|lib|studio|main\.js)/.test(r.label) && !/garbage collector|\(program\)/.test(r.label)) : [];
  ok(natives.every((r) => !!r.via), `every native/library leaf row carries a via (${natives.length ? natives.map((r) => `${r.label} via ${r.via}`).join(' · ') : 'no native leaf rows — better-sqlite3’s time folds into its JS caller in this build'})`);
  ok(g && /— paid by: \d+% stormOfGetsForTheSmoke \(scripts\/smoke_stall_profile\.js:\d+\)/.test(g.line) && / — under: \d+% /.test(g.line), 'the log line ends with who paid and under which lane');
  // cut 17: the instruments are never "who paid" — the slow-sync probe's wrapper sits above every
  // native Statement leaf and would otherwise be named where the app's caller was meant
  {
    const root = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
    const url = (rel) => 'file:///' + encodeURI(root + '/' + rel);
    ok(!P._isRepoFrame({ url: url('lib/slow_sync_probe.js') }) && !P._isRepoFrame({ url: url('lib/stall_profile.js') }) && P._isRepoFrame({ url: url('lib/db.js') }) && P._isRepoFrame({ url: url('main.js') }),
      'an instrument frame (the slow-sync probe wrapper, the profiler itself) is never a repo frame; app frames are — percent-encoded URLs included');
  }

  // a quiet window attributes to nothing (no false culprit)
  await new Promise((res) => setTimeout(res, 120));
  const q0 = Date.now(); await new Promise((res) => setTimeout(res, 60)); const q1 = Date.now();
  const q = await P.attribute({ endMs: q1, driftMs: q1 - q0, slackMs: 0 });
  ok(!q || q.sampledMs < 30, `a window where the loop was FREE yields no culprit (${q ? q.sampledMs + 'ms' : 'null'})`);

  // a block that straddles a window rotation is still covered (the last KEEP windows are read)
  const s0 = Date.now(); hogTheLoopForTheSmoke(150); await P._rotate(); hogTheLoopForTheSmoke(150); const s1 = Date.now();
  const s = await P.attribute({ endMs: s1, driftMs: s1 - s0 });
  // (by now TurboFan has INLINED the hog into its caller, so V8 attributes its samples to the caller's
  // frame — still this file, still a line; the profiler names where the time went, not which inlined body)
  ok(s && s.sampledMs >= 200 && /smoke_stall_profile\.js:\d+/.test(s.top[0].label) && s.top[0].pct >= 60,
    `a block across a window rotation is attributed from both windows (${s ? s.sampledMs + 'ms · ' + s.top.map((x) => x.pct + '% ' + x.label).join(' · ') : 'null'})`);

  await P.disarm();
  ok(!P.armed() && (await P.attribute({ endMs: Date.now(), driftMs: 100 })) === null, 'disarmed → no attribution, no throw');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke_stall_profile crashed:', e); process.exit(1); });
