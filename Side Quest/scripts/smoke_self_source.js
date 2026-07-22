/* Smoke: lib/self_source — read-only source self-access + the gate self-test (slice 3a).
 * THE JAIL IS THE CONTRACT: every escape shape must bounce with a plain refusal, never a throw.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_source.js
 */
'use strict';
const ss = require('../lib/self_source');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- THE JAIL: escapes bounce ---
  ok(ss.resolveSafe('../outside.js').abs === null, 'parent-dir traversal bounces');
  ok(ss.resolveSafe('lib/../../elsewhere/x.js').abs === null, 'buried traversal bounces');
  ok(ss.resolveSafe('C:/Windows/system32/drivers/etc/hosts').abs === null, 'absolute path bounces');
  ok(ss.resolveSafe('/etc/passwd').abs === null, 'unix absolute path bounces');
  ok(ss.resolveSafe('.env').abs === null, '.env (SECRETS) bounces by name');
  ok(ss.resolveSafe('lib/.env.backup').abs === null, '.env at any depth bounces');
  ok(ss.resolveSafe('data/sq.db').abs === null, 'data/ (her databases) bounces');
  ok(ss.resolveSafe('node_modules/better-sqlite3/package.json').abs === null, 'node_modules bounces');
  ok(ss.resolveSafe('boot40.log').abs === null, 'log files bounce');
  ok(ss.resolveSafe('logs_archive/boot12.log').abs === null, 'archived logs bounce');
  ok(ss.resolveSafe('package-lock.json').abs === null, 'package-lock bounces (noise, not source)');
  ok(ss.resolveSafe('lib/db.exe').abs === null, 'non-source extension bounces');
  ok(/not readable/.test(ss.readSource('../secrets.txt')) && /not readable/.test(ss.readSource('.env')), 'readSource refuses politely, never throws');

  // --- allowed reads work ---
  ok(ss.resolveSafe('lib/board.js').abs !== null, 'lib/*.js resolves');
  ok(ss.resolveSafe('main.js').abs !== null, 'root main.js resolves');
  ok(ss.resolveSafe('docs/BUILD_HANDOFF_2026-07-22.md').abs !== null, 'docs/*.md resolves');
  const body = ss.readSource('lib/self_source.js');
  ok(/THE JAIL IS THE CONTRACT/.test(body), 'she can read the module that jails her reads (this one)');
  ok(/no such file/.test(ss.readSource('lib/never_existed.js')), 'a missing file says so honestly');
  const big = ss.readSource('main.js', { maxChars: 5000 });
  ok(big.length < 5300 && /first 5000 of \d+ chars/.test(big), 'a big file caps with the honest deferral note');

  // --- the map ---
  const map = ss.sourceMap();
  ok(/lib\/board\.js/.test(map) && /lib\/autonomy\.js/.test(map), 'the map lists her modules');
  ok(/THE WORKSTREAM BOARD|workstream/i.test(map), "modules carry their own header line (the repo's headers ARE her self-description)");
  ok(!/\.env|sq\.db|node_modules/.test(map), 'the map never mentions secrets/data/dependencies');

  // --- search ---
  const hits = ss.searchSource('WATERMARK_KEY');
  ok(/lib\/conversation_objects\.js:\d+/.test(hits), 'search finds a symbol with file:line');
  ok(/no matches/.test(ss.searchSource('zz_never_in_any_file_zz')), 'no matches says so honestly');
  ok(typeof ss.searchSource('[invalid(regex') === 'string', 'an invalid regex falls back to literal, never throws');

  // --- the gate self-test (one FAST pure suite, end-to-end through her own binary) ---
  ok(/not a valid suite/.test(await ss.selfTest({ suite: '../../evil.js' })), 'selfTest suite name is jailed');
  ok(/no such suite/.test(await ss.selfTest({ suite: 'smoke_never_existed.js' })), 'a missing suite says so');
  const run = await ss.selfTest({ suite: 'smoke_recall.js' });
  ok(/ALL PASS/.test(run), 'she can run ONE of her own verification suites and read the verdict');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
