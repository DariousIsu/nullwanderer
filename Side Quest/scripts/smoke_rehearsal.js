/* Smoke: lib/rehearsal — R1 of the rehearsal ladder. THE PROOF IS ISOLATION: she breaks a module in
 * the sandbox, her gate FAILS in there, and the live source + live gate remain untouched and green.
 * Temp ZOE_REHEARSAL_DIR + SQ_DB_PATH → never touches live data/.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_rehearsal.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = path.join(os.tmpdir(), `zoe-rehearsal-${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
process.env.ZOE_REHEARSAL_DIR = path.join(TMP, 'rehearsal');
process.env.SQ_DB_PATH = path.join(TMP, 'sq.db');
require('../lib/db').init();
const R = require('../lib/rehearsal');
const ss = require('../lib/self_source');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- create + the jail ---
  ok(/cannot create/.test(R.create({ slug: '../evil' })), 'a traversal slug bounces');
  ok(/cannot create/.test(R.create({ slug: 'Bad Slug!' })), 'a garbage slug bounces');
  const c1 = R.create({ slug: 'test-idea' });
  ok(/created/.test(c1) && /live program is untouched/i.test(c1), 'a sandbox creates with the honest framing');
  ok(fs.existsSync(path.join(R.REHEARSAL_ROOT, 'test-idea', 'lib', 'recall.js')), 'source files are copied in');
  ok(fs.existsSync(path.join(R.REHEARSAL_ROOT, 'test-idea', 'node_modules')), 'node_modules junction is present');
  ok(/already exists/.test(R.create({ slug: 'test-idea' })), 'a duplicate slug refuses');

  // --- the edit contract (her Edit primitive, sandbox-only) ---
  ok(/cannot edit/.test(R.edit({ slug: 'test-idea', path: '../../main.js', find: 'x'.repeat(8), replace: 'y' })), 'an edit path escaping the sandbox bounces');
  ok(/cannot edit/.test(R.edit({ slug: 'test-idea', path: 'node_modules/x.js', find: 'x'.repeat(8), replace: 'y' })), 'the junction is not editable');
  ok(/does not appear/.test(R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: 'THIS_TEXT_IS_NOWHERE', replace: 'y' })), 'an absent find refuses — read the file first');
  ok(/appears \d+ times/.test(R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: 'function ', replace: 'fn ' })), 'an ambiguous find refuses — more context required');

  // ── A REFUSAL MUST HAND BACK WHAT IT TOOK ───────────────────────────────────────────────────
  // Both refusals used to state the problem and stop. "Include more surrounding context" leaves
  // the model guessing WHICH occurrence and what distinguishes them; "match it EXACTLY" never says
  // what the file contains. Each guess burns a whole rehearsal tick, and need-born runs are capped
  // at two open — so a refusal that cannot be acted on is close to a dead run.
  {
    const amb = R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: 'function ', replace: 'fn ' });
    ok(/Copy ONE of these spans verbatim/.test(amb), 'the ambiguous refusal says exactly what to do next');
    ok(/\[1\] line \d+:/.test(amb) && /\[2\] line \d+:/.test(amb), 'and SHOWS each occurrence with its line number');
    ok(/\d+ \| /.test(amb), 'with numbered surrounding lines — the thing that makes a span unique');
    ok(amb.length <= 1700, 'bounded: this lands in her context on a failed tick, so it stays small');

    // Whitespace is the usual cause of a miss — the file HAS the text, differently indented.
    const ws = R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: '      function parseRecallTags(text) {', replace: 'x' });
    ok(/does not appear/.test(ws), 'a whitespace-mangled find still refuses');
    ok(/different whitespace or indentation|not a whitespace slip/.test(ws), 'and the refusal diagnoses WHICH kind of miss it is');

    const nowhere = R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: 'ZZZ_NOT_IN_ANY_FILE_ANYWHERE_12345', replace: 'x' });
    ok(/not a whitespace slip/.test(nowhere) && /\d+-line file/.test(nowhere), 'a genuine absence says so plainly and names the file size, rather than implying a typo');
  }
  const liveRecall = fs.readFileSync(path.join(ss.ROOT, 'lib', 'recall.js'), 'utf8');
  // Break the d-ref branch INSIDE the sandbox only.
  const e1 = R.edit({ slug: 'test-idea', path: 'lib/recall.js', find: `if (ref.kind === 'd') {`, replace: `if (ref.kind === 'd-BROKEN') {` });
  ok(/edited lib\/recall\.js/.test(e1), 'an exact-once edit applies in the sandbox');
  ok(fs.readFileSync(path.join(ss.ROOT, 'lib', 'recall.js'), 'utf8') === liveRecall, '⭐the LIVE source is byte-identical after the sandbox edit');

  // --- the diff report ---
  const d1 = R.diff({ slug: 'test-idea' });
  ok(/1 file\(s\) changed/.test(d1) && /lib\/recall\.js/.test(d1) && /d-BROKEN/.test(d1), 'diff names the changed file and shows the change');

  // --- ⭐THE ISOLATION PROOF: her gate FAILS in the sandbox, PASSES live ---
  const sbRun = await R.test({ slug: 'test-idea', suite: 'smoke_recall.js' });
  ok(/gate FAILED|FAILURES/.test(sbRun), 'the broken sandbox FAILS its own gate (the change was judged, not trusted)');
  const liveRun = await ss.selfTest({ suite: 'smoke_recall.js' });
  ok(/ALL PASS/.test(liveRun), '⭐the LIVE gate still passes — the break never left the sandbox');

  // --- lifecycle: cap, discard, JUNCTION SAFETY on a sacrifice, tidy ---
  ok(/created/.test(R.create({ slug: 'second' })), 'a second sandbox is allowed');
  ok(/max 2/.test(R.create({ slug: 'third' })), 'the third refuses (bounded working set)');
  // ⭐The 2026-07-22 incident, made unrepeatable: point this sandbox's junction at a DUMMY target
  // with a canary file, discard, and the canary must survive. (rmSync once recursed through the
  // junction into the REAL node_modules; _rmSandbox now detaches the link first and REFUSES to
  // recurse if it cannot.) The destructive assertion runs against a sacrifice, never the real tree.
  const secondDir = path.join(R.REHEARSAL_ROOT, 'second');
  const dummy = path.join(TMP, 'dummy-target');
  fs.mkdirSync(dummy, { recursive: true });
  fs.writeFileSync(path.join(dummy, 'canary.txt'), 'alive');
  fs.rmdirSync(path.join(secondDir, 'node_modules'));
  fs.symlinkSync(dummy, path.join(secondDir, 'node_modules'), 'junction');
  ok(/discarded/.test(R.discard({ slug: 'second' })), 'discard removes a sandbox');
  ok(fs.existsSync(path.join(dummy, 'canary.txt')), '⭐the junction TARGET survives a discard — the incident cannot recur');
  const mk = path.join(R.REHEARSAL_ROOT, 'test-idea', '.rehearsal.json');
  const m = JSON.parse(fs.readFileSync(mk, 'utf8')); m.touchedTs = Date.now() - 3 * 24 * 3600e3; fs.writeFileSync(mk, JSON.stringify(m));
  ok(R.tidy() === 1 && R.list().length === 0, 'a stale sandbox tidies away (hardened removal path)');
  ok(fs.existsSync(path.join(ss.ROOT, 'node_modules', '.bin')) && fs.existsSync(path.join(ss.ROOT, 'node_modules', 'better-sqlite3')),
    '⭐the REAL node_modules (.bin included) is fully intact after every lifecycle op');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  // TMP now contains no junctions (every sandbox went through R.discard/R.tidy) — safe to remove.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
