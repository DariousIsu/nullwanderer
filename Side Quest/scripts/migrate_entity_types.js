/* scripts/migrate_entity_types.js — T4: re-type graph_entities from the winning type claim.
 *
 * The last slice. T3 made type a graded claim; this applies the winners to the rows that have been
 * carrying a default parameter as though it were a decision (§2a-i).
 *
 * ── THE SPEC SAID "MIGRATE THE 13,033". THE EVIDENCE DOES NOT SUPPORT THAT ──────────────────────
 *
 * 13,033 rows are typed `concept`, but only a fraction of those names has any source that ever said
 * what it was. Re-typing the rest would mean inventing types for exactly the rows whose whole problem is
 * that a type was invented for them. So this migrates ONLY where a settled claim exists, and prints the
 * remainder as a work list rather than quietly leaving it out of the summary.
 *
 * ── WHAT MAY BE OVERWRITTEN ─────────────────────────────────────────────────────────────────────
 *
 * A PLACEHOLDER only — `concept` or `unknown`. A row already carrying a real type is LEFT ALONE even
 * when a claim disagrees with it, because that disagreement is a dispute for T3's cleaning pass to
 * resolve with evidence, not something a migration should settle by overwriting. The one exception is
 * that nothing is ever downgraded TO a placeholder.
 *
 * The old value is printed for every single change. There is no undo beyond the backup, so the record of
 * what moved has to exist before it moves.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write. --verbose lists the unresolved.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/migrate_entity_types.js [--apply] [--verbose]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const ot = require('../lib/object_type');
const mt = require('../lib/mint_type');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

console.log(`\nENTITY RE-TYPE (T4) — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(80)}`);

const ents = d.prepare('SELECT id, name, entity_type FROM graph_entities').all();

// A COMMON NOUN IS NOT AN ENTITY. The dry run wanted to type `health` as a committee and `counties` as a
// location, both on genuinely official single sources — because an extractor once put those words in the
// entity slot. They are junk nodes, and the pre-existing generic-label over-merge (one global "Steering
// Committee" collecting evidence from unrelated meetings) is the same disease.
//
// Re-typing them changes garbage into CONFIDENT garbage, which is worse: `concept` at least reads as
// unclassified. A proper noun is capitalised; a bare lowercase word is a noun that leaked into the
// entity slot. Narrow on purpose — it holds, it does not delete, and it says why.
const isCommonNoun = (name) => {
  const s = String(name || '').trim();
  return !!s && s === s.toLowerCase() && !/[0-9[\]]/.test(s) && s.split(/\s+/).length <= 2;
};

const plan = [];
const held = [];
const reasons = { 'no claim at all': 0, 'claim not settled': 0, 'common noun, not an entity': 0, 'claim agrees — nothing to do': 0, 'real type, claim disagrees — T3 cleaning, not a migration': 0 };
const disputes = [];
for (const e of ents) {
  const t = ot.typeOf(e.name);
  if (!t.type) { reasons['no claim at all'] += 1; continue; }
  if (!t.settled) { reasons['claim not settled'] += 1; continue; }
  const current = String(e.entity_type || '').toLowerCase();
  if (current === t.type) { reasons['claim agrees — nothing to do'] += 1; continue; }
  if (!mt.isPlaceholder(current)) {
    // A real type contradicted by a settled claim is a genuine dispute. Surfaced, never overwritten.
    reasons['real type, claim disagrees — T3 cleaning, not a migration'] += 1;
    disputes.push({ id: e.id, name: e.name, current, claim: t.type, grade: t.grade });
    continue;
  }
  if (isCommonNoun(e.name)) {
    reasons['common noun, not an entity'] += 1;
    held.push({ id: e.id, name: e.name, to: t.type, grade: t.grade });
    continue;
  }
  plan.push({ id: e.id, name: e.name, from: current || '(empty)', to: t.type, grade: t.grade, sources: t.sources });
}

const byMove = {};
for (const p of plan) { const k = `${p.from} → ${p.to}`; byMove[k] = (byMove[k] || 0) + 1; }

console.log(`graph_entities                    ${ents.length}`);
console.log(`  RE-TYPE                         ${plan.length}`);
for (const [k, v] of Object.entries(byMove).sort((a, b) => b[1] - a[1])) console.log(`      ${String(v).padStart(5)}  ${k}`);
console.log(`  left alone                      ${ents.length - plan.length}`);
for (const [k, v] of Object.entries(reasons).filter(([, v2]) => v2)) console.log(`      ${String(v).padStart(5)}  ${k}`);

if (disputes.length) {
  console.log(`\nDISPUTES — a settled claim contradicts a real stored type. NOT touched; this is T3's`);
  console.log(`cleaning lane, because overwriting here would settle by fiat what should be settled by evidence.`);
  for (const x of disputes.slice(0, 20)) console.log(`   #${String(x.id).padStart(6)} ${String(x.name).slice(0, 38).padEnd(40)} stored=${x.current.padEnd(16)} claim=${x.claim} (${x.grade})`);
}

if (held.length) {
  console.log(`\nHELD AS JUNK NODES — a common noun that leaked into the entity slot. Typing these would turn`);
  console.log(`garbage into CONFIDENT garbage; \`concept\` at least reads as unclassified.`);
  for (const h of held) console.log(`   #${String(h.id).padStart(6)} ${String(h.name).slice(0, 38).padEnd(40)} would have become ${h.to} (${h.grade})`);
}

console.log(`\nEVERY CHANGE:`);
for (const p of plan) {
  console.log(`  #${String(p.id).padStart(6)} ${String(p.name).slice(0, 42).padEnd(44)} ${p.from.padEnd(9)} → ${String(p.to).padEnd(16)} ${p.grade}×${p.sources}`);
}

// What is STILL untyped after this, and why — the work list, printed rather than omitted.
const stillPlaceholder = ents.filter((e) => mt.isPlaceholder(e.entity_type)).length - plan.length;
const withStrongId = ents.filter((e) => mt.isPlaceholder(e.entity_type) && mt.hasStrongId(e.name)).length;
console.log(`\nWORK LIST AFTER THIS MIGRATION`);
console.log(`  rows still on a placeholder type          ${stillPlaceholder}`);
console.log(`  …of which carry a STRONG ID               ${withStrongId}  ← a QID/lda id types these with NO model call`);
console.log(`  These are what a Wikidata resolution pass (design §2a-ii step 1) would settle next.`);
if (VERBOSE) {
  const unresolved = ents.filter((e) => mt.isPlaceholder(e.entity_type) && mt.hasStrongId(e.name));
  console.log(`\n  strong-id rows a Wikidata pass could type (${unresolved.length}):`);
  for (const e of unresolved.slice(0, 60)) console.log(`     #${String(e.id).padStart(6)} ${String(e.name).slice(0, 60)}`);
  if (unresolved.length > 60) console.log(`     …and ${unresolved.length - 60} more`);
}

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const up = d.prepare('UPDATE graph_entities SET entity_type = ?, updated_at = ? WHERE id = ?');
const now = Date.now();
let changed = 0;
d.transaction(() => { for (const p of plan) changed += up.run(p.to, now, p.id).changes; })();

console.log(`\n${'='.repeat(80)}`);
console.log(`APPLIED — ${changed} entity/entities re-typed.`);
console.log(d.prepare(`SELECT entity_type, COUNT(*) c FROM graph_entities GROUP BY 1 ORDER BY c DESC LIMIT 12`).all());
process.exit(0);
