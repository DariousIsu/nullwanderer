/**
 * Backtest — downtime marker. formatGap is pure; recordBoot/awarenessLine run against
 * a TEMP db (SQ_DB_PATH) so we can seed last_alive_at and assert the computed gap,
 * the stored awareness line, the recency gating, and graceful-vs-hard-stop wording.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_downtime_${Date.now()}`, 'sq.db');  // unique dir isolates capability_log.json

const db = require('../lib/db');
db.init();
const dt = require('../lib/downtime');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — downtime marker\n');

console.log('formatGap (pure):');
ok('45s → seconds', dt.formatGap(45 * 1000) === '45 seconds');
ok('5m → minutes', dt.formatGap(5 * 60 * 1000) === '5 minutes');
ok('1h → "1 hour"', dt.formatGap(60 * 60 * 1000) === '1 hour');
ok('2h14m → "2h 14m"', dt.formatGap((2 * 60 + 14) * 60 * 1000) === '2h 14m');
ok('1 day → "1 day"', dt.formatGap(24 * 60 * 60 * 1000) === '1 day');
ok('negative/null → unknown', dt.formatGap(-5).includes('unknown'));

console.log('\nrecordBoot:');
// First-ever boot (no prior markers) → null
ok('first boot (no markers) → null', dt.recordBoot(1000) === null);

// Seed a heartbeat 3h ago, boot now → ~3h gap, hard stop (no shutdown marker)
const now = 2_000_000_000_000;   // a large epoch-ms so now − gap stays positive
db.setMeta(dt.ALIVE_KEY, String(now - 3 * 60 * 60 * 1000));
let r = dt.recordBoot(now);
ok('returns a gap', r && r.ms === 3 * 60 * 60 * 1000);
ok('summary mentions ~3h', /3 hours|3h/.test(r.summary));
ok('hard stop flagged not-clean', r.graceful === false && /not a clean shutdown/.test(r.summary));
ok('awareness line set + recent → surfaces', dt.awarenessLine(now) === r.summary);
ok('back-online reading inserted', db.getRecentMonologue(5).some(m => m.model === 'downtime' && /Back online/.test(m.content)));

// Graceful shutdown: shutdown marker >= alive → no "not clean" wording
db.setMeta(dt.ALIVE_KEY, String(now - 90 * 60 * 1000));
db.setMeta(dt.SHUTDOWN_KEY, String(now - 90 * 60 * 1000));
r = dt.recordBoot(now);
ok('graceful stop → clean wording', r.graceful === true && !/not a clean shutdown/.test(r.summary));

// Sub-minute reload → ignored as noise
db.setMeta(dt.ALIVE_KEY, String(now - 5000));
db.setMeta(dt.SHUTDOWN_KEY, '0');
ok('sub-minute reload → null', dt.recordBoot(now) === null);

console.log('\nawarenessLine recency gating:');
db.setMeta(dt.ALIVE_KEY, String(now - 2 * 60 * 60 * 1000));
db.setMeta(dt.SHUTDOWN_KEY, '0');
dt.recordBoot(now);
ok('surfaces right after boot', !!dt.awarenessLine(now));
ok('gone after the 30m window', dt.awarenessLine(now + 31 * 60 * 1000) === null);

console.log('\ncapability changelog in the reboot log (Lucas: tell her what changed):');
const changelog = require('../lib/changelog');
// quick reload (sub-minute) but a capability shipped → still surfaces the change
db.setMeta(dt.ALIVE_KEY, String(now - 5000));
db.setMeta(dt.SHUTDOWN_KEY, '0');
changelog.add('Added the byline pipeline', now - 1000);
let cr = dt.recordBoot(now);
ok('quick reload + change → surfaces the change', cr && cr.changes === 1 && /byline pipeline/.test(cr.summary));
ok('no offline-duration part on a quick reload', !/offline for about/.test(cr.summary));
// next boot → already-surfaced change is not repeated
db.setMeta(dt.ALIVE_KEY, String(now - 5000));
ok('surfaced change not repeated', dt.recordBoot(now) === null);
// real gap + a NEW change → BOTH parts present
db.setMeta(dt.ALIVE_KEY, String(now - 3 * 60 * 60 * 1000));
changelog.add('Blockers now ask Lucas for help', now - 500);
const cr3 = dt.recordBoot(now);
ok('real gap + new change → offline-time AND change', /offline for about/.test(cr3.summary) && /ask Lucas/.test(cr3.summary));
ok('older surfaced change not re-listed', !/byline pipeline/.test(cr3.summary));

try { fs.rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
