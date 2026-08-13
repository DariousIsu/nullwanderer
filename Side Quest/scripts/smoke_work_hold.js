/**
 * Work-hold control order (2026-08-13, turn #11783) — "put all work projects and tasks on hold
 * until 0630" was answered with a commitment to MORE work, twice verbatim, because the order
 * changed no engine state. lib/work_hold: conservative detect (hold/resume), wall-clock +
 * duration parsing, one meta key consulted by the directed engine seams.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_work_hold.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_whold_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const wh = require('../lib/work_hold');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// A fixed "now": 03:28 local (the live moment). Local tz on this machine IS Eastern.
const NOW = new Date(2026, 7, 13, 3, 28, 0).getTime();

// ── detection: the EXACT live order ──────────────────────────────────────────────────────────────
const live = wh.detect("You know what Zo, let's put all work projects and tasks on hold until 0630 (just about 3 hours from now) and you take this time to go build yourself.", NOW);
ok('the live #11782 order DETECTS as a hold', !!(live && live.hold));
const sixThirty = new Date(2026, 7, 13, 6, 30, 0).getTime();
ok(`"until 0630" parses to the next 06:30 (got ${live && new Date(live.untilTs).toLocaleTimeString()})`, live && live.untilTs === sixThirty);

// ── detection: phrasing variants ─────────────────────────────────────────────────────────────────
ok('"pause the work for 3 hours" → hold now+3h', (() => { const d = wh.detect('pause the work for 3 hours', NOW); return d && d.hold && d.untilTs === NOW + 3 * 3600000; })());
ok('"put the work on hold" (no time) → default hold ~3h', (() => { const d = wh.detect('put the work on hold', NOW); return d && d.hold && d.untilTs === NOW + 3 * 3600000; })());
ok('"hold all work until 6:30" → next 06:30', (() => { const d = wh.detect('hold all work until 6:30', NOW); return d && d.hold && d.untilTs === sixThirty; })());
ok('"park the work until morning" → next 08:00', (() => { const d = wh.detect('park the work until morning', NOW); return d && d.hold && d.untilTs === new Date(2026, 7, 13, 8, 0, 0).getTime(); })());
ok('"until 2pm" honors am/pm', (() => { const d = wh.detect('put the work on hold until 2pm', NOW); return d && d.hold && d.untilTs === new Date(2026, 7, 13, 14, 0, 0).getTime(); })());
ok('a wall-clock already past rolls to TOMORROW', (() => { const d = wh.detect('put the work on hold until 0100', NOW); return d && d.hold && d.untilTs === new Date(2026, 7, 14, 1, 0, 0).getTime(); })());

// ── resume ───────────────────────────────────────────────────────────────────────────────────────
ok('"back to work" → resume', (() => { const d = wh.detect('alright, back to work'); return d && d.resume; })());
ok('"resume the work" → resume', (() => { const d = wh.detect('resume the work please'); return d && d.resume; })());
ok('"lift the hold" → resume', (() => { const d = wh.detect('lift the hold'); return d && d.resume; })());
ok('resume WINS when both shapes appear', (() => { const d = wh.detect('back to work — the hold on work is over'); return d && d.resume; })());

// ── conservative negatives (a phantom hold is invisible — worse than a missed phrasing) ──────────
ok('"hold on a second" → null', wh.detect('hold on a second, let me think') === null);
ok('"hold that thought" → null', wh.detect('hold that thought') === null);
ok('normal work talk → null', wh.detect('the work on the Applied Digital dossier is going well') === null);
ok('"this should work on hold music" → null', wh.detect('this should work on hold music') === null);
ok('empty/null → null', wh.detect('') === null && wh.detect(null) === null);

// ── state machine ────────────────────────────────────────────────────────────────────────────────
ok('no hold initially', !wh.active() && wh.until() === 0);
wh.set(Date.now() + 60 * 60000);
ok('set → active, until in the future', wh.active() && wh.until() > Date.now());
ok('describe() renders an ET wall-clock', /\d{2}:\d{2} ET/.test(wh.describe()));
wh.clear();
ok('clear → inactive', !wh.active());
wh.set(Date.now() - 1000);
ok('an EXPIRED hold reads inactive (lift is automatic)', !wh.active() && wh.until() === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { db.getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
