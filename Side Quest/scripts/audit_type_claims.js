/* scripts/audit_type_claims.js — what does T3 actually settle, on live data?
 *
 * The number that matters for T4: how many names have a type that is decided WELL ENOUGH TO ACT ON.
 * `settled` is deliberately strict — B or better, no close rival, and a strict win over any rival, since
 * a tie resolved by sort order is first-writer-wins wearing a grade.
 *
 * Read-only. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/audit_type_claims.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const ot = require('../lib/object_type');

db.init();
const d = db.getDb();

const subjects = d.prepare(`SELECT object_key, MIN(object_label) label FROM encounters
                             WHERE claim_class = 'type' GROUP BY object_key`).all();

let settled = 0, contested = 0, cleaning = 0, unsettled = 0;
const byType = {}; const byGrade = {};
const notSettled = [];
for (const s of subjects) {
  const t = ot.typeOf(s.label);
  byGrade[t.grade || 'none'] = (byGrade[t.grade || 'none'] || 0) + 1;
  if (t.contested) contested += 1;
  if (t.cleaning) cleaning += 1;
  if (t.settled) { settled += 1; byType[t.type] = (byType[t.type] || 0) + 1; }
  else { unsettled += 1; if (notSettled.length < 12) notSettled.push({ label: s.label, ...t }); }
}

console.log(`\nTYPE CLAIMS (T3) — live\n${'='.repeat(76)}`);
console.log(`name subjects with a type claim   ${subjects.length}`);
console.log(`  SETTLED (T4 may act)            ${settled}`);
console.log(`  not settled                     ${unsettled}`);
console.log(`  contested                       ${contested}   of which needing cleaning: ${cleaning}`);
console.log(`\nby grade    ${JSON.stringify(byGrade)}`);
console.log(`settled by type  ${JSON.stringify(byType)}`);
console.log(`\nA SAMPLE OF WHAT IS NOT SETTLED (and why it is correct to hold these):`);
for (const n of notSettled) {
  console.log(`  ${String(n.label).slice(0, 32).padEnd(34)} ${String(n.type).padEnd(17)} ${String(n.grade || '—').padEnd(3)}`
    + ` ${n.contested ? 'contested' : ''}${n.cleaning ? '/cleaning' : ''}${n.unverified ? 'unverified' : ''}`);
}
process.exit(0);
