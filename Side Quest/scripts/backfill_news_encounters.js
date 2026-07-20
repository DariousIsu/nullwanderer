/* scripts/backfill_news_encounters.js — replay the news bucket into the encounter log (W3).
 *
 * 40,196 clustered reports across 27,567 events, every one carrying a real publisher host and a real
 * publication date. This is the first material in the log that can reach grade A on evidence rather
 * than on assumption — the document corpus floors at 1 because its origins were never captured.
 *
 * EXCLUDED: 58,234 YouTube caption fragments. Their "title" is a mid-sentence transcript line, not an
 * event. Speech is its own lane.
 *
 * Append-only and idempotent — the unique index means a second run adds nothing.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_news_encounters.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../lib/db');
const ne = require('../lib/news_encounters');
const og = require('../lib/origin');
const enc = require('../lib/encounters');

db.init();
const APPLY = process.argv.includes('--apply');

console.log(`\nNEWS → ENCOUNTER LOG — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(76)}`);

const news = new Database(path.join('data', 'news_bucket.db'), { readonly: true });
const stories = new Map();
for (const r of news.prepare('SELECT id, cluster_key, title FROM news_stories').all()) stories.set(r.id, r);

const build = [];
const byEvent = new Map();
let skipped = 0;
for (const it of news.prepare('SELECT id, source_kind, source_url, title, summary, ts, story_id FROM news_items WHERE story_id IS NOT NULL').iterate()) {
  const st = stories.get(it.story_id);
  if (!st) { skipped += 1; continue; }
  const e = ne.toEncounter(it, st);
  if (!e) { skipped += 1; continue; }
  build.push(e);
  if (!byEvent.has(e.object_key)) byEvent.set(e.object_key, []);
  byEvent.get(e.object_key).push(e);
}
news.close();

console.log(`encounters to write   ${build.length}`);
console.log(`  skipped             ${skipped}  (video captions + unclustered)`);
console.log(`distinct events       ${byEvent.size}`);
console.log(`  all carry a date    ${build.every((e) => e.observed_at) ? 'yes' : 'NO — investigate'}`);

// What the evidence actually looks like once independence is applied.
const dist = {}; let gradeA = 0, syndicated = 0, simultaneous = 0;
for (const [, v] of byEvent) {
  const i = og.independence(v);
  dist[i.count] = (dist[i.count] || 0) + 1;
  if (i.count >= 3) gradeA += 1;
  if (i.syndicated) syndicated += 1;
  if (og.synchrony(v).simultaneous) simultaneous += 1;
}
console.log(`\nindependent sources per event: ${Object.entries(dist).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join('  ')}`);
console.log(`  events at 3+ independent sources: ${gradeA}`);
console.log(`  flagged syndicated (many origins, one text): ${syndicated}`);
console.log(`  flagged simultaneous (3+ inside an hour): ${simultaneous}  ← a burst is not confirmation`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

// Chunked so one very large transaction cannot hold the database while the app is running.
let added = 0, known = 0;
for (let i = 0; i < build.length; i += 2000) {
  const r = enc.recordMany(build.slice(i, i + 2000));
  added += r.added; known += r.alreadyKnown;
}
const s = enc.stats();
console.log(`\n${'='.repeat(76)}`);
console.log(`APPLIED — ${added} written, ${known} already known (idempotent, not a second vote).`);
console.log(`log now holds ${s.encounters} encounter(s) across ${s.objects} object(s).`);
for (const b of s.byClass) console.log(`  ${b.claim_class.padEnd(14)} ${b.c}`);
process.exit(0);
