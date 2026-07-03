/* Smoke: lib/api_bulk — the BULK-PULL orchestrator (legislation via Echo legiscan tools). Mocked dispatch
 * (real legiscan session_list/master_list shapes) + mock landDoc; isolated temp api_stream.db. Proves the
 * incremental (session_hash + change_hash) + resumable (billLimit) mechanism. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_api_bulk.js */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_apibulk_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.API_DB_PATH = tmp;
process.env.LEGISCAN_STATES = 'FL';
const bulk = require('../lib/api_bulk');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1767225600000;   // 2026-01-01 → minYear defaults to 2026

// mutable fixtures (mirror real legiscan shapes)
const SESSIONS = {
  FL: { sessions: [
    { session_id: 100, state_abbr: 'FL', year_start: 2026, year_end: 2026, session_hash: 'sess-A', name: '2026 Regular' },
    { session_id: 90, state_abbr: 'FL', year_start: 2020, year_end: 2020, session_hash: 'old', name: '2020 Regular' },
  ] },
  CA: { sessions: [{ session_id: 200, state_abbr: 'CA', year_start: 2026, year_end: 2026, session_hash: 'ca-A' }] },
};
const ML = {
  100: { session_id: 100, count: 3, bills: [
    { bill_id: 1, number: 'H1', change_hash: 'h1', title: 'Property Tax Administration', description: 'Revises millage limits.', status: 1, last_action: 'Introduced', last_action_date: '2026-01-05', url: 'https://legiscan.com/FL/bill/H1' },
    { bill_id: 2, number: 'S2', change_hash: 'h2', title: 'Homestead Exemption', description: 'Increases homestead exemption.', status: 4, last_action: 'Passed', last_action_date: '2026-02-01', url: 'u2' },
    { bill_id: 3, number: 'H3', change_hash: 'h3', title: 'Public Safety Funding', description: 'Funds public safety.', status: 6, last_action: 'Failed', last_action_date: '2026-01-20', url: 'u3' },
  ] },
  200: { session_id: 200, count: 3, bills: [
    { bill_id: 11, number: 'A11', change_hash: 'c1', title: 'CA Bill 1', description: 'd', status: 1 },
    { bill_id: 12, number: 'A12', change_hash: 'c2', title: 'CA Bill 2', description: 'd', status: 1 },
    { bill_id: 13, number: 'A13', change_hash: 'c3', title: 'CA Bill 3', description: 'd', status: 1 },
  ] },
};
function mkDispatch() {
  const calls = { session_list: 0, master_list: 0 };
  const dispatch = async (t) => {
    if (t.name === 'legiscan_session_list') { calls.session_list++; return { ok: true, text: JSON.stringify(SESSIONS[t.args.state] || { sessions: [] }) }; }
    if (t.name === 'legiscan_master_list') { calls.master_list++; return { ok: true, text: JSON.stringify(ML[t.args.session_id] || { bills: [] }) }; }
    return { ok: false };
  };
  return { dispatch, calls };
}
const FL = { id: 'legiscan:FL', source: 'legiscan', state: 'FL' };

(async () => {
  // ===== PURE =====
  const proc = bulk.sessionsToProcess(SESSIONS.FL.sessions, {}, { minYear: 2026 });
  ok(proc.length === 1 && proc[0].session_id === 100, 'sessionsToProcess: keeps current-year, drops the 2020 session');
  ok(bulk.sessionsToProcess(SESSIONS.FL.sessions, { 100: 'sess-A' }, { minYear: 2026 }).length === 0, 'sessionsToProcess: skips a session whose hash is unchanged (already drained)');
  const doc = bulk.buildBillDoc(ML[100].bills[1], FL);
  ok(/# S2 — Homestead Exemption/.test(doc) && /Passed/.test(doc) && /homestead exemption/i.test(doc), 'buildBillDoc: readable doc w/ status label + description');
  ok(bulk.statusLabel(1) === 'Introduced' && bulk.statusLabel(6) === 'Failed', 'statusLabel maps LegiScan codes');

  // ===== runBulk pass 1: lands all 3 new bills + drains the session =====
  const D1 = mkDispatch(); const landed = [];
  const r1 = await bulk.runBulk(FL, { dispatch: D1.dispatch, landDoc: async (d) => { landed.push(d); }, now: T });
  ok(r1.landed === 3 && r1.sessions === 1 && r1.truncated === false, 'runBulk pass1: lands all 3 bills + drains the session');
  ok(landed.length === 3 && landed.every((d) => d.source === 'legislation' && /^bill:legiscan:/.test(d.ref)), 'landed docs: source=legislation + stable bill ref');
  ok(landed.some((d) => /Property Tax Administration/.test(d.body) && /## |Status/.test(d.body)), 'the landed doc carries the real bill content');
  ok(bulk.countRecords('legiscan:FL') === 3, 'bulk_records tracks the 3 landed bills');

  // ===== pass 2: idempotent — unchanged session skipped entirely =====
  const D2 = mkDispatch(); let n2 = 0;
  const r2 = await bulk.runBulk(FL, { dispatch: D2.dispatch, landDoc: async () => { n2++; }, now: T });
  ok(r2.landed === 0 && n2 === 0 && D2.calls.master_list === 0, 'idempotent: unchanged session is skipped (no master_list call, 0 landed)');

  // ===== a bill changes (+ session hash bumps): re-list, only the changed bill re-lands =====
  SESSIONS.FL.sessions[0].session_hash = 'sess-B';
  ML[100].bills[0].change_hash = 'h1-v2';
  const D3 = mkDispatch(); const landed3 = [];
  const r3 = await bulk.runBulk(FL, { dispatch: D3.dispatch, landDoc: async (d) => { landed3.push(d); }, now: T });
  ok(r3.landed === 1 && landed3.length === 1 && /H1/.test(landed3[0].title), 'changed session re-lists; only the bill with a new change_hash re-lands');

  // ===== billLimit truncation + resume (fresh CA job) =====
  const job = { id: 'legiscan:CA', source: 'legiscan', state: 'CA' };
  const t1 = await bulk.runBulk(job, { dispatch: mkDispatch().dispatch, landDoc: async () => {}, now: T, billLimit: 2 });
  ok(t1.landed === 2 && t1.truncated === true && t1.sessions === 0, 'billLimit: lands 2, session NOT drained (truncated, resumes next pass)');
  const t2 = await bulk.runBulk(job, { dispatch: mkDispatch().dispatch, landDoc: async () => {}, now: T, billLimit: 2 });
  ok(t2.landed === 1 && t2.sessions === 1, 'resume: next pass lands the remaining bill (already-landed skip via change_hash) + drains the session');

  // ===== runDueBulk over the configured jobs (FL) =====
  const due = await bulk.runDueBulk({ dispatch: mkDispatch().dispatch, landDoc: async () => {}, now: T });
  ok(Array.isArray(due) && due.length === 1 && due[0].jobId === 'legiscan:FL', 'runDueBulk runs each configured job (default LEGISCAN_STATES=FL)');

  // ===== fail-soft: no dispatch → no-op =====
  const rz = await bulk.runBulk(FL, { landDoc: async () => {}, now: T });
  ok(rz.landed === 0, 'runBulk with no dispatch → no-op (fail-soft)');

  try { require('../lib/api_store').close(); fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
