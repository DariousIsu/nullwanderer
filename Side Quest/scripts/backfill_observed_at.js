/* scripts/backfill_observed_at.js — stamp the SOURCE's own date onto existing encounters (W1).
 *
 * observed_at is NULL on every encounter written so far, which means the entire recency half of §5 —
 * contact decay, "newer supersedes", volatility classes — has nothing to run on. Unlike origin, this
 * one IS recoverable: the date is in the document text we still hold.
 *
 * Only documents that state a date get one. Roughly half do not, and those stay NULL — see
 * lib/observed_at.js for why guessing here is worse than abstaining.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_observed_at.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const oa = require('../lib/observed_at');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nOBSERVED_AT BACKFILL — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

// One date per document, computed once, so the same document can never stamp two different dates.
const dateFor = new Map();
const docs = d.prepare('SELECT id, title, ref, body FROM documents WHERE body IS NOT NULL').all();
let dated = 0;
for (const doc of docs) {
  const fn = String(doc.ref || '').split(/[\\/]/).pop();
  const r = oa.extractObservedAt({ text: doc.body, title: doc.title, filename: fn });
  if (r) { dateFor.set(doc.id, r); dated += 1; }
}
console.log(`documents            ${docs.length}`);
console.log(`  state a date       ${dated}  (${((dated / Math.max(1, docs.length)) * 100).toFixed(1)}%)`);
console.log(`  no date stated     ${docs.length - dated}  (stays NULL — abstaining beats guessing)`);

// Which encounters can be stamped: those citing a document that states a date.
const rows = d.prepare("SELECT id, source_ref FROM encounters WHERE observed_at IS NULL AND source_ref LIKE 'doc:%'").all();
const updates = [];
for (const e of rows) {
  const id = Number(String(e.source_ref).slice(4));
  const r = dateFor.get(id);
  if (r) updates.push({ id: e.id, ts: r.ts });
}
console.log(`\nencounters missing a date  ${rows.length}`);
console.log(`  stampable                ${updates.length}`);

// Sanity: the spread should look like a document corpus, not like today.
if (updates.length) {
  const years = {};
  for (const u of updates) { const y = new Date(u.ts).getUTCFullYear(); years[y] = (years[y] || 0) + 1; }
  const top = Object.entries(years).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  year spread: ${top.map(([y, n]) => `${y}:${n}`).join('  ')}`);
  const future = updates.filter((u) => u.ts > Date.now()).length;
  console.log(`  dated in the future: ${future}   ${future === 0 ? '✓ (refused at extraction)' : '✗ INVESTIGATE'}`);
}

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const stmt = d.prepare('UPDATE encounters SET observed_at = ? WHERE id = ? AND observed_at IS NULL');
d.transaction(() => { for (const u of updates) stmt.run(u.ts, u.id); })();

const now = d.prepare('SELECT COUNT(*) c FROM encounters WHERE observed_at IS NOT NULL').get().c;
const tot = d.prepare('SELECT COUNT(*) c FROM encounters').get().c;
console.log(`\n${'='.repeat(74)}\nAPPLIED — ${now} of ${tot} encounter(s) now carry the source's own date.`);
process.exit(0);
