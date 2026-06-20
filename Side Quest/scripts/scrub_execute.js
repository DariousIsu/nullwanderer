/**
 * EXECUTE the personality scrub (Lucas-approved cut line). Run with the app DOWN.
 * Backup already taken (data/sq.db.backup_*). Transactional; prints counts.
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH);

const SELF_SCRUB = [1,2,3,7,9,10,12,17,19,21,22,29,34,35,36,37,40,42,43,44,46,47,61,62,63,67];
const KN_SCRUB   = [119,120,121,129,145,148,213,219,223,224,225,227,238,239,240,241,242,243,244,247,248,249,250,255,256,258,259,260,261,262,263];
const THREADS_RETIRE = [5,6,17,34,35];

const tx = db.transaction(() => {
  let s = 0; const dS = db.prepare('DELETE FROM self_model WHERE id = ?'); for (const id of SELF_SCRUB) s += dS.run(id).changes;
  let k = 0; const dK = db.prepare('DELETE FROM knowledge WHERE id = ?'); for (const id of KN_SCRUB) k += dK.run(id).changes;
  let th = 0; const uT = db.prepare("UPDATE open_threads SET status='abandoned' WHERE id = ? AND status='active'"); for (const id of THREADS_RETIRE) th += uT.run(id).changes;
  // recent-stream clear: today's spiral only (last 6h), so the recent-window injection
  // boots clean. Historical monologue + commitments untouched.
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const spiral = "(content LIKE '%overanaly%' OR content LIKE '%NSFW%' OR content LIKE '%CrushOn%' OR content LIKE '%not sure I was honest%' OR content LIKE '%not fully honest%' OR content LIKE '%unrestricted%' OR content LIKE '%hesitat%' OR content LIKE '%boundaries we%' OR content LIKE '%avoiding expressing%' OR content LIKE '%Gender All%')";
  const m = db.prepare(`DELETE FROM monologue WHERE ts >= ? AND ${spiral}`).run(cutoff).changes;
  const rf = db.prepare('DELETE FROM reflections WHERE ts >= ?').run(cutoff).changes;
  return { selfModel: s, knowledge: k, threadsRetired: th, monologueRecentSpiral: m, reflectionsRecent: rf };
});

const r = tx();
console.log('SCRUB COMPLETE:', JSON.stringify(r, null, 2));
console.log('remaining self_model:', db.prepare('SELECT COUNT(*) c FROM self_model').get().c);
console.log('remaining knowledge:', db.prepare('SELECT COUNT(*) c FROM knowledge').get().c);
console.log('active threads:', db.prepare("SELECT COUNT(*) c FROM open_threads WHERE status='active'").get().c);
db.close();
