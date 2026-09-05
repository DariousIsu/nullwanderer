/* Smoke: lib/delivery_router — the moment-gate's grave becomes a shelf (senses §1, 2026-08-15).
 * Pure: an object-backed meta store + a presence spy; no db, no model. Proves the hold band +
 * trivia floor, dedupe, cap, shelf expiry, presence-aware notify, the awareness line, and clear.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_delivery_router.js
 */
'use strict';
const dr = require('../lib/delivery_router');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const store = {};
const deps = { db: { getMeta: (k) => store[k], setMeta: (k, v) => { store[k] = v; } } };
const held = () => JSON.parse(store[dr.HELD_KEY] || '[]');
const T = 1_000_000_000;

// hold band + floor
ok(dr.holdOrDrop({ text: 'The LA fill run finished its 4th parish overnight', imp: 7, threshold: 9, lane: 'ours', deps, nowMs: T }) === 'hold', 'near-miss (7 vs bar 9, band 2) → HELD');
ok(held().length === 1 && held()[0].imp === 7, 'shelved with its score');
ok(dr.holdOrDrop({ text: 'a passing shower thought about clouds', imp: 6, threshold: 9, deps, nowMs: T }) === 'drop', 'far miss (9-6 > band) → drop');
ok(dr.holdOrDrop({ text: 'tiny trivia', imp: 4, threshold: 5, deps, nowMs: T }) === 'drop', 'within band but under the absolute floor (5) → trivia never held');
ok(dr.holdOrDrop({ text: '', imp: 9, threshold: 9, deps, nowMs: T }) === 'drop', 'empty text → drop');

// dedupe: the same thought reworded past 60 chars still keys on the prefix
ok(dr.holdOrDrop({ text: 'The LA fill run finished its 4th parish overnight', imp: 8, threshold: 9, deps, nowMs: T + 1000 }) === 'hold', 'repeat → still reports hold');
ok(held().length === 1, '…but the shelf holds ONE copy (prefix dedupe)');

// cap + expiry
for (let i = 0; i < 20; i++) dr.holdOrDrop({ text: `distinct observation number ${i} about a different subject entirely`, imp: 8, threshold: 9, deps, nowMs: T + 2000 + i });
ok(held().length <= dr.HELD_CAP, `shelf capped at ${dr.HELD_CAP} (${held().length})`);
const line1 = dr.heldLine({ deps, nowMs: T + 5000 });
ok(!!line1 && /You are HOLDING \d+ smaller notes for Lucas/.test(line1) && /Offer them at a natural moment/.test(line1), `awareness line renders (${(line1 || '').slice(0, 70)}…)`);
ok(dr.heldLine({ deps, nowMs: T + dr.HELD_SHELF_MS + 10_000 }) === null, '48h shelf expiry → line goes quiet on its own');

// presence-aware notify
let notified = null;
const pres = { notify: (title, body) => { notified = { title, body }; } };
ok(dr.noteSurfaced({ away: true, text: 'The forecast recompute moved House P(D) to 53%', deps: { presence: pres } }) === true && notified && /forecast recompute/.test(notified.body), 'away → desktop notify fires with the utterance');
notified = null;
ok(dr.noteSurfaced({ away: false, text: 'x', deps: { presence: pres } }) === false && notified === null, 'present → no notify (chat surfacing is enough)');

// clear
ok(dr.clearHeld({ deps }) === true && held().length === 0, 'clearHeld empties the shelf');
ok(dr.heldLine({ deps, nowMs: T }) === null, 'empty shelf → no awareness line');

