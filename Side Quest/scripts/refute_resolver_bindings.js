/* scripts/refute_resolver_bindings.js — mark the false resolver bindings, and ONLY the provable ones.
 *
 * docs/RESOLVER_FALSE_IDENTIFICATION_HANDOFF.md §6c. V1 stops new ones; this deals with the pile
 * already in the log — 104 federal-ID-tagged people carrying 122 local structural claims, created when
 * the resolver bound a surface name to a canonical entity that `entity_match` would have refused.
 *
 * ── THE TEST IS EVIDENCE, NOT A PATTERN ─────────────────────────────────────────────────────────
 *
 * It is tempting to refute all 122 on the shape of the thing: a federal candidate id attached to a
 * county board is obviously wrong. But `BAIRD, JAMES R DR. [H8IN04199] → AMERICAN MEDICAL ASSOCIATION`
 * is entirely plausible — a physician who is also a congressman may well be an AMA member. Refuting it
 * would be asserting a falsehood of my own to clean up someone else's.
 *
 * So each claim is checked against ITS OWN SOURCE DOCUMENT: does the person's SURNAME appear anywhere
 * in the text the claim came from? If it does not, the document cannot have stated this claim about
 * this person, and the binding is provably unsupported — which is exactly what happened to Carolyn
 * Brummund (recorded as BOURDEAUX) and Adam Brege (recorded as Frisch): neither surname occurs in the
 * Alcona County minutes at all.
 *
 * If the surname IS present, the claim is left alone. It may still be wrong, but I cannot prove it is,
 * and `known_incorrect.record()` requires a reason for exactly this discipline — an unreasoned
 * refutation is an opinion, and indistinguishable from decay.
 *
 * Nothing is deleted. The log is append-only; a refuted claim stays and is marked, because deleting is
 * what lets the same datum walk back in on the next sweep.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/refute_resolver_bindings.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const ki = require('../lib/known_incorrect');
const { parseEntity } = require('../lib/entity_match');

db.init();
const d = db.getDb();
const APPLY = process.argv.includes('--apply');

console.log(`\nREFUTE FALSE RESOLVER BINDINGS — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(80)}`);

// The suspect population: a person carrying a FEDERAL strong id (FEC candidate / bioguide) with a local
// structural claim. That is the shape the audit found; the surname test below is what decides.
const rows = d.prepare(`
  SELECT id, object_key, object_label, claim_class, claim_key, claim_value, source_ref
    FROM encounters
   WHERE claim_class = 'structural' AND claim_key IN ('member_of','works_for','leads')
     AND (object_label LIKE '%[FEC:%' OR object_label GLOB '*[[]?[0-9][0-9][0-9][0-9][0-9][0-9][]]*')`).all();

console.log(`suspect claims (federal id + local structural claim)   ${rows.length}`);

const docBody = (ref) => {
  const m = /^doc:(\d+)$/.exec(String(ref || ''));
  if (!m) return null;
  try { return (d.prepare('SELECT body FROM documents WHERE id = ?').get(Number(m[1])) || {}).body || null; } catch { return null; }
};

const refute = []; const kept = []; const unknown = [];
for (const r of rows) {
  const body = docBody(r.source_ref);
  if (!body) { unknown.push({ ...r, why: 'source document not retrievable — cannot prove either way' }); continue; }
  const p = parseEntity({ name: r.object_label, type: 'person' });
  // The surname is the load-bearing token. A first name proves nothing — matching on one is the bug.
  const surname = p.surname && p.surname.length >= 3 ? p.surname : null;
  if (!surname) { unknown.push({ ...r, why: 'no usable surname to test' }); continue; }
  const present = new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body);
  if (present) kept.push({ ...r, surname });
  else refute.push({ ...r, surname });
}

console.log(`  PROVABLY UNSUPPORTED (surname absent from its own source)   ${refute.length}`);
console.log(`  surname IS present — left alone, cannot prove wrong        ${kept.length}`);
console.log(`  undecidable (no document / no surname)                     ${unknown.length}`);

console.log(`\nTO REFUTE — the source document never names this person:`);
for (const x of refute.slice(0, 20)) {
  console.log(`  ${String(x.object_label).slice(0, 34).padEnd(36)} —${x.claim_key}→ ${String(x.claim_value).slice(0, 30).padEnd(32)} (${x.source_ref}, no "${x.surname}")`);
}
if (kept.length) {
  console.log(`\nLEFT ALONE — the surname really is in the source, so this may be true:`);
  for (const x of kept.slice(0, 10)) console.log(`  ${String(x.object_label).slice(0, 34).padEnd(36)} —${x.claim_key}→ ${String(x.claim_value).slice(0, 34)}`);
}
if (unknown.length) {
  console.log(`\nUNDECIDABLE — reported, not guessed:`);
  for (const x of unknown.slice(0, 8)) console.log(`  ${String(x.object_label).slice(0, 34).padEnd(36)} ${x.why}`);
}

const accounted = refute.length + kept.length + unknown.length;
console.log(`\naccounting: ${refute.length} refute + ${kept.length} keep + ${unknown.length} undecidable = ${accounted} of ${rows.length}`
  + `  ${accounted === rows.length ? '(balances)' : '← DOES NOT BALANCE'}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = ki.recordMany(refute.map((x) => ({
  objectKey: x.object_key,
  claimClass: x.claim_class,
  claimKey: x.claim_key,
  claimValue: x.claim_value,
  reason: `resolver bound this on a first-name match; the surname "${x.surname}" does not appear in the source document (${x.source_ref}). Audit 2026-07-21.`,
  refutedBy: 'audit:resolver-false-identification',
})));

console.log(`\n${'='.repeat(80)}`);
console.log(`APPLIED — ${res.added} refutation(s) recorded, ${res.alreadyKnown} already known.`);
console.log(`known-incorrect now holds ${ki.stats().total} value(s) across ${ki.stats().objects} object(s).`);
console.log(`\nNOTHING WAS DELETED. The encounters stay and are marked — deleting is what lets a bad`);
console.log(`datum walk back in on the next sweep.`);
process.exit(0);
