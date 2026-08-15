/* Smoke: lib/diagnosis — Stage 2 of the native self-repair loop (the class-branched study).
 * Proves: repair-need detection, path confinement, the deterministic pre-gather against the REAL
 * repo (file head + git history; log tail fail-soft), the diagnosis prompt shape, and the
 * FILE:LINE validator (accepts cited diagnoses, refuses URLs-only/narration/short).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_diagnosis.js
 */
'use strict';
const dg = require('../lib/diagnosis');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// class detection
ok(dg.isRepairNeed({ born_from: 'self-audit:zero-caller-export:lib/absence.js' }) === true, 'self-audit-born → repair');
ok(dg.isRepairNeed({ born_from: 'self-watch: recurred 3x/24h' }) === true, 'self-watch-born → repair');
ok(dg.isRepairNeed({ born_from: 'fill-gap:Oregon House committees' }) === false, 'run-born → skill (web study unchanged)');
ok(dg.isRepairNeed({}) === false && dg.isRepairNeed(null) === false, 'no born_from → skill');

// path confinement — a signature can never walk out of the repo's source surface
ok(dg._safeRel('lib/absence.js') === 'lib/absence.js', 'lib path allowed');
ok(dg._safeRel('main.js') === 'main.js', 'main.js allowed');
ok(dg._safeRel('../secrets/.env') === null, 'traversal refused');
ok(dg._safeRel('C:/Windows/system32/x.js') === null, 'absolute path refused');
ok(dg._safeRel('data/sq.db') === null, 'non-source surface refused');

// pre-gather against the REAL repo (deterministic, model-free)
const need = { need: 'lib/absence.js exports ttlFor() and no live code calls it (smoke-only)', born_from: 'self-audit:zero-caller-export:lib/absence.js' };
const bundle = dg.preGather(need);
ok(/IMPLICATED FILE lib\/absence\.js/.test(bundle), 'bundle carries the implicated file head');
ok(/RECENT HISTORY of lib\/absence\.js/.test(bundle), 'bundle carries the file\'s git history');
ok(bundle.length <= dg.BUNDLE_CAP, `bundle capped (${bundle.length} ≤ ${dg.BUNDLE_CAP})`);
ok(dg.preGather({ need: 'x', born_from: 'self-audit:unread-meta-key:../evil' }) !== undefined, 'a hostile signature path gathers fail-soft (no throw)');

// the prompt
const prompt = dg.diagnosisPrompt(need, bundle);
ok(/DIAGNOSIS ONLY — do not build, fix, or search the web/.test(prompt), 'prompt forbids fixing + web search');
ok(/FILE:LINE citation/.test(prompt) && /never guess a cause/.test(prompt), 'prompt demands citations and forbids guessing');

// the validator — the repair-side payload contract
ok(dg.validateDiagnosis('Root cause: the ?? chain in lib/calendar.js:42 stops at the truthy object, so toMs(object) returns null and every Google event drops. Minimal repair: unwrap {dateTime} before coercion at lib/calendar.js:40.') === true, 'a cited diagnosis passes');
ok(dg.validateDiagnosis('See https://example.com/blog for the pattern; also https://x.dev.') === false, 'URLs without file:line → rejected (that is a skill study, not a diagnosis)');
ok(dg.validateDiagnosis('The root cause is probably somewhere in the calendar module and should be investigated further by the team.') === false, 'no citation → rejected');
ok(dg.validateDiagnosis('lib/x.js:1') === false, 'too short to be a diagnosis → rejected');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
