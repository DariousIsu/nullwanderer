/* scripts/cleanup_video_islands.js — retroactive prune of the PRE-FIX caption junk: raw-title (ALL-CAPS / ">>"),
 * single-source, PURE-video ISLAND stories with garbage 15+ entity_sets that never merged with the wire and were
 * never Echo-promoted. Forward captures are already clean (8bf0906, chunked reconstruction); this clears the
 * historical pollution from recall + the story count. Deletes the story + its member items + its story_updates.
 * Leaves clean/reconstructed video stories, any video+wire merges, and all wire/aggregator stories untouched.
 *
 * DEFAULT = DRY-RUN (counts + sample, zero writes). Pass --execute to BACK UP news_bucket.db, then delete in a txn.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/cleanup_video_islands.js [--execute]
 */
'use strict';
const path = require('path'), fs = require('fs');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const L = (s) => console.log(s);
const nd = require(path.join(SQ, 'lib', 'news_db'));
const db = nd.get();
db.pragma('busy_timeout = 8000');   // the app is LIVE on this DB (WAL) — wait for its write lock, don't fail

// The junk signature: raw title, single-source (never corroborated), NOT Echo-promoted, and EVERY member is
// video (a pure broadcast island — NOT a good video+wire merge, which we keep).
const TARGET = `
  SELECT s.id FROM news_stories s
  WHERE (s.title LIKE '%>>%' OR (s.title = UPPER(s.title) AND s.title <> LOWER(s.title)))
    AND COALESCE(s.outlet_count, 1) <= 1
    AND (s.event_ref IS NULL OR s.event_ref = '')
    AND EXISTS     (SELECT 1 FROM news_items i WHERE i.story_id = s.id AND i.source_kind = 'video')
    AND NOT EXISTS (SELECT 1 FROM news_items i WHERE i.story_id = s.id AND i.source_kind <> 'video')`;
const one = (s, ...p) => db.prepare(s).get(...p);

async function makeBackup(dest) {
  if (typeof db.backup === 'function') { await db.backup(dest); return 'online-backup'; }
  db.pragma('wal_checkpoint(TRUNCATE)');          // fold WAL into the main file, then a plain copy is consistent
  fs.copyFileSync(nd.DB_PATH, dest);
  return 'file-copy';
}

(async () => {
  const execute = process.argv.includes('--execute');
  const totBefore = one('SELECT COUNT(*) n FROM news_stories').n;
  const nStories = one('SELECT COUNT(*) n FROM (' + TARGET + ')').n;
  const nItems = one('SELECT COUNT(*) n FROM news_items WHERE story_id IN (' + TARGET + ')').n;
  const nUpdates = one('SELECT COUNT(*) n FROM news_story_updates WHERE story_id IN (' + TARGET + ')').n;
  const promoted = one('SELECT COUNT(*) n FROM news_stories s WHERE s.id IN (' + TARGET + ") AND s.event_ref IS NOT NULL AND s.event_ref <> ''").n;

  L('=== CLEANUP: raw-title pure-video ISLAND stories ===');
  L('  target stories:          ' + nStories + '  (of ' + totBefore + ' total)');
  L('  member items to delete:  ' + nItems);
  L('  story_updates to delete: ' + nUpdates);
  L('  Echo-promoted in target: ' + promoted + '  (MUST be 0)');
  L('  sample titles:');
  for (const r of db.prepare('SELECT title FROM news_stories WHERE id IN (' + TARGET + ') LIMIT 6').all()) L('    | ' + String(r.title || '').replace(/\s+/g, ' ').slice(0, 86));

  if (promoted > 0) { L('\nABORT: some targets are Echo-promoted — refusing to delete (would orphan an event).'); process.exit(1); }
  if (!execute) { L('\nDRY-RUN — no changes made. Re-run with --execute to back up + delete.'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(SQ, 'data', 'news_bucket.backup-' + stamp + '.db');
  L('\nbacking up news_bucket.db → ' + path.relative(SQ, backup));
  let mode;
  try { mode = await makeBackup(backup); } catch (e) { L('backup FAILED: ' + e.message + ' — NO deletion performed'); process.exit(1); }
  L('  backup ok (' + mode + '), ' + (fs.statSync(backup).size / 1e6).toFixed(1) + ' MB');

  const ids = db.prepare(TARGET).all().map((r) => r.id);   // SNAPSHOT ids BEFORE deleting (the TARGET EXISTS-clauses shift as items go)
  const del = db.transaction((idList) => {
    let u = 0, i = 0, s = 0;
    for (let k = 0; k < idList.length; k += 500) {
      const part = idList.slice(k, k + 500), ph = part.map(() => '?').join(',');
      u += db.prepare('DELETE FROM news_story_updates WHERE story_id IN (' + ph + ')').run(...part).changes;
      i += db.prepare('DELETE FROM news_items WHERE story_id IN (' + ph + ')').run(...part).changes;
      s += db.prepare('DELETE FROM news_stories WHERE id IN (' + ph + ')').run(...part).changes;
    }
    return { u, i, s };
  });
  const r = del(ids);
  const totAfter = one('SELECT COUNT(*) n FROM news_stories').n;
  L('\ndeleted: ' + r.s + ' stories, ' + r.i + ' items, ' + r.u + ' updates');
  L('news_stories: ' + totBefore + ' → ' + totAfter);
  L('restore with the backup if anything looks wrong: ' + path.relative(SQ, backup));
  process.exit(0);
})().catch((e) => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
