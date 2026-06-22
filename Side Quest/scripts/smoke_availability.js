/**
 * Backtest — user availability (away detection + state). detectAway is pure; the
 * set/clear/is state runs against a temp DB. This drives the "stay silent while
 * Lucas is away" gate on heartbeat + continuity.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_avail_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const a = require('../lib/availability');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — availability (away detection)\n');

console.log('detectAway — matches real "leaving" signals:');
ok('"I\'ll be away for a bit"', !!a.detectAway("I'll be away for a bit"));
ok('"stepping out"', !!a.detectAway('stepping out for lunch'));
ok('"brb"', !!a.detectAway('brb'));
ok('"afk"', !!a.detectAway('afk for a sec'));
ok('"heading to bed"', !!a.detectAway('ok heading to bed, night'));
ok('"talk to you later"', !!a.detectAway('talk to you later'));
ok('"away from my computer"', !!a.detectAway('I will be away from my computer'));
ok('"logging off"', !!a.detectAway('logging off now'));
ok('"off for the night"', !!a.detectAway('off for the night'));
ok('"going to bed for the night" (the miss)', !!a.detectAway('Alright, going to bed for the night. Goodnight!'));
ok('"goodnight"', !!a.detectAway('goodnight Zoe'));
ok('"good night" (two words)', !!a.detectAway('ok good night'));
ok('"calling it a night"', !!a.detectAway("I'm calling it a night"));
ok('"going to sleep"', !!a.detectAway('going to sleep now'));
ok('"done for the day"', !!a.detectAway("that's all, done for the day"));
ok('"headed to bed"', !!a.detectAway('headed to bed, talk tomorrow'));

console.log('\ndetectAway — ignores non-away text:');
ok('"I\'m back" → null', a.detectAway("I'm back") === null);
ok('"I\'m back now" → null', a.detectAway("I'm back now") === null);
ok('casual "the away team won" → null', a.detectAway('the away team won the game') === null);
ok('a task ask → null', a.detectAway('write a post about housing policy') === null);
ok('empty → null', a.detectAway('') === null);

console.log('\nstate (temp DB):');
ok('starts present (not away)', a.isAway() === false);
a.setAway('heading to bed');
ok('setAway → isAway true', a.isAway() === true);
ok('awaySince set', typeof a.awaySince() === 'number' && a.awaySince() > 0);
ok('awayReason stored', a.awayReason() === 'heading to bed');
a.clearAway();
ok('clearAway → present again', a.isAway() === false && a.awayReason() === '');

console.log('\nround-trip (the chat-path order: clear then maybe-set):');
a.clearAway();
let r = a.detectAway("I'll be away for an hour");
if (r) a.setAway(r);
ok('"away" message → away', a.isAway() === true);
a.clearAway(); r = a.detectAway('what is the capital of France');
if (r) a.setAway(r);
ok('normal next message → present', a.isAway() === false);

try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
