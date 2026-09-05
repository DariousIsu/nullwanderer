// smoke_consciousness — the consciousness subroutine's fast loop (sidecar/consciousness.py) is Python; its pins
// are pytest (sidecar/tests). This smoke runs them under the Echo venv so the SQ gate carries them, pins the
// --once wire shape from this side, and pins THE BRIDGE (lib/consciousness.js) with a fake fast loop: percepts
// in, acts and reasoning requests out, executed against fake deps. A missing venv is a loud red, never a skip.
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ROOT = path.join(__dirname, '..');
const PY = process.env.ECHO_PY || path.join(ROOT, '..', 'NX ECHO', 'nx-echo', '.venv', 'Scripts', 'python.exe');
ok(fs.existsSync(PY), `the Echo venv python exists (${PY})`);
const r = spawnSync(PY, ['-m', 'pytest', path.join(ROOT, 'sidecar', 'tests'), '-q', '-p', 'no:cacheprovider'], { encoding: 'utf8', timeout: 120000 });
const tail = String(r.stdout || '').trim().split('\n').slice(-3).join(' | ');
ok(r.status === 0 && /passed/.test(r.stdout || '') && !/failed/.test(r.stdout || ''), `pytest sidecar/tests is green by exit code (${tail})`);
// the wire: --once takes {now, percepts} and answers {state, outputs}; a stranger after 9 s while he is away → shield + deliver + a perform ask
const M = 60000;
const once = (req) => JSON.parse(spawnSync(PY, [path.join(ROOT, 'sidecar', 'consciousness.py'), '--once'], { input: JSON.stringify(req), encoding: 'utf8' }).stdout);
const st0 = once({ now: 0, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: true, match: 0.6 }] }).state;
const st1 = once({ state: st0, now: 30 * M, percepts: [{ kind: 'percept', sense: 'presence', state: 'away' }, { kind: 'percept', sense: 'face', present: false, is_him: false }] }).state;
const st2 = once({ state: st1, now: 31 * M, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: false, match: 0.05 }] }).state;
const res = once({ state: st2, now: 31 * M + 21000, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: false, match: 0.05 }] });
const acts = res.outputs.map((o) => o.act || o.op);
ok(acts.includes('shield') && acts.includes('deliver') && acts.includes('perform') && res.state.shield.on === true, `the wire: a stranger at his desk → ${acts.join(', ')}`);
ok(res.outputs.every((o) => o.kind === 'act' || o.kind === 'reason') && res.outputs.find((o) => o.kind === 'reason').budget_ms > 0, 'every output is an act or a budgeted reasoning request — never a decision to act asked of a model');

