/* scripts/backfill_known_incorrect.js — seed the inoculation record from proven bounces (§7).
 *
 * The Puller already holds 497 accepted revisions whose rationale is "<address> bounced; next pattern
 * …". Those are not stale addresses — they are addresses TESTED AND PROVEN UNDELIVERABLE, which is the
 * only thing that belongs in known_incorrect.
 *
 * A revision that merely supersedes (a newer address found, no failure) is NOT refutation and is left
 * alone: §5a says contact decays, so an old address is history rather than an error, and recording it
 * as incorrect would be a lie about a fact that was true when it was written.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_known_incorrect.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../lib/db');
const ki = require('../lib/known_incorrect');
const enc = require('../lib/encounters');

db.init();
const APPLY = process.argv.includes('--apply');

console.log(`\nKNOWN-INCORRECT BACKFILL (proven bounces) — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

const p = new Database(path.join('data', 'puller.db'), { readonly: true });
const rows = p.prepare(`
  SELECT r.attr, r.from_value, r.to_value, r.rationale, r.created_at, t.name
    FROM revisions r LEFT JOIN targets t ON t.id = r.target_id
   WHERE r.status = 'accepted' AND r.from_value IS NOT NULL`).all();
p.close();

// The rationale is the evidence. Only a stated FAILURE counts — "bounced", "undeliverable", "rejected".
const REFUTED_RE = /\b(bounce[sd]?|undeliverable|invalid|rejected|does not exist|no such (?:user|mailbox))\b/i;

const build = [];
let noName = 0, notRefuted = 0;
for (const r of rows) {
  if (!REFUTED_RE.test(String(r.rationale || ''))) { notRefuted += 1; continue; }
  if (!r.name) { noName += 1; continue; }              // no object to attach it to — never guessed
  const key = enc.objectKey('person', r.name);
  if (!key) { noName += 1; continue; }
  build.push({
    objectKey: key, claimClass: 'contact', claimKey: String(r.attr || 'email'),
    claimValue: r.from_value, reason: String(r.rationale).slice(0, 200),
    refutedBy: 'puller:revision', refutedAt: Number(r.created_at) || null,
  });
}

console.log(`accepted revisions        ${rows.length}`);
console.log(`  state a FAILURE         ${rows.length - notRefuted}  (bounced / undeliverable / rejected)`);
console.log(`  superseded only         ${notRefuted}  (left alone — decay is not refutation)`);
console.log(`  no resolvable person    ${noName}`);
console.log(`refutations to record     ${build.length}`);
for (const b of build.slice(0, 4)) console.log(`    ${b.objectKey.slice(7, 34).padEnd(28)} ${String(b.claimValue).slice(0, 38)}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = ki.recordMany(build);
const s = ki.stats();
console.log(`\n${'='.repeat(74)}`);
console.log(`APPLIED — ${res.added} recorded, ${res.alreadyKnown} already known (idempotent).`);
console.log(`known-incorrect now holds ${s.total} value(s) across ${s.objects} object(s).`);
process.exit(0);
