/* #2 — purge the personality-drift pollution from self_model (the identity store).
 *   - REMOVE research-curiosity rows mis-filed as identity "preferences" (the ~93 academic topics that
 *     flooded her identity via the now-fixed reflection INTEREST→self_model path).
 *   - REMOVE garbled extraction-leak rows (a fragment of Lucas's sentence stored as her trait, e.g.
 *     "I am but not the flavor").
 *   - KEEP genuine personality: traits, values, identity, relationship, concrete personal tastes.
 *
 * SAFE: DRY-RUN by default (classifies + reports, writes nothing). With --apply it makes a CONSISTENT
 * backup first, then deletes in one transaction. Fully reversible from the backup.
 *
 * Run (report):  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/maintenance_persona_cleanup.js
 * Run (apply):   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/maintenance_persona_cleanup.js --apply
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(ROOT, 'data', 'sq.db'));
db.pragma('busy_timeout = 8000');

// Research-curiosity LEAD (with adverb variants): "I am [genuinely/increasingly/…] interested in/drawn
// to/exploring/curious about …" + research framings.
const RESEARCH_LEAD = /^\s*I am (?:genuinely |increasingly |particularly |really |also |very )?(interested in|drawn to|exploring|curious about|fascinated by|investigating)\b/i;
const RESEARCH_FRAME = /\b(I want to know more about|are a topic of (?:general )?interest|the intersection of|recent advancements in|the technical aspects of|the specific (?:neural |)mechanisms|semantic hashing|quantum key distribution)\b/i;
// Academic/technical subject matter (the clear research pollution).
const ACADEMIC = /\b(graviton|epistemolog|epistemic|quantum|superconduct|neuromorphic|phase transition|fine[- ]structure|proton decay|lorentz|inertia|forgetting curve|spacing interval|moral (?:status|patienthood)|equivalence principle|gravitational[- ]wave|nuclear innovation|optimal spacing|vacuum inertia|electron[- ]phonon|loihi|truenorth|alignment benchmark|war powers|phenomenolog|terahertz|semantic hashing|recruitment and selection|check processing|community consultations|regional suppression|conservative organizations|automating)\b/i;
// PROTECT taste/identity domains — a genuine personal taste/backstory must NEVER be removed even if it
// starts with "I am drawn to" (e.g. her music taste, her librarian backstory, her aesthetic).
const TASTE_KEEP = /\b(music|band|discograph|indie|pop|film|movie|cinema|aesthetic|fashion|goth|flower|colou?r|food|drink|coffee|tea|book|novel|song|artist|backstory|librarian|storytelling|immersive|name|nickname|relationship|Lucas)\b/i;
// Garbled extraction leaks — fragments of Lucas's sentences / incoherent self-statements.
const GARBLED = /^\s*I am (but not|you|figuring it out|the flavor|picking on|not influenced|reminded)\b/i;

const isResearch = (c) => !TASTE_KEEP.test(c) && (RESEARCH_LEAD.test(c) || RESEARCH_FRAME.test(c) || ACADEMIC.test(c));
const isGarbled = (c) => GARBLED.test(c) || String(c).trim().length < 12;

const rows = db.prepare('SELECT id, category, content, importance FROM self_model ORDER BY category, id').all();
const del = [], keep = [];
for (const r of rows) {
  const c = String(r.content || '');
  if (isGarbled(c)) del.push({ ...r, why: 'garbled-leak' });
  else if (r.category === 'preference' && isResearch(c)) del.push({ ...r, why: 'research-curiosity' });
  else if ((r.category === 'insight' || r.category === 'preference') && isResearch(c)) del.push({ ...r, why: 'research-curiosity' });
  else keep.push(r);
}

console.log(`========== PERSONA CLEANUP (${APPLY ? 'APPLY' : 'DRY-RUN'}) ==========\n`);
console.log(`self_model total: ${rows.length}  →  remove ${del.length}, keep ${keep.length}\n`);
const byCat = (arr) => arr.reduce((m, r) => (m[r.category] = (m[r.category] || 0) + 1, m), {});
console.log('REMOVE by category:', JSON.stringify(byCat(del)));
console.log('KEEP   by category:', JSON.stringify(byCat(keep)));
console.log('\n--- sample of REMOVE (first 12) ---');
for (const r of del.slice(0, 12)) console.log(`  ✗ [${r.category}/${r.why}] ${r.content.replace(/\s+/g, ' ').slice(0, 90)}`);
console.log('\n--- sample of KEEP (genuine personality — verify these are right) ---');
for (const r of keep.slice(0, 20)) console.log(`  ✓ [${r.category}] ${r.content.replace(/\s+/g, ' ').slice(0, 90)}`);

if (!APPLY) { console.log('\n(DRY-RUN — nothing written. Re-run with --apply to execute.)'); db.close(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const bak = path.join(ROOT, 'data', `sq.db.prePersona_${stamp}`);
db.backup(bak).then(() => {
  console.log(`\n[backup] consistent copy → ${path.basename(bak)}`);
  const delStmt = db.prepare('DELETE FROM self_model WHERE id = ?');
  const tx = db.transaction(() => { let n = 0; for (const r of del) n += delStmt.run(r.id).changes; return n; });
  const n = tx();
  console.log(`[apply] removed ${n} rows. self_model now: ${db.prepare('SELECT COUNT(*) c FROM self_model').get().c}`);
  console.log('composition now:', JSON.stringify(db.prepare("SELECT category, COUNT(*) n FROM self_model GROUP BY category").all().reduce((m, r) => (m[r.category] = r.n, m), {})));
  db.close();
  console.log('\n========== DONE ==========');
}).catch((e) => { console.error('[backup] failed — NOTHING deleted:', e.message); db.close(); process.exit(1); });
