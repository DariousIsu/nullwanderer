/* scripts/migrate_place_keys.js — re-key existing place encounters onto one identity per place (O2).
 *
 * The live log holds 500 place objects, and some of them are the same place twice: `AL` and `Alabama`,
 * `AZ` and `ARIZONA`, `AR` and `Arkansas`. A state code does not fold into its state name under the
 * generic identity rule, so each pair grades as two objects with half the evidence each.
 *
 * ONLY the closed-set state-code merge is applied — see lib/place_key.js for the traps deliberately
 * left alone (`Adams` vs `Adams County`, `Orange` vs `Orange County`, `Kansas City` vs `Kansas`).
 *
 * Every merge is PRINTED with both labels before anything is written. A place merge is not reversible
 * by re-running anything, so it should be read, not trusted.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/migrate_place_keys.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const pk = require('../lib/place_key');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nPLACE KEY MIGRATION — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

const rows = d.prepare("SELECT id, object_key, object_label FROM encounters WHERE object_type = 'place'").all();
const before = new Set(rows.map((r) => r.object_key));

const updates = [];
const targets = new Map();   // new key → set of old keys that land on it
for (const r of rows) {
  const k = pk.placeKey(r.object_label);
  if (!k) continue;
  const next = `place:${k}`;
  if (next === r.object_key) continue;
  updates.push({ id: r.id, from: r.object_key, to: next, label: r.object_label });
  if (!targets.has(next)) targets.set(next, new Set());
  targets.get(next).add(r.object_key);
}

console.log(`place encounters      ${rows.length}`);
console.log(`distinct place keys   ${before.size}`);
console.log(`encounters to re-key  ${updates.length}`);

// A MERGE is where two previously-distinct keys become one. Everything else is a rename.
const merges = [];
for (const [next, olds] of targets) {
  const joined = [...olds].filter((o) => before.has(o));
  const alsoExisting = before.has(next) ? 1 : 0;
  if (joined.length + alsoExisting > 1) merges.push({ next, olds: joined, existing: !!alsoExisting });
}
console.log(`\nMERGES (two objects becoming one): ${merges.length}`);
for (const m of merges) {
  const labels = m.olds.map((o) => {
    const ex = rows.find((r) => r.object_key === o);
    return `${o}${ex ? ` ("${ex.object_label}")` : ''}`;
  });
  console.log(`  ${m.next}${m.existing ? ' [already exists]' : ''}`);
  for (const l of labels) console.log(`      ← ${l}`);
}
const renames = updates.length - merges.reduce((a, m) => a + m.olds.length, 0);
console.log(`\nrenames (key normalised, no other object involved): ~${Math.max(0, renames)}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

// The unique index means a re-keyed encounter can collide with one the target object already has — that
// collision IS the merge, and the surviving row is the same claim from the same source.
const upd = d.prepare('UPDATE OR IGNORE encounters SET object_key = ? WHERE id = ?');
const del = d.prepare('DELETE FROM encounters WHERE id = ?');
let moved = 0, collapsed = 0;
d.transaction(() => {
  for (const u of updates) {
    const r = upd.run(u.to, u.id);
    if (r.changes) moved += 1;
    else { del.run(u.id); collapsed += 1; }   // already present under the canonical key
  }
})();

const after = d.prepare("SELECT COUNT(DISTINCT object_key) c FROM encounters WHERE object_type = 'place'").get().c;
console.log(`\n${'='.repeat(74)}`);
console.log(`APPLIED — ${moved} re-keyed, ${collapsed} collapsed into an identical existing claim.`);
console.log(`distinct place objects: ${before.size} → ${after}`);
process.exit(0);
