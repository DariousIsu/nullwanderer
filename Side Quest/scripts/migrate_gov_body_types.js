/* scripts/migrate_gov_body_types.js — re-key the objects T1 stopped folding into `org`.
 *
 * T1 gave `government_body` and `committee` their own object types. New encounters land as `gov:` and
 * `body:` from now on — but the objects already in the log are keyed `org:`, and the type is part of the
 * identity key. Left alone, the SAME county commission accumulates evidence under two keys and every
 * grade is computed over half of it. That is the split-identity failure O1 was built to prevent, so the
 * code change is not finished until the existing rows move with it.
 *
 * ── WHAT DECIDES THE NEW TYPE ───────────────────────────────────────────────────────────────────
 *
 * The extractor's own call, recorded in `kg_observations.entity_type`. NOTHING is inferred here: no name
 * regex, no model, no guess. `isGovernmentCompany` gets 52 of 137 and misses the Postal Service — a name
 * classifier may PROPOSE a type (§2a-ii) and this migration is not the place for a proposal.
 *
 * ── THE AMBIGUITY REFUSAL ───────────────────────────────────────────────────────────────────────
 *
 * A label whose observations disagree — some `government_body`, some `organization` — is LEFT ALONE. A
 * disagreement is exactly the case T3 exists to adjudicate with evidence, and re-keying on a coin-flip
 * would move an object to a key that the losing claim can never argue with. Unmoved is recoverable;
 * moved-wrong is a false merge.
 *
 * `known_incorrect` is re-keyed alongside `encounters`, or a proven-bad value silently stops applying to
 * the object it refutes and walks straight back in.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/migrate_gov_body_types.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const enc = require('../lib/encounters');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');

console.log(`\nGOV/BODY RE-KEY (T1) — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

// Every distinct org-typed object in the log, with the extractor types its label was ever seen under.
// COUNT THE THING YOU ARE MOVING. An earlier cut counted rows across the join to kg_observations, which
// fans out per observation and reported "Steering Committee — 154 rows" for an object holding a handful.
// The number has to be encounter rows, or the report reads as a much larger change than it is.
const rows = d.prepare(`
  SELECT e.object_key, MIN(e.object_label) label,
         GROUP_CONCAT(DISTINCT o.entity_type) types,
         (SELECT COUNT(*) FROM encounters x WHERE x.object_key = e.object_key) rows_
    FROM encounters e
    JOIN kg_observations o ON lower(trim(o.source_entity)) = lower(trim(e.object_label))
   WHERE e.object_type = 'org' AND o.entity_type IS NOT NULL
   GROUP BY e.object_key`).all();

const WANT = { government_body: 'gov', committee: 'body' };
const plan = [];
const ambiguous = [];
for (const r of rows) {
  const types = String(r.types || '').split(',').map((t) => t.trim()).filter(Boolean);
  const targets = new Set(types.map((t) => WANT[t] || 'org'));
  if (targets.size !== 1) { ambiguous.push({ ...r, types: types.join('/') }); continue; }  // refused — see header
  const to = [...targets][0];
  if (to === 'org') continue;                                    // genuinely an organization; nothing to do
  const newKey = enc.objectKey(to, r.label);
  if (!newKey || newKey === r.object_key) continue;
  plan.push({ from: r.object_key, to: newKey, type: to, label: r.label, rows_: r.rows_ });
}

// A re-key that lands on an EXISTING key is a merge, and a merge is the unrecoverable failure. Report,
// never perform — O2's refusal list stands.
const collide = plan.filter((p) => d.prepare('SELECT 1 FROM encounters WHERE object_key = ? LIMIT 1').get(p.to));

console.log(`org-typed objects with an extractor type   ${rows.length}`);
console.log(`  → gov / body                             ${plan.length}`);
console.log(`  ambiguous, LEFT ALONE                    ${ambiguous.length}`);
console.log(`  would collide with an existing object    ${collide.length}  ${collide.length ? '← REFUSED' : ''}`);
for (const a of ambiguous) console.log(`    ambiguous  ${String(a.label).slice(0, 44).padEnd(46)} ${a.types}`);
for (const p of plan) console.log(`    ${p.type.padEnd(5)} ${String(p.label).slice(0, 46).padEnd(48)} ${p.rows_} row(s)`);

if (collide.length) { console.log('\nRefusing to merge onto an existing object. Nothing written.'); process.exit(1); }
if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const upE = d.prepare('UPDATE encounters SET object_key = ?, object_type = ? WHERE object_key = ?');
const upK = d.prepare('UPDATE known_incorrect SET object_key = ? WHERE object_key = ?');
let movedE = 0, movedK = 0;
d.transaction(() => {
  for (const p of plan) { movedE += upE.run(p.to, p.type, p.from).changes; movedK += upK.run(p.to, p.from).changes; }
})();

console.log(`\n${'='.repeat(78)}`);
console.log(`APPLIED — ${plan.length} object(s) re-keyed: ${movedE} encounter row(s), ${movedK} refutation(s).`);
console.log(d.prepare(`SELECT object_type, COUNT(*) c, COUNT(DISTINCT object_key) k FROM encounters
                        WHERE object_type IN ('org','gov','body') GROUP BY 1`).all());
process.exit(0);
