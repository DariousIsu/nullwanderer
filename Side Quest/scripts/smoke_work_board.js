/**
 * THE WORK BOARD (Lucas 09-01: "this turn is a perfect example of where live charts and graphics
 * would be useful. She autonomously made some art so I know she can use the tool" — the missing
 * piece was the WORK-STATUS reflex). Pins: lanes are SELECTed from real state (pen runs + queue,
 * parlor visit, quiet window, cycler lock), the SVG is deterministic (same snapshot = same
 * bytes) with hostile row text ESCAPED, the model-never-draws-a-bar law holds in the source, and
 * the wiring stands (window + tick + AUTO-OPEN on run start + verb door + preload bridges).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_work_board.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_wb_${Date.now()}.db`);
require('../lib/db').init();
const db = require('../lib/db');
const pen = require('../lib/code_pen');
const wb = require('../lib/work_board');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// ── lanes come from REAL rows ──
// pen #16 (09-05): the propose door checks the diff FITS its file (git's own --check) — the fixture is built from lib/board.js's real first two lines
const _bl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board.js'), 'utf8').split(/\r?\n/);
const pr = pen.propose({ title: 'wb smoke change', rationale: 'wb', diff: `--- a/lib/board.js\n+++ b/lib/board.js\n@@ -1,2 +1,3 @@\n ${_bl[0]}\n+// wb smoke\n ${_bl[1]}\n` });
ok(pr.ok === true, 'fixture proposal filed through the real door');
pen.setStatus(pr.id, 'applying', { gateNote: 'stage: diff applied — FULL gate running (≈595 suites)…' });
const s1 = wb.snapshot({});
ok(s1.lanes.some((l) => l.id === `pen-${pr.id}` && l.status === 'applying' && l.progress === 0.65),
  '⭐ a mid-gate pen run lanes at 0.65 — progress DERIVED from the row\'s own stage note, never authored');
pen.setStatus(pr.id, 'applied', { gateNote: 'gate GREEN — committed' });
ok(wb.snapshot({}).lanes.some((l) => l.id === `pen-${pr.id}` && l.progress === 1), 'a terminal run settles at the full bar (and ages out with RUN_WINDOW)');
// the parlor is DEFAULT OFF (09-02); an invitation is an engagement — the only way a visit opens on a fresh store
require('../lib/parlor').openVisit({ reason: 'wb reason', engaged: true });
ok(wb.snapshot({}).lanes.some((l) => l.kind === 'parlor' && /wb reason/.test(l.note)), 'an open parlor visit lanes with its turn budget');
db.setMeta('pen.gate_until', String(Date.now() + 5 * 60 * 1000));
ok(wb.snapshot({}).lanes.some((l) => l.kind === 'quiet'), 'the quiet window lanes while a gate holds');
db.setMeta('pen.gate_until', '');
ok(!wb.snapshot({}).lanes.some((l) => l.kind === 'quiet'), 'and leaves when the gate releases');

// ── the render: deterministic, escaped, lawful ──
const snap = { at: 1756700000000, lanes: [{ kind: 'pen', id: 'pen-1', label: 'PEN #1 — x', status: 'applying', note: 'stage', progress: 0.5 }] };
ok(wb.renderSVG(snap) === wb.renderSVG(snap) && /WORK BOARD/.test(wb.renderSVG(snap)) && / ET</.test(wb.renderSVG(snap)),
  '⭐ deterministic: same snapshot, same bytes — and the clock displays EASTERN (the display law)');
const hostile = wb.renderSVG({ at: 1756700000000, lanes: [{ kind: 'pen', id: 'p', label: '<img onerror=alert(1)>', status: 'applying', note: '"><script>x</script>', progress: 1 }] });
ok(!hostile.includes('<img') && !hostile.includes('<script') && hostile.includes('&lt;img'),
  '⭐ hostile row text is ESCAPED — DB-borne text can never script the board');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'work_board.js'), 'utf8');
ok(!/Math\.random/.test(src) && !/runCloudOperator|ollama|generateContent/i.test(src),
  '⭐ THE LAW: a model never draws a bar — no model call, no dice; the board draws SELECTed rows only');

// ── wiring ──
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/openWorkBoard/.test(main) && /work_board\.html/.test(main) && /workboard:tick/.test(main) && /workboard:snapshot/.test(main),
  'wiring: the window, the 5s tick channel, and the snapshot door exist');
ok(/_penApplyBusy = true;\s*\n?\s*try \{ openWorkBoard\(\{ quiet: true \}\)/.test(main),
  '⭐ the board AUTO-OPENS quiet the moment a run starts (the parlor-window pattern applied to work — his word: watch, not ask)');
{
  const vm = main.match(/const isWB = (\/.*\/i)\.test\(userMessage\);/);
  const re = vm ? eval(vm[1]) : null;
  ok(re && re.test('work board') && re.test('open the work board') && re.test('show me the workboard'),
    'the verb door answers natural phrasings');
  ok(re && !re.test('what do you think about the work board layout') && !re.test('work board was helpful yesterday'),
    'sentences ABOUT the board never hijack — full-match anchoring');
}
const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
ok(/onWorkBoardTick/.test(pre) && /workBoardSnapshot/.test(pre), 'wiring: the preload bridges feed the page');
ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'work_board.html')), 'wiring: the observer page exists');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { require('../lib/db').getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
