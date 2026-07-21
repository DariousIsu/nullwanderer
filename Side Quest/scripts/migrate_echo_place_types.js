/* scripts/migrate_echo_place_types.js — resolve a contradiction Echo's own rows already carry.
 *
 * Lucas, from a UI card: Ann Arbor, Arcadia, Alma, Allendale, Algona, Algoma — every one showing as
 * "Organization". They are cities. The cause is the same one that produced Fulton County: a refresh lane
 * fetches MAYORS via Wikidata P6 ("head of government"), and the thing that HAS a mayor got filed as an
 * organization. The ROLE the entity appeared in became its TYPE.
 *
 * ── WHY THIS NEEDS NO INFERENCE AT ALL ──────────────────────────────────────────────────────────
 *
 * The rows already say `entity_subtype = 'place'`. They were written by
 *   VALUES (?, 'organization', 'place', …)
 * with the type as a hardcoded literal beside a correct subtype. So this is not a judgement about what
 * these things are — it is a row disagreeing with itself, and the subtype is the side that is right.
 * Exactly the shape of T1: the data already knew, and the code discarded it.
 *
 * ── WHAT IS DELIBERATELY NOT TOUCHED ────────────────────────────────────────────────────────────
 *
 * `entity_subtype` of 'county' or 'state_government' typed organization is NOT a contradiction — whether
 * a county is a place or a governing body is a real question about the world, and it belongs to the
 * graded type-claim ladder, not to a sweep. Likewise the 1,631 lobby_client rows with governmental
 * names (SALT LAKE COUNTY, COBB COUNTY): that set contains THE FERGUSON GROUP, LLC FOR CITY OF
 * OCEANSIDE CA (a lobbying firm) and HOUSING AUTHORITY OF CITY OF ATLANTA (an authority, not the city),
 * so a name rule would mistype both. Held.
 *
 * TARGETS ECHO'S civic_graph.db, with Lucas's explicit sign-off (2026-07-21).
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/migrate_echo_place_types.js [--apply]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db';
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(DB)) { console.error(`no database at ${DB}`); process.exit(1); }

console.log(`\nECHO PLACE RE-TYPE — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);
console.log(`db: ${DB}`);

const d = new Database(DB, { readonly: !APPLY });

// The contradiction, and nothing else: type says organization, the row's own subtype says place.
const SEL = `SELECT id, name, entity_type, entity_subtype, proposed_by, wikidata_qid
               FROM entities WHERE entity_type = 'organization' AND entity_subtype = 'place'`;
const rows = d.prepare(SEL).all();

const byProposer = {};
for (const r of rows) byProposer[r.proposed_by || '(none)'] = (byProposer[r.proposed_by || '(none)'] || 0) + 1;

console.log(`\nrows contradicting themselves (organization + subtype place)   ${rows.length}`);
for (const [k, v] of Object.entries(byProposer).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\nsample:`);
for (const r of rows.slice(0, 12)) console.log(`   #${String(r.id).padStart(7)} ${String(r.name).slice(0, 44).padEnd(46)} ${r.wikidata_qid || ''}`);

// A name collision would mean two rows for one place; report it rather than discovering it mid-write.
const collide = d.prepare(`SELECT COUNT(*) c FROM entities a
   WHERE a.entity_type = 'organization' AND a.entity_subtype = 'place'
     AND EXISTS (SELECT 1 FROM entities b WHERE b.entity_type = 'place' AND b.name = a.name AND b.id <> a.id)`).get();
console.log(`\nnames that ALREADY exist as a place row: ${collide.c}  ${collide.c ? '← would be duplicates, reported not merged' : '(none)'}`);

console.log(`\nHELD — not a contradiction, so not this script's business:`);
for (const sub of ['county', 'state_government', 'lobby_client']) {
  const c = d.prepare(`SELECT COUNT(*) c FROM entities WHERE entity_type='organization' AND entity_subtype=?`).get(sub).c;
  console.log(`  ${String(c).padStart(6)}  organization/${sub}`);
}

if (!APPLY) { d.close(); console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

// A backup before touching the owner's graph. Cheap insurance against a bad WHERE clause.
// slice(0,14) — YYYYMMDDHHMMSS. An earlier 15 kept the dot before the milliseconds and produced
// `civic_graph.pre-placetype.20260721134248..db`.
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(path.dirname(DB), `civic_graph.pre-placetype.${stamp}.db`);
d.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
console.log(`\nbackup written: ${backup}`);

const info = d.prepare(`UPDATE entities SET entity_type = 'place', updated_at = ?
                         WHERE entity_type = 'organization' AND entity_subtype = 'place'`).run(Math.floor(Date.now() / 1000));

console.log(`${'='.repeat(78)}`);
console.log(`APPLIED — ${info.changes} row(s) re-typed organization → place.`);
console.log(`remaining contradictions: ${d.prepare(SEL).all().length}`);
console.log(`place rows now: ${d.prepare(`SELECT COUNT(*) c FROM entities WHERE entity_type='place'`).get().c}`);
d.close();
process.exit(0);
