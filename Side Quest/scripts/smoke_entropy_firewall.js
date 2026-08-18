'use strict';
// smoke_entropy_firewall.js — Wave 2c of the pre-hard-testing scope: the behavioral surface draws its
// randomness from lib/entropy, not Math.random. Scans every top-level lib/*.js for an actual
// `Math.random(` CALL (comments stripped, so a doc mention is never flagged) and fails on any that
// isn't a documented NON-behavioral utility. This turns "one governed source of randomness" from a
// discipline into a gate: a new ungoverned coin flip in the behavioral surface fails the build.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_entropy_firewall.js
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const LIB = path.join(__dirname, '..', 'lib');

// Non-behavioral utility sites: randomness that is NOT an expressive decision, so it needn't be
// seedable/reproducible for a turn diff. Each is documented; anything else must go through entropy.
const ALLOW = {
  'analysis_lane.js': 'unique run-id / temp-dir suffix (collision avoidance, not a behavioral choice)',
  'ollama.js': "retry-backoff jitter — de-syncs concurrent workers so they don't retry in lockstep",
  'vision.js': 'image-generation seed handed to ComfyUI (diffusion noise, not an epistemic decision)',
};

const CALL_RE = /Math\.random\s*\(/;
// strip block + line comments so a Math.random MENTION in prose is never mistaken for a call
// (entropy.js's own header explains what it replaces; monologue's tombstone names it). Avoid eating
// the // in a URL like http://…
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
ok(files.length > 20, `scanned the lib behavioral surface (${files.length} modules)`);

const offenders = [];
let allowed = 0;
for (const f of files) {
  let src = '';
  try { src = fs.readFileSync(path.join(LIB, f), 'utf8'); } catch {}
  if (!CALL_RE.test(stripComments(src))) continue;   // no real call → fine
  if (ALLOW[f]) { allowed++; console.log(`  · allow  ${f} — ${ALLOW[f]}`); continue; }
  offenders.push(f);
}
ok(offenders.length === 0,
  offenders.length
    ? `ungoverned Math.random() in: ${offenders.join(', ')} — route through lib/entropy`
    : 'no ungoverned Math.random() anywhere in the behavioral surface');

// the migrated files are specifically clean (proves this session's migration landed)
for (const f of ['interests.js', 'monologue.js']) {
  const code = stripComments(fs.readFileSync(path.join(LIB, f), 'utf8'));
  ok(!CALL_RE.test(code), `${f}: migrated off Math.random (draws from entropy)`);
}
// the governed source itself is Math.random-free (it IS the replacement — splitmix64)
ok(!CALL_RE.test(stripComments(fs.readFileSync(path.join(LIB, 'entropy.js'), 'utf8'))),
  'entropy.js carries no Math.random — the PRNG is splitmix64, not the thing it replaces');

// allowlist hygiene: a listed util that no longer calls Math.random is a stale entry (note, don't fail)
for (const f of Object.keys(ALLOW)) {
  let code = '';
  try { code = stripComments(fs.readFileSync(path.join(LIB, f), 'utf8')); } catch {}
  if (!CALL_RE.test(code)) console.log(`  ℹ allowlist entry ${f} no longer calls Math.random — can be pruned`);
}

// guard the guard: the scan must actually catch a call, and must NOT flag a commented-out one
ok(CALL_RE.test('const x = Math.random();'), 'the scan detects an introduced Math.random( call (self-check)');
ok(!CALL_RE.test(stripComments('x = 1; // legacy Math.random() call, now removed')),
  'a Math.random( inside a comment is stripped, not flagged (self-check)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
