'use strict';
/* S4 DRY-RUN batch sweep (READ-ONLY, NO WRITES) — runs the SAME gate (entity_match.matchPair) over the whole
 * civic_graph.db as a backlog sweep (Swoosh: write-path == batch). Emits the MERGE MANIFEST: every cluster the
 * matcher would CONFIDENTLY merge (decision 'match' — strong-id or person full-name+jurisdiction+corroboration;
 * non-persons only via a shared strong id), with the canonical survivor (entity_fuse.canonicalForm) and the
 * members to fold in. This is the exact, reviewable apply-set for operator sign-off. Nothing is written. */
const Database = require('C:/Users/azrae/Desktop/Side Quest/node_modules/better-sqlite3');
const EM = require('C:/Users/azrae/Desktop/Side Quest/lib/entity_match');
const FUSE = require('C:/Users/azrae/Desktop/Side Quest/lib/entity_fuse');
const fs = require('fs');
const db = new Database('C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db', { readonly: true, fileMustExist: true });

// canonical_id-aware: ONLY terminal entities (canonical_id IS NULL) are merge candidates. This structurally
// excludes the ~10.8k already-aliased nodes (the prior manifest's staleness bug — it re-listed nodes already
// folded into other canonicals, so merge_entities rejected/mis-survivor'd them) and guarantees every survivor
// is a real terminal node, not a non-terminal alias.
const blocks = new Map();   // normKey|jur → [{id,name,type,degree}]
for (const row of db.prepare('SELECT id, name, entity_type AS et, degree FROM entities WHERE canonical_id IS NULL').iterate()) {
  const p = EM.parseEntity({ name: row.name, type: row.et });
  if (!p.normKey) continue;
  const bk = `${p.normKey}|${p.jurisdiction || ''}`;
  let a = blocks.get(bk); if (!a) { a = []; blocks.set(bk, a); }
  if (a.length < 200) a.push({ id: row.id, name: row.name, type: row.et, degree: row.degree });
}
db.close();

const CAP = 80;
const manifest = [];
let oversized = 0;
for (const [, arr] of blocks) {
  if (arr.length < 2) continue;
  if (arr.length > CAP) { oversized++; continue; }
  const parsed = arr.map((r) => EM.parseEntity({ name: r.name, type: r.type }));
  const parent = arr.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let anyMatch = false;
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    if (EM.matchPair(parsed[i], parsed[j]).decision === 'match') { parent[find(i)] = find(j); anyMatch = true; }
  }
  if (!anyMatch) continue;
  const groups = new Map();
  for (let i = 0; i < arr.length; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(arr[i]); }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // survivor via the SAME degree+noise scoring the live gate uses (entity_fuse.canonicalForm) — record the
    // survivor's real id so the apply targets the exact terminal node, not a fragile name-match.
    const canon = FUSE.canonicalForm(members.map((m) => ({ name: m.name, degree: m.degree })));
    const survivor = members.find((m) => m.name === canon.canonicalName) || members[0];
    manifest.push({ canonical: canon.canonicalName, canonicalId: survivor.id, mergeCount: members.length - 1,
      members: members.map((m) => ({ id: m.id, name: m.name, type: m.type, degree: m.degree })) });
  }
}
manifest.sort((a, b) => b.mergeCount - a.mergeCount);
const totalMerges = manifest.reduce((s, c) => s + c.mergeCount, 0);
const outPath = 'C:/Users/azrae/AppData/Local/Temp/claude/C--Users-azrae-Desktop-Side-Quest/6d50f9d4-1062-416e-8c8d-1c68c96fea15/scratchpad/sweep_manifest.json';
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 1));

console.log('== S4 DRY-RUN SWEEP MANIFEST (read-only, nothing written to Echo) ==');
console.log('merge CLUSTERS:', manifest.length, ' | total rows folded in:', totalMerges, ' | oversized blocks skipped:', oversized);
console.log('manifest →', outPath);
console.log('\n== sample merges (canonical  ⇐  members) ==');
for (const c of manifest.slice(0, 22)) {
  console.log(`\n[fold ${c.mergeCount}] → "${c.canonical}"`);
  for (const m of c.members) console.log(`     #${m.id} "${m.name}" [${m.type}]`);
}
process.exit(0);
