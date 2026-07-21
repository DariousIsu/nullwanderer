/* scripts/merge_strong_id.js — apply T2's plan against graph_entities.
 *
 * lib/strong_id.js decides WHAT should merge; this is the store-specific arm that carries it out, the
 * same split identity_dedup uses. Live measurement behind it: 13,091 entities, 2,524 carrying a strong
 * id, 287 bare/tagged pairs of the same cleaned name — `Duke Energy` and `Duke Energy [Q1264404]` are two
 * rows for one company, and every fact about it is split across both.
 *
 * ── WHAT A MERGE ACTUALLY MOVES ─────────────────────────────────────────────────────────────────
 *
 * Rewiring the relations is the whole job; deleting the row is the easy part. Three things that would
 * silently corrupt the graph if skipped:
 *   SELF-EDGES     after rewiring, an edge between the two merged rows points at itself. Dropped.
 *   COLLISIONS     graph_relations is UNIQUE(source,target,type), so a rewire onto an edge that already
 *                  exists must be dropped rather than left to throw mid-transaction.
 *   CITATIONS      graph_citations.fact_id points at entity rows. Left behind, the evidence for a fact
 *                  stops resolving — and an uncited fact is exactly what this system refuses to keep.
 *
 * NOTHING IS GUESSED HERE. Every merge comes from a shared strong identifier or a bare name binding to
 * its single id-bearing twin, past all three of the planner's gates. Everything else prints under REVIEW
 * and is left alone.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write. --verbose prints the full review list.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/merge_strong_id.js [--apply] [--verbose]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const si = require('../lib/strong_id');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

console.log(`\nSTRONG-ID MERGE (T2) — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(80)}`);

const population = d.prepare(`
  SELECT e.id, e.name, e.entity_type,
         (SELECT COUNT(*) FROM graph_relations r
           WHERE (r.source_id = e.id OR r.target_id = e.id) AND COALESCE(r.deleted,0) = 0) degree
    FROM graph_entities e`).all();

const plan = si.planMerges(population);
console.log(`entities                  ${plan.stats.population}`);
console.log(`  carrying a strong id    ${plan.stats.withId}`);
console.log(`  MERGE                   ${plan.stats.merges}`);
console.log(`  held for review         ${plan.stats.review}`);

const byTier = {};
for (const m of plan.merges) byTier[m.tier] = (byTier[m.tier] || 0) + 1;
console.log(`  by tier                 ${JSON.stringify(byTier)}`);

const reasons = {};
for (const r of plan.review) reasons[String(r.reason).replace(/\d+/g, 'N').slice(0, 60)] = (reasons[String(r.reason).replace(/\d+/g, 'N').slice(0, 60)] || 0) + 1;
console.log(`\nHELD (nothing is done to these):`);
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
if (VERBOSE) for (const r of plan.review) console.log(`      ${r.rows.map((x) => `#${x.id}:${x.name}`).join('  ||  ')}`);

console.log(`\nMERGES (every one printed):`);
for (const m of plan.merges) {
  console.log(`  #${String(m.from).padStart(6)} ${String(m.fromName).slice(0, 34).padEnd(36)} → #${String(m.into).padStart(6)} ${String(m.intoName).slice(0, 34).padEnd(36)} ${m.tier}`);
}

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const stmts = {
  relSrc: d.prepare('UPDATE OR IGNORE graph_relations SET source_id = ? WHERE source_id = ?'),
  relTgt: d.prepare('UPDATE OR IGNORE graph_relations SET target_id = ? WHERE target_id = ?'),
  dropSrc: d.prepare('DELETE FROM graph_relations WHERE source_id = ?'),
  dropTgt: d.prepare('DELETE FROM graph_relations WHERE target_id = ?'),
  dropSelf: d.prepare('DELETE FROM graph_relations WHERE source_id = target_id'),
  cite: d.prepare(`UPDATE OR IGNORE graph_citations SET fact_id = ? WHERE fact_kind = 'entity' AND fact_id = ?`),
  dropCite: d.prepare(`DELETE FROM graph_citations WHERE fact_kind = 'entity' AND fact_id = ?`),
  del: d.prepare('DELETE FROM graph_entities WHERE id = ?'),
};

let rewired = 0, citesMoved = 0, dropped = 0;
d.transaction(() => {
  for (const m of plan.merges) {
    citesMoved += stmts.cite.run(m.into, m.from).changes;
    stmts.dropCite.run(m.from);                       // UPDATE OR IGNORE left the collisions behind
    rewired += stmts.relSrc.run(m.into, m.from).changes + stmts.relTgt.run(m.into, m.from).changes;
    stmts.dropSrc.run(m.from); stmts.dropTgt.run(m.from);   // whatever collided on the UNIQUE index
    dropped += stmts.del.run(m.from).changes;
  }
  stmts.dropSelf.run();
})();

console.log(`\n${'='.repeat(80)}`);
console.log(`APPLIED — ${dropped} row(s) absorbed, ${rewired} relation endpoint(s) rewired, ${citesMoved} citation(s) moved.`);
const dang = d.prepare(`SELECT COUNT(*) c FROM graph_relations r
                         WHERE NOT EXISTS (SELECT 1 FROM graph_entities e WHERE e.id = r.source_id)
                            OR NOT EXISTS (SELECT 1 FROM graph_entities e WHERE e.id = r.target_id)`).get();
console.log(`dangling relation endpoints after the merge: ${dang.c}  ${dang.c ? '← INVESTIGATE' : '(clean)'}`);
console.log(`self-edges: ${d.prepare('SELECT COUNT(*) c FROM graph_relations WHERE source_id = target_id').get().c}`);
process.exit(0);
