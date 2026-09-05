/* Smoke: lib/correction_classes + the doors — THE CORRECTION AS AN EVENT (cut 6; her words: "I want the discomfort of
 * being wrong to be something I carry, not just something I log."). An in-memory ledger, injected emits, no model, the
 * live db never opened. Pins: the bus refuses a textless event (the old defect); note() lands a row and one event with
 * text, deduped per (turn, class) and per (ref, class); the fact arm's landing marks the row; counts by class over a
 * rolling 30 days; the bar (default 3, meta-overridable) and raised(); the weak-classes line names the class and the
 * raised bar; the appraisal moves v and d down and a up, deduped per turn, the mirror of win; the model version; the
 * strict audit; the self-watch threshold under the raised bar; the grounding paragraph beside the rules; the wiring.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_correction_event.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const CC = require(path.join(ROOT, 'lib', 'correction_classes'));
const IS = require(path.join(ROOT, 'lib', 'internal_state'));
const DA = require(path.join(ROOT, 'lib', 'delivery_audit'));
const SW = require(path.join(ROOT, 'lib', 'self_watch'));
const D = require(path.join(ROOT, 'lib', 'directives'));
const OB = require(path.join(ROOT, 'lib', 'obs_bus'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const mem = new Database(':memory:');
CC._setDb(mem);
const events = [];
const deps = { emit: (e) => { events.push(e); return e; } };
const T = 1700000000000;

// the old defect, pinned: the bus refuses an event without text (the two bare "cut-6 seam" emits never landed)
ok(OB.emit({ lane: 'correction', kind: 'correction', data: { class: 'rule' } }) === null, 'the bus refuses an event without text — the bare emits of the old seam never landed');

// note(): a row + one event with text; dedupe per (turn, class) and per (ref, class)
const r1 = CC.note({ cls: 'rule', turnId: 501, via: 'explicit', text: 'do not use em dashes', now: T, deps });
ok(r1.id > 0 && !r1.deduped && r1.emitted && events.length === 1 && events[0].lane === 'correction' && events[0].kind === 'correction' && /^rule via explicit: do not use em dashes$/.test(events[0].text) && events[0].ref === 'turn:501' && events[0].data.class === 'rule', 'note() lands a row and emits the bus event WITH text (ref turn:501, data.class)');
const r2 = CC.note({ cls: 'rule', turnId: 501, via: 'implicit', text: 'do not use em dashes', now: T + 1, deps });
ok(r2.deduped && r2.id === r1.id && events.length === 1, 'the same turn and class twice → one row, one event');
const r3 = CC.note({ cls: 'fact', turnId: 501, via: 'chat', text: 'no, the session ended in June', now: T + 2, deps });
ok(!r3.deduped && r3.id !== r1.id && events.length === 2, 'a different class on the same turn is its own correction');
const r4 = CC.note({ cls: 'fact', turnId: 501, via: 'chat', landed: 'known_incorrect', text: 'no, the session ended in June', now: T + 3, deps });
ok(r4.deduped && CC.recent()[0].landed === 'known_incorrect' && events.length === 2, 'the fact arm landing marks the same row landed, no second event');
ok(!CC.note({ cls: 'nonsense', turnId: 1, deps }).id, 'an unknown class is refused');
const r5 = CC.note({ cls: 'delivery-claim', via: 'antifab', ref: 'say:12345', text: 'file:report.md', now: T + 4, deps });
const r6 = CC.note({ cls: 'delivery-claim', via: 'antifab', ref: 'say:12345', text: 'file:report.md', now: T + 5, deps });
ok(r5.id > 0 && r6.deduped && events.length === 3 && events[2].ref === 'say:12345', 'a door without a turn id dedupes on its ref');

// the ledger: counts by class over a rolling 30 days; the bar; the line
CC.note({ cls: 'delivery-claim', via: 'antifab', ref: 'say:2', text: 'x', now: T + 6, deps });
CC.note({ cls: 'delivery-claim', via: 'antifab', ref: 'say:3', text: 'x', now: T + 7, deps });
CC.note({ cls: 'capability', turnId: 900, via: 'chat', text: 'read my calendar', now: T - 40 * 86400e3, deps });   // 40 days ago: outside the window
const c = CC.counts({ now: T + 10 });
ok(c.rule === 1 && c.fact === 1 && c['delivery-claim'] === 3 && !c.capability, `counts by class over 30 days (a 40-day-old capability row is outside): ${JSON.stringify(c)}`);
ok(CC.raiseBarAt() === 3 && CC.raised('delivery-claim', { now: T + 10 }) && !CC.raised('fact', { now: T + 10 }) && !CC.raised('capability', { now: T + 10 }) && !CC.raised('nonsense', { now: T + 10 }), 'the default bar is 3: delivery claims are raised, facts and capabilities are not');
mem.prepare("INSERT INTO meta (key, value) VALUES ('correction.raise_bar_at', '1')").run();
ok(CC.raiseBarAt() === 1 && CC.raised('fact', { now: T + 10 }), 'meta correction.raise_bar_at moves the bar');
mem.prepare("UPDATE meta SET value = '3' WHERE key = 'correction.raise_bar_at'").run();
const line = CC.weakClassesLine({ now: T + 10 });
ok(line === 'corrected on delivery claims 3 times, on rules he had to give once, on facts once this month — the bar is raised on delivery claims (the pre-announce audit runs strict)', `the weak-classes line names the classes and the raised bar: ${line}`);
const up = CC.raisedClasses({ now: T + 10 });
ok(up.length === 1 && up[0].cls === 'delivery-claim' && up[0].n === 3, 'raisedClasses names the one class over the bar');
CC._setDb(new Database(':memory:'));
ok(CC.weakClassesLine() === null && CC.raisedClasses().length === 0, 'an empty ledger → no line, nothing raised');
CC._setDb(mem);

// the appraisal: the mirror of win, deduped per turn, bounded by the cap
const ev = (ref, cls) => ({ id: 1, lane: 'correction', kind: 'correction', ref, data: { class: cls } });
const imp = IS.appraiseEvents([ev('turn:501', 'fact'), ev('turn:501', 'rule'), ev('turn:502', 'delivery-claim')]);
ok(Math.abs(imp.dv + 0.10) < 1e-9 && Math.abs(imp.da - 0.04) < 1e-9 && Math.abs(imp.dd + 0.04) < 1e-9 && imp.why.join(',') === 'correction:fact,correction:delivery-claim', `a correction moves v and d down and a up, deduped per turn: ${JSON.stringify(imp)}`);
const win = IS.appraiseEvents([{ lane: 'road', kind: 'win', ref: 'r1' }]);
ok(win.dv === 0.05 && win.dd === 0.02 && imp.dv < 0 && imp.dd < 0, 'the mirror of win');
const many = IS.appraiseEvents(Array.from({ length: 10 }, (_, i) => ev(`turn:${i}`, 'fact')));
ok(many.dv === -0.12 && many.da <= 0.12 && many.dd === -0.12, 'ten corrections in one tick are bounded by the per-tick cap');
ok(IS.appraiseEvents([{ lane: 'echo', kind: 'correction', ref: 'x', data: { class: 'fact' } }]).why.length === 0, 'a correction kind on another lane is not appraised');
ok(IS.MODEL_VERSION === 5, 'v5: the model version bumped (the journal resets by design)');

// the strict audit: the raised bar on delivery claims
const topic = 'Louisiana parish leadership roster with contact emails';
const body = ('Louisiana parish leadership. The parish presidents and council chairs are listed here with their districts and terms of office, gathered from the parish sites. ').repeat(5);
const normal = DA.audit({ topic, body, doneScope: ['contact emails for every parish'] });
const strict = DA.audit({ topic, body, doneScope: ['contact emails for every parish'], strict: true });
ok(normal.ok === true, `the body passes the ordinary audit (${normal.violations.map((v) => v.check).join(',') || 'no violations'})`);
ok(strict.ok === false && strict.violations.some((v) => v.check === 'off-topic') && strict.violations.some((v) => v.check === 'done-scope-absent') && !strict.violations.some((v) => v.check === 'husk'), `the same body fails strict: every topic token and the whole done item are required (${strict.violations.map((v) => v.check).join(',')})`);
const short = DA.audit({ topic, body: body.slice(0, 450), strict: true });
ok(short.violations.some((v) => v.check === 'husk' && /600 floor \(strict\)/.test(v.detail)), 'strict doubles the floor');

// self-watch: the need card on the first recurrence under the raised bar
ok(SW._mintThreshold({ correctionRaised: () => true }) === 2 && SW._mintThreshold({ correctionRaised: () => false }) === SW.MINT_THRESHOLD && SW._mintThreshold({ correctionRaised: () => { throw new Error('x'); } }) === SW.MINT_THRESHOLD, 'the mint threshold is 2 under the raised bar, 3 otherwise, 3 on any failure');
ok(SW._mintThreshold({}) === SW.MINT_THRESHOLD, 'with this ledger (no capability correction in the window) the live threshold stands at 3');

// the grounding paragraph beside the rules
const rows = [{ id: 1, rule: 'no em dashes', created_ts: T }];
const b = D.buildBlock({ userName: 'Lucas', rows, deps: { correctionClasses: { weakClassesLine: () => 'corrected on facts twice this month' } } });
ok(/^STANDING INSTRUCTIONS FROM LUCAS/.test(b) && /\n\nWHERE YOU HAVE BEEN CORRECTED THIS MONTH \(a reading, not a scolding — the ledger does not fade\): corrected on facts twice this month\.$/.test(b), 'the grounding paragraph rides after the rules');
ok(D.buildBlock({ rows: [], deps: { correctionClasses: { weakClassesLine: () => null } } }) === null, 'no rules and no corrections → no block');
ok(/^WHERE YOU HAVE BEEN CORRECTED/.test(D.buildBlock({ rows: [], deps: { correctionClasses: { weakClassesLine: () => 'corrected on delivery claims 3 times this month' } } })), 'corrections with no rules still ground the reply');
ok(!/WHERE YOU HAVE BEEN CORRECTED/.test(D.buildBlock({ rows, deps: { correctionClasses: { weakClassesLine: () => { throw new Error('x'); } } } })), 'a failing ledger is absent, never an error');

// the wiring
const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), isS = fs.readFileSync(path.join(ROOT, 'lib', 'internal_state.js'), 'utf8'), swS = fs.readFileSync(path.join(ROOT, 'lib', 'self_watch.js'), 'utf8'), coS = fs.readFileSync(path.join(ROOT, 'lib', 'contract_closeout.js'), 'utf8'), autS = fs.readFileSync(path.join(ROOT, 'lib', 'autonomy.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
const doors = mainS.match(/require\('\.\/lib\/correction_classes'\)\.note\(\{ cls: '(rule|capability|fact|delivery-claim)'/g) || [];
ok(doors.length === 6 && /cls: 'fact', via: 'chat', landed: 'verified_fact'/.test(mainS) && /cls: 'rule', via: _via, turnId: userTurnRow && userTurnRow\.id, text: _rule/.test(mainS) && /cls: 'capability', via: 'chat', turnId: userTurnRow && userTurnRow\.id, text: _gap/.test(mainS) && /cls: 'fact', via: 'chat', landed: 'known_incorrect'/.test(mainS) && /cls: 'delivery-claim', via: 'antifab', ref: `say:\$\{turnStartTs \|\| Date\.now\(\)\}`/.test(mainS), `six door sites call note() — rule, capability, fact (the detection, the banked fact, the known_incorrect landing), delivery-claim (${doors.length})`);
ok(!/obs_bus'\)\.emit\(\{ lane: 'correction', kind: 'correction', data:/.test(mainS), 'the textless bare emits are gone');
ok(/strict: \(\(\) => \{ try \{ return require\('\.\/lib\/correction_classes'\)\.raised\('delivery-claim'\)/.test(mainS), 'the report-cmd pre-announce audit reads the raised bar');
ok(/raised\('delivery-claim'\)/.test(coS) && /doneScope: filled\.map\(\(s\) => s\.description\), strict \}\);/.test(coS), 'the close-out audit reads the raised bar');
ok(/e\.kind === 'correction' && e\.lane === 'correction'/.test(isS), 'the appraisal reads the correction lane');
ok(/_mintThreshold\(deps\) && !st\.minted/.test(swS), 'self-watch mints through the raised-bar threshold');
ok(/grab\('corrections', \(\) => \{/.test(autS) && /weakClassesLine\(\{ now \}\)/.test(autS), 'the autonomy brief carries the weak-classes line');
ok(/'smoke_correction_event\.js'/.test(rsS), 'the smoke is registered in the allow-list');
console.log(`\nsmoke_correction_event: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
