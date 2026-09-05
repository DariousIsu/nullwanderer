/* smoke_presence_state.js — PRESENCE AS A MEASUREMENT (the wants project, cut 2 piece 1 + W7; 2026-09-05).
 * Pins: the fusion truth table (each input alone; precedence meeting > his word > remote session > camera >
 * idle); his word outranks every sensor; the location net on the design's phrasings; the remote-session
 * reading; channelFor per state; the tick persists on change and emits once; the manifest line never says
 * "here" when he is remote.
 */
'use strict';
const path = require('path');
const LIB = process.env.SQ_MOD_DIR || path.join(__dirname, '..', 'lib');
const PS = require(path.join(LIB, 'presence_state'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const now = 1_000_000_000;

// ── the location net ──────────────────────────────────────────────────────────────────────────────
const L = PS.detectLocationStatement;
ok(L("I'm remoting in from Baton Rouge today").state === 'remote' && L("I'm remoting in from Baton Rouge today").place === 'Baton Rouge today'.replace(' today', '') || L("I'm remoting in from Baton Rouge").place === 'Baton Rouge', `"remoting in from Baton Rouge" → remote + the place (${JSON.stringify(L("I'm remoting in from Baton Rouge"))})`);
ok(L('remote accessing from the office right now').state === 'remote' && /office/.test(L('remote accessing from the office right now').place), '"remote accessing from the office" → remote + office');
ok(L("I'm in Houston, not at my computer").state === 'away' && L("I'm in Houston, not at my computer").place === 'Houston', '"I\'m in Houston, not at my computer" → away + Houston');
ok(L("not at my desk right now, I'm at the airport").state === 'away' && /airport/.test(L("not at my desk right now, I'm at the airport").place), '"not at my desk, I\'m at the airport" → away + airport');
ok(L("back at my desk").state === 'here' && L("ok I'm back at the computer").state === 'here', '"back at my desk" / "I\'m back at the computer" → here');
ok(L("I'm remoting in, keep it short").state === 'remote' && L("I'm remoting in, keep it short").place === null, 'remoting in without a place → remote, place unknown');
ok(L('can you check the remote sensing dataset') === null || L('can you check the remote sensing dataset').state !== 'remote', 'a sentence ABOUT remote things is not his location');
ok(L('what did the legislature do today') === null && L('delete the draft') === null, 'ordinary turns say nothing about where he is');
ok(L("I'm at the office").state === null && L("I'm at the office").place === 'office', '"I\'m at the office" alone → a place fact, no state change');

// ── the remote-session reading ────────────────────────────────────────────────────────────────────
ok(PS.readRemoteSession({ env: { SESSIONNAME: 'RDP-Tcp#3' } }).active === true, 'SESSIONNAME RDP-… → a remote session');
ok(PS.readRemoteSession({ env: { SESSIONNAME: 'Console' } }).active === false, 'Console → not remote');
const q = ' SESSIONNAME  USERNAME  ID  STATE\n services            0  Disc\n>rdp-tcp#2  azrae     2  Active\n console             1  Conn';
ok(PS.readRemoteSession({ env: {}, queryOut: q }).active === true && /rdp-tcp/.test(PS.readRemoteSession({ env: {}, queryOut: q }).name), '`query session` naming an active rdp-tcp → remote');
ok(PS.readRemoteSession({ env: {}, queryOut: '>console azrae 1 Active' }).active === false, 'an active console session → not remote');

// ── the fuse ───────────────────────────────────────────────────────────────────────────────────────
const F = (o) => PS.fuse({ now, ...o });
ok(F({ lastUserTurnTs: now - 60000 }).state === 'here', 'recent activity alone → here');
ok(F({ lastUserTurnTs: now - 2 * 3600e3 }).state === 'away' && F({}).state === 'away', 'long idle (or no turn) → away');
ok(F({ lastUserTurnTs: now - 60000, guard: { paused: true, reason: 'Teams in the foreground' } }).state === 'meeting', 'the guard paused for a meeting → meeting');
ok(F({ lastUserTurnTs: now - 60000, calendarBusy: true }).state === 'meeting', 'calendar busy → meeting');
ok(F({ lastUserTurnTs: now - 60000, remoteSession: { active: true, name: 'RDP-Tcp#1', source: 'SESSIONNAME' } }).state === 'remote', 'an OS remote session with activity → remote (never "here")');
ok(F({ lastUserTurnTs: now - 60000, hisWord: { away: true, awayReason: 'lunch' } }).state === 'away', 'his away word beats activity');
ok(F({ lastUserTurnTs: now - 60000, hisWord: { location: { place: 'Baton Rouge', remote: true } } }).state === 'remote' && /Baton Rouge/.test(F({ lastUserTurnTs: now - 60000, hisWord: { location: { place: 'Baton Rouge', remote: true } } }).reason), 'his stated remote location → remote with the place');
ok(F({ lastUserTurnTs: now - 60000, hisWord: { location: { place: 'Baton Rouge', remote: true } }, face: { present: true, is_him: true, at: now - 1000 } }).state === 'remote', 'his word outranks the camera (a sensor may not contradict a stated place)');
ok(F({ lastUserTurnTs: now - 60000, remoteSession: { active: true, name: 'x', source: 's' }, guard: { paused: true, reason: 'Meet' } }).state === 'meeting', 'meeting outranks remote');
ok(F({ lastUserTurnTs: now - 3 * 3600e3, face: { present: true, is_him: true, at: now - 500 } }).state === 'here', 'the camera (him, fresh) → here despite idle keys');
ok(F({ lastUserTurnTs: now - 3 * 3600e3, face: { present: true, is_him: false, at: now - 500 } }).state === 'away' && /someone else/.test(F({ lastUserTurnTs: now - 3 * 3600e3, face: { present: true, is_him: false, at: now - 500 } }).reason), 'a stranger on camera with idle keys → away, and says who');
const prev = { state: 'here', since: now - 5000, location: { place: 'office' } };
ok(F({ lastUserTurnTs: now - 60000, prev }).since === prev.since && F({ lastUserTurnTs: now - 60000, prev }).location.place === 'office', 'an unchanged state keeps its since; the location fact carries');
ok(PS.channelFor('here') === 'desktop' && PS.channelFor('remote') === 'discord' && PS.channelFor('away') === 'discord' && PS.channelFor('meeting') === 'queue', 'channelFor: desktop when here, Discord when remote/away, a queued note in a meeting');

// ── the organ: tick + his word ─────────────────────────────────────────────────────────────────────
const meta = {}; const db = { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };
const logs = [], events = [];
const deps = (extra = {}) => ({ db, log: (m) => logs.push(m), obsBus: { emit: (e) => events.push(e) }, availability: { isAway: () => false, awayReason: () => null }, remoteSession: () => ({ active: false }), face: () => null, lastUserTurnTs: now - 60000, now, ...extra });
const t1 = PS.tick({ deps: deps() });
ok(t1.state === 'here' && JSON.parse(meta[PS.STATE_KEY]).state === 'here' && events.length === 1 && /state=here/.test(logs[0]), 'the first tick persists + emits + logs');
const t2 = PS.tick({ deps: deps({ now: now + 60000 }) });
ok(t2.state === 'here' && events.length === 1, 'an unchanged tick emits nothing');
const w = PS.recordHisWord("I'm remoting in from Baton Rouge", { turnId: 77, deps: deps({ now: now + 120000 }) });
ok(w && w.state === 'remote' && JSON.parse(meta[PS.LOCATION_KEY]).place === 'Baton Rouge' && JSON.parse(meta[PS.LOCATION_KEY]).turn_id === 77, 'his word writes the location fact with the turn id');
ok(JSON.parse(meta[PS.STATE_KEY]).state === 'remote' && events.length === 2 && events[1].data.state === 'remote', 'and re-fuses at once → remote, one event');
const line = PS.awarenessLine({ deps: deps(), now: now + 130000 });
ok(/REMOTE/.test(line) && /Baton Rouge/.test(line) && /never say "here"/.test(line) && !/is HERE/.test(line), `the manifest line grounds the reply (${line.slice(0, 80)}…)`);
PS.recordHisWord('back at my desk', { turnId: 78, deps: deps({ now: now + 200000 }) });
ok(JSON.parse(meta[PS.STATE_KEY]).state === 'here' && /is HERE/.test(PS.awarenessLine({ deps: deps(), now: now + 201000 })), '"back at my desk" → here again');
ok(PS.recordHisWord('what time is it', { deps: deps() }) === null, 'an ordinary turn writes nothing');
// W7: a Discord DM from him = remote until a desk turn; his stated location by WORD is never cleared by a desk turn
const mk = PS.markRemoteViaDiscord({ deps: deps({ now: now + 300000 }) });
ok(mk.remote === true && mk.source === 'discord dm' && JSON.parse(meta[PS.STATE_KEY]).state === 'remote', 'a Discord DM from him → remote (not at the desk)');
const dk = PS.markDeskTurn({ deps: deps({ now: now + 360000 }) });
ok(dk && dk.remote === false && JSON.parse(meta[PS.STATE_KEY]).state === 'here', 'a desk turn clears the Discord-inferred remote');
PS.recordHisWord("I'm remoting in from Baton Rouge", { turnId: 79, deps: deps({ now: now + 400000 }) });
ok(PS.markDeskTurn({ deps: deps({ now: now + 401000 }) }) === null && JSON.parse(meta[PS.STATE_KEY]).state === 'remote', 'his WORD ("remoting in from…") is not cleared by keystrokes — it holds until he says otherwise');
console.log(`\nsmoke_presence_state: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
