'use strict';
/**
 * lib/console_tee.js — THE CONSOLE TEE (09-01, rides the self-reboot organ; extracted + made
 * non-blocking as cut 22, 2026-09-04).
 *
 * A self-relaunched generation loses the launcher's stdout redirect, so every console line ALSO
 * lands in boot_self.log — evidence survives whoever started the process. Rotates at 20MB. A
 * generation header marks each boot.
 *
 * THE BLOCK (boot_p279, 00:41:37, a 3.8 s profiled block, 99% writeBuffer via console.log): when
 * stdout is a FILE (the launcher's redirect), Node writes it SYNCHRONOUSLY on the main thread —
 * and under the decompose worker's 25-job burst the disk was saturated, so a burst of console
 * lines stalled the event loop behind the WAL. The tee already wrote its own copy through an
 * async stream; now the launcher's file gets the same: an fs.WriteStream on the original fd,
 * threadpool writes, never a sync write from the loop. A TTY or a pipe keeps the original
 * console (a terminal expects synchronous, ordered output; Windows pipes are not fs-writable).
 */
const fs = require('fs');
const util = require('util');

function _isFileFd(fd) { try { return fs.fstatSync(fd).isFile(); } catch { return false; } }

/**
 * install({ logPath, rotateBytes, stdoutFd, stderrFd, pid, now }) → { flush, uninstall, async }
 * `async` says whether stdout/stderr went through async streams (a file) or stayed on the console.
 */
function install({ logPath, rotateBytes = 20 * 1024 * 1024, stdoutFd = 1, stderrFd = 2, pid = process.pid, now = () => new Date() } = {}) {
  try { if (logPath && fs.existsSync(logPath) && fs.statSync(logPath).size > rotateBytes) fs.renameSync(logPath, logPath + '.1'); } catch {}
  let tee = null;
  try { if (logPath) { tee = fs.createWriteStream(logPath, { flags: 'a' }); tee.write(`\n══ boot generation pid ${pid} @ ${now().toISOString()} ══\n`); } } catch { tee = null; }
  const outFile = _isFileFd(stdoutFd), errFile = _isFileFd(stderrFd);
  let out = null, err = null;
  try { if (outFile) out = fs.createWriteStream(null, { fd: stdoutFd, autoClose: false }); } catch { out = null; }
  try { if (errFile) err = fs.createWriteStream(null, { fd: stderrFd, autoClose: false }); } catch { err = null; }
  for (const s of [tee, out, err]) { if (s) s.on('error', () => {}); }
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const bound = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const target = { log: out, warn: err, error: err };
  for (const k of ['log', 'warn', 'error']) {
    console[k] = (...a) => {
      let line; try { line = util.format(...a); } catch { line = a.map(String).join(' '); }
      const s = target[k];
      if (s) { try { s.write(line + '\n'); } catch {} } else { try { bound[k](...a); } catch {} }
      if (tee) { try { tee.write(line + '\n'); } catch {} }
    };
  }
  const streams = [tee, out, err].filter(Boolean);
  // flush(): resolves once every stream has drained what was written so far (for a gate; production never waits)
  const flush = () => Promise.all(streams.map((s) => new Promise((res) => { try { s.write('', res); } catch { res(); } })));
  const uninstall = () => { for (const k of ['log', 'warn', 'error']) console[k] = originals[k]; };
  return { flush, uninstall, async: !!(out || err), tee: !!tee };
}

module.exports = { install, _isFileFd };
