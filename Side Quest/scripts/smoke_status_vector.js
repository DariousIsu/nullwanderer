/* Smoke: the interoception loops (2026-08-15) — lib/machine_vitals (Loop C), lib/db_health (Loop D),
 * lib/status_vector (Loop A). Proves: pure CPU math, injected sampling → meta, threshold anomalies →
 * obs_bus (with cooldown), backup census + WAL watch + growth ring, quick_check child script on a
 * real store, vector assembly from deps, delta detection, line/block rendering from the SAME stored
 * object, staleness annotation, and the fail-absent contract (missing organs are absent, not guessed).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_status_vector.js
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync } = require('child_process');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_smoke_sv_'));
const tmp = path.join(tmpDir, 'sq.db');
process.env.SQ_DB_PATH = tmp;
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';
const db = require(ROOT + '/lib/db');
const bus = require(ROOT + '/lib/obs_bus');
const mv = require(ROOT + '/lib/machine_vitals');
const dh = require(ROOT + '/lib/db_health');
const sv = require(ROOT + '/lib/status_vector');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const GB = 1073741824;

(async () => {
  try {
    db.init();
    const now = Date.now();

    console.log('A) machine_vitals (Loop C)');
    ok(mv.cpuPctBetween(null, { busy: 1, total: 2 }) === null, 'cpu: first sample → null (no delta yet)');
    ok(mv.cpuPctBetween({ busy: 100, total: 1000 }, { busy: 600, total: 2000 }) === 50, 'cpu: 500 busy of 1000 total delta → 50%');
    ok(mv.cpuPctBetween({ busy: 0, total: 1000 }, { busy: 0, total: 1000 }) === null, 'cpu: zero delta → null (never divide)');

    // healthy sample — everything injected, lands in meta
    const cpusA = [{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }];
    const cpusB = [{ times: { user: 200, nice: 0, sys: 0, idle: 1800, irq: 0 } }];
    const statfsOk = async () => ({ bavail: 200 * 1024, bsize: 1048576, blocks: 1000 * 1024 });   // 200GB free of 1TB
    let s1 = await mv.sample({ deps: { cpus: () => cpusA, freemem: () => 16 * GB, totalmem: () => 64 * GB, statfs: statfsOk, gpuBytes: 8 * GB, uptime: () => 7200 } });
    let s2 = await mv.sample({ deps: { cpus: () => cpusB, freemem: () => 16 * GB, totalmem: () => 64 * GB, statfs: statfsOk, gpuBytes: 8 * GB, uptime: () => 7260 } });
    ok(s2.cpuPct === 10, `healthy sample: cpu delta 10% (${s2.cpuPct})`);
    ok(s2.ramFreeGB === 16 && s2.ramFreePct === 25, 'healthy sample: RAM free 16GB / 25%');
    ok(s2.diskFreeGB === 200 && s2.diskFreePct === 20, 'healthy sample: disk 200GB / 20% free');
    ok(s2.gpu && s2.gpu.usedGB === 8, 'healthy sample: injected GPU bytes → 8GB used');
    const stored = JSON.parse(db.getMeta('machine_vitals') || 'null');
    ok(stored && stored.cpuPct === 10, 'sample persisted to meta machine_vitals');
    ok(/CPU 10%/.test(mv.describe(stored)) && /disk 200GB/.test(mv.describe(stored)), `describe renders (${mv.describe(stored)})`);
    ok(mv.describe(null) === null, 'describe(null) → null (fail-absent)');

    // anomalies: low RAM + low disk → obs_bus events; cooldown suppresses a repeat
    const statfsLow = async () => ({ bavail: 30 * 1024, bsize: 1048576, blocks: 1000 * 1024 });   // 3% free
    await mv.sample({ deps: { cpus: () => cpusB, freemem: () => 1 * GB, totalmem: () => 64 * GB, statfs: statfsLow, gpuBytes: null, uptime: () => 1 } });
    bus.flush();
    let evs = bus.latest({ lanes: ['machine'], limit: 10 });
    ok(evs.some((e) => e.ref === 'ram_low'), 'low RAM → obs_bus machine/anomaly (ram_low)');
    ok(evs.some((e) => e.ref === 'disk_low'), 'low disk → obs_bus machine/anomaly (disk_low)');
    const evCount = evs.length;
    await mv.sample({ deps: { cpus: () => cpusB, freemem: () => 1 * GB, totalmem: () => 64 * GB, statfs: statfsLow, gpuBytes: null, uptime: () => 1 } });
    bus.flush();
    ok(bus.latest({ lanes: ['machine'], limit: 10 }).length === evCount, 'anomaly cooldown: immediate repeat emits nothing new');

    console.log('B) db_health (Loop D)');
    // a backup pile in the data dir
    fs.writeFileSync(path.join(tmpDir, 'sq.db.precuration_20990101_000000'), '');
    fs.truncateSync(path.join(tmpDir, 'sq.db.precuration_20990101_000000'), 60 * 1048576);
    fs.writeFileSync(path.join(tmpDir, 'sq.db.backup_tiny'), 'x');                      // <50MB → excluded
    fs.writeFileSync(path.join(tmpDir, 'unrelated.db'), '');
    fs.truncateSync(path.join(tmpDir, 'unrelated.db'), 60 * 1048576);                    // no backup name → excluded
    const census = dh.backupCensus(tmpDir);
    ok(census && census.count === 1 && census.totalGB === 0.1, `census: 1 backup ≥50MB counted, small + unrelated excluded (${JSON.stringify(census)})`);

    // tick: WAL over threshold → anomaly; snapshot persisted; growth ring across two days.
    // A DEDICATED fake store (never the live meta db — truncating a live store's WAL under an open
    // connection is exactly the corruption class Loop D exists to catch).
    const fakeDb = path.join(tmpDir, 'fake.db');
    fs.writeFileSync(fakeDb, ''); fs.truncateSync(fakeDb, 10 * 1048576);
    fs.writeFileSync(fakeDb + '-wal', ''); fs.truncateSync(fakeDb + '-wal', (dh.WAL_WARN_MB + 44) * 1048576);
    const paths = { sqDb: fakeDb, dataDir: tmpDir, echo: [] };
    const t1 = dh.tick({ nowMs: now, paths });
    ok(t1.sq && t1.sq.walMB === dh.WAL_WARN_MB + 44, `tick reads WAL size (${t1.sq.walMB}MB)`);
    bus.flush();
    ok(bus.latest({ lanes: ['db'], limit: 10 }).some((e) => e.ref === 'wal_growth'), 'oversized WAL → obs_bus db/anomaly (the p39 lock class)');
    const t2 = dh.tick({ nowMs: now + 21 * 3600e3, paths });
    const ring = JSON.parse(db.getMeta(dh.RING_KEY) || '[]');
    ok(ring.length === 2, `growth ring: one sample per ~day (${ring.length} entries after 2 ticks 21h apart)`);
    ok(typeof t2.growthMBperDay === 'number', `growth computed (${t2.growthMBperDay}MB/day)`);
    ok(JSON.parse(db.getMeta(dh.SNAP_KEY) || 'null').at === now + 21 * 3600e3, 'snapshot persisted to meta db_health');

    // PRECURATION ROTATION (Lucas's 08-15 reclaim ruling): newest N kept, strictly-matched only.
    // Drop the census fixture first (it matches the strict pattern and would skew the sort).
    try { fs.unlinkSync(path.join(tmpDir, 'sq.db.precuration_20990101_000000')); } catch {}
    for (const n of ['sq.db.precuration_20260810_010101', 'sq.db.precuration_20260812_010101', 'sq.db.precuration_20260814_010101']) fs.writeFileSync(path.join(tmpDir, n), 'x');
    fs.writeFileSync(path.join(tmpDir, 'sq.db.precuration_NOTASTAMP'), 'x');   // pattern miss → untouched
    const rot = dh.rotateBackups({ dataDir: tmpDir });
    ok(rot.pruned.length === 1 && rot.pruned[0] === 'sq.db.precuration_20260810_010101', `rotation prunes exactly beyond newest ${dh.PRECURATION_KEEP} (${JSON.stringify(rot.pruned)})`);
    ok(fs.existsSync(path.join(tmpDir, 'sq.db.precuration_20260814_010101')) && fs.existsSync(path.join(tmpDir, 'sq.db.precuration_20260812_010101')), 'the 2 newest copies survive');
    ok(!fs.existsSync(path.join(tmpDir, 'sq.db.precuration_20260810_010101')), 'the oldest copy is gone');
    ok(fs.existsSync(path.join(tmpDir, 'sq.db.precuration_NOTASTAMP')), 'a non-matching name is NEVER touched (strict pattern)');
    ok(dh.rotateBackups({ dataDir: tmpDir }).pruned.length === 0, 'steady state: nothing further to prune');

    // quick_check child script on a PRISTINE real store → ok:true
    const cleanDb = path.join(tmpDir, 'clean.db');
    { const D = require(ROOT + '/node_modules/better-sqlite3'); const d2 = new D(cleanDb); d2.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)'); d2.close(); }
    const qcOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'db_quick_check.js'), cleanDb],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
    const qc = JSON.parse(qcOut.trim().split('\n').pop());
    ok(qc && qc.ok === true, `db_quick_check child: healthy store → ok (${qc.ok ? qc.ms + 'ms' : qc.msg})`);
    const qcBad = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'db_quick_check.js'), path.join(tmpDir, 'nope.db')],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
    ok(qcBad && qcBad.ok === false, 'db_quick_check child: missing file → ok:false, exit clean');
    db.setMeta(dh.QC_KEY, JSON.stringify({ at: Date.now(), ok: true, msg: 'ok' }));
    ok(dh.maybeQuickCheck({ paths }) === false, 'maybeQuickCheck: fresh verdict → due-gated, no spawn');

    console.log('C) status_vector (Loop A)');
    const qgFix = {
      state: () => ({ known: true, usedPct: 0.56, remaining: 44000, hoursLeft: 22.5, pacePerHour: 1955, msLeft: 1, limit: 100000, markAt: 1, resetPassed: false }),
      allow: (lane) => ({ allow: lane !== 'idle' ? true : true }),
    };
    const deps1 = {
      echoConnected: true, ownBrowser: true, sharedBrowser: false,
      guard: { paused: false, reason: null, mode: 'auto' },
      working: { goal: 'Louisiana parish leadership', done: 12, universe: 64, workers: 2 },
      speakerStatus: { gate: true, enrolled: true, count: 5 },
      quotaGate: qgFix,
    };
    const v1 = sv.assemble({ deps: deps1, nowMs: now });
    ok(v1.organs.echo === true && v1.organs.sharedBrowser === false, 'assemble: organ truths from deps');
    ok(v1.voice.gate === true && v1.voice.samples === 5, 'assemble: speaker gate state');
    ok(v1.quota.usedPct === 56 && v1.quota.idleOpen === true, 'assemble: quota pool + lane allowances');
    ok(v1.machine && v1.machine.at, 'assemble: machine section reads Loop C meta');
    ok(v1.memory && v1.memory.at, 'assemble: memory section reads Loop D meta');
    ok(v1.drives === undefined, 'assemble: drives ABSENT until C1 exists (measured-never-asserted)');
    ok(v1.focus.goal === 'Louisiana parish leadership', 'assemble: working focus');

    const r1 = sv.refresh({ deps: deps1, nowMs: now });
    ok(r1.vector.at === now && JSON.parse(db.getMeta(sv.META_KEY)).at === now, 'refresh persists the vector');
    const line1 = sv.line({ nowMs: now + 1000 });
    ok(!!line1 && /Echo ✓/.test(line1) && /quota 56% used/.test(line1) && /gate (enforce|shadow)/.test(line1), `line renders from stored (${line1.slice(0, 110)}…)`);
    ok(!/may be stale/.test(line1), 'fresh line carries no stale flag');
    ok(/may be stale/.test(sv.line({ nowMs: now + 20 * 60e3 }) || ''), 'old vector → stale annotation');

    // delta: echo drops + quota decile crossing + guard pause
    const deps2 = { ...deps1, echoConnected: false, guard: { paused: true, reason: 'meeting', mode: 'auto' }, quotaGate: { ...qgFix, state: () => ({ ...qgFix.state(), usedPct: 0.63 }) } };
    const r2 = sv.refresh({ deps: deps2, nowMs: now + 60e3 });
    ok(r2.delta.includes('Echo DROPPED'), `delta: echo drop detected (${JSON.stringify(r2.delta)})`);
    ok(r2.delta.some((d) => /quota crossed 60%/.test(d)), 'delta: quota decile crossing');
    ok(r2.delta.some((d) => /voice paused \(meeting\)/.test(d)), 'delta: guard pause with reason');
    ok(/Changed just now:.*Echo DROPPED/.test(sv.line({ nowMs: now + 61e3 })), 'delta rides the line (the beat feels the change)');

    const blk = sv.block({ nowMs: now + 61e3 });
    ok(!!blk && /YOUR SYSTEMS — a measured self-read/.test(blk), 'block: full render header');
    ok(/speaker gate ON \(5 enrollment samples/.test(blk), 'block: voice section');
    ok(/12 of 64 done/.test(blk), 'block: focus progress');
    ok(/Machine \(your body\)/.test(blk) && /Memory substrate/.test(blk), 'block: interoception sections present');
    ok(/tier gate/i.test(blk), 'block: gate mode named');

    // fail-absent: empty store → null line/block, no throw
    db.setMeta(sv.META_KEY, '');
    ok(sv.line() === null && sv.block() === null, 'never-refreshed → null line/block (fail-absent, no guess)');

    console.log('D) widened STATE_RE (the door the block sits behind)');
    const ss = require(ROOT + '/lib/self_state');
    for (const q of ['how are your systems?', "how's the machine holding up", 'how is your memory doing', 'system status', 'systems check', 'how are you running', 'everything okay on your end']) {
      ok(ss.detectStateQuestion(q), `opens: "${q}"`);
    }
    for (const q of ['how are you feeling today', 'tell me about the database design', 'what body of water is that']) {
      ok(!ss.detectStateQuestion(q), `stays shut: "${q}"`);
    }
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { bus._stop(); } catch {}
    try { db.getDb().close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
