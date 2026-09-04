/* smoke_trajectory_mine.js — LEG B (2026-09-04): THE TRAJECTORY-MINING ORGAN.
 *
 * RHO's recipe over the run ledger (lib/db.js `runs`, stage 4.5 C): mine terminal FAILURES into classes
 * keyed on a normalized error signature, rank by recurrence x spread x recency, emit a brief, and — in
 * the organ — surface a recurring class as a capability_need (self_watch's proven pipeline, its own
 * born_from + cap). Pure over a temp db built from the app's own DDL; the wiring pins read main.js /
 * test_port.js so the door, the organ, and the needs seam can never silently drift.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const L = require('../lib/run_ledger');
const TM = require('../lib/trajectory_mine');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── a temp db with the app's own `runs` DDL (read out of lib/db.js so the two can never drift) ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_trajmine_'));
const db = new Database(path.join(dir, 'sq.db'));
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
const ddl = dbSrc.match(/`CREATE TABLE IF NOT EXISTS runs \([\s\S]*?\)`/);
ok(!!ddl, 'lib/db.js declares the runs table (shared DDL)');
db.exec(ddl[0].slice(1, -1));
for (const m of dbSrc.matchAll(/`(CREATE INDEX IF NOT EXISTS idx_runs_[\s\S]*?)`/g)) db.exec(m[1]);
const o = { db };

// ── the signature (pure) ────────────────────────────────────────────────────────────────────────
ok(TM.signatureOf('Timeout after 20000ms') === TM.signatureOf('Timeout after 45000ms'), 'signatureOf folds numbers: two timeouts differing only by ms are ONE class');
ok(TM.signatureOf('engine run 0123456789abcdef reported failed').includes('<id>'), 'signatureOf blanks a long hex run id');
ok(TM.signatureOf('cannot read C\\:\\Users\\x\\a.xlsx').includes('<path>') || TM.signatureOf('open /var/data/foo/bar failed').includes('<path>'), 'signatureOf blanks a path');
ok(TM.signatureOf('') === '<no message> (failed)' && TM.signatureOf(null, 'cancelled') === '<no message> (cancelled)', 'an empty error signs by the state alone');
const longSig = TM.signatureOf('x'.repeat(170) + ' the real error kind at the end here');
ok(longSig.includes(' … ') && longSig.length <= 170, 'a long message keeps head AND tail (the kind lives at the tail)');

// ── a window of runs through the real ledger ──────────────────────────────────────────────────────
const NOW = 1_800_000_000_000, DAY = 86400e3;
const fin = (role, executor, lane, state, error, endedAt) => {
  const id = L.start({ role, executor, lane, trigger_kind: 'scheduled', state: 'running', now: endedAt - 1000 }, o);
  L.finish(id, { state, error, now: endedAt }, o);
  return id;
};
// class "database is locked": 4 failed across 3 distinct days, roles writer+collector, executors sq+echo
fin('writer', 'sq', 'research', 'failed', 'database is locked', NOW - 0.2 * DAY);
fin('writer', 'sq', 'research', 'failed', 'database is locked', NOW - 1.2 * DAY);
fin('writer', 'sq', 'research', 'failed', 'database is locked', NOW - 2.2 * DAY);
fin('collector', 'echo', 'research', 'failed', 'database is locked', NOW - 0.3 * DAY);
// class "timeout after Nms": 3 failed over 2 days, role fetcher (numbers fold to one class)
fin('fetcher', 'sq', 'research', 'failed', 'timeout after 20000ms', NOW - 0.1 * DAY);
fin('fetcher', 'sq', 'research', 'failed', 'timeout after 45000ms', NOW - 1.1 * DAY);
fin('fetcher', 'sq', 'research', 'failed', 'timeout after 60000ms', NOW - 1.3 * DAY);
// class "engine reported failed": 1 failed — NOT recurring
fin('closer', 'echo', 'directed', 'failed', 'engine reported failed', NOW - 0.4 * DAY);
// cancelled: releases/give-ups — counted, but NEVER a failure class
fin('swarm-worker', 'sq', 'directed', 'cancelled', 'stalled 6h — released', NOW - 0.5 * DAY);
fin('swarm-worker', 'sq', 'directed', 'cancelled', 'stalled 6h — released', NOW - 1.5 * DAY);
// succeeded runs (writer, for its fail-rate)
for (let i = 0; i < 4; i++) fin('writer', 'sq', 'research', 'succeeded', null, NOW - (0.1 + i * 0.1) * DAY);
// out of the 7-day window: excluded entirely
fin('writer', 'sq', 'research', 'failed', 'database is locked', NOW - 30 * DAY);
// non-terminal (no ended_at): excluded
L.start({ role: 'writer', executor: 'sq', lane: 'research', trigger_kind: 'scheduled', state: 'running', now: NOW - 0.05 * DAY }, o);

const m = TM.mine({ db, now: NOW, windowDays: 7 });
ok(m.totals.runs === 14 && m.totals.failed === 8 && m.totals.succeeded === 4 && m.totals.cancelled === 2, `totals count only terminal, in-window runs (${JSON.stringify(m.totals)})`);
ok(m.classes.length === 3, 'three failure classes (cancelled + succeeded + out-of-window + non-terminal never form a class)');

const locked = m.classes.find((c) => c.sig === 'database is locked');
ok(locked && locked.count === 4 && locked.distinctDays === 3, 'the db-locked class counts 4 failures over 3 distinct days (out-of-window one excluded)');
ok(locked && locked.roles.join(',') === 'collector,writer' && locked.executors.join(',') === 'echo,sq' && locked.lanes.join(',') === 'research', 'the class carries its roles, executors and lanes as sorted sets');
ok(locked && locked.recurring === true && locked.sampleRunIds.length >= 3, 'a class at or above the mint threshold is flagged recurring and keeps exemplar run ids');

const to = m.classes.find((c) => c.sig === 'timeout after Nms');
ok(to && to.count === 3 && to.distinctDays === 2 && to.recurring === true, 'the timeout class folds the three ms-varied failures into one recurring class');

const eng = m.classes.find((c) => c.sig === 'engine reported failed');
ok(eng && eng.count === 1 && eng.recurring === false, 'a once-only failure is a class but NOT recurring');
ok(!m.classes.some((c) => /stalled/.test(c.sig)), 'a cancelled run (a release) is never mined as a failure class');

ok(m.classes[0].sig === 'database is locked' && m.classes.every((c, i, a) => i === 0 || a[i - 1].score >= c.score), 'classes rank by score, recent+frequent first');

ok(m.roles.length === 1 && m.roles[0].role === 'writer' && m.roles[0].runs === 7 && m.roles[0].failed === 3 && m.roles[0].failRate === 0.429, `only a role with >= ${TM.ROLE_MIN_RUNS} runs and a failure appears in roles (${JSON.stringify(m.roles)})`);

// ── the brief (the compact carry) ───────────────────────────────────────────────────────────────
const b = TM.brief({ db, now: NOW, windowDays: 7, limit: 2 });
ok(b.recurring === 2 && b.classes.length === 2, 'the brief counts recurring classes and honors its limit');
ok(typeof b.classes[0].hint === 'string' && /\dx over \dd/.test(b.classes[0].hint), 'each brief class carries a retest hint (Nx over Dd in <roles>)');
const b2 = TM.brief({ now: NOW, windowDays: 7, mined: m });
ok(b2.recurring === 2 && b2.totals.runs === 14, 'brief(mined) reuses an already-computed mine (the organ mines once)');

// ── the need shape (what a recurring class becomes) ─────────────────────────────────────────────
ok(TM.needBornFrom(locked) === 'trajectory:database is locked', 'needBornFrom carries the signature under the trajectory prefix (the stable dedup key)');
ok(TM.needText(locked).includes('database is locked') && TM.needText(locked).startsWith('a recurring run failure in'), 'needText names the recurring failure and its role, stably (no count/days to defeat dedup)');
ok(/4x over 3d/.test(TM.retestHint(locked)), 'retestHint names the count and spread');

// ── the wiring: the read door, the organ, the needs seam ────────────────────────────────────────
const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
ok(/req\.url\.startsWith\('\/trajectory'\)/.test(tp) && /require\('\.\/trajectory_mine'\)[\s\S]*?\.brief\(/.test(tp), 'GET /trajectory serves the brief on the control port');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/maybeMineTrajectory = async/.test(main) && /ZOE_TRAJECTORY_MINE\b/.test(main), 'main.js runs the nightly organ behind the ZOE_TRAJECTORY_MINE kill switch');
ok(/last_trajectory_mine_at/.test(main) && /trajectory\.last_brief/.test(main), 'the organ is cooldown-gated and records its brief to meta');
ok(/require\('\.\/lib\/capability_need'\)[\s\S]*?startsWith\('trajectory'\)/.test(main) && /bornFrom: tm\.needBornFrom\(c\), similarFloor: 0\.8/.test(main), 'a recurring class mints a trajectory-born need, capped and deduped, on the existing needs pipeline');
ok(/setTimeout\(\(\) => \{ maybeMineTrajectory\(\)\.catch\(\(\) => \{\}\); \}, 180000\)/.test(main), 'a catch-up kick runs the first pass ~3min after boot');

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_trajectory_mine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
