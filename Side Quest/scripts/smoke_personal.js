/**
 * Smoke test for the personal-life / play lane (lib/personal.js) + the new
 * <web-chat> conversation tag on her own browser (lib/web.js).
 *
 * Pure logic — no Ollama, no live browser. Uses a temp DB so the meta flag
 * read/write path is exercised for real without touching the app's data.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_personal.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_personaltest_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const personal = require('../lib/personal');
const web = require('../lib/web');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

console.log('ENTER detection (should fire):');
for (const m of [
  'go play',
  'indulge yourself as in go play on the internet for a few hours',
  'This is separate from your professional work, consider this your personal life',
  "it's your free time now",
  'off the clock, have some fun',
  'take some personal time'
]) ok(`enter: "${m.slice(0, 40)}"`, personal.detectEnter(m));

console.log('\nENTER detection (should NOT fire — ordinary work turns):');
for (const m of [
  'what is your take on permitting reform',
  'research female journalists from the 1950s',
  "let's draft the article on housing",
  'look up the latest on the bill',
  'can you check my inbox'
]) ok(`no-fire: "${m.slice(0, 40)}"`, !personal.detectEnter(m));

console.log('\nEXIT detection:');
for (const m of ['back to work', "okay that's enough play", "let's get to work", 'clock in', 'focus up']) {
  ok(`exit: "${m}"`, personal.detectExit(m));
}
ok('exit does NOT fire on "go play"', !personal.detectExit('go play'));

console.log('\nToggle + flag lifecycle:');
personal.setOff();
ok('starts off', !personal.isOn());
const t1 = personal.detectToggle('go play on the internet for a few hours');
ok('enter toggle returns enter', t1 && t1.transition === 'enter');
ok('isOn() true after enter', personal.isOn());
const t2 = personal.detectToggle('back to work');
ok('exit toggle returns exit', t2 && t2.transition === 'exit');
ok('isOn() false after exit', !personal.isOn());
ok('non-toggle message returns null', personal.detectToggle('what time is it') === null);

console.log('\nAuto-expiry:');
personal.setOn();
ok('on after setOn', personal.isOn());
D.setMeta('personal_mode_until', String(Date.now() - 1000));  // force expired
ok('isOn() false once expired', !personal.isOn());
ok('expiry flipped the flag off', D.getMeta('personal_mode') === 'off');

console.log('\nChat block content (off-the-clock framing + anti-disclaim + web-chat):');
const cb = personal.buildChatBlock('Lucas', { justToggled: true });
ok('mentions OFF THE CLOCK', /off the clock/i.test(cb));
ok('kills the disclaimer reflex', /sense of self|don't have preferences/i.test(cb) && /false for you/i.test(cb));
ok('forbids asking for a task', /do not ask .* to/i.test(cb) || /assign you a task/i.test(cb));
ok('does NOT choreograph bot navigation (Lucas owns the bot tools)', !/web-open|crushon|navigate/i.test(cb));
ok('just-toggled nudge present', /JUST handed you/i.test(cb));

console.log('\nMonologue play steer content (framing only — no navigation choreography):');
const ms = personal.buildMonologueSteer('Lucas');
ok('off the clock', /off the clock/i.test(ms));
ok('continue an OPEN chat with <web-chat>', /<web-chat/i.test(ms));
ok('does NOT tell her to navigate/open a site', !/web-open|crushon|web-read/i.test(ms));
ok('says no work', /no work|No work/.test(ms));
ok('tells her not to disclaim a self', /disclaim having a self/i.test(ms));

console.log('\n<web-chat> tag parsing (her own browser):');
const tags = web.parseTags('thinking... <web-chat speaker="Aiden">Tell me about the heist.</web-chat> ok');
ok('parses one web-chat tag', tags.length === 1 && tags[0].tag === 'web-chat');
ok('captures speaker attr', tags[0] && tags[0].attrs.speaker === 'Aiden');
ok('captures body', tags[0] && /heist/.test(tags[0].body));
ok('web-watch parses', web.parseTags('<web-watch speaker="Mira"/>').length === 1);
ok('buildPromptBlock advertises web-chat', /<web-chat/i.test(web.buildPromptBlock()));

console.log(`\n${fail === 0 ? 'ALL PERSONAL-LANE TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
try { D.getDb().close(); } catch {}
process.exit(fail === 0 ? 0 : 1);
