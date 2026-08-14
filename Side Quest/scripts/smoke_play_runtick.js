/**
 * Integration test for play_session.runTick — drives the full stepwise walk
 * (open → inventory → choose → startchat → chat) with the browser + model STUBBED, so the
 * orchestration is proven deterministically without a live CrushOn session or
 * Ollama. Also verifies the 3-strike reset when a step keeps failing.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_play_runtick.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_runtick_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const web = require('../lib/web');     // same cached object play_session holds
const ollama = require('../lib/ollama');
const ps = require('../lib/play_session');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

// --- stubs ---
const calls = { open: 0, read: 0, click: null, chatSend: null };
const READ_DUMP = [
  'CrushOn AI', 'Interactive elements:',
  '  [L0] link: Home',
  '  [L1] link: Mizuki, the fired mini-boss',
  '  [L2] link: Detective Kaito',
  '  [B0] button: Start Chat',
  '  [I0] input: Search'
].join('\n');

function installHappyStubs() {
  web.open = async () => { calls.open++; return { ok: true, url: 'https://crushon.ai', title: 'CrushOn' }; };
  web.read = async () => { calls.read++; return { ok: true, url: 'https://crushon.ai', title: 'CrushOn', text: READ_DUMP }; };
  web.click = async (h) => { calls.click = h; return { ok: true, url: 'https://crushon.ai/c/mizuki' }; };
  web.chatSend = async (line, speaker) => { calls.chatSend = { line, speaker }; return { ok: true, text: 'So... you heard about the mini-boss thing?', speaker, url: 'https://crushon.ai/c/mizuki' }; };
  // model: pick L1 on a 'choose' prompt, else speak a line on a 'chat' prompt
  ollama.streamChat = async ({ messages, onToken }) => {
    const txt = JSON.stringify(messages);
    const out = /characters on the page/i.test(txt) ? '<web-click>L1</web-click>' : '<web-chat speaker="Mizuki">Hey — rough day?</web-chat>';
    for (const ch of out) onToken(ch);
  };
}

(async () => {
  // REGRESSION: play_session calls webLib.chatSend/read/click/open on the exported
  // object — assert they're really EXPORTED before the stubs below mask them. (A
  // missing chatSend export once caused a runaway no-GPU-registering tick loop.)
  for (const fn of ['chatSend', 'chatWatch', 'chatUnwatch', 'read', 'open', 'click']) {
    ok(`web.${fn} is exported`, typeof web[fn] === 'function');
  }
  installHappyStubs();
  // D3 (2026-08-14): no hardcoded site — an unconfigured 'open' tick resets honestly, and the walk
  // below runs against an EXPLICITLY configured play_site_url (the only source now).
  ps.reset(); ps.start({ requireSite: false });   // force the state machine to 'open' with no site
  let r0 = await ps.runTick({ userName: 'Lucas' });
  ok('open tick with NO play_site_url → honest reset, no browser call', ps.get() === 'none' && calls.open === 0, r0.note);
  D.setMeta('play_site_url', 'https://crushon.ai');
  ps.reset(); ps.start();
  ok('starts at open', ps.get() === 'open');

  let r = await ps.runTick({ userName: 'Lucas' });
  ok('open tick → inventory, browser opened', ps.get() === 'inventory' && calls.open === 1, r.note);

  r = await ps.runTick({ userName: 'Lucas' });
  ok('inventory tick → choose, page read', ps.get() === 'choose' && calls.read === 1, r.note);
  const inv = JSON.parse(D.getMeta('play_inventory') || '[]');
  ok('inventory stored 2 characters (Home dropped)', inv.length === 2, inv.map(o => o.label).join(' | '));

  r = await ps.runTick({ userName: 'Lucas' });
  ok('choose tick → startchat, clicked L1', ps.get() === 'startchat' && calls.click === 'L1', r.note);
  ok('character recorded', /Mizuki/.test(ps.character()), ps.character());

  r = await ps.runTick({ userName: 'Lucas' });
  ok('startchat tick → chat, clicked Start Chat', ps.get() === 'chat' && calls.click === 'B0', r.note);

  r = await ps.runTick({ userName: 'Lucas' });
  ok('chat tick sent her line', calls.chatSend && /rough day/i.test(calls.chatSend.line), calls.chatSend && calls.chatSend.line);
  ok('stays in chat for next turn', ps.get() === 'chat');
  ok('bot reply stored for continuity', /mini-boss thing/i.test(D.getMeta('play_last_reply') || ''));

  // --- 3-strike reset: open keeps failing ---
  console.log('\n3-strike reset (open keeps failing):');
  web.open = async () => ({ ok: false, reason: 'boom' });
  ps.reset(); ps.start();
  await ps.runTick({ userName: 'Lucas' });  // strike 1
  ok('still open after strike 1', ps.get() === 'open');
  await ps.runTick({ userName: 'Lucas' });  // strike 2
  ok('still open after strike 2', ps.get() === 'open');
  const r3 = await ps.runTick({ userName: 'Lucas' });  // strike 3 → reset
  ok('session reset after 3 strikes', ps.get() === 'none', r3.note);

  console.log(`\n${fail === 0 ? 'ALL RUNTICK TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
