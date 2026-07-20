/* scripts/backfill_encounters.js — replay the existing doc_contacts store into the encounter log.
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2. Every row in doc_contacts is already an encounter: a named
 * person, asserted by one document, with that document's origin and content hash now recoverable
 * (commit f0a1af6). Replaying them is what makes the 1,468 trapped parish contacts GRADEABLE rather
 * than merely findable — the difference between "we have a phone number" and "three independent
 * documents attest to this phone number".
 *
 * Nothing is invented. observed_at stays NULL because a document's created_ts is when WE ingested it,
 * not the date the source carries; filling it in would let a 2021 roster read as current evidence.
 * Authority is 'official' only where the document's real origin_host is a .gov/.mil/.us — for the
 * legacy corpus with no captured origin that is 'unknown', which is the honest answer.
 *
 * Append-only and idempotent: the unique index means a second run adds nothing. Fully reversible with
 * DELETE FROM encounters WHERE source_kind='document'.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_encounters.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const enc = require('../lib/encounters');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nENCOUNTER LOG BACKFILL FROM doc_contacts — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

const rows = d.prepare(
  `SELECT c.name, c.email, c.phone, c.title, c.company, c.state, c.doc_id,
          doc.origin, doc.origin_host, doc.content_hash
     FROM doc_contacts c LEFT JOIN documents doc ON doc.id = c.doc_id`).all();

let official = 0, withHash = 0, withOrigin = 0;
const people = new Set();
const build = [];
for (const r of rows) {
  const key = enc.objectKey('person', r.name);
  if (!key) continue;
  people.add(key);
  const gov = r.origin_host && /(^|\.)(gov|mil)$|\.us$/i.test(r.origin_host);
  if (gov) official += 1;
  if (r.content_hash) withHash += 1;
  if (r.origin_host) withOrigin += 1;
  const base = {
    object_type: 'person', object_key: key, object_label: r.name,
    source_kind: 'document', source_ref: `doc:${r.doc_id}`,
    origin: r.origin || null, origin_host: r.origin_host || null, content_hash: r.content_hash || null,
    authority: gov ? 'official' : 'unknown', observed_at: r.observed_at || null,
  };
  build.push({ ...base, claim_class: 'existence' });
  if (r.email) build.push({ ...base, claim_class: 'contact', claim_key: 'email', claim_value: String(r.email).toLowerCase() });
  if (r.phone) build.push({ ...base, claim_class: 'contact', claim_key: 'phone', claim_value: r.phone });
  if (r.title) build.push({ ...base, claim_class: 'biographical', claim_key: 'title', claim_value: r.title });
  if (r.company) build.push({ ...base, claim_class: 'structural', claim_key: 'affiliated_with', claim_value: r.company });
  if (r.state) build.push({ ...base, claim_class: 'structural', claim_key: 'state', claim_value: r.state });
}

console.log(`doc_contacts rows:     ${rows.length}`);
console.log(`distinct people:       ${people.size}`);
console.log(`encounters to write:   ${build.length}`);
console.log(`  citing a doc w/ hash:   ${withHash}   (independence computable)`);
console.log(`  citing a doc w/ origin: ${withOrigin}   (the rest are pre-hook — permanently unproven, honestly)`);
console.log(`  from an official host:  ${official}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = enc.recordMany(build);
console.log(`\n${'='.repeat(74)}`);
console.log(`APPLIED — ${res.added} encounter(s) written, ${res.alreadyKnown} already known (idempotent, not a second vote).`);
const s = enc.stats();
console.log(`log now holds ${s.encounters} encounter(s) across ${s.objects} object(s); ${s.withOrigin} carry an origin host.`);
for (const b of s.byClass) console.log(`  ${b.claim_class.padEnd(14)} ${b.c}`);
process.exit(0);
