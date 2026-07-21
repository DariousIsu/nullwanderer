/* scripts/backfill_id_scheme_types.js — type claims from identifier schemes (design §2a-ii step 1).
 *
 * The cheapest rung of the validation ladder Lucas asked for: no network, no model, no guess. A
 * Congressional Biographical Directory code identifies a person because that register contains nothing
 * else. 1,943 placeholder rows carry one.
 *
 * ── IT RECORDS CLAIMS, IT DOES NOT WRITE TYPES ──────────────────────────────────────────────────
 *
 * This deliberately goes through T3 rather than UPDATE-ing graph_entities, so the register competes with
 * every other source on the same ladder instead of overwriting them. scripts/migrate_entity_types.js
 * then applies whatever wins. It also means a wrong id is correctable by evidence rather than baked into
 * a column — which is the entire point of type-as-a-claim.
 *
 * Authority is `official`: these are government registers. Independence is honest and LOW by
 * construction — every bioguide claim shares one origin, so 1,943 claims are ONE source, not 1,943.
 * That is correct: they are one register, and inflating them would be manufacturing corroboration.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_id_scheme_types.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const ot = require('../lib/object_type');
const st = require('../lib/id_scheme_type');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');

console.log(`\nID-SCHEME TYPE CLAIMS — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

const ents = d.prepare('SELECT id, name, entity_type FROM graph_entities').all();

const build = [];
const refused = {};
for (const e of ents) {
  const r = st.typeFromIds(e.name);
  if (!r) { refused['no scheme that proves a kind'] = (refused['no scheme that proves a kind'] || 0) + 1; continue; }
  if (!r.type) { refused[r.why] = (refused[r.why] || 0) + 1; continue; }
  build.push({
    label: e.name,
    type: r.type,
    sourceKind: 'register',
    // One register = one source. The ref names the SCHEME, not the row, so the unique index collapses
    // repeats from the same register instead of counting them as independent corroboration.
    sourceRef: `idscheme:${r.scheme}`,
    originHost: `register.${r.scheme}`,
    contentHash: `${r.scheme}:${String(e.name).toLowerCase()}`,
    authority: 'official',
  });
}

const byType = {}; const byScheme = {};
for (const b of build) {
  byType[b.type] = (byType[b.type] || 0) + 1;
  byScheme[b.sourceRef] = (byScheme[b.sourceRef] || 0) + 1;
}
console.log(`entities scanned              ${ents.length}`);
console.log(`claims to record              ${build.length}`);
console.log(`  by type                     ${JSON.stringify(byType)}`);
console.log(`  by scheme                   ${JSON.stringify(byScheme)}`);
console.log(`\nnot claimed:`);
for (const [k, v] of Object.entries(refused).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\nREFUSED BY DESIGN: lda_client ids. A lobbying CLIENT may be a company or a county`);
console.log(`government — Fulton County has one. Typing on it is the original bug: role became type.`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = ot.recordMany(build);
console.log(`\n${'='.repeat(78)}`);
console.log(`APPLIED — ${res.added} claim(s) recorded, ${res.refused} refused.`);
console.log(`\nSpot-check (the register competes, it does not overwrite):`);
for (const b of build.slice(0, 5)) {
  const t = ot.typeOf(b.label);
  console.log(`  ${String(b.label).slice(0, 40).padEnd(42)} → ${String(t.type).padEnd(14)} ${t.grade} ×${t.sources} ${t.settled ? 'settled' : 'UNSETTLED'}${t.contested ? ' contested' : ''}`);
}
process.exit(0);
