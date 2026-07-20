/* scripts/audit_encounter_conversion.js — WHY does an observation not become an encounter? (O1)
 *
 * Read-only. 736 encounters came out of roughly 2,947 recent observations and there was no way to ask
 * which ones were refused or why, because the entity type — the thing most refusals turn on — was
 * dropped at the store boundary and never persisted. Now that it is stored, the conversion is
 * auditable.
 *
 * Every refusal here is deliberate (see lib/decomp_encounters.js). The point of the audit is to check
 * that the refusals are the ones intended, and in the proportions intended: a rule that silently
 * discards most of the corpus is a bug even when each individual refusal is correct.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/audit_encounter_conversion.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const de = require('../lib/decomp_encounters');

db.init();
const d = db.getDb();

console.log(`\nOBSERVATION → ENCOUNTER CONVERSION AUDIT\n${'='.repeat(72)}`);

// Only observations written since the type started persisting can be audited honestly. Older rows have
// entity_type NULL because it was never captured, not because the extractor failed to type them —
// counting those as "untyped" would blame the extractor for a storage gap.
const typed = d.prepare("SELECT COUNT(*) c FROM kg_observations WHERE entity_type IS NOT NULL").get().c;
const total = d.prepare("SELECT COUNT(*) c FROM kg_observations WHERE url LIKE 'docstore:%'").get().c;
console.log(`document-cited observations   ${total}`);
console.log(`  with a persisted type       ${typed}  ← only these are auditable; the rest predate O1`);

if (!typed) {
  console.log(`\nNothing to audit yet — the type persists from the next decompose onward.`);
  console.log(`Run a document through the lane, then re-run this.`);
  process.exit(0);
}

const rows = d.prepare("SELECT source_entity, relation, target, value, status, entity_type FROM kg_observations WHERE entity_type IS NOT NULL").all();
const reason = {};
let made = 0;
for (const r of rows) {
  const obs = { sourceEntity: r.source_entity, relation: r.relation, target: r.target, value: r.value, status: r.status, type: r.entity_type };
  const e = de.toEncounter(obs, { id: 1 });
  if (e) { made += 1; continue; }
  // Re-derive which rule refused it, in the order toEncounter applies them.
  let why;
  if (!r.source_entity) why = 'no subject';
  else if (!de.claimClassFor(r.relation)) why = `unknown relation (${r.relation})`;
  else if (r.status && r.status !== 'promoted') why = `not promoted (${r.status})`;
  else if (!de.objectTypeFor(r.entity_type)) why = `untyped subject (${r.entity_type})`;
  else why = 'other';
  reason[why] = (reason[why] || 0) + 1;
}

console.log(`\nconverted to encounters       ${made}  (${((made / rows.length) * 100).toFixed(1)}%)`);
console.log(`refused                       ${rows.length - made}`);
for (const [k, n] of Object.entries(reason).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}

console.log(`\ntypes seen:`);
for (const r of d.prepare('SELECT entity_type t, COUNT(*) c FROM kg_observations WHERE entity_type IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 14').all()) {
  const mapped = de.objectTypeFor(r.t);
  console.log(`  ${String(r.c).padStart(6)}  ${String(r.t).padEnd(18)} → ${mapped || 'REFUSED (untyped)'}`);
}
process.exit(0);
