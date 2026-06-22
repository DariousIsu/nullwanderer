/**
 * Backtest — lanes.js (HERS/YOURS/OURS surfacing lanes), OFFLINE (temp DB + real CPU
 * embedder, no chat model). Proves: domains derive from user-assigned threads + commitments,
 * a candidate matching an ACTIVE assignment → yours, one matching the broader history
 * profile → ours, an unrelated thought → hers, the default is hers when nothing's assigned,
 * and the per-lane thresholds make HERS the quietest.
 */
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_lanes_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');
const lanes = require('../lib/lanes');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const SESSION = db.startSession();
// helper: create a user turn + an open_thread sourced from it (an assignment from Lucas)
function assign(content, status = 'active') {
  const turn = db.insertTurn({ sessionId: SESSION, speaker: 'user', content });
  const t = db.insertOpenThread({ content, sourceTurnId: turn.id });
  if (status !== 'pending') db.getDb().prepare('UPDATE open_threads SET status = ? WHERE id = ?').run(status, t.id);
  return t.id;
}

(async () => {
  console.log('Backtest — lanes.js (offline)\n');
  await memory.warm();

  console.log('thresholds (HERS quietest, deliverables loudest):');
  ok('HERS bar (9) > OURS bar (6) > YOURS bar (5)', lanes.thresholdFor('hers') === 9 && lanes.thresholdFor('ours') === 6 && lanes.thresholdFor('yours') === 5);
  ok('unknown lane falls back to the HERS bar', lanes.thresholdFor('???') === 9);

  console.log('\nno assignments yet → everything is HERS (safe default):');
  ok('a candidate with an empty domain profile → hers', (await lanes.classify('I keep thinking about 1960s female war correspondents.')) === 'hers');

  console.log('\nwith assignments → lanes separate by origin + overlap:');
  // YOURS: an ACTIVE assignment from Lucas
  assign('Draft a policy brief on US-Israel economic partnership and trade ties.', 'active');
  // a resolved/older assignment → part of the broader "his work" profile, not an active deliverable
  assign('Pull together Gleipnir client outreach notes for the regulatory campaign.', 'resolved');
  lanes.invalidate();
  const dom = await lanes.buildDomains(true);
  ok('domain profile built from assignments (all ≥ 2, active ≥ 1)', dom.all.length >= 2 && dom.active.length >= 1);

  const yours = await lanes.classify('A new angle on the US-Israel economic partnership and bilateral trade just occurred to me.');
  ok('candidate matching an ACTIVE assignment → yours', yours === 'yours');

  const ours = await lanes.classify('I found background that could feed the Gleipnir client outreach for the regulatory campaign.');
  ok('candidate matching the broader his-work profile (not active) → ours', ours === 'ours');

  const hers = await lanes.classify('I want to keep reading about the history of jazz piano voicings.');
  ok('candidate unrelated to his work → hers', hers === 'hers');

  console.log('\ninvalidate() forces a rebuild on the next classify:');
  lanes.invalidate();
  assign('Monitor the new appropriations bill markup and summarize amendments.', 'active');
  const fresh = await lanes.classify('The appropriations bill markup added two amendments worth flagging.');
  ok('a freshly-assigned topic is picked up immediately (yours)', fresh === 'yours');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