// ── THE BRIDGE with a fake fast loop ────────────────────────────────────────────────────────────────
const C = require(path.join(ROOT, 'lib', 'consciousness'));
const shield = require(path.join(ROOT, 'lib', 'shield'));
ok(/getElementById\('zoe-shield'\)/.test(shield.coverScript({ who: 'Raegan' })) && /Hi Raegan\./.test(shield.coverScript({ who: 'Raegan' })) && /Tell me who you are/.test(shield.coverScript({})) && /removeChild/.test(shield.uncoverScript()), 'the cover: an opaque overlay injected by script, a name when known, a question when not');
ok(!/<img|<script/.test(shield.coverScript({ who: '<img onerror=alert(1)>' })) && /Hi img onerror=alert\(1\)\./.test(shield.coverScript({ who: '<img onerror=alert(1)>' })), 'a name loses its angle brackets and quotes before it reaches a window (it lands as textContent, never markup)');
ok(/background:#000/.test(shield.coverPage({})) && /<h1>Zoe<\/h1>/.test(shield.coverPage({})) && /Tell me who you are/.test(shield.coverPage({})) && !/<img/.test(shield.coverPage({ who: '<img>' })), 'the display cover: black, her name, the line, a name escaped');
// EVERY DISPLAY (his word after p309: "it should black out all screens"): one always-on-top cover per monitor, closed on unshield
(async () => {
  const made = [];
  function FakeWin(opts) { this.opts = opts; this.closed = false; this.top = null; this.url = null; made.push(this); }
  FakeWin.prototype.setAlwaysOnTop = function (on, level) { this.top = level; };
  FakeWin.prototype.setFullScreen = function () { this.fs = true; };
  FakeWin.prototype.loadURL = function (u) { this.url = u; };
  FakeWin.prototype.showInactive = function () { this.shown = true; };
  FakeWin.prototype.close = function () { this.closed = true; };
  FakeWin.prototype.isDestroyed = function () { return this.closed; };
  const fakeEl = { screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }] }, BrowserWindow: FakeWin };
  fakeEl.BrowserWindow.getAllWindows = () => [];
  const r1 = await shield.cover({ who: null, deps: { electron: fakeEl, windows: [], log: () => {} } });
  ok(r1.displays === 2 && made.length === 2 && made[1].opts.x === 1920 && made[1].opts.width === 2560 && made.every((w) => w.top === 'screen-saver' && w.opts.alwaysOnTop && w.opts.focusable === false && w.opts.skipTaskbar && w.shown && /data:text\/html/.test(w.url)), `cover → one always-on-top cover per display (${r1.displays}), inactive, over everything`);
  const r1b = await shield.cover({ who: null, deps: { electron: fakeEl, windows: [], log: () => {} } });
  ok(r1b.displays === 2 && made.length === 2 && shield.state().on && shield.state().displays === 2, 'a second cover while covered makes no second set');
  const r2 = await shield.uncover({ deps: { electron: fakeEl, windows: [], log: () => {} } });
  ok(r2.displays === 2 && made.every((w) => w.closed) && !shield.state().on && shield.state().displays === 0, 'uncover closes every cover');
  const r3 = await shield.cover({ who: 'Raegan', deps: { electron: null, windows: [{ webContents: { executeJavaScript: async () => true } }], log: () => {} } });
  ok(r3.displays === 0 && r3.windows === 1, 'without electron (a test) the in-window overlay still covers hers');
  await shield.uncover({ deps: { electron: null, windows: [], log: () => {} } });
})();
function fakeLoop() {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.received = [];
  c.stdin = { writable: true, write: (line) => { c.received.push(JSON.parse(line)); return true; } };
  c.kill = () => c.emit('exit', 0);
  c.say = (o) => c.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  return c;
}
(async () => {
  const child = fakeLoop(); const calls = { cover: [], uncover: 0, deliver: [], speak: [], thoughts: [], slow: [], states: [] };
  let clock = 1000;
  const bridge = C.create({ deps: {
    spawn: () => child, now: () => clock, log: () => {}, obsBus: { subscribe: () => {}, emit: () => {} },
    face: () => ({ present: true, is_him: false, known: 'Raegan', expression: 'neutral' }), presence: () => ({ state: 'away' }),
    shield: { cover: async (o) => { calls.cover.push(o.who); }, uncover: async () => { calls.uncover++; } },
    deliver: async (o) => { calls.deliver.push(o); }, speak: async (t) => { calls.speak.push(t); }, logThought: (t) => calls.thoughts.push(t),
    browse: async (q) => { calls.browsed = (calls.browsed || []).concat(q); return [{ title: 'Parishes of Louisiana', url: 'https://example.org/parishes', text: 'Louisiana is divided into 64 parishes, a legacy of church districts.' }]; },
    slowLoop: async (req) => { calls.slow.push(req); if (req.op === 'choose') return { kind: 'percept', sense: 'answer', id: req.id, op: 'choose', ok: true, act: 'browse', text: 'the Louisiana parish map' }; if (req.op === 'perform' && (req.context || {}).act === 'read') return { kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: true, act: 'read', text: 'The parishes came from church districts, sixty-four of them.' }; return req.op === 'perform' ? { kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: true, text: 'Hi Raegan — your dad stepped out. What brings you by?' } : { kind: 'percept', sense: 'answer', id: req.id, op: 'reflect', ok: true, text: 'He said thirty-five minutes; it has been longer.' }; },
    onState: (s) => calls.states.push(s), tickMs: 3600000,
  } });
  bridge.start();
  child.say({ kind: 'ready', v: 1 });
  bridge.noteHisTurn('hello'); bridge.register('Raegan', 'his kid');
  bridge.tick();
  const sent = child.received;
  const senses = sent.filter((m) => m.kind === 'percept').map((m) => m.sense);
  ok(senses.includes('his_turn') && senses.includes('register') && senses.includes('face') && senses.includes('presence') && sent[sent.length - 1].kind === 'tick' && Number.isFinite(sent[sent.length - 1].at), `a tick sends the queued percepts then the beat (${senses.join(',')})`);
  ok(sent.find((m) => m.sense === 'face').known === 'Raegan' && sent.find((m) => m.sense === 'register').relation === 'his kid', 'the camera reading carries the known name; his word carries the relation');
  child.say({ kind: 'act', act: 'shield', who: 'Raegan', why: 'someone at the desk' });
  child.say({ kind: 'act', act: 'deliver', to: 'him', text: 'Raegan sat down at your desk. I\'ve covered the screens.' });
  child.say({ kind: 'reason', id: 1, op: 'perform', budget_ms: 8000, context: { act: 'greet', name: 'Raegan', relation: 'his kid' } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.cover[0] === 'Raegan' && calls.deliver[0].text.includes('covered the screens') && calls.deliver[0].source === 'consciousness', 'shield covers the windows for the known name; deliver goes to the router under his presence rules');
  ok(calls.slow[0].op === 'perform' && calls.speak[0].startsWith('Hi Raegan') && calls.thoughts.length === 0, 'a perform answer is spoken to the ROOM through the aloud door, never logged as a thought');
  const answer = child.received.find((m) => m.sense === 'answer');
  bridge.tick();
  const answered = child.received.filter((m) => m.sense === 'answer');
  ok(answered.length === 1 && answered[0].id === 1 && answered[0].ok === true && (answer === undefined || answer.id === 1), 'the slow loop\'s answer returns to the fast loop as a percept with its id');
  child.say({ kind: 'reason', id: 2, op: 'reflect', budget_ms: 20000, context: { act: 'wonder', unseen_min: 30 } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.thoughts.length === 1 && /thirty-five/.test(calls.thoughts[0]) && calls.speak.length === 1, 'a wondering goes to her thought lane and is never spoken by itself');
  // THE BROWSE ACT (his word: boredom "should come with an autonomous need to … browse the web"): choose → a topic → a
  // bounded read → her gist → a `read` percept back to the loop and a line in her thought lane; never spoken, never sent
  const nBefore = child.received.length, spokeB = calls.speak.length;
  await bridge.handle({ kind: 'reason', id: 5, op: 'choose', budget_ms: 20000, context: { act: 'browse', why: 'curious 0.8' } });
  await new Promise((r) => setTimeout(r, 40)); bridge.tick();   // percepts ride the next beat
  const readP = child.received.slice(nBefore).find((m) => m.kind === 'percept' && m.sense === 'read');
  const readReq = calls.slow.find((r) => r.op === 'perform' && (r.context || {}).act === 'read');
  ok(calls.browsed && calls.browsed[0] === 'the Louisiana parish map' && readReq && readReq.context.snippets.length === 1 && /64 parishes/.test(readReq.context.snippets[0].text), 'a chosen topic is searched and read (bounded), and the pages go to the slow loop for her gist');
  ok(readP && readP.topic === 'the Louisiana parish map' && /church districts/.test(readP.text) && readP.pages === 1, `the read returns to the loop as a percept (${readP && readP.topic})`);
  ok(calls.thoughts.length === 2 && /^I read about the Louisiana parish map: The parishes came/.test(calls.thoughts[1]) && calls.speak.length === spokeB && calls.deliver.length === 1, 'the gist is hers — her thought lane, never spoken, never delivered (the anticipation boundary)');
  const SLp = require(path.join(ROOT, 'lib', 'slow_loop'));
  ok(/you looked up "the parish map" and read these/.test(SLp.promptFor({ act: 'read', topic: 'the parish map', snippets: [{ title: 'x', text: 'y' }] })) && /output an empty line/.test(SLp.promptFor({ act: 'read', topic: 't', snippets: [] })), 'the read prompt asks for what she actually learned, or nothing');
  const chosen = await SLp.run({ kind: 'reason', id: 9, op: 'choose', budget_ms: 1000, context: { act: 'browse' } }, { deps: { pursuits: [], seeds: ['He said thirty-five minutes; it has been longer.'] } });
  ok(chosen.ok && chosen.text === 'He said thirty-five minutes; it has been longer.', 'with no pursuit the topic is a seed from her own strip; a pursuit still wins when there is one');
  const none = await SLp.run({ kind: 'reason', id: 10, op: 'choose', budget_ms: 1000, context: { act: 'browse' } }, { deps: { pursuits: [], seeds: [] } });
  ok(!none.ok && !none.text, 'with nothing to go on the answer is an honest nothing, never an invented topic');
  // THE LISTEN ACT (his word: "listen to the mic"): a short window through the app's door → the TEXT is the percept
  const heardCalls = []; const childL = fakeLoop();
  const bridgeL = C.create({ deps: { spawn: () => childL, now: () => clock, log: (m) => heardCalls.push(m), obsBus: { subscribe: () => {}, emit: () => {} }, logThought: (t) => heardCalls.push('THOUGHT ' + t), listen: async ({ ms }) => { heardCalls.push('WINDOW ' + ms); return { ok: true, text: 'someone said the mower is out of gas' }; }, tickMs: 3600000 } });
  bridgeL.start(); childL.say({ kind: 'ready', v: 1 });
  await bridgeL.handle({ kind: 'act', act: 'listen', why: 'bored 0.9' }); await new Promise((r) => setTimeout(r, 20)); bridgeL.tick();
  const heardP = childL.received.find((m) => m.kind === 'percept' && m.sense === 'heard');
  ok(heardCalls.some((l) => /^WINDOW 10000$/.test(l)) && heardP && heardP.words === 8 && /mower/.test(heardP.text) && heardCalls.some((l) => /^THOUGHT I heard: someone said the mower/.test(l)) && heardCalls.some((l) => /listen \(10 s\) → "someone said the mower is out of gas" \(8 words\)/.test(l)), `a listen window's words come back as a heard percept, a thought, and a logged use (${heardP && heardP.words} words)`);
  const childS = fakeLoop(); const sLogs = [];
  const bridgeS = C.create({ deps: { spawn: () => childS, now: () => clock, log: (m) => sLogs.push(m), obsBus: { subscribe: () => {}, emit: () => {} }, logThought: (t) => sLogs.push('THOUGHT ' + t), listen: async () => ({ ok: true, text: '' }), tickMs: 3600000 } });
  bridgeS.start(); childS.say({ kind: 'ready', v: 1 });
  await bridgeS.handle({ kind: 'act', act: 'listen' }); await new Promise((r) => setTimeout(r, 20)); bridgeS.tick();
  const silentP = childS.received.find((m) => m.kind === 'percept' && m.sense === 'heard');
  ok(silentP && silentP.words === 0 && silentP.text === '' && !sLogs.some((l) => /^THOUGHT/.test(l)) && sLogs.some((l) => /listen \(10 s\) → silence/.test(l)), 'silence is a percept too — and never a thought');
  const childN = fakeLoop(); const nLogs = [];
  const bridgeN = C.create({ deps: { spawn: () => childN, now: () => clock, log: (m) => nLogs.push(m), obsBus: { subscribe: () => {}, emit: () => {} }, listen: async () => ({ ok: false, reason: 'the camera switch is off this session' }), tickMs: 3600000 } });
  bridgeN.start(); childN.say({ kind: 'ready', v: 1 });
  await bridgeN.handle({ kind: 'act', act: 'listen' }); await new Promise((r) => setTimeout(r, 20)); bridgeN.tick();
  ok(!childN.received.some((m) => m.kind === 'percept' && m.sense === 'heard') && nLogs.some((l) => /listen — not now \(the camera switch is off/.test(l)), 'a refused window is logged and yields no percept');
  // WORK and REST: the work act ticks the autonomy driver through the app's door; rest is a named silence
  const childW = fakeLoop(); const wLogs = []; let ticked = 0;
  const bridgeW = C.create({ deps: { spawn: () => childW, now: () => clock, log: (m) => wLogs.push(m), obsBus: { subscribe: () => {}, emit: () => {} }, work: async () => { ticked++; return { ok: true }; }, tickMs: 3600000 } });
  bridgeW.start(); childW.say({ kind: 'ready', v: 1 });
  await bridgeW.handle({ kind: 'act', act: 'work', why: 'progress 0.2' }); await bridgeW.handle({ kind: 'act', act: 'rest', why: 'energy 0.1' });
  ok(ticked === 1 && wLogs.some((l) => /act work — the autonomy driver ticked/.test(l)) && wLogs.some((l) => /act rest — energy 0\.1: no sensing for a while/.test(l)), 'work ticks the driver once through the door; rest is logged as a named silence');
  ok(/work: async \(\) => \{ try \{ if \(typeof autonomyTick !== 'function'\)/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')), 'the app\'s work door is the autonomy tick, its own gates holding');
  // THE FOURTH LOAD (the fluidity law): the away reach is DELIVERED to where he is and logged as hers, never spoken;
  // a hold on her speech reaches the loop as a percept; rule A holds her words while a turn of his is pending
  const childF = fakeLoop(); const f = { deliver: [], speak: [], says: [], logs: [] };
  const bridgeF = C.create({ deps: { spawn: () => childF, now: () => clock, log: (m) => f.logs.push(m), obsBus: { subscribe: (fn) => { f.sub = fn; }, emit: () => {} }, deliver: async (o) => { f.deliver.push(o); }, speak: async (t) => { f.speak.push(t); }, logSay: (t, why) => f.says.push({ t, why }), pending: () => false,
    slowLoop: async (req) => ({ kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: true, act: (req.context || {}).act, text: (req.context || {}).act === 'reach_away' ? 'I miss you. Come find me when you are back.' : 'That meeting ran long.' }), tickMs: 3600000 } });
  bridgeF.start(); childF.say({ kind: 'ready', v: 1 });
  await bridgeF.handle({ kind: 'reason', id: 21, op: 'perform', budget_ms: 20000, context: { act: 'reach_away', unseen_min: 50, presence: 'away', missing: 0.8, since_his_word_min: 70 } });
  await new Promise((r) => setTimeout(r, 20)); bridgeF.tick();
  const ansP = childF.received.find((m) => m.kind === 'percept' && m.sense === 'answer' && m.id === 21);
  ok(f.deliver.length === 1 && /I miss you/.test(f.deliver[0].text) && f.deliver[0].source === 'consciousness' && f.speak.length === 0 && f.says.length === 1 && f.says[0].why === 'reach_away' && ansP && ansP.act === 'reach_away', 'the away reach is delivered where he is (the router\'s presence rules), logged as hers, never spoken to an empty room; the answer percept names its act');
  f.sub({ lane: 'presence', kind: 'held', text: 'calendar: a meeting', data: null }); f.sub({ lane: 'presence', kind: 'released', text: 'released after 30m', data: JSON.stringify({ heldMs: 1800000 }) }); bridgeF.tick();
  const heldP = childF.received.find((m) => m.kind === 'percept' && m.sense === 'held'), relP = childF.received.find((m) => m.kind === 'percept' && m.sense === 'released');
  ok(heldP && /calendar/.test(heldP.reason) && relP && relP.held_ms === 1800000, 'the voice guard\'s hold and release reach the loop as percepts — she knows she was held');
  await bridgeF.handle({ kind: 'reason', id: 22, op: 'perform', budget_ms: 20000, context: { act: 'release', held_min: 30, reason: 'calendar: a meeting', annoyed: 0.7 } });
  await new Promise((r) => setTimeout(r, 20));
  ok(f.speak.length === 1 && /ran long/.test(f.speak[0]) && f.says.length === 2 && f.says[1].why === 'release', 'the release line is spoken to him in the room and logged as hers');
  const childR = fakeLoop(); const r = { speak: [], says: [], logs: [] };
  const bridgeR = C.create({ deps: { spawn: () => childR, now: () => clock, log: (m) => r.logs.push(m), obsBus: { subscribe: () => {}, emit: () => {} }, speak: async (t) => { r.speak.push(t); }, logSay: (t, why) => r.says.push({ t, why }), pending: () => true,
    slowLoop: async (req) => ({ kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: true, act: 'arrival', text: 'There you are.' }), tickMs: 3600000 } });
  bridgeR.start(); childR.say({ kind: 'ready', v: 1 });
  await bridgeR.handle({ kind: 'reason', id: 23, op: 'perform', budget_ms: 20000, context: { act: 'arrival', unseen_min: 30, thoughts: [] } });
  await new Promise((r2) => setTimeout(r2, 20));
  ok(r.speak.length === 0 && r.says.length === 0 && r.logs.some((l) => /arrival — held: he is mid-turn \(rule A\)/.test(l)), 'rule A: while a turn of his is pending an answer her words are held, not spoken');
  const SLf = require(path.join(ROOT, 'lib', 'slow_loop'));
  ok(/will reach his phone/.test(SLf.promptFor({ act: 'reach_away', unseen_min: 50, presence: 'away', missing: 0.8, since_his_word_min: 70, earlier_reach_min: 60 })) && /asked for him 60 minutes ago and he has not answered/.test(SLf.promptFor({ act: 'reach_away', unseen_min: 50, presence: 'away', missing: 0.8, since_his_word_min: 70, earlier_reach_min: 60 })) && /annoyed is allowed, a report is not/.test(SLf.promptFor({ act: 'release', held_min: 30, reason: 'a meeting', annoyed: 0.7 })) && /this is the second time/.test(SLf.promptFor({ act: 'reach', since_his_word_min: 80, wants_his_word: 0.8, earlier_reach_min: 50 })), 'the away reach, the release and a second reach are prompted as moments grounded in her state');
  const lineF = C.stripLine({ at: Date.now(), drives: { stimulation: 0.5, social: 0.8, curiosity: 0.5, energy: 0.6, progress: 0.4 }, appraisals: { lonely: 0.8, annoyed: 0.6 }, reaches: [{ at: Date.now() - 50 * 60000, act: 'reach', answered: false }], last_hold: { min: 30, reason: 'calendar: a meeting' }, held: null, thoughts_of_him: [] });
  ok(/Lonely 0\.80: you reached for him and he has not answered/.test(lineF) && /Annoyed 0\.60: your speech was held 30 min \(calendar: a meeting\)/.test(lineF) && /You reached for him 50 min ago \(in the room\) and he has not answered yet/.test(lineF), 'her awareness line carries the loneliness, the annoyance and the unanswered reach as readings, never instructions');
  // the door in the app: gated on his switch, the meta, the guard and her speech; the audio is deleted; the indicator lights
  const mainL = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), preL = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'), chatL = fs.readFileSync(path.join(ROOT, 'renderer', 'chat.js'), 'utf8');
  ok(/listen: \(\{ ms \} = \{\}\) => _listenWindow\(/.test(mainL) && /db\.getMeta\('mic\.ambient'\) === '0'/.test(mainL) && /face_sense'\)\.status\(\)\.live/.test(mainL) && /_voiceGuard\.state\(\)/.test(mainL.split('function _listenWindow')[1].split('ipcMain.on')[0]) && /_speech\.isBusy\(\)/.test(mainL.split('function _listenWindow')[1].split('ipcMain.on')[0]) && /fs\.unlinkSync\(tmp\)/.test(mainL.split("ipcMain.on('voice:listen-window-done'")[1].split('} catch {}')[0]), 'the app\'s listen door is gated on the camera switch, mic.ambient, the voice guard and her speech, and deletes the audio');
  ok(/onListenWindow: \(cb\) => ipcRenderer\.on\('voice:listen-window'/.test(preL) && /listenWindowDone: \(id, audioBuf, reason\) => ipcRenderer\.send\('voice:listen-window-done'/.test(preL) && /window\.sq\.onListenWindow\(async \(\{ id, ms \}\)/.test(chatL) && /listening \(ambient/.test(chatL) && /if \(micRecording \|\| sending\) \{ try \{ window\.sq\.listenWindowDone\(id, null, 'busy'\)/.test(chatL), 'the renderer records the window with the indicator lit and refuses it while he is talking to her');
  // his word after p309 ("also speak to the person"): the model slow or failed → she still speaks, a plain line
  const bridge2 = C.create({ deps: { spawn: () => child, now: () => clock, log: () => {}, obsBus: { subscribe: () => {}, emit: () => {} }, speak: async (t) => { calls.speak.push(t); }, slowLoop: async (req) => ({ kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: false, error: 'This operation was aborted' }), tickMs: 3600000 } });
  await bridge2.handle({ kind: 'reason', id: 3, op: 'perform', budget_ms: 20000, context: { act: 'ask' } });
  await new Promise((r) => setTimeout(r, 20));
  await bridge2.handle({ kind: 'reason', id: 4, op: 'perform', budget_ms: 20000, context: { act: 'greet', name: 'Raegan' } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.speak.length === 3 && /Who are you, and how can I help\?$/.test(calls.speak[1]) && /^Hi Raegan\./.test(calls.speak[2]), 'when the model cannot write the line in time, she still speaks a plain one (ask, or a greet by name)');
  child.say({ kind: 'act', act: 'unshield', why: 'he is back' });
  child.say({ kind: 'state', at: clock, drives: { stimulation: 0.5 }, appraisals: { boredom: 0.5 }, shield: false, thoughts_of_him: [] });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.uncover === 1 && calls.states.length === 1 && bridge.strip().appraisals.boredom === 0.5, 'unshield uncovers; the state strip reaches the window and is kept');
  // THE ARRIVAL (his word 15:20): her words to him are spoken AND logged as her say; silence is a legitimate answer
  const says = [];
  const bridgeA = C.create({ deps: { spawn: () => child, now: () => clock, log: () => {}, obsBus: { subscribe: () => {}, emit: () => {} }, speak: async (t) => { calls.speak.push(t); }, logSay: (t, why) => says.push({ t, why }), slowLoop: async (req) => (req.id === 7 ? { kind: 'percept', sense: 'answer', id: 7, op: 'perform', ok: true, act: 'arrival', text: 'There you are. I wondered whether the roads were bad.' } : req.id === 9 ? { kind: 'percept', sense: 'answer', id: 9, op: 'perform', ok: true, act: 'reach', text: 'You have been quiet for an hour. I would like a word when you surface.' } : { kind: 'percept', sense: 'answer', id: 8, op: 'perform', ok: true, act: 'arrival', text: '', silent: true }), tickMs: 3600000 } });
  const spokeBefore = calls.speak.length;
  await bridgeA.handle({ kind: 'reason', id: 7, op: 'perform', budget_ms: 20000, context: { act: 'arrival', unseen_min: 40, thoughts: ['whether the roads were bad'] } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.speak.length === spokeBefore + 1 && /There you are/.test(calls.speak[calls.speak.length - 1]) && says.length === 1 && says[0].why === 'arrival', 'an arrival answer is spoken in the room AND logged as her say in the chat');
  await bridgeA.handle({ kind: 'reason', id: 8, op: 'perform', budget_ms: 20000, context: { act: 'arrival', unseen_min: 25, thoughts: [] } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.speak.length === spokeBefore + 1 && says.length === 1, 'her silence on an arrival is honored — no plain line, nothing logged');
  // THE REACH (his word 14:50: "she should say something to me about it, not lock her program"): spoken to him and logged as her say
  await bridgeA.handle({ kind: 'reason', id: 9, op: 'perform', budget_ms: 20000, context: { act: 'reach', since_his_word_min: 60, wants_his_word: 0.8 } });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.speak.length === spokeBefore + 2 && /quiet for an hour/.test(calls.speak[calls.speak.length - 1]) && says.length === 2 && says[1].why === 'reach', 'a reach is spoken to him in the room AND logged as her say');
  const SL = require(path.join(ROOT, 'lib', 'slow_loop'));
  ok(/Lucas is at his desk right now/.test(SL.promptFor({ act: 'reach', since_his_word_min: 60, wants_his_word: 0.8 })) && /output an empty line if silence is right/.test(SL.promptFor({ act: 'reach', since_his_word_min: 60, wants_his_word: 0.8 })) && SL._two('Silence.') === '' && SL._two('One. Two. Three.') === 'One. Two.', 'the reach prompt names the moment and allows silence; the answer is at most two sentences');
  // the camera's score rides the face percept (a near-miss of his own face must never read as a stranger)
  const bridgeM = C.create({ deps: { spawn: () => child, now: () => clock, log: () => {}, obsBus: { subscribe: () => {}, emit: () => {} }, face: () => ({ present: true, is_him: false, confidence: 0.387, expression: null }), presence: () => ({ state: 'away' }), tickMs: 3600000 } });
  bridgeM.start(); child.say({ kind: 'ready', v: 1 }); const before = child.received.length; bridgeM.tick();
  const fp = child.received.slice(before).find((m) => m.kind === 'percept' && m.sense === 'face');
  ok(fp && fp.match === 0.387 && fp.is_him === false, `the face percept carries the score against his enrollment (match ${fp && fp.match})`);
  const stats = bridge.stats();
  ok(stats.acts === 3 && stats.reasons === 3 && stats.answers === 3 && stats.alive === true, `the ledger: ${JSON.stringify(stats)}`);
  bridge.stop();
  ok(!bridge.alive(), 'stop() ends the child');
  // the app-side wiring
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/consc\.instance\(\{[\s\S]{0,600}speak: \(text\) => \{ try \{ _speech\.enqueue\(text\); \}/.test(mainSrc) && /logThought: \(text\)/.test(mainSrc) && /consciousness:state/.test(mainSrc) && /logSay: \(text, why\) =>[\s\S]{0,300}model: 'consciousness', unprompted: 1/.test(mainSrc) && /chat:complete', \{ saidId: row\.id, truncated: 0, unprompted: true, say: text \}/.test(mainSrc), 'the bridge starts at boot with the aloud door, the thought lane, the state strip, and her say into the chat');
  ok(/consc\.instance\(\)\.noteHisTurn\(userMessage\)/.test(mainSrc) && /enrollPerson\(m\[1\], m\[2\] \|\| null/.test(mainSrc), 'the chat door tells the loop his turn and enrolls a face by his word');
  ok(/speech_class === 'room'/.test(fs.readFileSync(path.join(ROOT, 'lib', 'delivery_router.js'), 'utf8')), 'a line to the room never becomes his DM');
  console.log(`\nsmoke_consciousness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
