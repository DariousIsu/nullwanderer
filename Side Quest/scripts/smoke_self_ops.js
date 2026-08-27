/* Smoke: lib/self_ops — read-only operational exhaust (M2.5.2: logs, git history, obs_events).
 * The doors are the contract: only boot*.log / *.err.log by basename, only validated read-only
 * git argv, obs_events bounded + injectable (no live-db writes from this suite).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_ops.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const so = require('../lib/self_ops');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
// ⭐ SANDBOX-AWARE (2026-08-07). A rehearsal sandbox is a COPY of the tree with no boot logs and no
// git history of its own, so assertions about THE LIVE MACHINE's exhaust are unsatisfiable there by
// construction. Failing them made the FULL GATE unpassable inside any sandbox — which silently made
// the rehearsal loop's green exit (and the R2 proposal card) UNREACHABLE FOREVER: measured on need
// #48, a pristine copy with zero edits went "suite green, full gate red" on every iteration. These
// checks now SKIP with a visible note in a sandbox; the LOGIC above/below still runs everywhere.
const IN_SANDBOX = fs.existsSync(path.join(so.ROOT, '.rehearsal.json'));
const skip = (t) => console.log(`  ⏭ ${t} — skipped (rehearsal sandbox: no live boot logs / no own git history)`);

(async () => {
  // --- THE LOG JAIL: names, never paths ---
  ok(/not readable/.test(so.logRead('.env')), '.env bounces (not a log name)');
  ok(/not readable/.test(so.logRead('sq.db')), 'a database bounces');
  ok(/not readable/.test(so.logRead('lib/board.js')), 'source bounces (logs only here)');
  ok(/not readable/.test(so.logRead('boot_never_existed_zz.log')), 'a missing log says so honestly');
  ok(so._resolveLog('../../etc/boot1.log').abs === null || /boot1\.log$/.test(so._resolveLog('../../etc/boot1.log').abs || ''), 'traversal is stripped to a basename — the directories are fixed');

  // --- a real boot log reads (pick whichever exists on this machine) ---
  const dataDir = path.join(so.ROOT, 'data');
  const anyLog = (fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []).find((f) => /^boot[\w.-]*\.log$/i.test(f))
    || fs.readdirSync(so.ROOT).find((f) => /^boot[\w.-]*\.log$/i.test(f));
  if (anyLog) {
    const t = so.logRead(anyLog, { tail: 5 });
    ok(t.startsWith(anyLog.replace(/\.log$/i, '') + '.log') || t.startsWith(anyLog), `tail reads a real log (${anyLog})`);
    ok(/last \d+ line\(s\):/.test(t), 'tail names how many lines it shows');
    const g = so.logRead(anyLog, { grep: '\\[' });
    ok(/line\(s\) matching|no lines match/.test(g), 'grep mode answers with matches or an honest miss');
  } else if (IN_SANDBOX) {
    skip('a real boot log reads');
  } else {
    ok(false, 'no boot log found to read (expected at least one on this machine)');
  }

  // --- GIT, read-only, argv-jailed ---
  const log = await so.gitLog({ limit: 3 });
  ok(/^[0-9a-f]{7,}\s+\d{4}-\d{2}-\d{2}\s+/m.test(log), 'git_log returns hash + date + subject lines');
  // paths are app-root-relative, same convention as source_read (git resolves them against cwd)
  const scoped = await so.gitLog({ limit: 3, path: 'lib/self_source.js' });
  if (IN_SANDBOX) skip('git_log scopes to an app-relative path');
  else ok(/^[0-9a-f]{7,}\s+\d{4}-\d{2}-\d{2}\s+/m.test(scoped), 'git_log scopes to an app-relative path');
  ok(/not readable/.test(await so.gitLog({ since: '--exec=evil' })), 'an option-shaped since is refused');
  ok(/not readable/.test(await so.gitLog({ path: '-output=x' })), 'an option-shaped path is refused');
  const show = await so.gitShow({ ref: 'HEAD', maxChars: 800 });
  ok(/^commit [0-9a-f]{7,}/m.test(show) || /…\(chars/.test(show), 'git_show reads HEAD');
  const m = show.match(/"offset":(\d+)/);
  if (m) {
    const p2 = await so.gitShow({ ref: 'HEAD', offset: parseInt(m[1], 10), maxChars: 800 });
    ok(p2.startsWith(`…(HEAD continuing from char ${m[1]}`), "git_show's continuation note works verbatim (O2)");
  } else {
    ok(show.length <= 800 + 200, 'HEAD show fit in one page (no cursor needed)');
  }
  ok(/not readable/.test(await so.gitShow({ ref: '--all' })), 'an option-shaped ref is refused');
  ok(/not readable/.test(await so.gitShow({ ref: 'x; rm -rf' })), 'a shell-shaped ref is refused');

  // --- OBS EVENTS (injected in-memory db — the live store is never touched here) ---
  const Database = require('better-sqlite3');
  const dbh = new Database(':memory:');
  dbh.exec('CREATE TABLE obs_events (id INTEGER PRIMARY KEY, ts INTEGER, lane TEXT, kind TEXT, level TEXT, text TEXT, ref TEXT, data TEXT)');
  const now = Date.now();
  const ins = dbh.prepare('INSERT INTO obs_events (ts, lane, kind, level, text) VALUES (?,?,?,?,?)');
  ins.run(now - 60e3, 'heartbeat', 'line', 'info', '[heartbeat] suppressed semantic self-repeat');
  ins.run(now - 30e3, 'window', 'line', 'warn', '[fit] heartbeat prompt 27000ch over budget');
  ins.run(now - 10e3, 'rehearsal', 'line', 'info', '[rehearse] drive iterate step 3 green');
  ins.run(now - 9 * 3600e3, 'heartbeat', 'line', 'info', 'ancient event outside the window');
  const q1 = so.obsQuery({ lane: 'heartbeat', since_min: 240 }, { dbh });
  ok(/1 obs_event/.test(q1) && /suppressed semantic/.test(q1), 'lane filter + since window work (the 9h-old row excluded)');
  const q2 = so.obsQuery({ grep: 'rehears', since_min: 240 }, { dbh });
  ok(/rehearse.*drive iterate/i.test(q2), 'grep finds the rehearsal event (the inquiry-#147 shape: "inspect the rehearsal logs")');
  ok(/no obs_events/.test(so.obsQuery({ lane: 'nope' }, { dbh })), 'an empty result says so honestly');

  // --- localdb manifest now carries obs_events with a purpose line (the un-blacklist half) ---
  const localdb = require('../lib/localdb');
  const rows = [{ table: 'obs_events', rows: 1000 }, { table: 'route_obs', rows: 999999 }, { table: 'knowledge', rows: 50 }];
  const manifest = localdb.manifestTables(16, rows);
  // label corrected 2026-08-27 (H-KIND root): the purpose now names the OMNIBUS bus + the
  // lane='watch' boundary — it must still mention self-watch (the boundary), never AS the stream.
  ok(manifest.some((t) => t.table === 'obs_events' && /self-watch/i.test(t.purpose || '') && /omnibus/i.test(t.purpose || '')), 'obs_events is manifest-listed with the corrected omnibus purpose');
  ok(!manifest.some((t) => t.table === 'route_obs' && t.purpose), 'route_obs stays unlisted exhaust');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
