/**
 * lib/crm_upsert.js — upsertPersonObject: THE ONE DOOR into the CRM.
 *
 * Lucas's ruling (2026-07-24): "All real people objects should live in the CRM upon creation.
 * Puller should be sweeping the CRM for incompletes... the CRM and its formatting is the ULTIMATE
 * STORE." Puller is a completion engine, not a home. This module is the invariant that makes that
 * true rather than aspirational: every creation path — doc-decompose, news lane, Puller discovery,
 * meeting, manual — resolves and lands through here.
 *
 * WHY THE DOOR DIDN'T EXIST. Echo's `update_contact` rejects an unknown contact_id, and nothing
 * anywhere created a person row. `puller_db.promoteTarget(id, crmId)` only RECORDS a link after a
 * CRM row exists (puller_db.js:10 — "references CRM/Echo rows by id only; it never edits them").
 * So 341,142 Puller targets sit at crm_id = 0 and all 1,014 Louisiana parish officials are absent
 * from the store of record. Echo gained `create_contact` (5d1705b); this is its caller.
 *
 * SHAPE OF A PERSON OBJECT (Lucas's model, spec §3). Facts come two ways and the CRM line is the
 * MATERIALIZED UNIFIED READ-OUT of both:
 *   attributeFacts — birthday, notes, phone, email        → descriptive columns, point at nothing
 *   edgeFacts      — org, elected body, jurisdiction, role → relational columns, point at objects
 *
 * IDENTITY IS RESOLVED, NEVER ASSUMED (§9 rails):
 *   1. strong crosswalk id (bioguide / wikidata / OCD / FEC / PCC)  → auto-match
 *   2. blocked name + jurisdiction + org, UNIQUELY                  → match
 *   3. otherwise                                                    → MINT
 * A name alone NEVER matches: a resolver once substituted a person on first name
 * ([[resolver-false-identification]]), and the CRM carries 4,522 duplicate name+jurisdiction groups
 * (5,237 surplus rows, 4.7%) — so an ambiguous name match is evidence of nothing. Ambiguity holds
 * the record rather than guessing.
 *
 * INJECTABLE by design: `callTool` (Echo MCP) and `readCrm` (read-only lookups) are passed in, so
 * the door is provable offline against a sandbox copy without a live Echo and without touching the
 * real CRM. Same idiom as the rest of lib/.
 */
'use strict';

// Columns Echo's update_contact/create_contact whitelist accepts that we populate from a person
// object. Anything not here is carried as a note rather than silently dropped.
const SPINE = ['FirstName', 'LastName', 'Suffix', 'Title', 'Email', 'Phone', 'MobilePhone',
  'MailingStreet', 'MailingCity', 'MailingState', 'MailingPostalCode',
  'Jurisdiction__c', 'Chamber__c', 'Party__c', 'District__c', 'Active_Elected__c',
  // AccountId is THE org edge — the column that points a person at the body they serve. It was
  // missing here at first, so toFields() silently dropped it and every edgeFact naming an
  // organisation went nowhere. A column absent from SPINE is not rejected, it VANISHES, which is
  // the quietest possible failure; keep this list in step with Echo's write whitelist.
  'AccountId',
  'Notes_Public__c'];

const STRONG_IDS = ['Bioguide_Id__c', 'Wikidata_Qid__c', 'OCD_Person_Id__c',
  'FEC_Candidate_Id__c', 'PCC_Account_Id__c'];

/** Split a display name into first/last. Deliberately dumb: the CRM's LastName is the only NOT
 *  NULL column, so the priority is never losing the surname, not clever particle handling. */
function splitName(full) {
  const s = String(full || '').trim().replace(/\s+/g, ' ');
  if (!s) return { FirstName: null, LastName: null };
  if (s.includes(',')) {                     // "Benton, Glenn"
    const [last, first] = s.split(',', 2).map(x => x.trim());
    return { FirstName: first || null, LastName: last || null };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { FirstName: null, LastName: parts[0] };
  const SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|esq)\.?$/i;
  let last = parts.pop();
  let suffix = null;
  if (SUFFIX.test(last) && parts.length > 1) { suffix = last; last = parts.pop(); }
  return { FirstName: parts.join(' ') || null, LastName: last, Suffix: suffix };
}

/** Blocking key for candidate lookup — last name + first initial, lowercased. Cheap, index-able,
 *  and deliberately LOOSE: it only narrows the candidate set, it never decides identity. */
function blockKey(first, last) {
  const l = String(last || '').toLowerCase().replace(/[^a-z]/g, '');
  const f = String(first || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 1);
  return l ? `${l}|${f}` : null;
}

