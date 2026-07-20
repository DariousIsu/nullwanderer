/* scripts/backfill_doc_origin.js — populate content_hash (and origin where recoverable) on the
 * existing document corpus.
 *
 * content_hash is fully recoverable: it is a function of bytes we already hold, so the whole corpus can
 * be back-filled exactly. That alone closes blocker #1 — the measured 11.6% byte-identical duplication
 * that was already inflating corroboration counts (a person reading `doc_count: 5` from 3 real texts).
 *
 * ORIGIN IS MOSTLY NOT RECOVERABLE, and this script does not pretend otherwise. It is only inferable
 * where a `ref` happens to carry a URL. A guessed origin is worse than a null one: it would create
 * false independence, which inflates grades — the exact failure the design warns about. Everything
 * ingested before the capture hooks landed simply has no origin, permanently, and that is the honest
 * state.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_doc_origin.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const og = require('../lib/origin');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nDOCUMENT ORIGIN / CONTENT-HASH BACKFILL — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

const rows = d.prepare('SELECT id, ref, body, content_hash, origin FROM documents WHERE body IS NOT NULL').all();
let needHash = 0, gotOrigin = 0;
const updates = [];
for (const r of rows) {
  const hash = r.content_hash || og.contentHash(r.body);
  // A ref sometimes IS a url (some lanes stored one); never invent otherwise.
  let origin = r.origin || null;
  if (!origin && r.ref && /^https?:\/\//i.test(String(r.ref))) origin = og.normalizeUrl(r.ref);
  if (!r.content_hash && hash) needHash += 1;
  if (!r.origin && origin) gotOrigin += 1;
  if ((!r.content_hash && hash) || (!r.origin && origin)) updates.push({ id: r.id, hash, origin, host: origin ? og.hostOf(origin) : null });
}

console.log(`documents:            ${rows.length}`);
console.log(`  content_hash to set: ${needHash}`);
console.log(`  origin recoverable:  ${gotOrigin}  (the rest have none — permanently, and honestly)`);

// What the hashes reveal about duplication, which is the point of doing this at all.
const byHash = new Map();
for (const r of rows) {
  const h = r.content_hash || og.contentHash(r.body);
  if (!h) continue;
  byHash.set(h, (byHash.get(h) || 0) + 1);
}
const dupGroups = [...byHash.values()].filter((n) => n > 1);
const redundant = dupGroups.reduce((a, n) => a + (n - 1), 0);
console.log(`\nduplication the hash exposes: ${dupGroups.length} group(s), ${redundant} redundant copies ` +
  `(${((redundant / Math.max(1, rows.length)) * 100).toFixed(1)}% of corpus)`);
console.log(`  → these now collapse to ONE origin in origin.independence() instead of counting separately`);

// ORIGIN IS THE FIRST HIGH-QUALITY SOURCE (Lucas, 2026-07-20). Rows already written may hold a CDN or
// object-store host as their origin — that is where the bytes were, not who published. Demote those to
// fetch_url and blank the origin, because the publisher is genuinely unknown for them and claiming a
// bucket as the source would both deny official documents their authority and collapse independent
// publishers who share a hosting vendor. Nothing is lost: the URL moves, it is not deleted.
const commodity = d.prepare('SELECT id, origin, origin_host FROM documents WHERE origin_host IS NOT NULL').all()
  .filter((r) => og.isCommodityHost(r.origin_host));
console.log(`\norigins that are infrastructure, not a publisher: ${commodity.length}`);
for (const r of commodity.slice(0, 5)) console.log(`  #${r.id}  ${r.origin_host}`);
if (commodity.length) console.log(`  → demoted to fetch_url; origin blanked (the publisher is unknown, and saying so is the honest state)`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

if (commodity.length) {
  const dem = d.prepare('UPDATE documents SET fetch_url = COALESCE(fetch_url, origin), origin = NULL, origin_host = NULL WHERE id = ?');
  d.transaction(() => { for (const r of commodity) dem.run(r.id); })();
}

const stmt = d.prepare('UPDATE documents SET content_hash = COALESCE(content_hash, ?), origin = COALESCE(origin, ?), origin_host = COALESCE(origin_host, ?) WHERE id = ?');
const tx = d.transaction(() => { for (const u of updates) stmt.run(u.hash, u.origin, u.host, u.id); });
tx();

const after = d.prepare('SELECT COUNT(*) c FROM documents WHERE content_hash IS NOT NULL').get().c;
const withOrigin = d.prepare('SELECT COUNT(*) c FROM documents WHERE origin IS NOT NULL').get().c;
console.log(`\n${'='.repeat(74)}\nAPPLIED — ${after} document(s) now hashed, ${withOrigin} with a recorded origin.`);
process.exit(0);
