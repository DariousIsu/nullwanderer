/* E0 — one-time janitorial cleanup of the video-watch pollution found in the 2026-06-29 audit.
 *   (1) DEDUP media_watch knowledge nodes — keep the NEWEST node per YouTube video id, delete older
 *       re-watch duplicates (42 nodes for 15 videos → 15). Never deletes a node referenced as a parent.
 *   (2) DELETE the ONE contaminated self_model row — Lucas's 2nd-person critique mis-stored as her
 *       1st-person belief ("I am picking on my video jumping around…"). Keeps all other self-model rows
 *       (per Lucas: video MAY inform self-model; only the critique-grounding leak is wrong).
 *
 * SAFE: defaults to DRY-RUN (reports, writes nothing). With --apply it first makes a CONSISTENT backup
 * via SQLite's online backup API, then deletes inside a single transaction with a busy_timeout (so a
 * concurrent app write can't collide). SQLite is ACID — no corruption risk from the live app.
 *
 * Run (report only):  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/maintenance_e0_cleanup.js
 * Run (apply):        ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/maintenance_e0_cleanup.js --apply
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const APPLY = process.argv.includes('--apply');
const DBP = path.join(ROOT, 'data', 'sq.db');

const db = new Database(DBP);
db.pragma('busy_timeout = 8000');

const vidOf = (content) => { const m = String(content).match(/watch\?v=([\w-]+)/); return m ? m[1] : null; };

// --- (1) media dedup plan ---
const media = db.prepare(`SELECT id, content, importance, created_ts FROM knowledge WHERE source='media_watch'`).all();
const groups = {};
for (const r of media) { const v = vidOf(r.content) || `__noid_${r.id}`; (groups[v] = groups[v] || []).push(r); }
const parentIds = new Set(db.prepare(`SELECT DISTINCT parent_id FROM knowledge WHERE parent_id IS NOT NULL`).all().map(r => r.parent_id));
const toDelete = [];
for (const [vid, rows] of Object.entries(groups)) {
  if (rows.length <= 1) continue;
  rows.sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));   // newest first
  const keep = rows[0];
  for (const r of rows.slice(1)) {
    if (parentIds.has(r.id)) continue;   // never delete a node something else hangs off of
    toDelete.push({ id: r.id, vid, created: r.created_ts });
  }
}

// --- (2) the contaminated self_model row ---
const badSelf = db.prepare(`SELECT id, content, importance FROM self_model WHERE content LIKE '%picking on my video jumping around%'`).all();

console.log(`========== E0 CLEANUP (${APPLY ? 'APPLY' : 'DRY-RUN'}) ==========\n`);
console.log(`media_watch nodes: ${media.length} across ${Object.keys(groups).length} videos → will delete ${toDelete.length} duplicates, keep ${media.length - toDelete.length}`);
for (const [vid, rows] of Object.entries(groups)) { if (rows.length > 1) console.log(`   ${vid}: ${rows.length} → keep 1 (newest), delete ${rows.length - 1}`); }
console.log(`\ncontaminated self_model rows to delete: ${badSelf.length}`);
for (const r of badSelf) console.log(`   #${r.id} (imp ${r.importance}): ${String(r.content).slice(0, 90)}`);

if (!APPLY) { console.log('\n(DRY-RUN — nothing written. Re-run with --apply to execute.)'); db.close(); process.exit(0); }

// --- backup (consistent online copy) then delete in one transaction ---
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const bak = path.join(ROOT, 'data', `sq.db.preE0_${stamp}`);
db.backup(bak).then(() => {
  console.log(`\n[backup] consistent copy → ${path.basename(bak)}`);
  const delK = db.prepare(`DELETE FROM knowledge WHERE id = ?`);
  const delS = db.prepare(`DELETE FROM self_model WHERE id = ?`);
  const tx = db.transaction(() => {
    let k = 0, s = 0;
    for (const r of toDelete) k += delK.run(r.id).changes;
    for (const r of badSelf) s += delS.run(r.id).changes;
    return { k, s };
  });
  const res = tx();
  const after = db.prepare(`SELECT COUNT(*) n FROM knowledge WHERE source='media_watch'`).get().n;
  console.log(`[apply] deleted ${res.k} media duplicates + ${res.s} self_model row(s). media_watch now: ${after}`);
  db.close();
  console.log('\n========== DONE ==========');
}).catch(e => { console.error('[backup] failed — NOTHING deleted:', e.message); db.close(); process.exit(1); });
