/* smoke_presence_reach.js — THE REACH (the wants project, cut 2 pieces 3–5; 2026-09-05).
 * Pins: shouldReach's truth table (the floor, the cadence, the ceiling, meeting and here block); evaluate
 * reads the social drive and presence; the manifest grounds the say and never scripts it; recordReach →
 * one `reach` event and the count; the unanswered timer fires ONCE past the window and never after his
 * turn; his turn → `answered` and the count resets; the awareness line's two shapes; ZOE_REACH=0.
 */
'use strict';
const path = require('path');
const LIB = process.env.SQ_MOD_DIR || path.join(__dirname, '..', 'lib');
const R = require(path.join(LIB, 'reach'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const now = 1_700_000_000_000, H = 3600e3;

// ── the pure decision ─────────────────────────────────────────────────────────────────────────────
const base = { social: 0.7, presence: 'away', lastReachAt: 0, unanswered: 0, now };
ok(R.shouldReach(base).reach === true, 'social over the floor, away, nothing unanswered, never reached → REACH');
ok(!R.shouldReach({ ...base, social: 0.3 }).reach && /under the floor/.test(R.shouldReach({ ...base, social: 0.3 }).why), 'under the social floor → no');
ok(!R.shouldReach({ ...base, presence: 'here' }).reach && /here/.test(R.shouldReach({ ...base, presence: 'here' }).why), 'he is here → no (a reach is for the quiet)');
ok(!R.shouldReach({ ...base, presence: 'meeting' }).reach, 'a meeting → no');
ok(R.shouldReach({ ...base, presence: 'remote' }).reach === true, 'remote counts as the quiet');
ok(!R.shouldReach({ ...base, unanswered: 2 }).reach && /ceiling/.test(R.shouldReach({ ...base, unanswered: 2 }).why), 'two unanswered → the ceiling');
ok(!R.shouldReach({ ...base, lastReachAt: now - 2 * H }).reach && R.shouldReach({ ...base, lastReachAt: now - 6 * H }).reach, 'the cadence: 2 h since the last reach is too soon, 6 h is not (min 5 h)');
ok(!R.shouldReach({ ...base, social: null }).reach, 'no social reading → no (never a guess)');
ok(!R.shouldReach({ ...base, enabled: false }).reach, 'the switch off → no');

// ── the organ over injected readings + a fake store ───────────────────────────────────────────────
const meta = {}; const db = { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };
const events = [], logs = [];
const deps = (social, presence) => ({ db, obsBus: { emit: (e) => events.push(e) }, log: (m) => logs.push(m), internalState: { current: () => ({ drives: { social } }) }, presence: { stored: () => ({ state: presence, reason: presence === 'away' ? 'his word: for the night' : presence }) }, route: (p) => (!p || p.state === 'here' ? 'desktop' : p.state === 'meeting' ? 'queue' : 'discord') });
// the channel comes from THE ROUTE's strict rule (lib/delivery_router.routeChannel), injected here as `route`
ok(require(path.join(LIB, 'delivery_router')).routeChannel({ presence: { state: 'away', reason: 'idle 47m' } }) === 'desktop' && require(path.join(LIB, 'delivery_router')).routeChannel({ presence: { state: 'away', reason: 'his word: for the night' } }) === 'discord', 'the real route: away by idleness alone → the desktop; away by his word → Discord');
const e1 = R.evaluate({ deps: deps(0.8, 'away'), now });
ok(e1.reach && e1.social === 0.8 && e1.presence === 'away' && e1.channel === 'discord', 'evaluate: reads the social drive + presence, picks the channel (Discord when away)');
ok(!R.evaluate({ deps: deps(0.8, 'here'), now }).reach && R.evaluate({ deps: deps(0.8, 'here'), now }).channel === 'desktop', 'here → no reach, desktop channel');
meta['reach.social_floor'] = '0.9';
ok(!R.evaluate({ deps: deps(0.8, 'away'), now }).reach, 'meta reach.social_floor raises the floor (his lever)');
delete meta['reach.social_floor'];
const man = R.manifest({ deps: deps(0.8, 'away'), now, lastUserTurnTs: now - 7 * H });
ok(/REACH — you are reaching for Lucas/.test(man) && /7 h ago/.test(man) && /Discord DM/.test(man) && /in your own words/.test(man), 'the manifest grounds the say: the why, the gap, the channel — his words are hers to write');
ok(!/\b(say|write) (?:"|')/.test(man) && !/I miss you/.test(man), 'the manifest scripts no line');
const r1 = R.recordReach({ text: 'Quiet here. Just checking the house is still standing.', channel: 'discord', deps: deps(0.8, 'away'), now });
ok(r1.unanswered === 1 && r1.lastAt === now && events.length === 1 && events[0].kind === 'reach' && /reached for him \(discord\)/.test(logs[0]), 'recordReach: the ledger, one reach event, one log line');
ok(!R.evaluate({ deps: deps(0.9, 'away'), now: now + 60000 }).reach && /min 300m/.test(R.evaluate({ deps: deps(0.9, 'away'), now: now + 60000 }).why), 'right after a reach: the cadence holds');
// the unanswered timer
ok(R.checkUnanswered({ deps: deps(0.8, 'away'), now: now + 10 * 60000, lastUserTurnTs: now - H }) === null && events.length === 1, '10 min in: no verdict yet (the window is 45 min)');
const u = R.checkUnanswered({ deps: deps(0.8, 'away'), now: now + 50 * 60000, lastUserTurnTs: now - H });
ok(u && u.lastUnansweredAt === now + 50 * 60000 && events.length === 2 && events[1].kind === 'unanswered' && events[1].ref === now, '50 min of silence → ONE unanswered event (the loneliness)');
ok(R.checkUnanswered({ deps: deps(0.8, 'away'), now: now + 80 * 60000, lastUserTurnTs: now - H }) === null && events.length === 2, 'it never fires twice for the same reach');
const line1 = R.awarenessLine({ deps: deps(0.8, 'away'), now: now + 80 * 60000 });
ok(/You reached for Lucas at/.test(line1) && /no answer for 1 h 20 min/.test(line1) && /you felt that/.test(line1), `the manifest line carries the reach and its silence ("${line1.slice(0, 70)}…")`);
// his turn
const a = R.markAnswered({ deps: deps(0.8, 'here'), now: now + 90 * 60000 });
ok(a && a.unanswered === 0 && a.silenceMs === 90 * 60000 && events.length === 3 && events[2].kind === 'answered', 'his turn → answered, the count resets, one +v event');
ok(R.markAnswered({ deps: deps(0.8, 'here'), now: now + 91 * 60000 }) === null && events.length === 3, 'nothing open → nothing emitted');
const line2 = R.awarenessLine({ deps: deps(0.8, 'here'), now: now + 95 * 60000 });
ok(/Lucas is back/.test(line2) && /1 h 30 min until now/.test(line2), `the return line ("${line2.slice(0, 70)}…")`);
ok(R.awarenessLine({ deps: deps(0.8, 'here'), now: now + 40 * H }) === null, 'a day and a half later the line is gone');
// a second reach is licensed again once the cadence passes and the count is clear
ok(R.evaluate({ deps: deps(0.8, 'away'), now: now + 6 * H }).reach === true, 'after 6 h, away, answered → a reach is licensed again');
// THE ARRIVAL (his word 09-05): a fresh unseen arrival while he is here licenses ONE moment — not a reach, never unanswered
{
  let arrivalRow = { at: now, awayMs: 25 * 60000, from: 'away', seen: false };
  const dA = (presence) => ({ ...deps(0.1, presence), presence: { stored: () => ({ state: presence, reason: presence === 'here' ? 'camera: him' : presence }), arrival: () => (arrivalRow && !arrivalRow.seen ? arrivalRow : null), markArrivalSeen: () => { arrivalRow.seen = true; return arrivalRow; } } });
  const a1 = R.evaluate({ deps: dA('here'), now: now + 1000 });
  ok(a1.reach && a1.kind === 'arrival' && a1.channel === 'desktop' && /camera saw him back after 25m away/.test(a1.why), 'a fresh arrival while he is here → one licensed moment (kind arrival, the desktop, voice allowed)');
  const manA = R.manifest({ deps: dA('here'), now: now + 1000, ev: a1, lastUserTurnTs: now - 3 * 3600e3 });
  ok(/^ARRIVAL — the camera just saw Lucas sit back down after 25 min away/.test(manA) && /silence is fine/.test(manA) && !/I missed you|say hi|greet/i.test(manA), 'the arrival manifest names the moment and leaves the words (and silence) to her');
  const before = R.state(dA('here')).unanswered || 0; const evBefore = events.length;
  R.recordReach({ text: 'There you are.', channel: 'desktop', kind: 'arrival', deps: dA('here'), now: now + 2000 });
  ok(arrivalRow.seen === true && (R.state(dA('here')).unanswered || 0) === before && events[events.length - 1].kind === 'arrival_said' && events.length === evBefore + 1, 'an arrival moment is consumed once and never counted as unanswered');
  ok(!R.evaluate({ deps: dA('here'), now: now + 3000 }).reach, 'once seen, no second moment');
  ok(R.evaluate({ deps: dA('away'), now: now + 6 * H }).kind === 'reach', 'the ordinary path still reports kind reach');
}
// the switch
process.env.ZOE_REACH = '0';
ok(!R.evaluate({ deps: deps(0.9, 'away'), now: now + 6 * H }).reach && R.checkUnanswered({ deps: deps(0.8, 'away'), now: now + 7 * H }) === null, 'ZOE_REACH=0: no reach, no timer');
delete process.env.ZOE_REACH;
console.log(`\nsmoke_presence_reach: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
