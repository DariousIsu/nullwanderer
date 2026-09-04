/* smoke_cut22.js — CUT 22 (2026-09-04): two residue blocks from boot_p279's stall ledger, cured off the
 * main thread and pinned by MECHANISM.
 *   (1) the fragment probe (paper_finalize.gatherFragments) stat'd + head-read 2,665 notes on the main
 *       thread on every driver tick of a paper focus (1.5 s block) → the walk runs in lib/fs_worker's
 *       thread; ONE predicate serves the thread, the fallback and this gate.
 *   (2) the console tee's companion write to the launcher's stdout FILE was synchronous (3.8 s block
 *       under the decompose burst's disk load) → lib/console_tee writes both files through async streams.
 * Hermetic: temp dirs and temp files only. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cut22.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cut22-smoke-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  // ── 1. the fragment probe in the worker ────────────────────────────────────────────────────────
  console.log('gatherFragments (worker thread):');
  const pf = require('../lib/paper_finalize');
  const fsw = require('../lib/fs_worker');
  const ndir = path.join(tmp, 'notes'); fs.mkdirSync(ndir);
  const big = '# Acme Widgets overview\n' + 'x'.repeat(9000) + '\nfooter';
  fs.writeFileSync(path.join(ndir, 'acme_widgets_overview.md'), big);
  fs.writeFileSync(path.join(ndir, 'acme_widgets_solutions.md'), '# Acme Widgets Solutions Inc\nthe wrong entity');
  fs.writeFileSync(path.join(ndir, 'late_mention.md'), '# Something else\n' + 'y'.repeat(2000) + '\nacme widgets appear only here, past the 800-char head');
  fs.writeFileSync(path.join(ndir, 'older_acme_widgets.md'), '# older acme widgets note\nshort');
  const early = Date.now() - 3600e3; fs.utimesSync(path.join(ndir, 'older_acme_widgets.md'), early / 1000, early / 1000);
  const sync = pf.gatherFragments({ tokens: ['Acme', 'widgets'], exclude: ['solutions'], dir: ndir });
  const origStat = fs.statSync; let statCalls = 0; fs.statSync = (...a) => { statCalls++; return origStat(...a); };
  let asyncRes; try { asyncRes = await pf.gatherFragmentsAsync({ tokens: ['Acme', 'widgets'], exclude: ['solutions'], dir: ndir }); } finally { fs.statSync = origStat; }
  ok(sync.length === 2 && sync[0].file === 'acme_widgets_overview.md' && sync[1].file === 'older_acme_widgets.md', `the sync probe: head matches only, the exclude veto holds, newest first (${sync.map((x) => x.file).join(', ')})`);
  ok(JSON.stringify(asyncRes.map((x) => [x.file, x.mtime, x.text.length])) === JSON.stringify(sync.map((x) => [x.file, x.mtime, x.text.length])), '⭐ the worker returns the SAME fragments, order and texts as the sync probe (one predicate)');
  ok(statCalls === 0 && fsw._live(), `⭐ the async gather stat'd nothing on the main thread (${statCalls} statSync calls) — the worker did the walk`);
  ok(asyncRes[0].text.length === big.length, 'the matched file comes back in FULL from the worker');
  ok((await pf.gatherFragmentsAsync({ tokens: [], dir: ndir })).length === 0, 'no tokens → no walk (empty)');
  ok((await pf.gatherFragmentsAsync({ tokens: ['acme'], dir: path.join(tmp, 'missing') })).length === 0, 'a missing dir → empty, never a throw');
  // the fallback: a dead worker door falls back to the sync probe and the gather never goes dark
  const origProbe = fsw.probeFragments; fsw.probeFragments = async () => { throw new Error('worker down'); };
  const fb = await pf.gatherFragmentsAsync({ tokens: ['acme', 'widgets'], exclude: ['solutions'], dir: ndir });
  fsw.probeFragments = origProbe;
  ok(fb.length === 2 && fb[0].file === 'acme_widgets_overview.md', 'a worker failure falls back to the sync probe (same answer)');
  ok(/await pfLib\.gatherFragmentsAsync\(\{ tokens: _toks, exclude: _excl \}\)/.test(src('main.js')), 'the driver tick gathers through the worker (main.js runDirectedResearchPass)');
  ok(/const fragments = await gatherFragmentsAsync\(/.test(src('lib/paper_finalize.js')), 'finalize() gathers through the worker');
  ok(!/fs\.statSync\(/.test(src('lib/paper_finalize.js')), 'paper_finalize no longer stats files itself — the walk lives in fs_worker');
  await fsw.close();

  // ── 2. the console tee: both files through async streams ──────────────────────────────────────
  console.log('\nconsole tee (async file streams):');
  const tee = require('../lib/console_tee');
  const outP = path.join(tmp, 'stdout.log'), errP = path.join(tmp, 'stderr.log'), logP = path.join(tmp, 'boot_self.log');
  const outFd = fs.openSync(outP, 'a'), errFd = fs.openSync(errP, 'a');
  const origWriteSync = fs.writeSync; let syncWrites = 0; fs.writeSync = (...a) => { syncWrites++; return origWriteSync(...a); };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const inst = tee.install({ logPath: logP, stdoutFd: outFd, stderrFd: errFd, pid: 4242, now: () => new Date(0) });
  for (let i = 0; i < 3000; i++) console.log(`line ${i} ` + 'z'.repeat(200));
  console.log('object %s and %d', 'fmt', 7, { a: 1 });
  console.warn('a warning');
  console.error('an error', new Error('boom').message);
  await inst.flush();
  fs.writeSync = origWriteSync;
  inst.uninstall();
  Object.assign(console, saved);
  fs.closeSync(outFd); fs.closeSync(errFd);
  const outTxt = fs.readFileSync(outP, 'utf8'), errTxt = fs.readFileSync(errP, 'utf8'), logTxt = fs.readFileSync(logP, 'utf8');
  ok(inst.async === true && inst.tee === true, 'a FILE stdout/stderr installs the async streams (the launcher redirect shape)');
  ok(syncWrites === 0, `⭐ 3,000 lines under the tee issued ${syncWrites} synchronous writes — nothing blocks the loop`);
  ok((outTxt.match(/^line \d+ z+$/gm) || []).length === 3000 && /^object fmt and 7 \{ a: 1 \}$/m.test(outTxt), 'stdout holds every line, formatted like console.log (util.format)');
  ok(/^a warning$/m.test(errTxt) && /^an error boom$/m.test(errTxt) && !/a warning/.test(outTxt), 'warn/error go to stderr, never stdout');
  ok(/══ boot generation pid 4242 @ 1970-01-01T00:00:00.000Z ══/.test(logTxt) && (logTxt.match(/^line \d+ z+$/gm) || []).length === 3000 && /^a warning$/m.test(logTxt) && /^an error boom$/m.test(logTxt), 'boot_self.log carries the header and every line of all three levels');
  ok(console.log === saved.log, 'uninstall restores the console');
  // a non-file fd (a pipe, a TTY) keeps the original console: the gate is fstat().isFile()
  ok(tee._isFileFd(outFd === undefined ? 1 : fs.openSync(outP, 'r')) === true && /_isFileFd\(stdoutFd\)/.test(src('lib/console_tee.js')), 'the async path is taken only for a FILE fd (a terminal or a Windows pipe keeps the original console)');
  ok(/require\('\.\/lib\/console_tee'\)\.install\(\{ logPath: path\.join\(__dirname, 'boot_self\.log'\) \}\)/.test(src('main.js')) && !/stream\.write\(a\.map/.test(src('main.js')), 'main.js installs the tee from the module; the old inline tee is gone');

  // ── 3. the workspace search in the worker (cut 25, boot_p284: a 1.7 s block inside her reply) ─────
  console.log('\nfileSearch (worker thread):');
  const files = require('../lib/files');
  const fsw2 = require('../lib/fs_worker');
  const sroot = path.join(tmp, 'ws'); fs.mkdirSync(path.join(sroot, 'notes'), { recursive: true }); fs.mkdirSync(path.join(sroot, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(sroot, 'notes', 'florida.md'), '# Florida roster\nline two mentions Tallahassee\n');
  fs.writeFileSync(path.join(sroot, 'notes', 'other.md'), 'nothing here\n');
  fs.writeFileSync(path.join(sroot, 'node_modules', 'x', 'skip.md'), 'Tallahassee inside node_modules must be skipped\n');
  fs.writeFileSync(path.join(sroot, 'notes', 'big.md'), 'Tallahassee '.repeat(60000));          // > 512 KB → skipped
  fs.writeFileSync(path.join(sroot, 'notes', 'bin.dat'), Buffer.from('Tallahassee\0binary'));    // NUL → skipped
  const sSync = files.fileSearch(sroot, 'tallahassee');
  const origRead = fs.readFileSync; let reads = 0; fs.readFileSync = (...a) => { reads++; return origRead(...a); };
  let sAsync; try { sAsync = await files.fileSearchAsync(sroot, 'tallahassee'); } finally { fs.readFileSync = origRead; }
  ok(sSync.ok && sSync.matches.length === 1 && /florida\.md$/.test(sSync.matches[0].path) && sSync.matches[0].line === 2, `the sync search: one match, at its line; node_modules, the >512 KB file and the binary file are skipped (${sSync.matches.length} match, ${sSync.scanned} scanned)`);
  ok(sAsync.ok && JSON.stringify(sAsync.matches) === JSON.stringify(sSync.matches) && sAsync.scanned === sSync.scanned, '⭐ the worker returns the SAME matches and scan count (one function, both doors)');
  ok(reads === 0, `⭐ the async search read nothing on the main thread (${reads} readFileSync calls)`);
  ok((await files.fileSearchAsync(sroot, '')).ok === false && (await files.fileSearchAsync(path.join(tmp, 'nowhere'), 'x')).ok === false, 'an empty query and a missing dir are honest refusals, never a throw');
  const origProbeS = fsw2.probeSearch; fsw2.probeSearch = async () => { throw new Error('worker down'); };
  const sFb = await files.fileSearchAsync(sroot, 'tallahassee');
  fsw2.probeSearch = origProbeS;
  ok(sFb.ok && sFb.matches.length === 1, 'a worker failure falls back to the sync search (same answer)');
  ok(/case 'file-search': return fileSearchAsync\(/.test(src('lib/files.js')) && /async function dispatch\(/.test(src('lib/files.js')), 'the chat tag <file-search> dispatches through the worker door (every caller already awaits dispatch)');
  await fsw2.close();

  console.log(`\nsmoke_cut22: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke_cut22 crashed:', e && e.stack || e); process.exit(1); });
