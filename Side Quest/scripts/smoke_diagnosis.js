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

// ── REAL CODE, REAL CITES (Lucas 08-27: repairs built from sourced, verified evidence) ─────────
// citation EXISTENCE: a repo-shaped cite must point at code that exists
ok(dg.validateDiagnosis('Root cause: the fold in lib/does_not_exist.js:12 collapses distinct rows. Minimal repair: split the key at lib/does_not_exist.js:15.') === false,
  'a citation into a NONEXISTENT repo file → the whole diagnosis rejected (hallucinated cite)');
ok(dg.validateDiagnosis('Root cause: the loader at lib/diagnosis.js:999999 never returns. Minimal repair: bound the read at lib/diagnosis.js:999998.') === false,
  'a citation past EOF → rejected');
ok(dg.validateDiagnosis('Root cause: DOMMatrix is missing in the worker (node:internal/worker:123); the polyfill gate sits at lib/diagnosis.js:20 and never arms. Minimal repair: arm it.') === true,
  'non-repo paths are ignored; a real repo cite carries the diagnosis');

// implicated-code search: a file-less self-watch signature finds the real files by its tokens
const toks = dg._sigTokens('[echo] FAILED: domainLeashTokens exploded in lane 4');
ok(toks.includes('domainLeashTokens'), `distinctive identifier extracted (${toks.join(',')})`);
const impl = dg._findImplicated('[echo] FAILED: domainLeashTokens exploded in lane 4');
ok(impl.length >= 1 && impl.every((f) => /\.js$/.test(f)), `implicated files found by token search (${impl.join(', ')})`);
const bundle2 = dg.preGather({ need: 'I need a fix for a recurring failure in my own program: domainLeashTokens exploded', born_from: 'self-watch: [echo] FAILED: domainLeashTokens exploded' });
ok(/IMPLICATED FILE/.test(bundle2), 'a file-less self-watch need now gathers REAL CODE via the token search');

// study citations verify against the ledger (cited = actually read)
const fakeLedger = { seen: (u) => (/known\.gov/.test(u) ? { url: u } : null) };
const vc1 = dg.verifyStudyCitations('Pattern: use X. Sources: https://known.gov/how and https://never-read.example/post', { deps: { siteLedger: fakeLedger } });
ok(vc1.ok && vc1.verified.length === 1 && vc1.unverified.length === 1, 'study cites split into ledger-verified vs never-read');
const vc2 = dg.verifyStudyCitations('Pattern: use Y. Source: https://never-read.example/post', { deps: { siteLedger: fakeLedger } });
ok(vc2.ok === false && /never actually read/.test(vc2.reason), 'a study whose EVERY cite was never read → rejected (composed, not sourced)');
ok(dg.verifyStudyCitations('no urls at all here', { deps: { siteLedger: fakeLedger } }).ok === false, 'no URLs → not sourced');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
