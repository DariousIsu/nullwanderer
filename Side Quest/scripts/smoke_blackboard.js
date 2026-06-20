/**
 * Phase A backtest — Blackboard + StuckDetector.
 *
 * Deterministic, no model required. Runs against an ISOLATED throwaway DB
 * (SQ_DB_PATH) so it never touches data/sq.db. Proves:
 *   - blackboard append + signature normalization + read APIs
 *   - StuckDetector scenario 3 (monologue loop) — Side Quest's real pain
 *   - scenario 1 (action+observation repeat)
 *   - scenario 4 (A,B,A,B,A,B alternation)
 *   - a reading/observation between thoughts BREAKS the monologue loop
 *   - a user message RESETS the interactive slice (no false stuck after it)
 *   - near-but-distinct content does NOT trip the detector (no false positives)
 *
 * Run: node scripts/smoke_blackboard.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the DB BEFORE requiring db.js (DB_PATH is read at module load).
const tmp = path.join(os.tmpdir(), `sq_smoke_bb_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const blackboard = require('../lib/blackboard');
const stuck = require('../lib/stuck');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
function reset() { db.getDb().prepare('DELETE FROM agent_events').run(); }

function run() {
  db.init();
  console.log('Phase A backtest — blackboard + stuck detector\n');

  // --- signature normalization ---
  console.log('signature normalization:');
  ok('case/punctuation/whitespace collapse to same key',
    blackboard.signature('I want to WRITE a better email!!!') === blackboard.signature('i want to write a better email'));
  ok('leaked tags stripped from signature',
    blackboard.signature('<focus>study X</focus>') === blackboard.signature('study X'));
  ok('empty content → empty signature', blackboard.signature('') === '' && blackboard.signature(null) === '');
  ok('distinct content → distinct signatures',
    blackboard.signature('study the maastricht treaty') !== blackboard.signature('study the schengen agreement'));

  // --- append + read APIs ---
  console.log('\nblackboard append + read:');
  reset();
  const e1 = blackboard.append({ source: 'monologue', kind: 'thought', content: 'first thought' });
  const e2 = blackboard.append({ source: 'monologue', kind: 'reading', content: 'a reading' });
  ok('append returns ascending ids', e2.id > e1.id);
  const rec = blackboard.recent(10);
  ok('recent() returns oldest→newest', rec.length === 2 && rec[0].id === e1.id && rec[1].id === e2.id);
  ok('signature derived from content on append', rec[0].signature === blackboard.signature('first thought'));
  blackboard.append({ source: 'monologue', kind: 'thought', focusId: 42, content: 'focus-scoped' });
  ok('forFocus() filters by focus_id', blackboard.forFocus(42).length === 1);

  // --- scenario 3: monologue loop ---
  console.log('\nscenario 3 — monologue loop (the real pain):');
  reset();
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'why am I hesitant to act' });
  ok('not stuck after 1 repeat', stuck.check().stuck === false);
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'Why am I hesitant to act?' });
  ok('not stuck after 2 repeats', stuck.check().stuck === false);
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'why am I hesitant to ACT!' });
  const s3 = stuck.check();
  ok('STUCK after 3 identical thoughts', s3.stuck === true && s3.scenario === 'monologue-repeat');

  // --- a reading between thoughts breaks the loop ---
  console.log('\nobservation breaks the monologue loop:');
  reset();
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'same recurring thought' });
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'same recurring thought' });
  blackboard.append({ source: 'monologue', kind: 'reading', content: 'I looked something up' });
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'same recurring thought' });
  ok('NOT stuck — a reading interrupted the contiguous run', stuck.check().stuck === false);

  // --- no false positive on distinct thoughts ---
  console.log('\nno false positives:');
  reset();
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'thinking about the treaty' });
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'now about the economy' });
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'and about the election' });
  ok('three DISTINCT thoughts → not stuck', stuck.check().stuck === false);

  // --- scenario 1: action+observation repeat ---
  console.log('\nscenario 1 — action+observation repeat:');
  reset();
  for (let i = 0; i < 4; i++) {
    blackboard.append({ source: 'action', kind: 'action', content: 'send email to bob' });
    blackboard.append({ source: 'action', kind: 'observation', content: 'send failed: timeout' });
  }
  const s1 = stuck.check();
  ok('STUCK after 4 identical action+observation pairs', s1.stuck === true && s1.scenario === 'action-observation-repeat');

  // --- scenario 4: alternation ---
  console.log('\nscenario 4 — A,B,A,B,A,B alternation:');
  reset();
  for (let i = 0; i < 3; i++) {
    blackboard.append({ source: 'action', kind: 'action', content: 'open file A' });
    blackboard.append({ source: 'action', kind: 'action', content: 'open file B' });
  }
  const s4 = stuck.check();
  ok('STUCK on alternating oscillation', s4.stuck === true && s4.scenario === 'alternating');

  // --- user message resets the slice ---
  console.log('\nuser message resets the interactive slice:');
  reset();
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'looping thought' });
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'looping thought' });
  blackboard.markUser('hey, change topic', 1);
  blackboard.append({ source: 'monologue', kind: 'thought', content: 'looping thought' });
  ok('NOT stuck — user message reset the loop window', stuck.check().stuck === false);

  // --- focus-scoped detection ---
  console.log('\nfocus-scoped detection:');
  reset();
  for (let i = 0; i < 3; i++) blackboard.append({ source: 'monologue', kind: 'thought', focusId: 7, content: 'stuck on focus 7' });
  blackboard.append({ source: 'monologue', kind: 'thought', focusId: 9, content: 'different focus, fine' });
  ok('focus 7 detected stuck in its own working set', stuck.check({ focusId: 7 }).stuck === true);
  ok('focus 9 not stuck', stuck.check({ focusId: 9 }).stuck === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);

  try { db.getDb().close(); } catch {}
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(tmp + '-wal'); } catch {}
  try { fs.unlinkSync(tmp + '-shm'); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

run();
