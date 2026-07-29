/**
 * lib/crm_door.js — the LIVE-APP caller of THE ONE DOOR (lib/crm_upsert), so a person DISCOVERED during
 * a research/extraction turn lands in the CRM IMMEDIATELY (auto-commit) instead of sitting in the Puller
 * until a batch drain. This is #2's record-auto-add: "research it and it's there next time."
 *
 * Approach A (Lucas 2026-07-27): reuse the drain's proven read path — resolve identity against a READ-ONLY
 * handle on Echo's electoral.db (strong-id -> name+jurisdiction block -> MINT), so it is identity-SAFE and
 * never sprays name-matched duplicates (the [[resolver-false-identification]] trap the door was built to
 * avoid). Writes go through echoSuit (create_contact/update_contact) as a DELIBERATE, non-autonomous write
 * so the tier gate permits it. Lazy singleton; returns null (no-op) if the CRM file or Echo isn't ready.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ECHO_DIR = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ELECTORAL = process.env.CRM_DB_PATH || path.join(ECHO_DIR, 'data', 'foundations', 'electoral.db');

let _door = null, _crm = null, _failed = false, _warnedMissing = false;

function getDoor(echoSuit) {
  if (_door) return _door;
  if (_failed) return null;                       // don't retry-spam a bad init error
  if (!echoSuit || !echoSuit.connected) return null;   // Echo not warm yet — try again next call
  try {
    // A missing file is TRANSIENT (Echo may still be laying the store down) — warn once, never latch.
    // The permanent _failed latch is reserved for hard init errors (require/open), where retrying spams.
    if (!fs.existsSync(ELECTORAL)) { if (!_warnedMissing) { console.error('[crm-door] electoral.db not found (will retry):', ELECTORAL); _warnedMissing = true; } return null; }
    const Database = require('better-sqlite3');
    _crm = new Database(ELECTORAL, { readonly: true });
    const strongStmt = {};
    const readCrm = {
      findByStrongId(col, val) {
        strongStmt[col] ||= _crm.prepare(`SELECT id FROM contact WHERE ${col} = ? AND COALESCE(deleted,0)=0 LIMIT 1`);
        const r = strongStmt[col].get(val);
        return r ? r.id : null;
      },
      findByBlock(key, { jurisdiction, org } = {}) {
        // IDENTITY SAFETY (2026-07-29): "a name alone NEVER matches" is crm_upsert's own invariant,
        // but this wiring ran the block bare — personObjectFromCard carries no jurisdiction and `org`
        // was ignored — so ONE same-surname row anywhere in the 113k-row CRM "matched" and a
        // discovered email/phone landed on a stranger. A block candidate now needs a CORROBORATOR:
        // jurisdiction, or account-name overlap with the discovered org. No corroborator → [] → the
        // door MINTS instead (Echo's strong-id dedupe still guards true re-adds) — a duplicate row is
        // recoverable, a false merge is not ([[resolver-false-identification]]).
        const [last, fi] = String(key).split('|');
        if (!jurisdiction && !org) return [];
        // Compare the surname as blockKey normalized it (letters only) — the raw LOWER(TRIM())
        // compare could never equal the stripped key for O'Brien / hyphenated / spaced surnames,
        // which silently forced a duplicate mint for every such person.
        const lastNorm = "REPLACE(REPLACE(REPLACE(REPLACE(LOWER(TRIM(c.LastName)),'''',''),'-',''),'.',''),' ','')";
        const where = ['COALESCE(c.deleted,0)=0', `${lastNorm} = ?`];
        const params = [last];
        if (jurisdiction) { where.push('(c.Jurisdiction__c = ? OR c.MailingState = ?)'); params.push(jurisdiction, String(jurisdiction).replace(/^US-/, '')); }
        if (org) {
          const like = String(org).toLowerCase().replace(/[\\%_]/g, (x) => '\\' + x).trim();
          where.push("LOWER(COALESCE(a.Name,'')) LIKE ? ESCAPE '\\'"); params.push(`%${like}%`);
        }
        const rows = _crm.prepare(
          `SELECT c.id, c.FirstName FROM contact c LEFT JOIN account a ON a.id = c.AccountId WHERE ${where.join(' AND ')} LIMIT 500`
        ).all(...params);
        return rows.filter((r) => !fi || String(r.FirstName || '').toLowerCase().startsWith(fi)).map((r) => r.id);
      },
    };
    // DELIBERATE write ({autonomous:false}) so the tier gate permits create/update — this is a user-facing
    // landing of researched data, not an unattended background mutation.
    const callTool = async (name, args) => {
      const r = await echoSuit.dispatch({ kind: 'do', name, args }, { autonomous: false });
      if (r && r.ok) { try { return JSON.parse(r.text); } catch { return r; } }
      return { error: (r && (r.error || r.text)) || 'dispatch failed' };
    };
    _door = require('./crm_upsert').createCrmUpserter({ callTool, readCrm });
    return _door;
  } catch (e) { console.error('[crm-door] init failed:', e && e.message); _failed = true; return null; }
}

// A Puller-landed person (name + company) + its beliefs → the person object the door consumes. Only
// text-grounded attributes are carried (email/phone/role); org travels as a note (AccountId edge is a
// later slice). DISCOVERY-not-invention: nothing is guessed — the beliefs came from the source text.
function personObjectFromCard(landed, beliefs = []) {
  const b = (t) => { const x = (beliefs || []).find((y) => y && y.type === t); return x && x.value; };
  const attributeFacts = {};
  const email = b('email'); if (email) attributeFacts.Email = email;
  const phone = b('phone'); if (phone) attributeFacts.Phone = phone;
  const role = b('role'); if (role) attributeFacts.Title = role;
  return { name: landed.name, attributeFacts, edgeFacts: {}, identifiers: {}, org: landed.company || null };
}

function _resetForTest() { try { if (_crm) _crm.close(); } catch {} _door = null; _crm = null; _failed = false; _warnedMissing = false; }

module.exports = { getDoor, personObjectFromCard, ELECTORAL, _resetForTest };
