/* scripts/retract_false_commitments.js — retire two held "commitments" that state things that are not true.
 *
 * Both were produced by bugs fixed on 2026-07-20, and both are re-injected into her prompt every turn,
 * so they keep seeding wrong answers until retired:
 *
 *   1254  "has fully researched 24 Louisiana organizations with contact information"
 *         FALSE twice over. 24 was ONE focus thread's covered list read as the whole (fixed in ff337eb
 *         — the beat unions to 64 of 64), and "researched" counts BODIES worked, never contacts
 *         captured. This is the claim she repeated to Lucas as "24 of 64, that leaves 40 more to go".
 *
 *   1260  "has the framework ready for the full research brief on White House claims regarding
 *         election integrity"
 *         An artefact of the referent bug (fixed in b73f926): Lucas asked for a brief on China's World
 *         AI announcement, ambient retrieval substituted an unrelated subject, and the hallucinated
 *         topic was then canonized as something she holds.
 *
 * NOT DELETED — status-changed via db.markCommitmentStatus, which appends to revision_history. The row,
 * its evidence turn ids, and the reason all survive; getHeldCommitments only reads status='held', so
 * retiring is enough to stop the injection. Reversible by setting status back to 'held'.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/retract_false_commitments.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');

db.init();
const APPLY = process.argv.includes('--apply');

const TARGETS = [
  { id: 1254, reason: 'FALSE: "24" was one focus thread\'s covered list read as the whole (the beat unions to 64 of 64, ff337eb), and "researched" counts bodies worked, not contacts captured' },
  { id: 1260, reason: 'FALSE: artefact of the elliptical-referent bug (b73f926) — Lucas asked for a brief on China\'s World AI; an unrelated subject was substituted from ambient retrieval and then canonized' },
];

console.log(`\nRETRACT FALSE COMMITMENTS — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(72)}`);

let acted = 0;
for (const t of TARGETS) {
  const row = db.getDb().prepare('SELECT id, claim, status FROM commitments WHERE id = ?').get(t.id);
  if (!row) { console.log(`  [${t.id}] NOT FOUND — skipping (nothing to do)`); continue; }
  if (row.status !== 'held') { console.log(`  [${t.id}] already status='${row.status}' — leaving alone`); continue; }
  console.log(`\n  [${row.id}] "${row.claim}"`);
  console.log(`      status: held → retracted`);
  console.log(`      why:    ${t.reason}`);
  if (APPLY) { db.markCommitmentStatus(t.id, 'retracted', { reason: t.reason }); acted++; }
}

const held = db.getDb().prepare("SELECT COUNT(*) c FROM commitments WHERE status='held'").get().c;
console.log(`\n${'='.repeat(72)}`);
console.log(APPLY ? `APPLIED — ${acted} retracted. held commitments now: ${held}` : `Dry run only — nothing written. held commitments: ${held}`);
console.log(`Reversible: UPDATE commitments SET status='held' WHERE id IN (1254,1260);`);
process.exit(0);
