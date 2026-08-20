/* smoke_slow_sync_probe.js — the stall disease's naming instrument (built 2026-08-20).
 *
 * The proven gap: the day's ≥10s main-thread giants all logged active="idle" — unmarked sync work
 * the attributor could not name, so each hunt was manual (three measurement passes to pin the
 * bridge-crawl storm). The probe patches better-sqlite3's Statement/exec so a slow call logs its
 * OWN SQL + caller stack. Injected collector + tiny threshold — no live DB, no console noise.
 */
'use strict';
const bridgeProbe = require('../lib/slow_sync_probe');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const lines = [];
const r1 = bridgeProbe.arm({ thresholdMs: 25, log: (l) => lines.push(l) });
ok(r1.armed === true, 'probe arms');
const r2 = bridgeProbe.arm({ thresholdMs: 25, log: (l) => lines.push(l) });
ok(r2.armed === true && r2.already === true, 'second arm is a no-op (idempotent — no double-wrap)');

const db = new Database(':memory:');
// A deliberately slow statement: a recursive CTE big enough to clear the 25ms bar on any machine.
const t0 = Date.now();
db.prepare('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 400000) SELECT COUNT(*) n FROM c').get();
const slowMs = Date.now() - t0;
ok(slowMs >= 25, `fixture sanity: the slow query really is slow (${slowMs}ms)`);
ok(lines.length === 1, `the slow call logged exactly once (got ${lines.length})`);
ok(/^\d+ms stmt:get — WITH RECURSIVE/.test(lines[0] || ''), 'the log names duration, method, and the SQL itself');
ok(/\[at /.test(lines[0] || '') || /\[.*smoke_slow_sync_probe/.test(lines[0] || ''), 'the log carries the caller stack');

// Fast calls stay silent.
const before = lines.length;
db.prepare('SELECT 1 one').get();
db.prepare('CREATE TABLE t (x)').run();
db.exec('INSERT INTO t VALUES (1)');
ok(lines.length === before, 'fast statements log nothing (zero noise)');

// Results are untouched by the wrap.
ok(db.prepare('SELECT COUNT(*) n FROM t').get().n === 1, 'wrapped statements still return real results');

// A slow exec names the script text (exec has no this.source).
const t1 = Date.now();
db.exec('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 400000) SELECT COUNT(*) FROM c');
ok(Date.now() - t1 >= 25 && /exec:exec — WITH RECURSIVE/.test(lines[lines.length - 1] || ''), 'a slow exec logs with its script text');

db.close();

// Wiring: main.js arms the probe at boot behind the kill switch.
const fs = require('fs'), path = require('path');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/ZOE_SLOW_SYNC_PROBE/.test(mainSrc) && /slow_sync_probe'\)\.arm\(\)/.test(mainSrc), 'wiring: main.js arms the probe at boot (kill-switched)');

console.log(`\nsmoke_slow_sync_probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
