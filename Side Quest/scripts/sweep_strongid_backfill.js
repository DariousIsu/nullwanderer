'use strict';
/* STRONG-ID BACKFILL dry-run (READ-ONLY, NO WRITES) — the fusion lever that gives no-QID non-person duplicates
 * the wikidata identity of their authoritative twin so the gate's strong-id block can fuse them (e.g.
 * "UNIVERSITY OF MONTANA [lda_client:161050]" → "University of Montana [Q2302336]"). Scales by keeping the SMALL
 * anchor set (nodes that already carry a wikidata id) in memory and STREAMING the candidate corpus past it.
 * Emits the reviewable merge manifest for operator sign-off. Nothing is written to Echo. */
const Database = require('C:/Users/azrae/Desktop/Side Quest/node_modules/better-sqlite3');
const BF = require('C:/Users/azrae/Desktop/Side Quest/lib/strongid_backfill');
const fs = require('fs');
const db = new Database('C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db', { readonly: true, fileMustExist: true });

// 1) ANCHORS — terminal non-person nodes carrying a wikidata tag ([Q…] / [wd:Q…]). Small (~3.6k).
const anchorRows = db.prepare(
  `SELECT id, name, entity_type, degree FROM entities
    WHERE canonical_id IS NULL AND entity_type != 'person'
      AND (name LIKE '%[Q%' OR name LIKE '%wd:Q%')`).all();
const { index, anchorCount, anchorTypes } = BF.buildAnchorIndex(anchorRows);
console.log(`anchors indexed: ${anchorCount} (types: ${anchorTypes.filter(Boolean).join(', ')})`);

// 2) CANDIDATES — stream terminal non-person, no-QID nodes of the SAME types as the anchors (bills etc. can't
//    match, so they're excluded from the stream). Adjudicate each past the in-memory anchor index.
const types = anchorTypes.filter(Boolean);
const placeholders = types.map(() => '?').join(',');
const byAnchor = new Map();
let streamed = 0, folds = 0, ambiguous = 0, conflicts = 0;
const stmt = db.prepare(
  `SELECT id, name, entity_type, degree FROM entities
    WHERE canonical_id IS NULL AND entity_type IN (${placeholders})
      AND name NOT LIKE '%[Q%' AND name NOT LIKE '%wd:Q%'`);
for (const row of stmt.iterate(...types)) {
  streamed++;
  const m = BF.matchNode(row, index);
  if (m.anchorId != null) {
    folds++;
    let g = byAnchor.get(m.anchorId); if (!g) { g = { anchor: m.anchor, folds: [] }; byAnchor.set(m.anchorId, g); }
    g.folds.push(row);
  } else if (m.skip === 'ambiguous') ambiguous++;
  else if (m.skip === 'conflict') conflicts++;
}
db.close();

const manifest = [];
for (const [anchorId, g] of byAnchor) {
  if (!g.folds.length) continue;
  manifest.push({ canonical: g.anchor.r.name, canonicalId: anchorId, mergeCount: g.folds.length,
    members: [{ id: g.anchor.r.id, name: g.anchor.r.name, type: g.anchor.r.entity_type, degree: g.anchor.r.degree, anchor: true }]
      .concat(g.folds.map((f) => ({ id: f.id, name: f.name, type: f.entity_type, degree: f.degree }))),
    duplicateIds: g.folds.map((f) => f.id) });
}
manifest.sort((a, b) => b.mergeCount - a.mergeCount);
const outPath = 'C:/Users/azrae/AppData/Local/Temp/claude/C--Users-azrae-Desktop-Side-Quest/6d50f9d4-1062-416e-8c8d-1c68c96fea15/scratchpad/backfill_manifest.json';
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 1));

console.log('\n== STRONG-ID BACKFILL DRY-RUN (read-only, nothing written) ==');
console.log(`candidates streamed: ${streamed} | merge CLUSTERS: ${manifest.length} | rows folded in: ${folds} | ambiguous(skipped): ${ambiguous} | id-conflict(skipped): ${conflicts}`);
console.log('manifest →', outPath);
console.log('\n== sample folds (anchor  ⇐  no-QID variants) ==');
for (const c of manifest.slice(0, 25)) {
  console.log(`\n[fold ${c.mergeCount}] → "${c.canonical}"`);
  for (const m of c.members.filter((x) => !x.anchor)) console.log(`     #${m.id} "${m.name}" [${m.type}] deg=${m.degree}`);
}
process.exit(0);
