/**
 * Hard smoke — Phase 4: episodic attendance reconciliation (closes the Madeline loop).
 * Meeting = witnessed event; speakers ATTENDED (witnessed); expected attendees reconcile
 * against who was present — present → confirmed (live), absent → refuted + superseded so it
 * stops being a live fact she can free-associate. Offline, no model, no embedder.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_graph4_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gm = require('../lib/graph_memory');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(function () {
  console.log('Hard smoke — Phase 4 attendance reconciliation\n');

  const res = gm.reconcileAttendance({
    meeting: 'Google Meet pcv-sren-zzu',
    expected: ['Madeline Keeter', 'Joshua Fredrickson', 'Lucas Overby'],   // pre-meeting: all three expected
    present: ['Joshua Fredrickson', 'Lucas Overby']                         // captions: only two spoke
  });

  console.log('meeting + present grounded as witnessed:');
  ok('meeting is a witnessed event', (gm.getEntity('Google Meet pcv-sren-zzu') || {}).epistemic === 'witnessed');
  ok('Joshua present → witnessed person', (gm.getEntity('Joshua Fredrickson') || {}).epistemic === 'witnessed');
  ok('Joshua has a live ATTENDED edge', gm.neighbors('Joshua Fredrickson').some(r => r.relation_type === 'ATTENDED'));
  ok('return: confirmed = the two who showed', res.confirmed.includes('Joshua Fredrickson') && res.confirmed.includes('Lucas Overby') && res.confirmed.length === 2);

  console.log('\nMADELINE — expected but absent → refuted + superseded:');
  ok('return: absent = Madeline only', res.absent.length === 1 && res.absent[0] === 'Madeline Keeter');
  const histEdge = gm.neighbors('Madeline Keeter', { includeSuperseded: true }).find(r => r.relation_type === 'EXPECTED_ATTENDEE');
  ok('the expected edge exists in history', !!histEdge);
  ok('it is refuted (confirmed=0) + superseded (valid_to set)', histEdge && histEdge.confirmed === 0 && histEdge.valid_to !== null);
  ok('Madeline is NOT a live expected-attendee anymore', !gm.neighbors('Madeline Keeter').some(r => r.relation_type === 'EXPECTED_ATTENDEE'));

  console.log('\nJOSHUA — expected AND present → confirmed, stays live:');
  const jEdge = gm.neighbors('Joshua Fredrickson').find(r => r.relation_type === 'EXPECTED_ATTENDEE');
  ok('Joshua expected edge is live + confirmed=1', jEdge && jEdge.confirmed === 1 && jEdge.valid_to === null);

  console.log('\nIDEMPOTENT — re-running reconciliation is stable:');
  const res2 = gm.reconcileAttendance({ meeting: 'Google Meet pcv-sren-zzu', expected: ['Madeline Keeter'], present: ['Joshua Fredrickson', 'Lucas Overby'] });
  ok('Madeline still absent + still superseded (no resurrection)', res2.absent[0] === 'Madeline Keeter' && !gm.neighbors('Madeline Keeter').some(r => r.relation_type === 'EXPECTED_ATTENDEE'));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
