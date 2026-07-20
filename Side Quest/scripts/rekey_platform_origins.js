/* scripts/rekey_platform_origins.js — re-key platform-hosted encounters onto their CHANNEL.
 *
 * W3 landed 1,703 news encounters with origin_host `youtube.com`: closed captions read off live news
 * channels, plus channel RSS — ABC News, CNN, Yahoo Finance, MeidasTouch, David Pakman, Brian Tyler
 * Cohen. Each is an independent publisher, and all of them shared one origin key, so eight channels
 * reporting the same story counted as ONE source.
 *
 * The channel was never missing — `news_items.source` has held it all along. It was discarded at the
 * origin step, which took the host and stopped. This recomputes origin_host as `youtube.com/<channel>`
 * from the item each encounter already cites.
 *
 * Deflation, not inflation: this can only RAISE independence, and only where the sources really are
 * distinct channels. Where the channel is unknown the encounter stays on the bare platform host.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/rekey_platform_origins.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../lib/db');
const og = require('../lib/origin');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nPLATFORM ORIGIN RE-KEY — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

// The publisher each news item named, keyed by the encounter's source_ref.
const news = new Database(path.join('data', 'news_bucket.db'), { readonly: true });
const publisherOf = new Map();
for (const r of news.prepare('SELECT id, source, source_url FROM news_items').iterate()) {
  publisherOf.set(`news:${r.id}`, { source: r.source, url: r.source_url });
}
news.close();

const rows = d.prepare("SELECT id, source_ref, origin, origin_host FROM encounters WHERE origin_host IS NOT NULL AND source_ref LIKE 'news:%'").all();
const updates = [];
let unnamed = 0;
for (const e of rows) {
  if (!og.isPlatformHost(e.origin_host)) continue;   // already a channel key, or an ordinary publisher
  const it = publisherOf.get(e.source_ref);
  if (!it) continue;
  const key = og.platformOrigin(it.url || e.origin, it.source);
  if (!key || key === e.origin_host) { unnamed += 1; continue; }
  updates.push({ id: e.id, key });
}

const byKey = {};
for (const u of updates) byKey[u.key] = (byKey[u.key] || 0) + 1;
console.log(`news encounters on a platform host: ${rows.filter((r) => og.isPlatformHost(r.origin_host)).length}`);
console.log(`  re-keyable to a named channel:    ${updates.length}`);
console.log(`  channel unknown (stays bare):     ${unnamed}`);
console.log(`  distinct channels:                ${Object.keys(byKey).length}`);
for (const [k, n] of Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${String(n).padStart(5)}  ${k}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const stmt = d.prepare('UPDATE encounters SET origin_host = ? WHERE id = ?');
d.transaction(() => { for (const u of updates) stmt.run(u.key, u.id); })();

const left = d.prepare("SELECT COUNT(*) c FROM encounters WHERE origin_host = 'youtube.com'").get().c;
console.log(`\n${'='.repeat(74)}\nAPPLIED — ${updates.length} encounter(s) re-keyed. ${left} remain on the bare platform host (channel genuinely unknown).`);
process.exit(0);
