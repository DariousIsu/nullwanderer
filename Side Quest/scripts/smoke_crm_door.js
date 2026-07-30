/* Smoke: lib/crm_door — the LIVE-APP caller that lands a discovered person in the CRM immediately (#2/#3).
 *
 * Covers the pure seam (personObjectFromCard: a Puller-landed person + beliefs -> the door's person object,
 * DISCOVERY-not-invention), the graceful gating (getDoor returns null, a safe no-op, when Echo isn't
 * ready), and — against a TEMP electoral-shaped DB — the door's IDENTITY SAFETY: a name alone never
 * matches (2026-07-29 finding: the bare block let one same-surname row anywhere in the CRM absorb a
 * stranger's email/phone). The upsert discipline itself is proven by smoke_crm_upsert.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_crm_door.js
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
// Point the door at a TEMP CRM — must be set BEFORE the module is required (ELECTORAL is read at load).
const tmp = path.join(os.tmpdir(), `sq_smoke_crmdoor_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.CRM_DB_PATH = tmp;
const door = require('../lib/crm_door');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // 1. Full mapping: beliefs → attributeFacts; company → org.
  const obj = door.personObjectFromCard(
    { name: 'Sheldon Jones', company: 'Richland Parish School Board' },
    [{ type: 'email', value: 'sj@richland.k12.la.us' }, { type: 'role', value: 'Superintendent' }, { type: 'phone', value: '318-555-1212' }]);
  ok(obj.name === 'Sheldon Jones', 'name carried');
  ok(obj.attributeFacts.Email === 'sj@richland.k12.la.us', 'email → attributeFacts.Email');
  ok(obj.attributeFacts.Title === 'Superintendent', 'role → attributeFacts.Title');
  ok(obj.attributeFacts.Phone === '318-555-1212', 'phone → attributeFacts.Phone');
  ok(obj.org === 'Richland Parish School Board', 'company → org (for the block match + note)');

  // 1b. THE DOOR TRUSTS NO FEEDER (2026-07-29 flood): a placeholder "name" is refused AT the door —
  // null out, the wire skips — even if an upstream gate missed it.
  ok(door.personObjectFromCard({ name: '- PERSON', company: 'Anywhere' }, []) === null, 'placeholder name "- PERSON" refused at the door (the ~190-row flood)');
  ok(door.personObjectFromCard({ name: '   ', company: 'X' }, []) === null, 'blank name refused');
  ok(door.personObjectFromCard({ name: 'Finance Director', company: 'X' }, []) === null, 'role-word name refused at the door too');
  ok(door.personObjectFromCard({ name: 'Talya', company: 'X' }, []) !== null, 'a real mononym still passes');

  // 2. DISCOVERY-not-invention: no beliefs → no invented contact fields.
  const bare = door.personObjectFromCard({ name: 'Garth Sullivan', company: 'Richland Parish 911' }, []);
  ok(Object.keys(bare.attributeFacts).length === 0, 'no beliefs → empty attributeFacts (nothing guessed)');
  ok(bare.name === 'Garth Sullivan' && bare.org === 'Richland Parish 911', 'name + org still carried with no beliefs');

  // 3. IDENTITY SAFETY against a temp CRM (dryRun — resolve only, no writes).
  const Database = require('better-sqlite3');
  const crm = new Database(tmp);
  crm.exec(`CREATE TABLE contact (id INTEGER PRIMARY KEY, FirstName TEXT, LastName TEXT, AccountId INTEGER,
              Jurisdiction__c TEXT, MailingState TEXT, deleted INTEGER DEFAULT 0);
            CREATE TABLE account (id INTEGER PRIMARY KEY, Name TEXT);
            INSERT INTO account VALUES (10,'Stanford University'),(20,'Acme Corp'),(30,'Tulane University');
            INSERT INTO contact (id,FirstName,LastName,AccountId) VALUES
              (1,'Laila','Pirnazar',10),(2,'John','Smith',20),(3,'Pat','O''Brien',30);`);
  crm.close();
  const suit = { connected: true, dispatch: async () => ({ ok: true, text: '{}' }) };
  door._resetForTest();
  const d = door.getDoor(suit);
  ok(!!d, 'door opens against the temp CRM');
  const dry = { dryRun: true };
  const r1 = await d.upsertPersonObject(door.personObjectFromCard({ name: 'Lucy Pirnazar', company: 'Rainey Center' }, []), dry);
  ok(r1.action === 'would-create', `same surname + initial, DIFFERENT org → MINT, never merge (got ${r1.action})`);
  const r2 = await d.upsertPersonObject(door.personObjectFromCard({ name: 'Laila Pirnazar', company: 'Stanford University' }, [{ type: 'email', value: 'lp@stanford.edu' }]), dry);
  ok(r2.action === 'would-update' && r2.contactId === 1, 'same person + org corroboration → updates the existing row');
  const r3 = await d.upsertPersonObject(door.personObjectFromCard({ name: "Pat O'Brien", company: 'Tulane' }, []), dry);
  ok(r3.action === 'would-update' && r3.contactId === 3, "O'Brien still blocks despite punctuation (normalized surname compare)");
  const r4 = await d.upsertPersonObject({ name: 'John Smith', attributeFacts: {}, edgeFacts: {}, identifiers: {}, org: null }, dry);
  ok(r4.action === 'would-create', 'no corroborator at all → a name alone NEVER matches → mint');

  // 3b. SESSION MEMORY (boot111: Edson Beall ×3): a repeat discovery of a person the door just
  // created must land on the SAME row — one create, then updates — even though the new contact has
  // no account row for the org-corroborator to match.
  {
    const calls = { create: 0, update: 0 };
    const suit2 = { connected: true, dispatch: async (msg) => {
      if (msg.name === 'create_contact') { calls.create++; return { ok: true, text: JSON.stringify({ action: 'created', contact_id: 777 }) }; }
      if (msg.name === 'update_contact') { calls.update++; return { ok: true, text: JSON.stringify({ updated_fields: ['Email'] }) }; }
      return { ok: true, text: '{}' };
    } };
    door._resetForTest();
    const d2 = door.getDoor(suit2);
    const card = { name: 'Zed Qorvax', company: 'Voidly Blockworks' };   // no such row in the temp CRM
    const r1 = await d2.upsertPersonObject(door.personObjectFromCard(card, []));
    ok(r1.action === 'created' && r1.contactId === 777, `repeat: first discovery creates (${r1.action} #${r1.contactId})`);
    const r2 = await d2.upsertPersonObject(door.personObjectFromCard(card, [{ type: 'email', value: 'zq@voidly.example' }]));
    ok(r2.contactId === 777 && r2.action !== 'created', `repeat: second discovery lands on the SAME row (${r2.action} #${r2.contactId})`);
    ok(calls.create === 1, `repeat: create_contact called exactly once (${calls.create})`);
  }

  // 4. Graceful gating: no Echo / not connected → null (a safe no-op, never a throw).
  door._resetForTest();
  ok(door.getDoor(null) === null, 'no echoSuit → null (no-op)');
  door._resetForTest();
  ok(door.getDoor({ connected: false }) === null, 'echo not connected → null (no-op)');

  door._resetForTest();
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
