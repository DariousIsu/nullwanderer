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

// the grandfathered-run intercept: a run advancing a repair-born need must leave the rehearse pipe
const rowsFor = [{ id: 94, born_from: 'self-watch: exhaust audit' }, { id: 40, born_from: 'fill-gap:Oregon House committees' }];
ok(dg.isRepairRunFor({ slug: 'need-94-i-need-a-fix-for-a-recurring-fai' }, rowsFor)?.id === 94, 'repair-born run → its need row returned (discard it)');
ok(dg.isRepairRunFor({ slug: 'need-40-oregon-house-committee-roster' }, rowsFor) === null, 'a run for a RUN-BORN (skill) need stays in the rehearse pipe');
ok(dg.isRepairRunFor({ slug: 'canvas-format-polish' }, rowsFor) === null, 'a non-need slug is never intercepted');
ok(dg.isRepairRunFor({ slug: 'need-94-i-need-a-fix' }, []) === null && dg.isRepairRunFor(null, rowsFor) === null, 'missing row or no run → null (never discard blind)');
// the v1 miss, caught live: the run-backed row sits in 'rehearsing' — ABSENT from listOpen()'s
// array — so the intercept must find it through the direct getNeed lookup.
const rehearsingRow = { id: 94, status: 'rehearsing', born_from: 'self-watch: exhaust audit' };
ok(dg.isRepairRunFor({ slug: 'need-94-i-need-a-fix' }, [], { getNeed: (id) => (id === 94 ? rehearsingRow : null) })?.id === 94,
  "a 'rehearsing' repair row invisible to listOpen is found via getNeed (the LIVE leak shape)");
ok(dg.isRepairRunFor({ slug: 'need-40-x' }, [], { getNeed: () => ({ id: 40, born_from: 'fill-gap:committees' }) }) === null,
  'getNeed returning a skill row still never discards');
ok(dg.isRepairRunFor({ slug: 'need-77-x' }, [], { getNeed: () => null }) === null, 'getNeed finding nothing → null (still never blind)');

// ── SIGNATURE FIDELITY (§52e: the first wrong diagnosis read blanking artifacts as the defect) ──
// the matcher inverts self_watch's normalization: \d+→'N', whitespace collapsed, 90-char slice
const rawLine = '[autonomy] chose=rehearse → need-94-i-need-a-fix-for-a-recurring-fai active — edit pick returned but FAILED VALIDATION (schema) — budget refunded';
const blanked = rawLine.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 90);   // the exact self_watch.js:99 recipe
ok(dg._sigToRegex(blanked).test(rawLine), 'a digit-blanked, truncated signature matches its own VERBATIM source line');
ok(dg._sigToRegex(blanked).test(rawLine.replace('need-94', 'need-101')) === true, 'the blanked N matches ANY instance number (the fold means many raw lines share one sig)');
ok(dg._sigToRegex(blanked).test('[curator] stalled 5 long-untouched active thread(s)') === false, 'an unrelated line does not match');
ok(dg._sigToRegex('BAD NEWS from a completed pass').test('BAD NEWS from a completed pass'), "a literal 'N' in real words still matches (N-or-digits, never digits-only)");
const hayk = 'noise line\n' + rawLine + '\n' + rawLine + '\nother noise';
const rawHits = dg._rawLinesFor(blanked, { text: hayk });
ok(rawHits.length === 1 && rawHits[0] === rawLine, `raw lines gathered from text, deduped (${rawHits.length})`);
// the bundle: raw lines lead for a self-watch need, and the prompt names the convention
const swNeed = { need: `I need a fix for a recurring failure in my own program: ${blanked}`, born_from: `self-watch: ${blanked}` };
const swBundle = dg.preGather(swNeed, { deps: { rawText: hayk } });
ok(/^RAW LOG LINES matching this signature/.test(swBundle) && swBundle.includes('budget refunded'), 'a self-watch bundle LEADS with the verbatim raw lines (the cap can never starve them)');
ok(/digit-blanked/.test(dg.diagnosisPrompt(swNeed, swBundle)) && /NEVER the defect/.test(dg.diagnosisPrompt(swNeed, swBundle)),
  'the self-watch prompt names the normalization so artifacts are never diagnosed as corruption');
ok(!/digit-blanked/.test(dg.diagnosisPrompt(need, bundle)), 'a self-audit prompt carries no signature note (nothing was blanked)');

// study citations verify against the ledger (cited = actually read)
const fakeLedger = { seen: (u) => (/known\.gov/.test(u) ? { url: u } : null) };
const vc1 = dg.verifyStudyCitations('Pattern: use X. Sources: https://known.gov/how and https://never-read.example/post', { deps: { siteLedger: fakeLedger } });
ok(vc1.ok && vc1.verified.length === 1 && vc1.unverified.length === 1, 'study cites split into ledger-verified vs never-read');
const vc2 = dg.verifyStudyCitations('Pattern: use Y. Source: https://never-read.example/post', { deps: { siteLedger: fakeLedger } });
ok(vc2.ok === false && /never actually read/.test(vc2.reason), 'a study whose EVERY cite was never read → rejected (composed, not sourced)');
ok(dg.verifyStudyCitations('no urls at all here', { deps: { siteLedger: fakeLedger } }).ok === false, 'no URLs → not sourced');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
