/* Smoke: lib/capability_need — the need detector + store (Slice R part 1, PLAN_MAP §1).
 * Guards the wire's first half: a run that NAMES its missing capability lands a typed row;
 * acknowledgments/questions/"no need" never do; dedupe holds; the suite matcher finds the
 * bar a need-born rehearsal will be judged by. Fixtures are the ROSTER EPISODE's verbatims.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_capability_need.js
 */
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_smoke_capneed_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const CN = require('C:/Users/azrae/Desktop/Side Quest/lib/capability_need');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  db.init();
  const T0 = 1000000000000;

  // ── the detector: the roster episode's real shapes MUST land ──
  ok(CN.detect('The file downloaded but I need a tool that can read XLS files to get the rows out.').length === 1,
    'detect: "I need a tool that can read XLS files" (the canonical roster sentence)');
  ok(CN.detect('Extracting this requires a Python script with pandas to parse the BIFF format.').length === 1,
    'detect: "requires a Python script with pandas"');
  ok(CN.detect('I tried three doors; no tool can parse the legacy BIFF spreadsheet format.').length === 1,
    'detect: "no tool can parse…"');
  ok(CN.detect('Downloaded 3.1MB but unable to parse the spreadsheet into rows.').length === 1,
    'detect: "unable to parse…"');

  // ── the guards: shapes that must NOT become needs ──
  ok(CN.detect('Understood — I need a moment to check the directory.').length === 0,
    'guard: acknowledgment opener never lands');
  ok(CN.detect('There is no need to re-search the sheriffs, that list is complete.').length === 0,
    'guard: "no need to…" is the opposite of a need');
  ok(CN.detect('Would we need a tool that can read XLS files?').length === 0,
    'guard: a question is not a declaration');
  ok(CN.detect('The parish clerk offices are listed on the roster.').length === 0,
    'guard: plain findings text stays silent');

  // ── the store: land, dedupe, status flow ──
  const r1 = CN.record('need a tool that can read XLS files', { bornFrom: 'inquiry-1-t18', nowMs: T0 });
  ok(r1.id != null && !r1.deduped, 'record: a need lands as a row');
  const r2 = CN.record('I need a tool that reads XLS spreadsheet files', { bornFrom: 'inquiry-1-t19', nowMs: T0 + 1000 });
  ok(r2.deduped === true && r2.id === r1.id, 'record: a near-identical need DEDUPES onto the open row');
  const r3 = CN.record('need a crawler that can walk a whole site plan', { bornFrom: 'run-x', nowMs: T0 });
  ok(r3.id != null && r3.id !== r1.id, 'record: a genuinely different need is its own row');
  ok(CN.listOpen().length === 2, 'listOpen: both open needs listed');
  ok(CN.setStatus(r1.id, 'rehearsing', { nowMs: T0 + 2000 }) && CN.get(r1.id).status === 'rehearsing',
    'setStatus: open → rehearsing');
  const r4 = CN.record('a tool to read XLS files', { nowMs: T0 + 3000 });
  ok(r4.deduped === true && r4.id === r1.id, 'dedupe also holds against a REHEARSING row (no forking a worked need)');
  CN.setStatus(r1.id, 'retired', { nowMs: T0 + 4000 });
  const r5 = CN.record('need a tool that can read XLS files', { nowMs: T0 + 5000 });
  ok(r5.id != null && r5.id !== r1.id && !r5.deduped, 'a RETIRED twin does not block — a need that returns is a need again');

  // ── harvest: full text in, rows out ──
  const h = CN.harvest('Sheriffs complete. I need a tool that can diff two rosters across years. Also there is no need to redo clerks.', { bornFrom: 'inquiry-1-t20', nowMs: T0 + 6000 });
  ok(h.length === 1 && CN.get(h[0].id).born_from === 'inquiry-1-t20', 'harvest: lands the need, carries born_from, skips the guard shapes');

  // ── suiteFor: the bar a need-born rehearsal is judged by ──
  const SUITES = ['smoke_sheet_extract', 'smoke_site_ledger', 'smoke_cognition', 'smoke_web_search'];
  ok(CN.suiteFor('a tool that can read XLS files', SUITES) === 'smoke_sheet_extract',
    'suiteFor: the roster need maps to smoke_sheet_extract (alias xls→sheet/extract)');
  ok(CN.suiteFor('a crawler that can walk a whole site plan ledger', SUITES) === 'smoke_site_ledger',
    'suiteFor: site-plan need maps to smoke_site_ledger');
  ok(CN.suiteFor('a quantum entanglement synthesizer', SUITES) === null,
    'suiteFor: nothing fits → honest null (park for Lucas, never iterate against an unrelated bar)');

  // ── the state line ──
  const lines = CN.manifestLines({ nowMs: T0 + 7200000 });
  ok(lines.length === 3 && /\[need #\d+\]/.test(lines[0]) && /named 2h ago/.test(lines[0]),
    'manifestLines: open needs render with id, text, age, and born_from (3 open: crawler, re-landed xls, roster-diff)');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.stack || e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
