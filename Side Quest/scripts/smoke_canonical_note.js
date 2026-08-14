/**
 * ONE-CANONICAL-ARTIFACT at the file-write door (Block 3, 2026-08-14). Measured disease: ~10
 * sibling notes for one subject (applied_digital_overview / applied-digital-overview /
 * applied_digital_current_state …) — every pass minted a fresh filename. Pins: same-subject stems
 * FOLD into the existing canonical as a dated APPEND (prior material recoverable); different
 * subjects, different entities (…_solutions_…), date-stamped, directed-*, and _FINAL names all
 * still mint their own files.
 *
 * Runs in a throwaway subdir of the real workspace (the canonical scan is directory-local, so the
 * test is hermetic there); removed in the finally.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_canonical_note.js
 */
const fs = require('fs');
const path = require('path');
const files = require('../lib/files');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const sub = `notes/__smoke_canon_${Date.now()}`;
const absDir = path.join(files.WORKSPACE, sub);

try {
  // Seed the canonical.
  const w1 = files.fileWrite(`${sub}/applied_digital_overview.md`, '# Applied Digital\nOriginal material.\n');
  ok('first write on a subject creates the file normally', w1.ok && !w1.redirected && fs.existsSync(w1.path));

  // The live sibling shapes: same subject, different filler words / separators → FOLDED.
  const w2 = files.fileWrite(`${sub}/applied-digital-current-state.md`, 'Newer pass material.');
  ok('same-subject sibling ("current-state") folds into the canonical', w2.ok && w2.redirected === true
    && path.basename(w2.path) === 'applied_digital_overview.md' && !fs.existsSync(path.join(absDir, 'applied-digital-current-state.md')));
  ok('the fold is an APPEND — original material still present + revision marked', (() => {
    const t = fs.readFileSync(w2.path, 'utf8');
    return t.includes('Original material.') && t.includes('Newer pass material.') && t.includes('*revision ');
  })());
  const w3 = files.fileWrite(`${sub}/applied_digital_research_overview.md`, 'Third pass.');
  ok('a third sibling shape also folds (generic "research"/"overview" stripped)', w3.ok && w3.redirected === true);

  // Entity distinction survives: extra DISTINCTIVE token = a different file.
  const w4 = files.fileWrite(`${sub}/applied_digital_solutions_overview.md`, 'The VeriChip-era company — different entity.');
  ok('a distinct-entity name ("solutions") still mints its own file', w4.ok && !w4.redirected);

  // Different subjects never fold (the allen-county trap: 60% token overlap, different counties).
  files.fileWrite(`${sub}/allen_county_ks_governance.md`, 'Kansas.');
  const w5 = files.fileWrite(`${sub}/allen_county_indiana_governance.md`, 'Indiana.');
  ok('same-shape different-subject names stay separate (KS vs Indiana)', w5.ok && !w5.redirected);

  // Exemptions: dated, directed-*, _FINAL.
  files.fileWrite(`${sub}/roster-refresh-2026-08-13.md`, 'day one');
  const w6 = files.fileWrite(`${sub}/roster-refresh-2026-08-14.md`, 'day two');
  ok('date-stamped artifacts are exempt (per-day files stay per-day)', w6.ok && !w6.redirected);
  const w7 = files.fileWrite(`${sub}/applied_digital_FINAL.md`, 'the conductor owns this');
  ok('_FINAL names are exempt (the conductor owns them)', w7.ok && !w7.redirected);

  // Explicit path to an EXISTING file is untouched behavior (overwrite in place).
  const w8 = files.fileWrite(`${sub}/applied_digital_overview.md`, '# Rewritten whole.\n');
  ok('writing an existing file overwrites it in place (no redirect logic)', w8.ok && !w8.redirected
    && fs.readFileSync(w8.path, 'utf8') === '# Rewritten whole.\n');

  // Append to a would-be sibling folds too.
  const a1 = files.fileAppend(`${sub}/applied-digital-notes.md`, 'appended fact');
  ok('append to a new same-subject name folds into the canonical', a1.ok && a1.redirected === true
    && fs.readFileSync(a1.path, 'utf8').includes('appended fact'));
} finally {
  try { fs.rmSync(absDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
