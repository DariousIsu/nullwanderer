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
  // --- O2 cursors: a cap is a page size, and page 2 is REALLY page 2 ---
  const fs = require('fs'), path = require('path');
  const full = fs.readFileSync(path.join(ss.ROOT, 'main.js'), 'utf8');
  const p1 = ss.readSource('main.js', { maxChars: 5000 });
  ok(/chars 0-5000 of \d+/.test(p1) && /"offset":5000/.test(p1), 'page 1 caps with a note naming the exact continuation call');
  const p2 = ss.readSource('main.js', { offset: 5000, maxChars: 5000 });
  ok(p2.startsWith('…(main.js continuing from char 5000'), 'page 2 announces its position');
  ok(p2.slice(p2.indexOf('\n') + 1).startsWith(full.slice(5000, 5040)), 'page 2 starts at exactly char 5000 (the cursor is honest)');
  const noteOff = parseInt((p1.match(/"offset":(\d+)/) || [])[1], 10);
  const p2b = ss.readSource('main.js', { offset: noteOff, maxChars: 5000 });
  ok(Number.isFinite(noteOff) && !/not readable/.test(p2b) && p2b !== p1, "the note's suggested call works verbatim (O2 proof gate)");
  ok(/past the end/.test(ss.readSource('lib/self_source.js', { offset: 99999999 })), 'an offset past the end says so, naming the last-page start');
  ok(!/…\(chars/.test(ss.readSource('package.json')), 'a file within the cap comes back whole, no cursor noise');

  // --- O3 the ranked map (async — the scan runs in a worker) ---
  const map = await ss.sourceMap();
  ok(/ranked by how much/.test(map), 'the map declares its ranking');
  ok(/main\.js \(\d+KB/.test(map), 'main.js (the entry point) ranks into the default budget');
  ok(/lib\/board\.js \(\d+KB, used by \d+/.test(map), 'a leaned-on lib module ranks in, carrying its inbound count');
  ok(/lib\/db\.js/.test(map), 'the most-required module is present');
  ok(/THE WORKSTREAM BOARD|workstream/i.test(map), "modules carry their own header line (the repo's headers ARE her self-description)");
  ok(!/\.env|sq\.db|node_modules/.test(map), 'the map never mentions secrets/data/dependencies');
  ok(/meeting/i.test(await ss.sourceMap({ focus: 'meeting scribe notes' })), 'a focus pulls topically-matching files into the map');

  // --- O3 outline → O2 cursor: the navigation loop closes ---
  const outline = ss.sourceOutline('main.js');
  ok(outline.length < 20000, 'outline of the ~1MB main.js fits under 20k chars');
  ok(/L\d+ @\d+: /.test(outline), 'outline entries carry line + char addresses');
  const om = ss.sourceOutline('lib/self_source.js').match(/L\d+ @(\d+): function readSource/);
  ok(!!om, "outline finds readSource's definition in this module");
  ok(om && ss.readSource('lib/self_source.js', { offset: parseInt(om[1], 10), maxChars: 200 }).includes('function readSource'), 'reading at an outline @char lands exactly on the symbol');
  ok(/not readable/.test(ss.sourceOutline('data/sq.db')), 'outline is jailed like every other read');

  // --- search: ALL the source, off the main thread ---
  const hits = await ss.searchSource('WATERMARK_KEY');
  ok(/lib\/conversation_objects\.js:\d+/.test(hits), 'search finds a symbol with file:line');
  ok(/main\.js:\d+/.test(await ss.searchSource('async function runCloudOperator')), 'search reaches the main.js definition (the full corpus is scanned — proof gate)');
  ok(/no matches .+ files scanned/.test(await ss.searchSource('zz_never_in_any_file_zz')), 'no matches says so honestly, naming the corpus size');
  ok(typeof (await ss.searchSource('[invalid(regex')) === 'string', 'an invalid regex falls back to literal, never throws');

  // --- self-code-review intent (the trigger that routes "review your code" to the operator) ---
  ok(ss.isSelfCodeReview('access your code base and run a full review and report'), 'catches "access your code base and run a full review"');
  ok(ss.isSelfCodeReview('read your code'), 'catches "read your code"');
  ok(ss.isSelfCodeReview('what about evaluating her own code'), 'catches the "evaluating her own code" gerund');
  ok(ss.isSelfCodeReview('can you analyze your implementation'), 'catches analyze + your implementation');
  ok(!ss.isSelfCodeReview('review the contacts we hold'), 'a review of NON-code data is not self-code-review');
  ok(!ss.isSelfCodeReview('are you ready to go'), '"ready" does not trip the read verb');
  ok(!ss.isSelfCodeReview('look at your calendar'), '"look at your calendar" is not code');

  // --- the gate self-test (one FAST pure suite, end-to-end through her own binary) ---
  ok(/not a valid suite/.test(await ss.selfTest({ suite: '../../evil.js' })), 'selfTest suite name is jailed');
  ok(/no such suite/.test(await ss.selfTest({ suite: 'smoke_never_existed.js' })), 'a missing suite says so');
  const run = await ss.selfTest({ suite: 'smoke_recall.js' });
  ok(/ALL PASS/.test(run), 'she can run ONE of her own verification suites and read the verdict');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
