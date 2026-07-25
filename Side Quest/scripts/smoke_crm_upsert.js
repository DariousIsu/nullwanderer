/* smoke_crm_upsert.js — upsertPersonObject, THE ONE DOOR into the CRM (2026-07-24).
 *
 * The door exists because nothing could create a CRM person row: Echo's update_contact rejects an
 * unknown contact_id, and puller_db.promoteTarget only RECORDS a link after a row exists. Hence
 * 341,142 Puller targets at crm_id = 0 and 1,014 Louisiana parish officials absent from the store
 * of record.
 *
 * What matters most here is what the door REFUSES to do. The CRM already carries 4,522 duplicate
 * name+jurisdiction groups (5,237 surplus rows), so a door that guesses identity makes the worst
 * existing problem worse. These assert the rails: strong id auto-matches, a UNIQUE block+
 * jurisdiction matches, an AMBIGUOUS one is HELD rather than guessed or duplicated, and a bare name
 * never matches anything.
 *
 * Fully offline — callTool and readCrm are injected, no live Echo, no real CRM touched.
 */
'use strict';
const { createCrmUpserter, splitName, blockKey } = require('../lib/crm_upsert');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// A fake CRM: strong-id index + block index, plus a recorder for the tool calls made.
function harness({ byStrongId = {}, byBlock = {} } = {}) {
  const calls = [];
  let nextId = 900001;
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'create_contact') {
      return { action: 'created', contact_id: nextId++, created_fields: Object.keys(args.fields) };
    }
    if (name === 'update_contact') {
      return { contact_id: args.contact_id, updated_fields: Object.keys(args.fields) };
    }
    throw new Error('unexpected tool ' + name);
  };
  const readCrm = {
    findByStrongId: (col, val) => (byStrongId[`${col}=${val}`] ?? null),
    findByBlock: (key) => (byBlock[key] || []),
  };
  return { calls, ...createCrmUpserter({ callTool, readCrm }) };
}

