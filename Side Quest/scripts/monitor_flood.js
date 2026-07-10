/* scripts/monitor_flood.js — MONITOR (do not undo) what the autonomous system does with a bulk drop of
 * context-poor person targets (the "wrong spreadsheet" flood). Pins the cohort at baseline (a fixed id set)
 * and, on each re-run, reports what has HAPPENED to those exact records: enriched (company/domain/beliefs),
 * deduped (merged_into), promoted to the civic graph, or still sitting as raw adhoc. The immune system in
 * motion — dedup, enrichment, the context-free prune GC — observed, not touched.
 *
 * Run once to capture the baseline, then re-run any time to see the diff:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/monitor_flood.js [capture]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const bs = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const PULLER = path.join(__dirname, '..', 'data', 'puller.db');
const CIVIC = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db';
const BASELINE = path.join(__dirname, '..', 'data', 'flood_cohort_baseline.json');
const WINDOW_H = 3;   // the drop happened in a tight window; the flood signature = adhoc + blank company

function cohortState(db, ids) {
  // per-target current state for a fixed id set
  const q = db.prepare(`SELECT id, COALESCE(status,'') status, COALESCE(company,'') company,
    COALESCE(domain,'') domain, merged_into FROM targets WHERE id = ?`);
  const hasBelief = db.prepare("SELECT 1 FROM beliefs WHERE target_id = ? AND type='email' LIMIT 1");
  const out = { total: ids.length, byStatus: {}, merged: 0, withCompany: 0, withEmail: 0, stillRawAdhoc: 0 };
  for (const id of ids) {
    const r = q.get(id);
    if (!r) { out.byStatus['(deleted)'] = (out.byStatus['(deleted)'] || 0) + 1; continue; }
    out.byStatus[r.status || '(none)'] = (out.byStatus[r.status || '(none)'] || 0) + 1;
    if (r.merged_into != null) out.merged++;
    if (r.company) out.withCompany++;
    if (hasBelief.get(id)) out.withEmail++;
    if ((r.status === 'adhoc') && !r.company && !r.domain && r.merged_into == null && !hasBelief.get(id)) out.stillRawAdhoc++;
  }
  return out;
}

function promotedToCivic(cohortNames) {
  // did any cohort NAME land as a civic entity (promotion out of the prospecting store into the public graph)?
  try {
    const c = bs(`file:${CIVIC}?mode=ro`, { readonly: true });
    const stmt = c.prepare('SELECT COUNT(*) n FROM entities WHERE name = ? AND entity_type = ?');
    let n = 0;
    for (const nm of cohortNames) { try { if (stmt.get(nm, 'person').n) n++; } catch {} }
    c.close();
    return n;
  } catch { return null; }
}

function main() {
  const db = bs(PULLER, { readonly: true });
  const capture = process.argv.includes('capture') || !fs.existsSync(BASELINE);

  if (capture) {
    // pin the flood cohort: adhoc + blank company, created in the last WINDOW_H hours (ms epoch)
    const cutoff = Date.now() - WINDOW_H * 3600 * 1000;
    const rows = db.prepare(`SELECT id, name FROM targets WHERE created_at > ?
      AND COALESCE(status,'')='adhoc' AND COALESCE(company,'')='' ORDER BY id`).all(cutoff);
    const ids = rows.map((r) => r.id);
    const names = rows.map((r) => r.name);
    const base = { capturedAt: Date.now(), windowHours: WINDOW_H, count: ids.length, ids, names,
                   baseline: cohortState(db, ids) };
    fs.writeFileSync(BASELINE, JSON.stringify(base));
    console.log(`[flood-monitor] BASELINE captured: ${ids.length} context-poor person targets pinned.`);
    console.log('  baseline state:', JSON.stringify(base.baseline));
    db.close();
    return;
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const now = cohortState(db, base.ids);
  const civic = promotedToCivic(base.names);
  const ageH = ((Date.now() - base.capturedAt) / 3600000).toFixed(1);
  db.close();

  const b = base.baseline;
  const d = (k) => (now[k] || 0) - (b[k] || 0);
  console.log(`\n[flood-monitor] cohort of ${base.count} pinned ${ageH}h ago — what the system did with it:`);
  console.log(`  status now:        ${JSON.stringify(now.byStatus)}`);
  console.log(`  enriched (company): ${now.withCompany}   (Δ ${d('withCompany') >= 0 ? '+' : ''}${d('withCompany')})`);
  console.log(`  found an email:     ${now.withEmail}      (Δ ${d('withEmail') >= 0 ? '+' : ''}${d('withEmail')})`);
  console.log(`  deduped (merged):   ${now.merged}         (Δ ${d('merged') >= 0 ? '+' : ''}${d('merged')})`);
  console.log(`  promoted to civic:  ${civic == null ? 'n/a' : civic}`);
  console.log(`  still raw adhoc:    ${now.stillRawAdhoc} / ${base.count}   (Δ ${d('stillRawAdhoc') >= 0 ? '+' : ''}${d('stillRawAdhoc')})`);
  const moved = base.count - now.stillRawAdhoc;
  console.log(`  → the system has TOUCHED ${moved}/${base.count} (${((100 * moved) / base.count).toFixed(0)}%) so far.`);
}

main();