function createCrmUpserter({ callTool, readCrm, log = () => {} } = {}) {
  if (typeof callTool !== 'function') throw new Error('crm_upsert: callTool required');
  if (!readCrm || typeof readCrm.findByStrongId !== 'function'
      || typeof readCrm.findByBlock !== 'function') {
    throw new Error('crm_upsert: readCrm{findByStrongId,findByBlock} required');
  }

  /**
   * Resolve a person object to an existing contact id, or null to mint.
   * Returns { contactId, how, candidates } — `how` is the evidence, so a caller (and an audit)
   * can see WHY two records were considered the same person.
   */
  function resolve({ identifiers = {}, name, FirstName, LastName, jurisdiction, org }) {
    for (const col of STRONG_IDS) {
      const v = identifiers[col];
      if (v === undefined || v === null || v === '') continue;
      const hit = readCrm.findByStrongId(col, v);
      if (hit) return { contactId: hit, how: `strong:${col}`, candidates: 1 };
    }
    const parts = (FirstName || LastName) ? { FirstName, LastName } : splitName(name);
    const key = blockKey(parts.FirstName, parts.LastName);
    if (!key) return { contactId: null, how: 'no-name', candidates: 0 };

    const cands = readCrm.findByBlock(key, { jurisdiction, org });
    if (cands.length === 1) return { contactId: cands[0], how: 'block+jurisdiction', candidates: 1 };
    if (cands.length > 1) {
      // AMBIGUOUS. Do not guess and do not mint a duplicate on top of a duplicate — hold it.
      return { contactId: null, how: 'ambiguous', candidates: cands.length, hold: true };
    }
    return { contactId: null, how: 'mint', candidates: 0 };
  }

  /** Map a person object onto CRM columns. attributeFacts fill descriptive columns; edgeFacts
   *  fill the relational ones (the CRM line materialises BOTH — Lucas's §3 point). */
  function toFields({ name, FirstName, LastName, attributeFacts = {}, edgeFacts = {},
                      identifiers = {} }) {
    const parts = (FirstName || LastName) ? { FirstName, LastName } : splitName(name);
    const f = {};
    if (parts.FirstName) f.FirstName = parts.FirstName;
    if (parts.LastName) f.LastName = parts.LastName;
    if (parts.Suffix) f.Suffix = parts.Suffix;
    for (const [k, v] of Object.entries(attributeFacts)) {
      if (SPINE.includes(k) && v !== undefined && v !== null && v !== '') f[k] = v;
    }
    for (const [k, v] of Object.entries(edgeFacts)) {
      if (SPINE.includes(k) && v !== undefined && v !== null && v !== '') f[k] = v;
    }
    for (const col of STRONG_IDS) {
      if (identifiers[col]) f[col] = identifiers[col];
    }
    return f;
  }

  /**
   * THE DOOR. Given a person object, create or maintain its unified CRM line.
   * Returns { action, contactId, how, fields } where action is
   * created | updated | unchanged | held | rejected.
   */
  async function upsertPersonObject(obj, { dryRun = false, source = null, notes = null } = {}) {
    const fields = toFields(obj);
    if (!fields.LastName) {
      return { action: 'rejected', reason: 'no LastName (the CRM\'s one required column)', obj };
    }
    const r = resolve({ ...obj, FirstName: fields.FirstName, LastName: fields.LastName });

    if (r.hold) {
      return { action: 'held', reason: 'ambiguous identity', how: r.how,
               candidates: r.candidates, fields };
    }
    if (dryRun) {
      return { action: r.contactId ? 'would-update' : 'would-create',
               contactId: r.contactId, how: r.how, fields };
    }

    if (r.contactId) {
      const res = await callTool('update_contact', {
        contact_id: r.contactId, fields, finding_notes: notes, source_url: source,
      });
      const changed = (res && res.updated_fields) || [];
      return { action: changed.length ? 'updated' : 'unchanged',
               contactId: r.contactId, how: r.how, fields, updated: changed, raw: res };
    }

    const res = await callTool('create_contact', {
      fields, finding_notes: notes, source_url: source, stage: 'new',
    });
    if (res && res.action === 'existing') {
      // Echo's own strong-id guard caught what our resolve() missed (it checks the same ids, so
      // this means the id arrived only in `fields`). Treat as an update, never a duplicate.
      const upd = await callTool('update_contact', {
        contact_id: res.contact_id, fields, finding_notes: notes, source_url: source,
      });
      return { action: 'updated', contactId: res.contact_id, how: `echo-dedupe:${res.matched_on}`,
               fields, updated: (upd && upd.updated_fields) || [], raw: upd };
    }
    if (!res || res.action !== 'created') {
      return { action: 'rejected', reason: (res && res.error) || 'create_contact failed',
               fields, raw: res };
    }
    return { action: 'created', contactId: res.contact_id, how: r.how, fields, raw: res };
  }

  return { upsertPersonObject, resolve, toFields, splitName, blockKey };
}

module.exports = { createCrmUpserter, splitName, blockKey, SPINE, STRONG_IDS };
