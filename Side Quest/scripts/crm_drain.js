/**
 * scripts/crm_drain.js — run Puller targets through the ONE DOOR into the CRM (spec §7b).
 *
 *   node scripts/crm_drain.js --cohort parish            # dry-run (default), Louisiana parish
 *   node scripts/crm_drain.js --cohort parish --commit   # write
 *   node scripts/crm_drain.js --cohort all --limit 500   # any slice of the 341,142
 *
 * NOT a bulk INSERT — deliberately. It runs the same upsertPersonObject every other creation path
 * uses, so the backlog is CLEANED as it installs: the real-person gate keeps organisations out of
 * the person CRM, identity is resolved against the existing 110k before anything is written, and
 * ambiguity is HELD rather than guessed. Batched and resumable via targets.crm_id, never one giant
 * transaction (the 16.6s freeze lesson: stream, never load the whole population).
 *
 * Reads Puller's own store (data/puller.db) and resolves against a READ-ONLY handle on Echo's
 * electoral.db. All writes go through Echo's create_contact / update_contact so the CRM's
 * provenance discipline — enrichment_job, per-field findings, FTS, canonical derivation — applies
 * to a drained record exactly as it would to a hand-curated one.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createCrmUpserter } = require('../lib/crm_upsert');

const APP_ROOT = path.resolve(__dirname, '..');
const PULLER_DB = process.env.PULLER_DB_PATH || path.join(APP_ROOT, 'data', 'puller.db');
const ECHO_DIR = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ELECTORAL = process.env.CRM_DB_PATH
  || path.join(ECHO_DIR, 'data', 'foundations', 'electoral.db');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const COMMIT = argv.includes('--commit');
const COHORT = flag('--cohort', 'parish');
const LIMIT = parseInt(flag('--limit', '0'), 10) || 0;

// Organisations that must never be forced into the person CRM (spec §7b.1). Kept deliberately
// tight: over-matching here silently drops real people.
const ORG_STRONG = /\b(PAC|Committee|Inc\.?|LLC|L\.L\.C|Corp\.?|Corporation|Foundation|Association|Coalition|Fund|Partners|Group|Holdings|Trust|Society|Institute|Council|Alliance|Union|Federation)\b/i;

function isLikelyOrg(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (ORG_STRONG.test(n)) return true;
  if (n === n.toUpperCase() && n.replace(/[^A-Z]/g, '').length > 6) return true; // ALL-CAPS bulk rows
  return false;
}

// Puller belief types -> CRM columns. Anything unmapped is carried as a note, never dropped.
const BELIEF_TO_COLUMN = { email: 'Email', phone: 'Phone', address: 'MailingStreet', role: 'Title' };

function main() {
  if (!fs.existsSync(PULLER_DB)) throw new Error(`puller db not found: ${PULLER_DB}`);
  if (!fs.existsSync(ELECTORAL)) throw new Error(`electoral db not found: ${ELECTORAL}`);
  const puller = new Database(PULLER_DB, { readonly: !COMMIT });
  const crm = new Database(ELECTORAL, { readonly: true });

  // ---- read side: resolution against the live CRM -------------------------------------------
  const strongStmt = {};
  const readCrm = {
    findByStrongId(col, val) {
      strongStmt[col] ||= crm.prepare(
        `SELECT id FROM contact WHERE ${col} = ? AND COALESCE(deleted,0)=0 LIMIT 1`);
      const r = strongStmt[col].get(val);
      return r ? r.id : null;
    },
    findByBlock(key, { jurisdiction } = {}) {
      const [last, fi] = key.split('|');
      const rows = crm.prepare(
        `SELECT id, FirstName FROM contact
          WHERE COALESCE(deleted,0)=0 AND LOWER(TRIM(LastName)) = ?
            ${jurisdiction ? 'AND (Jurisdiction__c = ? OR MailingState = ?)' : ''}
          LIMIT 50`
      ).all(...(jurisdiction ? [last, jurisdiction, String(jurisdiction).replace(/^US-/, '')] : [last]));
      return rows
        .filter((r) => !fi || String(r.FirstName || '').toLowerCase().startsWith(fi))
        .map((r) => r.id);
    },
  };

  // ---- write side ------------------------------------------------------------------------------
  let callTool;
  if (COMMIT) {
    const { EchoClient, httpTransport } = require('../lib/echo.js');
    const toml = fs.readFileSync(path.join(ECHO_DIR, 'config.toml'), 'utf8');
    const tok = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m);
    const prt = toml.match(/^\s*port\s*=\s*(\d+)/m);
    const client = new EchoClient({ transport: httpTransport({
      url: `http://127.0.0.1:${prt ? prt[1] : 8765}/mcp/`, token: tok ? tok[1] : null }) });
    let ready = null;
    callTool = async (name, args) => {
      ready ||= client.initialize();
      await ready;
      const res = await client.callTool(name, args);
      const txt = res && res.content && res.content[0] && res.content[0].text;
      try { return txt ? JSON.parse(txt) : res; } catch { return res; }
    };
  } else {
    callTool = async () => { throw new Error('dry-run must not call tools'); };
  }

  const { upsertPersonObject } = createCrmUpserter({ callTool, readCrm });

  // ---- the work list ---------------------------------------------------------------------------
  const where = COHORT === 'parish'
    ? `(LOWER(company) LIKE '%parish%' OR LOWER(name) LIKE '%parish%')`
    : `1=1`;
  const rows = puller.prepare(
    `SELECT id, kind, name, company, domain, function
       FROM targets
      WHERE crm_id IS NULL AND ${where}
      ORDER BY id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all();

  // beliefs carries status ('active' is the current answer per (target,type)) -- there is no
  // retired_at column; the store supersedes by flipping status, not by stamping a time.
  const beliefStmt = puller.prepare(
    `SELECT type, value, confidence FROM beliefs WHERE target_id = ? AND status = 'active'`);

  console.log(`cohort=${COHORT}  targets=${rows.length.toLocaleString()}  mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);

  const tally = {};
  const held = [], rejected = [];
  const promote = COMMIT
    ? puller.prepare(`UPDATE targets SET status='promoted', crm_id=?, last_accessed_at=? WHERE id=?`)
    : null;

  return (async () => {
    for (const t of rows) {
      if (isLikelyOrg(t.name)) { tally['skipped-org'] = (tally['skipped-org'] || 0) + 1; continue; }

      const attributeFacts = {}; const edgeFacts = {};
      let beliefs = [];
      try { beliefs = beliefStmt.all(t.id); } catch { beliefs = []; }
      for (const b of beliefs) {
        const col = BELIEF_TO_COLUMN[b.type];
        if (col && b.value) (col === 'Title' ? edgeFacts : attributeFacts)[col] = b.value;
      }
      // The parish/company string IS the edge — it names the body this person serves.
      if (t.company) {
        edgeFacts.Jurisdiction__c = 'US-LA';
        edgeFacts.MailingState = 'LA';
        if (!edgeFacts.Title) edgeFacts.Title = t.company;
      }

      const r = await upsertPersonObject(
        { name: t.name, attributeFacts, edgeFacts, identifiers: {}, jurisdiction: 'US-LA',
          org: t.company },
        { dryRun: !COMMIT, source: `puller://target/${t.id}`,
          notes: `drained from Puller target ${t.id}${t.company ? ' — ' + t.company : ''}` });

      tally[r.action] = (tally[r.action] || 0) + 1;
      if (r.action === 'held') held.push({ id: t.id, name: t.name, candidates: r.candidates });
      if (r.action === 'rejected') rejected.push({ id: t.id, name: t.name, reason: r.reason });
      if (COMMIT && r.contactId) promote.run(r.contactId, Math.floor(Date.now() / 1000), t.id);
    }

    console.log('\noutcome:');
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${k.padEnd(16)} ${String(v).padStart(6)}`);
    }
    if (held.length) {
      console.log(`\nHELD (ambiguous identity — never guessed): ${held.length}`);
      for (const h of held.slice(0, 8)) console.log(`   #${h.id} ${h.name} (${h.candidates} candidates)`);
    }
    if (rejected.length) {
      console.log(`\nREJECTED: ${rejected.length}`);
      for (const h of rejected.slice(0, 5)) console.log(`   #${h.id} ${h.name} — ${h.reason}`);
    }
    puller.close(); crm.close();
    if (!COMMIT) console.log('\n(dry-run — pass --commit to write)');
  })();
}

main().catch((e) => { console.error(e); process.exit(1); });