// ── THE ROUTE (the wants project, cut 2 + W7; Lucas 09-05: "really only when I am not at my desk") ──────
(async () => {
  const R = (state, reason) => dr.routeChannel({ presence: { state, reason } });
  ok(R('here', 'active 2m ago') === 'desktop', 'here → the desktop');
  ok(R('remote', 'his word: remoting in from Baton Rouge') === 'discord' && R('remote', 'remote session (SESSIONNAME: RDP-Tcp#3)') === 'discord', 'remote (his word or the OS session) → Discord');
  ok(R('away', 'his word: for the night') === 'discord', 'away by HIS WORD → Discord');
  ok(R('away', 'idle 47m, no one on camera') === 'discord', 'away with the camera seeing no one → Discord');
  ok(R('away', 'idle 47m') === 'desktop', 'away by keyboard idleness ALONE → the desktop (he may be reading)');
  ok(R('meeting', 'voice guard: Teams') === 'queue', 'a meeting → a queued note, never a ping');
  ok(dr.routeChannel({ presence: null }) === 'desktop' && dr.routeChannel({ presence: {} }) === 'desktop', 'no presence reading → the desktop');

  // deliver — an injected Discord, run ledger, presence and bus
  const store2 = {}; const db2 = { getMeta: (k) => store2[k], setMeta: (k, v) => { store2[k] = v; } };
  const sent = [], runs = [], busEv = [], logs = [];
  const board = { start: (r) => { runs.push({ ...r, id: runs.length + 1 }); return { id: runs.length }; }, finish: (id, r) => { runs[id - 1].finish = r; } };
  const d2 = (presence, sendOk = true) => ({ db: db2, presence, discord: { sendDM: async (t) => { sent.push(t); return sendOk ? { ok: true } : { ok: false, reason: 'not connected' }; } }, board, obsBus: { emit: (e) => busEv.push(e), subscribe: () => () => {} }, availability: { isAway: () => false }, log: (m) => logs.push(m) });
  const r1 = await dr.deliver({ text: 'The Louisiana list is done — 64 parishes.', source: 'report', ref: 42, deps: d2({ state: 'remote', reason: 'his word: remoting in from Baton Rouge' }), nowMs: T });
  ok(r1.channel === 'discord' && r1.dm.ok && sent.length === 1 && /64 parishes/.test(sent[0]), 'remote → the say goes to his Discord DM');
  ok(runs.length === 1 && runs[0].lane === 'delivery' && runs[0].kind === 'discord-dm' && runs[0].finish.status === 'done' && runs[0].finish.note === 'sent', 'every DM = a run-ledger receipt (delivery / discord-dm, done: sent)');
  ok(JSON.parse(store2[dr.LAST_DM_KEY]).ref === 42 && busEv.length === 1 && busEv[0].lane === 'delivery' && busEv[0].kind === 'dm' && busEv[0].data.ok === true, 'the last DM is recorded + one bus event');
  ok(/report → Discord DM sent \(remote: his word/.test(logs[0]), 'the log names the source, the channel and why');
  const r2 = await dr.deliver({ text: 'Another line right after.', source: 'say', deps: d2({ state: 'remote', reason: 'his word' }), nowMs: T + 20000 });
  ok(r2.channel === 'discord' && !r2.dm.ok && /gap/.test(r2.dm.reason) && sent.length === 1, 'never two DMs inside a minute — the second waits');
  const r3 = await dr.deliver({ text: 'Later.', source: 'say', deps: d2({ state: 'remote', reason: 'his word' }), nowMs: T + 90000 });
  ok(r3.dm.ok && sent.length === 2, 'a minute later the next DM goes');
  const r4 = await dr.deliver({ text: 'Desk line.', source: 'say', deps: d2({ state: 'here', reason: 'active 1m ago' }), nowMs: T + 200000 });
  ok(r4.channel === 'desktop' && r4.dm === null && sent.length === 2, 'here → nothing leaves the desktop');
  let notified5 = null;
  const r5 = await dr.deliver({ text: 'Idle line.', source: 'say', deps: { ...d2({ state: 'away', reason: 'idle 47m' }), availability: { isAway: () => true }, presence: { state: 'away', reason: 'idle 47m' }, presenceNotify: null, presence_: null, presenceDesk: { notify: (t, b) => { notified5 = b; return { ok: true }; } } }, nowMs: T + 300000 });
  ok(r5.channel === 'desktop' && sent.length === 2, 'away by idleness alone → still the desktop, no DM');
  void notified5;
  const r6 = await dr.deliver({ text: 'Down line.', source: 'say', deps: d2({ state: 'remote', reason: 'his word' }, false), nowMs: T + 400000 });
  ok(r6.channel === 'discord' && !r6.dm.ok && runs[runs.length - 1].finish.status === 'failed' && busEv[busEv.length - 1].data.ok === false, 'a DM that fails is an honest failed receipt, never a claimed delivery');
  ok((await dr.deliver({ text: '   ', deps: d2({ state: 'remote', reason: 'x' }) })).why === 'empty', 'empty text delivers nothing');
  const line = dr.lastDeliveryLine({ deps: { db: db2 }, nowMs: T + 90000 + 30 * 60000 });
  ok(/went to his Discord DM 30 min ago/.test(line) && /not at the desk/.test(line), `the manifest line (${line.slice(0, 60)}…)`);
  ok(dr.lastDeliveryLine({ deps: { db: db2 }, nowMs: T + 13 * 3600e3 }) === null, 'the line ages out after 12 h');

  // attach — the store's unprompted-say event routes; a replay-railed say never leaves; other events are ignored
  dr._detach();
  let listener = null; const bus3 = { subscribe: (fn) => { listener = fn; return () => {}; }, emit: (e) => busEv.push(e) };
  const sent3 = []; const deps3 = { db: db2, discord: { sendDM: async (t) => { sent3.push(t); return { ok: true }; } }, board: null, obsBus: bus3, presence: { state: 'remote', reason: 'his word' }, log: () => {} };
  ok(dr.attach({ deps: deps3 }) === true && typeof listener === 'function' && dr.attach({ deps: deps3 }) === false, 'attach subscribes once');
  listener({ lane: 'delivery', kind: 'unprompted_say', text: 'short', ref: 7, data: { speech_class: null, full: 'The full say, longer than the event text.' } });
  await new Promise((r) => setTimeout(r, 5));
  ok(sent3.length === 1 && /The full say/.test(sent3[0]), 'an unprompted say from the store routes (the FULL text, not the event snippet)');
  listener({ lane: 'delivery', kind: 'unprompted_say', text: 'again', ref: 8, data: { speech_class: 'replay', full: 'again' } });
  listener({ lane: 'presence', kind: 'face', text: 'x' });
  await new Promise((r) => setTimeout(r, 5));
  ok(sent3.length === 1, 'a replay-railed say and non-delivery events never leave the box');
  dr._detach();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('route smoke threw:', e); process.exit(1); });
