/**
 * Offline smoke for lib/snapback — the manual recall lever.
 * Verifies the hard-pull phrase matcher fires on explicit recall phrases and
 * stays quiet on ordinary chatter (false-positive guard), plus the busy-line picker.
 *
 * Run: node scripts/smoke_snapback.js
 */
const { detectHardPull, pickBusyLine, BUSY_LINES } = require('../lib/snapback');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- should HARD-PULL (explicit recall) ---
const PULL = [
  'earth to Zoe',
  'Earth to Zoe!',
  'Zoe, come back',
  'zoe come back to me',
  'come back zoe',
  'Zoe, snap out of it',
  'snap out of it',
  'snap out of it zoe',
  'Zoe, you there?',
  'you there zoe?',
  'Zoe are you with me?',
  'zoe wake up',
  'Zoe pay attention',
];
for (const m of PULL) ok(`pull: "${m}"`, detectHardPull(m) === true, 'expected hard-pull');

// --- should NOT pull (ordinary chatter / her name without a recall verb) ---
const NOPULL = [
  'what do you think about VNV Nation, Zoe?',
  'Zoe, can you find our papers on weather modification?',
  'come back later we can finish this',          // no "zoe"
  'I love how lost in thought you get',
  'tell me more about Castle Ybor',
  'Zoe is doing great today',
  'lets get back to work on the editor',
  '',
  null,
];
for (const m of NOPULL) ok(`no-pull: ${JSON.stringify(m)}`, detectHardPull(m) === false, 'expected no pull');

// --- busy-line picker ---
ok('busy line is a non-empty string', typeof pickBusyLine(0) === 'string' && pickBusyLine(0).length > 0);
ok('busy picker wraps the array', pickBusyLine(BUSY_LINES.length) === pickBusyLine(0));
ok('busy picker varies by seed', pickBusyLine(0) !== pickBusyLine(1));
ok('busy picker tolerates junk seed', typeof pickBusyLine(undefined) === 'string');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
