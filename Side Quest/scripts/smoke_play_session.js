/**
 * Smoke test for the stepwise play-session state machine (lib/play_session.js).
 * Covers the pure parts — state transitions, inventory extraction from a real
 * web.read() dump, character-pick parsing, and chat-line parsing. The runTick
 * orchestrator calls Ollama + the live browser, so it's verified in-app; here we
 * prove the logic each step depends on.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_play_session.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_playtest_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const ps = require('../lib/play_session');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

console.log('State machine:');
ps.reset();
ok('reset → none', ps.get() === 'none' && !ps.active());
ps.start();
ok('start → open + active', ps.get() === 'open' && ps.active());
ps.set('chat');
ok('set advances step', ps.get() === 'chat');
ps.set('bogus');
ok('set ignores invalid step', ps.get() === 'chat');
ps.reset();
ok('reset clears character + inventory', ps.get() === 'none' && ps.character() === '');

console.log('\nInventory extraction (real web.read() dump shape):');
const readDump = [
  'CrushOn AI — discover characters',
  '',
  'Interactive elements:',
  '  [L0] link: Home',
  '  [L1] link: Log in',
  '  [L2] link: Mizuki, the fired mini-boss',
  '  [L3] link: Detective Kaito Mori',
  '  [L4] link: Create Character',
  '  [L5] link: Premium',
  '  [L6] link: Seraphina the archivist',
  '  [B0] button: Menu',
  '  [I0] input: Search'
].join('\n');
const inv = ps.extractInventory(readDump);
ok('keeps the 3 character links', inv.length === 3, inv.map(o => o.label).join(' | '));
ok('drops Home/Login/Create/Premium nav', !inv.some(o => /home|log in|create|premium/i.test(o.label)));
ok('first is Mizuki @ L2', inv[0] && inv[0].handle === 'L2' && /Mizuki/.test(inv[0].label));

console.log('\nPick parsing:');
ok('explicit <web-click>L3</web-click>', ps.parsePick('<web-click>L3</web-click>', inv) && ps.parsePick('<web-click>L3</web-click>', inv).handle === 'L3');
ok('bare handle "L6"', ps.parsePick('L6', inv) && ps.parsePick('L6', inv).handle === 'L6');
ok('1-based number "2" → 2nd entry', ps.parsePick('I think 2', inv) && ps.parsePick('I think 2', inv).handle === inv[1].handle);
ok('number "1" → first entry', ps.parsePick('1', inv) && ps.parsePick('1', inv).handle === inv[0].handle);
ok('unparseable → null', ps.parsePick('hmm, none of these', inv) === null);

console.log('\nChat-line parsing:');
ok('extracts <web-chat> body', ps.parseChatLine('<web-chat speaker="Mizuki">So, you got fired?</web-chat>') === 'So, you got fired?');
ok('falls back to plain text', ps.parseChatLine('Just talking normally.') === 'Just talking normally.');
ok('empty body → strips to remainder', ps.parseChatLine('<web-chat speaker="X"></web-chat> hey there') === 'hey there');

console.log(`\n${fail === 0 ? 'ALL PLAY-SESSION TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
try { D.getDb().close(); } catch {}
process.exit(fail === 0 ? 0 : 1);
