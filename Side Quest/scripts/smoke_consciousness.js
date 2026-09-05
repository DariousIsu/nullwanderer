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
const st0 = once({ now: 0, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: true }] }).state;
const st1 = once({ state: st0, now: 30 * M, percepts: [{ kind: 'percept', sense: 'presence', state: 'away' }, { kind: 'percept', sense: 'face', present: true, is_him: false }] }).state;
const res = once({ state: st1, now: 30 * M + 9000, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: false }] });
const acts = res.outputs.map((o) => o.act || o.op);
ok(acts.includes('shield') && acts.includes('deliver') && acts.includes('perform') && res.state.shield.on === true, `the wire: a stranger at his desk → ${acts.join(', ')}`);
ok(res.outputs.every((o) => o.kind === 'act' || o.kind === 'reason') && res.outputs.find((o) => o.kind === 'reason').budget_ms > 0, 'every output is an act or a budgeted reasoning request — never a decision to act asked of a model');

// ── THE BRIDGE with a fake fast loop ────────────────────────────────────────────────────────────────
const C = require(path.join(ROOT, 'lib', 'consciousness'));
const shield = require(path.join(ROOT, 'lib', 'shield'));
ok(/getElementById\('zoe-shield'\)/.test(shield.coverScript({ who: 'Raegan' })) && /Hi Raegan\./.test(shield.coverScript({ who: 'Raegan' })) && /Tell me who you are/.test(shield.coverScript({})) && /removeChild/.test(shield.uncoverScript()), 'the cover: an opaque overlay injected by script, a name when known, a question when not');
ok(!/<img|<script/.test(shield.coverScript({ who: '<img onerror=alert(1)>' })) && /Hi img onerror=alert\(1\)\./.test(shield.coverScript({ who: '<img onerror=alert(1)>' })), 'a name loses its angle brackets and quotes before it reaches a window (it lands as textContent, never markup)');
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
    slowLoop: async (req) => { calls.slow.push(req); return req.op === 'perform' ? { kind: 'percept', sense: 'answer', id: req.id, op: 'perform', ok: true, text: 'Hi Raegan — your dad stepped out. What brings you by?' } : { kind: 'percept', sense: 'answer', id: req.id, op: 'reflect', ok: true, text: 'He said thirty-five minutes; it has been longer.' }; },
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
  child.say({ kind: 'act', act: 'unshield', why: 'he is back' });
  child.say({ kind: 'state', at: clock, drives: { stimulation: 0.5 }, appraisals: { boredom: 0.5 }, shield: false, thoughts_of_him: [] });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.uncover === 1 && calls.states.length === 1 && bridge.strip().appraisals.boredom === 0.5, 'unshield uncovers; the state strip reaches the window and is kept');
  const stats = bridge.stats();
  ok(stats.acts === 3 && stats.reasons === 2 && stats.answers === 2 && stats.alive === true, `the ledger: ${JSON.stringify(stats)}`);
  bridge.stop();
  ok(!bridge.alive(), 'stop() ends the child');
  // the app-side wiring
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/consc\.instance\(\{[\s\S]{0,600}speak: \(text\) => \{ try \{ _speech\.enqueue\(text\); \}/.test(mainSrc) && /logThought: \(text\)/.test(mainSrc) && /consciousness:state/.test(mainSrc), 'the bridge starts at boot with the aloud door, the thought lane and the state strip');
  ok(/consc\.instance\(\)\.noteHisTurn\(userMessage\)/.test(mainSrc) && /enrollPerson\(m\[1\], m\[2\] \|\| null/.test(mainSrc), 'the chat door tells the loop his turn and enrolls a face by his word');
  ok(/speech_class === 'room'/.test(fs.readFileSync(path.join(ROOT, 'lib', 'delivery_router.js'), 'utf8')), 'a line to the room never becomes his DM');
  console.log(`\nsmoke_consciousness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
