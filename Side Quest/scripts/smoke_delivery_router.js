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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
