/* scripts/route_derive_report.js — run P1 derivation over the observation log and print the routes.
 * Read-only. Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/route_derive_report.js [hours]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const rd = require('../lib/route_derive');

const HOURS = Number(process.argv[2]) || 6;
db.init();
const d = db.getDb();
const since = Date.now() - HOURS * 3600 * 1000;

// only linked-era rows (seq not null) carry the causal chain P1 needs
const rows = d.prepare(
  `SELECT id, focus_id, tool, arg_shape, outcome, latency_ms, seq, parent_id
   FROM route_obs WHERE ts > ? AND seq IS NOT NULL ORDER BY ts`).all(since);

const rep = rd.derive(rows);
console.log(`\nP1 ROUTE DERIVATION — last ${HOURS}h\n${'='.repeat(76)}`);
console.log(`observations: ${rep.linkedObservations} linked | chains: ${rep.chains} | templates: ${rep.summary.totalTemplates}`);
console.log(`\n${rep.summary.note}\n`);

const fmtTail = (t) => `${t.hit}h/${t.miss}m/${t.err}e`;
console.log(`TOP ROUTE TEMPLATES (by instances):`);
console.log(`  ${'inst'.padStart(5)} ${'foci'.padStart(4)} ${'len'.padStart(3)} ${'ceil(s)'.padStart(8)}  tail        route`);
for (const t of rep.templates.slice(0, 20)) {
  const flag = t.crossEpisode ? '★' : ' ';
  console.log(`${flag} ${String(t.count).padStart(5)} ${String(t.focusCount).padStart(4)} ${String(t.length).padStart(3)} ${String(Math.round(t.savingsCeilingMs / 1000)).padStart(8)}  ${fmtTail(t.tail).padEnd(10)}  ${t.key}`);
}

if (rep.crossEpisodeTemplates.length) {
  console.log(`\n★ CROSS-EPISODE (candidate durable routes — recur across >1 focus):`);
  for (const t of rep.crossEpisodeTemplates.slice(0, 12))
    console.log(`   ${t.count}x over ${t.focusCount} foci  ceil ${Math.round(t.savingsCeilingMs / 1000)}s  ${t.key}`);
} else {
  console.log(`\n(no cross-episode templates yet — accumulate more focuses before trusting routes to generalise)`);
}

// total savings ceiling across all templates, and the honest caveat
const ceil = rep.templates.reduce((a, t) => a + t.savingsCeilingMs, 0);
console.log(`\nTOTAL SAVINGS CEILING: ${Math.round(ceil / 1000)}s`);
console.log(`  UPPER BOUND only — real replay pays a match cost and must invalidate on graph change`);
console.log(`  (Minton). P2's utility gate measures the real number; this just sizes the opportunity.`);
process.exit(0);
