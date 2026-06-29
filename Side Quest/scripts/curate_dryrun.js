/* Dry-run the Slice 1a local pre-clean against the LIVE db. READ-ONLY (apply=false → no writes).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_dryrun.js
 */
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

db.init();
const r = curator.preClean({ apply: false });

console.log('=== Slice 1a pre-clean — DRY RUN (no writes) ===');
console.log(`knowledge rows: ${r.knowledge_before}`);
console.log('\n[Job A] quarantine prune:');
console.log(`  stale focus_tombstones (>48h):   ${r.quarantine.detail.stale_tombstones}`);
console.log(`  recent tombstones kept (spawn):  ${r.quarantine.detail.kept_recent_tombstones}`);
console.log(`  reflection_speculation:          ${r.quarantine.detail.speculation}`);
console.log(`  → would prune:                   ${r.quarantine.pruneIds.length} rows (${(100 * r.quarantine.pruneIds.length / r.knowledge_before).toFixed(1)}% of store)`);

console.log('\n[Job B] self_evolution merge (report-only):');
console.log(`  self_evolution rows:             ${r.self_evolution.rows}`);
console.log(`  multi-row clusters:              ${r.self_evolution.clusters.length}`);
console.log(`  would collapse:                  ${r.self_evolution.would_collapse} dup rows`);
for (const c of r.self_evolution.clusters.slice(0, 8)) {
  console.log(`    · ${c.size}× → keep #${c.keepId}  "${c.sample}"`);
}

const projected = r.knowledge_before - r.quarantine.pruneIds.length - r.self_evolution.would_collapse;
console.log(`\nprojected store after full pre-clean: ${r.knowledge_before} → ${projected} (Job A applied + Job B when cloud stage lands)`);
db.getDb().close();
