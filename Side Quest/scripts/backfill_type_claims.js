/* scripts/backfill_type_claims.js — seed T3's type claims from what sources actually said.
 *
 * lib/object_type.js records what a source ASSERTS about what kind of thing something is. This puts the
 * assertions the corpus already contains into the log so the ladder has something to adjudicate.
 *
 * ── WHAT IS AND IS NOT A CLAIM ──────────────────────────────────────────────────────────────────
 *
 * `kg_observations.entity_type` IS a claim: an extractor read a document and said "this is a
 * government_body". It carries a url, so it gets a publisher, a content hash, and an authority.
 *
 * `graph_entities.entity_type` is NOT a claim, and this is the whole point of §2a-i. Those 13,033
 * `concept` values are a DEFAULT PARAMETER — `recordEntity({ type = 'concept' })` that `recordRelation`
 * never passes. Nobody decided them. Recording them as claims would manufacture 13,033 pieces of
 * evidence out of a JavaScript fallback and bury every real assertion under them. They are refused here,
 * deliberately and by name.
 *
 * Authority comes from the PUBLISHER, never from the type being asserted — otherwise a source could
 * vouch for itself by claiming something official-sounding.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_type_claims.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const ot = require('../lib/object_type');
const og = require('../lib/origin');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');

console.log(`\nTYPE-CLAIM BACKFILL (T3) — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

const rows = d.prepare(`
  SELECT source_entity, entity_type, url, captured_at, feed, id
    FROM kg_observations
   WHERE entity_type IS NOT NULL AND entity_type <> '' AND entity_type <> 'other'
     AND status = 'promoted'`).all();

const build = [];
for (const r of rows) {
  const host = r.url ? og.hostOf(r.url) : null;
  build.push({
    label: r.source_entity,
    type: r.entity_type,
    sourceKind: 'document',
    sourceRef: `obs:${r.id}`,
    origin: r.url || null,
    originHost: host,
    // The content hash makes independence computable. With no url there is nothing to hash, and an
    // invented one would let a single feed count as many sources.
    contentHash: r.url ? og.contentHash(r.url) : null,
    authority: host && /(^|\.)(gov|mil)$|\.us$/i.test(host) ? 'official' : (host ? 'ordinary' : 'unknown'),
    observedAt: Number(r.captured_at) || null,
  });
}

const byType = {}; const byAuth = {};
for (const b of build) { byType[b.type] = (byType[b.type] || 0) + 1; byAuth[b.authority] = (byAuth[b.authority] || 0) + 1; }
console.log(`observations carrying a type   ${rows.length}`);
console.log(`  by asserted type             ${JSON.stringify(byType)}`);
console.log(`  by publisher authority       ${JSON.stringify(byAuth)}`);
console.log(`distinct name subjects         ${new Set(build.map((b) => ot.typeSubject(b.label))).size}`);
console.log(`\nREFUSED BY DESIGN: graph_entities.entity_type — 13,033 'concept' values that are a default`);
console.log(`parameter, not an assertion (§2a-i). Recording them would bury every real claim.`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = ot.recordMany(build);
console.log(`\n${'='.repeat(78)}`);
console.log(`APPLIED — ${res.added} type claim(s) recorded, ${res.refused} refused.`);

const contested = ot.contested({ limit: 2000 });
console.log(`\nCONTESTED SUBJECTS (sources disagree about what it is): ${contested.length}`);
for (const c of contested.slice(0, 25)) {
  const vals = c.values.map((v) => `${v.value}(${v.grade || '—'}×${v.sources})`).join('  vs  ');
  console.log(`  ${c.cleaning ? 'CLEAN' : '     '} ${String(c.label).slice(0, 34).padEnd(36)} → ${c.type}   [${vals}]`);
}
process.exit(0);
