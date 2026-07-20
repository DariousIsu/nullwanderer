/* scripts/collapse_open_threads.js — one-off cleanup of the open_threads backlog.
 *
 * Thread adoption (open_threads.matchCarriedThread, wired into seedBeatRun) stops NEW duplicate
 * commitments being minted. It does nothing about the ones already in the table: on 2026-07-19 one
 * request from Lucas existed as 7+ near-identical threads, and 11 of 32 open threads had been
 * untouched for 7+ days with action_count 0.
 *
 * This links duplicates under a single surviving thread using the SAME structural matcher the live
 * path uses — no second definition of "same commitment" that could disagree with it.
 *
 * DRY RUN BY DEFAULT. Prints the plan and changes nothing. Pass --apply to write.
 * Nothing is deleted and no status is changed: children keep their own lifecycle and simply stop
 * standing as separate commitments (getActiveOpenThreads filters parent_id IS NOT NULL). Reversible
 * by clearing parent_id.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/collapse_open_threads.js
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/collapse_open_threads.js --apply
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));

const APPLY = process.argv.includes('--apply');
const db = require('../lib/db');
db.init();
const ot = require('../lib/open_threads');
const beats = require('../lib/beats');

function main() {
  const open = db.getActiveOpenThreads(500, { includeStalled: true });
  console.log(`open threads (root, pending/active/stalled): ${open.length}`);

  // Every state that has a county-tier beat is a candidate scope. Using the beats themselves keeps
  // this consistent with what the live adoption path would decide for the same rows.
  const scopes = beats.listCountyStates().map(code => beats.beatScope(beats.countyCommissionBeat(code))).filter(Boolean);

  const planned = new Map();          // childId -> parentId
  const groups = [];
  for (const scope of scopes) {
    const m = ot.matchCarriedThread(scope, open.filter(t => !planned.has(t.id)));
    if (!m.adopt || !m.duplicates.length) continue;
    const kept = [];
    for (const d of m.duplicates) {
      if (planned.has(d.id) || d.id === m.adopt.id) continue;
      planned.set(d.id, m.adopt.id);
      kept.push(d);
    }
    if (kept.length) groups.push({ scope: scope.stateName, adopt: m.adopt, duplicates: kept });
  }

  if (!groups.length) { console.log('\nNothing to collapse.'); }
  for (const g of groups) {
    console.log(`\n[${g.scope}] keep #${g.adopt.id}: ${String(g.adopt.content).replace(/\s+/g, ' ').slice(0, 90)}`);
    for (const d of g.duplicates) {
      console.log(`        merge #${d.id}: ${String(d.content).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  console.log(`\nwould link ${planned.size} duplicate thread(s) under ${groups.length} surviving commitment(s)`);

  // Staleness report — NOT acted on here. curator.curateThreads already ages active/pending → stalled
  // at 10d and stalled → abandoned at 24d; duplicating that decay with a different threshold in a
  // one-off script is how two mechanisms end up disagreeing about the same rows.
  const now = Date.now();
  const ageDays = t => Math.round((now - (t.last_touched_ts > 1e12 ? t.last_touched_ts : t.last_touched_ts * 1000)) / 86400000);
  const stale = open.filter(t => !planned.has(t.id) && ageDays(t) >= 7);
  if (stale.length) {
    console.log(`\n${stale.length} thread(s) 7d+ untouched — left to curator.curateThreads (stalls at 10d).`);
    console.log('They now show in her prompt labelled "not touched", so they are no longer claimed as in-progress:');
    for (const t of stale) console.log(`   ${String(ageDays(t)).padStart(3)}d  #${t.id} ${String(t.content).replace(/\s+/g, ' ').slice(0, 80)}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.'); return; }
  let n = 0;
  for (const [childId, parentId] of planned) {
    try { db.setOpenThreadParent(childId, parentId); n++; } catch (e) { console.error(`  #${childId} failed:`, e.message); }
  }
  console.log(`\nAPPLIED — linked ${n} duplicate thread(s).`);
}

main();