async function main() {
  // ---- name splitting: never lose the surname ------------------------------------------------
  ok(splitName('Glenn Benton').LastName === 'Benton', 'splits "First Last"');
  ok(splitName('Benton, Glenn').FirstName === 'Glenn', 'splits "Last, First"');
  ok(splitName('Cher').LastName === 'Cher', 'a single token becomes the LastName, never dropped');
  ok(splitName('Cara Christine Pavalock-DAmato').LastName === 'Pavalock-DAmato', 'keeps a hyphenated surname');
  ok(splitName('John K. Hampton Jr').LastName === 'Hampton', 'a suffix does not become the surname');
  ok(splitName('John K. Hampton Jr').Suffix === 'Jr', 'and the suffix is kept');
  ok(splitName('   ').LastName === null, 'blank name yields nothing rather than ""');

  ok(blockKey('Glenn', 'Benton') === 'benton|g', 'block key is surname + first initial');
  ok(blockKey(null, 'Benton') === 'benton|', 'block key survives a missing first name');
  ok(blockKey('Glenn', null) === null, 'no surname -> no block key');

  // ---- 1. strong id auto-matches -------------------------------------------------------------
  {
    const h = harness({ byStrongId: { 'Bioguide_Id__c=B000944': 4242 } });
    const r = await h.upsertPersonObject({
      name: 'Sherrod Brown', identifiers: { Bioguide_Id__c: 'B000944' },
    });
    ok(r.action === 'updated' && r.contactId === 4242, '⭐ a strong id matches an existing contact');
    ok(r.how === 'strong:Bioguide_Id__c', 'and the evidence names the id it matched on');
    ok(!h.calls.some((c) => c.name === 'create_contact'), 'no duplicate was created');
  }

  // ---- 2. unique block+jurisdiction matches ---------------------------------------------------
  {
    const h = harness({ byBlock: { 'benton|g': [777] } });
    const r = await h.upsertPersonObject({ name: 'Glenn Benton', jurisdiction: 'US-LA' });
    ok(r.action === 'updated' && r.contactId === 777, 'a UNIQUE block candidate matches');
    ok(r.how === 'block+jurisdiction', 'and says so');
  }

  // ---- 3. AMBIGUOUS is HELD — the rail that protects a 4.7%-duplicated CRM --------------------
  {
    const h = harness({ byBlock: { 'odea|t': [2296, 2706, 43824, 56595] } });
    const r = await h.upsertPersonObject({ name: 'Tom ODea', jurisdiction: 'US-CT' });
    ok(r.action === 'held', '⭐⭐ 4 same-name candidates HOLD the record');
    ok(r.candidates === 4, 'and report how many it saw');
    ok(h.calls.length === 0, '⭐ nothing was written — not an update, and NOT a new duplicate');
  }

  // ---- 4. genuinely new person mints ----------------------------------------------------------
  {
    const h = harness();
    const r = await h.upsertPersonObject({
      name: 'Stormy Gage-Watts',
      attributeFacts: { Phone: '555-0101', Email: 'sgw@caddo.example.gov' },
      edgeFacts: { MailingState: 'LA', Jurisdiction__c: 'US-LA', Title: 'Commissioner' },
    }, { source: 'puller://target/18286' });
    ok(r.action === 'created', 'a new person is created');
    ok(r.how === 'mint', 'and is recorded as a mint, not a match');
    const c = h.calls.find((x) => x.name === 'create_contact');
    ok(c && c.args.fields.LastName === 'Gage-Watts', 'surname landed');
    ok(c.args.fields.Phone === '555-0101' && c.args.fields.Email === 'sgw@caddo.example.gov',
       'attribute-facts filled descriptive columns');
    ok(c.args.fields.Jurisdiction__c === 'US-LA' && c.args.fields.Title === 'Commissioner',
       '⭐ edge-facts filled relational columns — the CRM line materialises BOTH shapes');
    ok(c.args.source_url === 'puller://target/18286', 'provenance travelled with the write');
  }

  // ---- 4b. the ORG EDGE survives toFields ------------------------------------------------------
  // Regression: AccountId was missing from SPINE, so every edgeFact naming an organisation was
  // silently DROPPED rather than rejected — the quietest possible failure.
  {
    const h = harness();
    await h.upsertPersonObject({
      name: 'Walter Adams',
      edgeFacts: { AccountId: 4242, Jurisdiction__c: 'US-LA', Title: 'Police Juror Member' },
    });
    const c = h.calls.find((x) => x.name === 'create_contact');
    ok(c.args.fields.AccountId === 4242, '⭐⭐ AccountId — the org edge — reaches the write');
    ok(Object.prototype.hasOwnProperty.call(c.args.fields, 'District__c') === false,
       'and an absent edge is simply absent, not null-written');
  }

  // ---- 5. refusals -----------------------------------------------------------------------------
  {
    const h = harness();
    const r = await h.upsertPersonObject({ name: '' });
    ok(r.action === 'rejected', 'a nameless object is rejected, never written');
    ok(h.calls.length === 0, 'and nothing was sent to Echo');
  }
  {
    // Echo's own guard fires when the strong id only arrives inside `fields`.
    const calls = [];
    const up = createCrmUpserter({
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'create_contact') return { action: 'existing', contact_id: 555, matched_on: 'Wikidata_Qid__c' };
        return { contact_id: args.contact_id, updated_fields: Object.keys(args.fields) };
      },
      readCrm: { findByStrongId: () => null, findByBlock: () => [] },
    });
    const r = await up.upsertPersonObject({ name: 'Jay Inslee', identifiers: { Wikidata_Qid__c: 'Q1100710' } });
    ok(r.action === 'updated' && r.contactId === 555,
       "⭐ Echo's dedupe turns a would-be duplicate into an update");
    ok(calls.filter((c) => c.name === 'create_contact').length === 1
       && calls.some((c) => c.name === 'update_contact'), 'and the record is still enriched');
  }

  // ---- 6. dryRun writes nothing ----------------------------------------------------------------
  {
    const h = harness();
    const r = await h.upsertPersonObject({ name: 'Eric Soileau' }, { dryRun: true });
    ok(r.action === 'would-create', 'dryRun reports the plan');
    ok(h.calls.length === 0, 'and touches nothing');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
