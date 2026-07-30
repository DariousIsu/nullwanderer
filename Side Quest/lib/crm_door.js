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
// SESSION MEMORY (boot111: Edson Beall minted 3× from one multi-chunk doc): a research-created
// contact has no account row yet, so org-corroboration can never match the row THIS DOOR just
// created — every chunk re-discovered the person and re-minted. The door remembers its own
// creations for the session; a repeat resolves to the remembered row and lands as an update.
const _sessionCreates = new Map();   // `${blockKey}|${org}` → contactId

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
        const ck = `${key}|${String(org || '').toLowerCase().trim()}`;
        if (_sessionCreates.has(ck)) return [_sessionCreates.get(ck)];
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
    const raw = require('./crm_upsert').createCrmUpserter({ callTool, readCrm });
    _door = {
      ...raw,
      // The wrapper remembers what the door lands, so findByBlock's session cache can resolve a
      // repeat discovery to the SAME row instead of re-minting (best-effort — a cache miss only
      // costs Echo's own strong-id guard a look).
      async upsertPersonObject(obj, opts) {
        const r = await raw.upsertPersonObject(obj, opts);
        try {
          if (r && r.contactId && ['created', 'updated', 'unchanged'].includes(r.action)) {
            const U = require('./crm_upsert');
            const parts = U.splitName((obj && obj.name) || '');
            const k = U.blockKey(parts.FirstName, parts.LastName);
            if (k) _sessionCreates.set(`${k}|${String((obj && obj.org) || '').toLowerCase().trim()}`, r.contactId);
          }
        } catch { /* cache is best-effort */ }
        return r;
      },
    };
    return _door;
  } catch (e) { console.error('[crm-door] init failed:', e && e.message); _failed = true; return null; }
}

// A Puller-landed person (name + company) + its beliefs → the person object the door consumes. Only
// text-grounded attributes are carried (email/phone/role); org travels as a note (AccountId edge is a
// later slice). DISCOVERY-not-invention: nothing is guessed — the beliefs came from the source text.
function personObjectFromCard(landed, beliefs = []) {
  // THE DOOR TRUSTS NO FEEDER (2026-07-29 live flood): the doc-cards extractor handed ~190 people
  // named "- PERSON" (literal annotation tokens in the source doc) and every one landed in the CRM
  // before the upstream gate learned the pattern. The one door re-checks name validity itself:
  // null = refuse (the wire skips), never a junk row.
  const name = String((landed && landed.name) || '').trim();
  if (!name || !/[a-z]/i.test(name)) return null;
  try { if (require('../studio/puller_name_gate').isJunkPersonName(name)) return null; } catch { /* gate unavailable → fall through */ }
  // FULL NAME OR HOLD (boot113: bare "Trump" minted as a contact): a research-discovered CONTACT
  // with one name token is unactionable (no one to email) and famous-surname extraction noise is
  // indistinguishable from a real mononym. The AUTO-ADD door requires two alphabetic name tokens
  // to MINT; the Puller keeps the mononym target for enrichment, and the person lands here the
  // moment a full name exists. (Puller-drain and manual paths are unchanged.)
  if ((name.match(/[a-z]+/gi) || []).length < 2) return null;
  const b = (t) => { const x = (beliefs || []).find((y) => y && y.type === t); return x && x.value; };
  const attributeFacts = {};
  const email = b('email'); if (email) attributeFacts.Email = email;
  const phone = b('phone'); if (phone) attributeFacts.Phone = phone;
  const role = b('role'); if (role) attributeFacts.Title = role;
  return { name, attributeFacts, edgeFacts: {}, identifiers: {}, org: (landed && landed.company) || null };
}

function _resetForTest() { try { if (_crm) _crm.close(); } catch {} _door = null; _crm = null; _failed = false; _warnedMissing = false; _sessionCreates.clear(); }

module.exports = { getDoor, personObjectFromCard, ELECTORAL, _resetForTest };
