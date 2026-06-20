/**
 * Phase F backtest — capability gaps + proposal-on-return + curator aging.
 *
 * Deterministic, no model. Isolated DB. Covers tag parsing (all forms), dedup,
 * lifecycle (open→proposed→resolved/dismissed), the return-proposal block, and
 * the curator's gap age-out.
 *
 * Run under electron-as-node.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_gaps_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const gaps = require('../lib/gaps');
const curator = require('../lib/curator');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() { db.getDb().prepare('DELETE FROM capability_gaps').run(); }

function run() {
  db.init();
  console.log('Phase F backtest — capability gaps + proposals\n');

  // --- tag parsing (all forms) ---
  console.log('parseTags:');
  const p1 = gaps.parseTags('<gap>I cannot read PDF files :: use a pdf-to-text library</gap>');
  ok(':: splits description / solution', p1.length === 1 && p1[0].description === 'I cannot read PDF files' && p1[0].solution === 'use a pdf-to-text library');
  const p2 = gaps.parseTags('<gap solution="add a calendar API">I cannot see his calendar</gap>');
  ok('solution= attribute parsed', p2.length === 1 && p2[0].description === 'I cannot see his calendar' && p2[0].solution === 'add a calendar API');
  const p3 = gaps.parseTags('<gap>I cannot send SMS</gap>');
  ok('bare description (no solution)', p3.length === 1 && p3[0].description === 'I cannot send SMS' && p3[0].solution === null);
  ok('too-short body ignored', gaps.parseTags('<gap>no</gap>').length === 0);
  ok('stripTags removes the tag', gaps.stripTags('before <gap>x y z capability</gap> after').trim() === 'before  after'.trim());

  // --- record + dedup ---
  console.log('\nrecord + dedup:');
  reset();
  ok('records a new gap', gaps.record('<gap>I cannot read PDF files :: pdf lib</gap>') === 1);
  ok('open gap present', db.getOpenCapabilityGaps(10).length === 1);
  ok('duplicate (same desc, diff case/punct) is NOT re-recorded', gaps.record('<gap>I cannot read PDF files!!!</gap>') === 0);
  ok('still only one open gap', db.getOpenCapabilityGaps(10).length === 1);
  ok('a distinct gap IS recorded', gaps.record('<gap>I cannot access the webcam</gap>') === 1);
  ok('two open gaps now', db.getOpenCapabilityGaps(10).length === 2);
  ok('recordOne dedups too', gaps.recordOne('I cannot access the webcam') === false);

  // --- proposal-on-return ---
  console.log('\nbuildReturnProposalBlock:');
  reset();
  ok('no gaps → null block', gaps.buildReturnProposalBlock('Lucas') === null);
  gaps.record('<gap>I cannot read PDF files :: use a pdf-to-text library</gap>');
  const block = gaps.buildReturnProposalBlock('Lucas');
  ok('block names the gap', block && /pdf/i.test(block));
  ok('block includes the proposed solution', /pdf-to-text/.test(block));
  ok('the proposed gap is no longer "open"', db.getOpenCapabilityGaps(10).length === 0);
  ok('second call (nothing open) → null', gaps.buildReturnProposalBlock('Lucas') === null);

  // --- lifecycle ---
  console.log('\nlifecycle:');
  reset();
  gaps.record('<gap>I cannot transcribe audio :: whisper.cpp</gap>');
  const g = db.getOpenCapabilityGaps(1)[0];
  db.markCapabilityGapStatus(g.id, 'proposed');
  ok('open → proposed removes from open list', db.getOpenCapabilityGaps(10).length === 0);
  gaps.markResolved(g.id);
  const row = db.getDb().prepare('SELECT status, resolved_ts FROM capability_gaps WHERE id = ?').get(g.id);
  ok('resolved sets status + resolved_ts', row.status === 'resolved' && row.resolved_ts != null);

  // --- curator ages stale gaps ---
  console.log('\ncurator gap age-out:');
  reset();
  const fresh = db.insertCapabilityGap({ description: 'fresh gap, leave alone', signature: 'fresh' });
  const old = db.insertCapabilityGap({ description: 'ancient gap, dismiss me', signature: 'old' });
  db.getDb().prepare('UPDATE capability_gaps SET detected_ts = ? WHERE id = ?').run(Date.now() - 30 * 86400000, old.id); // 30d
  const dismissed = curator.curateGaps();
  ok('exactly the stale gap is dismissed', dismissed === 1);
  ok('old gap → dismissed', db.getDb().prepare('SELECT status FROM capability_gaps WHERE id=?').get(old.id).status === 'dismissed');
  ok('fresh gap → still open', db.getDb().prepare('SELECT status FROM capability_gaps WHERE id=?').get(fresh.id).status === 'open');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
