'use strict';
/*
 * lib/slow_sync_probe.js — the main-thread blocker names ITSELF, by its own SQL.
 *
 * THE BLIND SPOT (stall disease, 2026-08-20): the stall attributor (main.js markActivity + the 1s
 * probe) can only name lanes that MARK themselves — the day's giants logged `active="idle"
 * ran=57534ms`: 20-54s synchronous blocks from work that never called markActivity, so every
 * hypothesis had to be hunted by hand (the bridge-crawl storm took three measurement passes to
 * pin, and the pre-existing ≥10s stratum — 22 hits in 6h — is still anonymous).
 *
 * THE INSTRUMENT: patch the synchronous DB layer itself. Every better-sqlite3 Statement.all/get/run
 * and Database.exec self-times; any call over thresholdMs logs its duration, its SQL (the culprit's
 * own name), and the caller stack — to the console AND to data/stall_attrib.log, so the slow-call
 * lines interleave with the block timeline they explain. Overhead: one Date.now() pair per DB call
 * (~ns against calls that touch a 3.5GB file); the stack is only captured in the slow branch.
 *
 * Scope note: sqlite through better-sqlite3 is this process's dominant synchronous-work class
 * (measured: the cured bridge storm, the docfts LIKE stall, the liveDigest scan were ALL statements).
 * fs-level sync giants (huge copies) were already made async (M1.3); if a future giant logs NOTHING
 * here, that absence itself narrows the hunt to non-DB work — the probe is informative either way.
 *
 * arm() is idempotent, fail-soft, and kill-switched (ZOE_SLOW_SYNC_PROBE=0). Pure-injectable for
 * the smoke: arm({ thresholdMs, log }) — the smoke passes a collector and a tiny threshold.
 */

const path = require('path');

let _armed = false;

function arm({ thresholdMs = 1000, log = null } = {}) {
  if (_armed) return { armed: true, already: true };
  try {
    const Database = require('better-sqlite3');
    const mem = new Database(':memory:');
    const stmtProto = Object.getPrototypeOf(mem.prepare('SELECT 1'));
    const dbProto = Object.getPrototypeOf(mem);
    mem.close();
    const emit = log || ((line) => {
      try { console.warn(`[slow-sync] ${line}`); } catch {}
      try {
        require('fs').appendFile(path.join(__dirname, '..', 'data', 'stall_attrib.log'),
          `${new Date().toISOString()}\tSLOW-SYNC\t${line}\n`, () => {});
      } catch {}
    });
    const wrap = (proto, name, kind) => {
      const orig = proto[name];
      if (typeof orig !== 'function' || orig.__slowSyncWrapped) return;
      const wrapped = function (...args) {
        const t0 = Date.now();
        try { return orig.apply(this, args); }
        finally {
          const ms = Date.now() - t0;
          if (ms >= thresholdMs) {
            let src = ''; try { src = String(this.source || (kind === 'exec' ? args[0] : '') || '').replace(/\s+/g, ' ').slice(0, 180); } catch {}
            let at = ''; try { at = (new Error().stack || '').split('\n').slice(2, 5).map((l) => l.trim()).join(' | '); } catch {}
            emit(`${ms}ms ${kind}:${name} — ${src}${at ? `  [${at}]` : ''}`);
          }
        }
      };
      wrapped.__slowSyncWrapped = true;
      proto[name] = wrapped;
    };
    for (const m of ['all', 'get', 'run']) wrap(stmtProto, m, 'stmt');
    wrap(dbProto, 'exec', 'exec');
    _armed = true;
    return { armed: true };
  } catch (e) { return { armed: false, why: String((e && e.message) || e) }; }
}

module.exports = { arm };
