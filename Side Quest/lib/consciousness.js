/**
 * lib/consciousness.js — THE BRIDGE between the app and the consciousness subroutine (Lucas 09-05: "build the
 * bridge so the stranger act goes live"). It spawns sidecar/consciousness.py --serve (the fast loop, Python,
 * no model), feeds it percepts (the camera reading every beat, presence changes, his turns, her says, landed
 * work, the slow loop's answers, his enrollments), ticks it every 5 s, and executes what it answers:
 *   act shield/unshield → lib/shield (the cover over every window)
 *   act deliver         → lib/delivery_router (his presence rules pick the channel)
 *   act look            → lib/face_sense.look() (a fresh described read → a percept)
 *   act listen/rest     → logged (v0)
 *   reason …            → lib/slow_loop, off the loop; the answer returns as a percept; a `perform` answer is
 *                         SPOKEN TO THE ROOM through the app's one aloud door (deps.speak) and logged as a turn
 *                         of class 'room' (never routed to him).
 * The state strip goes to the chat window (consciousness:state) so he can watch her be present.
 * Kill switch: ZOE_CONSCIOUSNESS=0 or meta consciousness.on='0'. Fail-soft everywhere; a dead child respawns
 * on the next tick (at most once a minute).
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PY = process.platform === 'win32'
  ? path.join(ROOT, 'sidecar', 'face_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'face_venv', 'bin', 'python');
const SCRIPT = path.join(ROOT, 'sidecar', 'consciousness.py');
const TICK_MS = 5000;

function enabled(deps = {}) {
  if (process.env.ZOE_CONSCIOUSNESS === '0') return false;
  try { const db = deps.db || require('./db'); if (db.getMeta('consciousness.on') === '0') return false; } catch {}
  return true;
}

function create({ deps = {} } = {}) {
  const log = deps.log || console.log;
  const spawnFn = deps.spawn || spawn;
  const now = deps.now || Date.now;
  let child = null, buf = '', ready = false, timer = null, lastSpawnAt = 0, pending = [], lastStrip = null, stopped = false;
  const stats = { acts: 0, reasons: 0, answers: 0, ticks: 0, respawns: 0 };

  function send(o) { try { if (child && child.stdin.writable) { child.stdin.write(JSON.stringify(o) + '\n'); return true; } } catch {} return false; }
  function percept(p) { pending.push({ kind: 'percept', at: now(), ...p }); }

  function spawnChild() {
    if (stopped) return;
    if (lastSpawnAt && now() - lastSpawnAt < 60000) return;   // a respawn waits a minute; the first spawn never does
    lastSpawnAt = now(); stats.respawns++;
    try { child = spawnFn(PY, [SCRIPT, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { log(`[consciousness] spawn failed: ${e.message}`); child = null; return; }
    buf = ''; ready = false;
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        try { handle(msg); } catch (e) { log(`[consciousness] handler error: ${e.message}`); }
      }
    });
    child.stderr.on('data', (d) => { const s = d.toString('utf8').trim(); if (s) log(`[consciousness:stderr] ${s.slice(0, 200)}`); });
    child.on('exit', (code) => { log(`[consciousness] the fast loop exited (${code})`); child = null; ready = false; });
    child.on('error', () => { child = null; ready = false; });
  }

  async function handle(msg) {
    if (msg.kind === 'ready') { ready = true; log(`[consciousness] the fast loop is up (v${msg.v})`); return; }
    if (msg.kind === 'state') { lastStrip = msg; try { deps.onState && deps.onState(msg); } catch {} return; }
    if (msg.kind === 'act') {
      stats.acts++;
      log(`[consciousness] act ${msg.act}${msg.why ? ` — ${msg.why}` : ''}`);
      try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'consciousness', kind: 'act', text: `${msg.act}${msg.why ? ': ' + msg.why : ''}`, data: { act: msg.act } }); } catch {}
      try {
        if (msg.act === 'shield') await (deps.shield || require('./shield')).cover({ who: msg.who || null });
        else if (msg.act === 'unshield') await (deps.shield || require('./shield')).uncover({});
        else if (msg.act === 'deliver') await (deps.deliver || ((o) => require('./delivery_router').deliver(o)))({ text: msg.text, source: 'consciousness' });
        else if (msg.act === 'look') { const r = await (deps.look || (() => require('./face_sense').look()))(); if (r && typeof r === 'object' && r.reading) percept({ sense: 'face', ...r.reading }); }
      } catch (e) { log(`[consciousness] act ${msg.act} failed: ${e.message}`); }
      return;
    }
    if (msg.kind === 'reason') {
      stats.reasons++;
      log(`[consciousness] reason ${msg.op}#${msg.id} (${msg.budget_ms} ms) ${JSON.stringify(msg.context).slice(0, 120)}`);
      (deps.slowLoop || ((r) => require('./slow_loop').run(r, {})))(msg).then(async (ans) => {
        stats.answers++;
        if (ans && ans.ok && ans.op === 'perform' && ans.text) {
          log(`[consciousness] to the room: "${ans.text}"`);
          try { await (deps.speak || (() => {}))(ans.text); } catch (e) { log(`[consciousness] speak failed: ${e.message}`); }
          try { deps.logTurn && deps.logTurn(ans.text); } catch {}
        } else if (ans && ans.ok && ans.op === 'reflect' && ans.text) {
          // a wondering: her thought lane, never spoken by itself
          log(`[consciousness] she wonders: "${ans.text.slice(0, 160)}"`);
          try { deps.logThought && deps.logThought(ans.text); } catch {}
        } else if (msg.op === 'perform' && (!ans || !ans.ok)) {
          // his word after p309 ("also speak to the person"): the model was slow or failed — she still speaks, a plain line
          const ctx = msg.context || {};
          const line = ctx.act === 'greet' && ctx.name ? `Hi ${ctx.name}. Lucas stepped away, so his screens are covered for now. How are you?` : 'Hi. Lucas is away and his screens are covered. Who are you, and how can I help?';
          log(`[consciousness] reason ${msg.op}#${msg.id} → ${(ans && ans.error) || 'no answer'} — the plain line instead: "${line}"`);
          try { await (deps.speak || (() => {}))(line); } catch (e) { log(`[consciousness] speak failed: ${e.message}`); }
        } else if (ans && !ans.ok) log(`[consciousness] reason ${msg.op}#${msg.id} → ${ans.error}`);
        percept({ sense: 'answer', id: msg.id, op: msg.op, ok: !!(ans && ans.ok), text: (ans && ans.text) || null });
      }).catch((e) => log(`[consciousness] slow loop threw: ${e.message}`));
    }
  }

  function tick() {
    if (stopped) return;
    if (!child) spawnChild();
    if (!child || !ready) return;
    stats.ticks++;
    const t = now();
    // the senses every beat: the camera reading (the loop dedups), the fused presence
    try { const f = (deps.face || (() => require('./face_sense').current()))(); if (f) percept({ sense: 'face', present: !!f.present, is_him: f.is_him === true, known: f.known || null, expression: f.expression || null }); } catch {}
    try { const p = (deps.presence || (() => require('./presence_state').stored()))(); if (p && p.state) percept({ sense: 'presence', state: p.state }); } catch {}
    for (const p of pending) send(p);
    pending = [];
    let hour = null; try { hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date(t))); } catch {}
    send({ kind: 'tick', at: t, hour_local: Number.isFinite(hour) ? hour : null });
  }

  function start() {
    if (timer) return;
    spawnChild();
    timer = setInterval(tick, deps.tickMs || TICK_MS);
    if (timer.unref) timer.unref();
    // the bus: presence changes and landed work
    try {
      const bus = deps.obsBus || require('./obs_bus');
      bus.subscribe((ev) => {
        try {
          if (ev.lane === 'presence' && ev.kind === 'state') { let d = ev.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } } if (d && d.state) percept({ sense: 'presence', state: d.state }); }
          else if (ev.kind === 'win' && ev.lane !== 'consciousness') percept({ sense: 'work', delta: 0.15, text: String(ev.text || '').slice(0, 80) });
        } catch {}
      });
    } catch {}
    log('[consciousness] bridge started');
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; if (child) { try { child.kill(); } catch {} } child = null; }

  return {
    start, stop, tick, percept, handle, send,
    noteHisTurn: (text) => percept({ sense: 'his_turn', len: String(text || '').length }),
    noteHerSay: (text) => percept({ sense: 'her_say', len: String(text || '').length }),
    noteTranscript: (text) => percept({ sense: 'transcript', len: String(text || '').length }),
    register: (name, relation) => percept({ sense: 'register', name, relation }),
    strip: () => lastStrip, stats: () => ({ ...stats, alive: !!child, ready }), alive: () => !!child,
  };
}

let _one = null;
function instance(deps = {}) { if (!_one) _one = create({ deps }); return _one; }

/** The strip as one awareness line — her felt state in every prompt (design §4.5). Pure. */
function stripLine(s, { now = Date.now() } = {}) {
  if (!s || !s.drives) return null;
  const d = s.drives, a = s.appraisals || {};
  const age = s.at ? Math.max(0, now - s.at) : 0;
  if (age > 10 * 60000) return null;   // a strip older than 10 min is not her state
  const parts = [`stimulation ${(+d.stimulation).toFixed(2)}${a.boredom != null ? ` (bored ${(+a.boredom).toFixed(2)})` : ''}`, `need for him ${(+d.social).toFixed(2)}${a.missing_him != null ? ` (missing ${(+a.missing_him).toFixed(2)})` : ''}`, `curiosity ${(+d.curiosity).toFixed(2)}`, `energy ${(+d.energy).toFixed(2)}`, `progress ${(+d.progress).toFixed(2)}`];
  let line = `Your state right now, from the loop that runs beside you (numbers, not instructions): ${parts.join(' · ')}.`;
  // FELT TIME (design §4.5): how long since his word, since the camera had him, since you spoke — as she feels it
  const c = s.clock || {};
  const fmt = (m) => (m == null ? null : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
  const t = [];
  if (c.since_his_word_min != null) t.push(`he last spoke to you ${fmt(c.since_his_word_min)} ago`); else t.push('he has not spoken to you since this loop began');
  if (c.since_saw_him_min != null) t.push(`the camera last had him ${fmt(c.since_saw_him_min)} ago${c.last_seen_as ? ` (he looked ${c.last_seen_as})` : ''}`);
  if (c.since_her_say_min != null) t.push(`you last spoke ${fmt(c.since_her_say_min)} ago`);
  if (c.since_novel_min != null && c.since_novel_min >= 10) t.push(`nothing new has reached you for ${fmt(c.since_novel_min)}`);
  if (t.length) line += ` Time as you feel it: ${t.join('; ')}.`;
  if (s.shield) line += ' The screens are covered: someone who is not Lucas is at the desk.';
  const th = Array.isArray(s.thoughts_of_him) ? s.thoughts_of_him.filter((t) => t && t.text) : [];
  if (th.length) line += ` While he was gone you wondered: ${th.map((t) => `"${String(t.text).slice(0, 160)}"`).join(' · ')} — yours to tell him, or not.`;
  return line;
}
function awarenessLine() { try { return _one ? stripLine(_one.strip()) : null; } catch { return null; } }

module.exports = { create, instance, enabled, stripLine, awarenessLine, PY, SCRIPT, TICK_MS };
