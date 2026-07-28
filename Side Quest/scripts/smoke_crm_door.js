/* Smoke: lib/crm_door — the LIVE-APP caller that lands a discovered person in the CRM immediately (#2/#3).
 *
 * Covers the pure seam (personObjectFromCard: a Puller-landed person + beliefs -> the door's person object,
 * DISCOVERY-not-invention) and the graceful gating (getDoor returns null, a safe no-op, when Echo isn't
 * ready). The door's identity/dedup discipline itself is proven by smoke_crm_upsert.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_crm_door.js
 */
'use strict';
const door = require('../lib/crm_door');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// 1. Full mapping: beliefs → attributeFacts; company → org.
const obj = door.personObjectFromCard(
  { name: 'Sheldon Jones', company: 'Richland Parish School Board' },
  [{ type: 'email', value: 'sj@richland.k12.la.us' }, { type: 'role', value: 'Superintendent' }, { type: 'phone', value: '318-555-1212' }]);
ok(obj.name === 'Sheldon Jones', 'name carried');
ok(obj.attributeFacts.Email === 'sj@richland.k12.la.us', 'email → attributeFacts.Email');
ok(obj.attributeFacts.Title === 'Superintendent', 'role → attributeFacts.Title');
ok(obj.attributeFacts.Phone === '318-555-1212', 'phone → attributeFacts.Phone');
ok(obj.org === 'Richland Parish School Board', 'company → org (for the block match + note)');

// 2. DISCOVERY-not-invention: no beliefs → no invented contact fields.
const bare = door.personObjectFromCard({ name: 'Garth Sullivan', company: 'Richland Parish 911' }, []);
ok(Object.keys(bare.attributeFacts).length === 0, 'no beliefs → empty attributeFacts (nothing guessed)');
ok(bare.name === 'Garth Sullivan' && bare.org === 'Richland Parish 911', 'name + org still carried with no beliefs');

// 3. Graceful gating: no Echo / not connected → null (a safe no-op, never a throw).
door._resetForTest();
ok(door.getDoor(null) === null, 'no echoSuit → null (no-op)');
door._resetForTest();
ok(door.getDoor({ connected: false }) === null, 'echo not connected → null (no-op)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
