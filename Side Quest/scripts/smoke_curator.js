/**
 * Phase E backtest — tombstones + spawn gate + curator.
 *
 * Deterministic, offline. Tombstones are inserted WITHOUT embeddings so the spawn
 * gate exercises its text-containment fallback (no embedder/model needed). The
 * semantic-similarity path runs live in the app.
 *
 * Run under electron-as-node.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_cur_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const focus = require('../lib/focus');
const curator = require('../lib/curator');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() {
  db.getDb().prepare('DELETE FROM agent_events').run();
  db.getDb().prepare('DELETE FROM open_threads').run();
  db.getDb().prepare('DELETE FROM knowledge').run();
  db.setMeta('current_focus_id', ''); db.setMeta('focus_state', '');
}
// Insert a tombstone note directly (no embedding → spawn gate uses text fallback).
function tombstone(goal, status, ageHours = 0) {
  const r = db.insertKnowledge({ kind: 'note', content: `Focus "${goal}" → ${status}: test`, embedding: null, source: 'focus_tombstone', importance: 0.5 });
  const ts = Date.now() - ageHours * 3600000;
  db.getDb().prepare('UPDATE knowledge SET created_ts = ? WHERE id = ?').run(ts, r.id);
  return r.id;
}

async function run() {
  db.init();
  console.log('Phase E backtest — tombstones + spawn gate + curator\n');

  // --- tombstone written on close ---
  console.log('tombstone on focus close:');
  reset();
  const row = db.insertOpenThread({ content: 'draft a reusable cold-pitch template' });
  focus.setCurrent(row.id);
  focus.recordOutcome(db.getOpenThread(row.id), { control: { type: 'done', note: 'done' } });
  // tombstone store is async (embedding); poll briefly for the row
  let tombRows = [];
  for (let i = 0; i < 20 && tombRows.length === 0; i++) {
    tombRows = db.getKnowledgeBySourceSince('focus_tombstone%', 0);
    if (tombRows.length === 0) await new Promise(r => setTimeout(r, 50));
  }
  ok('a tombstone note is written when a focus closes', tombRows.length === 1 && /cold-pitch template/.test(tombRows[0].content));

  // --- spawn gate suppresses a near-identical re-spawn within 24h ---
  console.log('\nspawn gate (text-containment fallback):');
  reset();
  tombstone('learn to structure a cold pitch email', 'stalled', 1); // 1h ago
  const blocked = await focus.setFromText('<focus>learn to structure a cold pitch email</focus>');
  ok('re-spawn of a recently-closed focus is SUPPRESSED', blocked === null && focus.isActive() === false);

  // --- a different goal is allowed ---
  reset();
  tombstone('learn to structure a cold pitch email', 'stalled', 1);
  const allowed = await focus.setFromText('<focus>research the history of the Hanseatic League</focus>');
  ok('an unrelated new focus is ALLOWED', allowed && focus.isActive());

  // --- outside the refractory window it is allowed again ---
  reset();
  tombstone('learn to structure a cold pitch email', 'stalled', 30); // 30h ago > 24h
  const reAllowed = await focus.setFromText('<focus>learn to structure a cold pitch email</focus>');
  ok('same focus allowed again after the 24h refractory window', reAllowed && focus.isActive());

  // --- first-ever focus (no tombstones) is allowed ---
  reset();
  const first = await focus.setFromText('<focus>understand how the governor paces autonomous actions</focus>');
  ok('first focus with no tombstones is allowed', first && focus.isActive());

  // --- curator ages stale stalled threads, keeps the rest ---
  console.log('\ncurator age-out:');
  reset();
  const oldStalled = db.insertOpenThread({ content: 'old stalled thread' });
  db.markOpenThreadStatus(oldStalled.id, 'stalled', { reason: 'x' });
  db.getDb().prepare('UPDATE open_threads SET last_touched_ts = ? WHERE id = ?').run(Date.now() - 20 * 86400000, oldStalled.id); // 20d
  const freshStalled = db.insertOpenThread({ content: 'fresh stalled thread' });
  db.markOpenThreadStatus(freshStalled.id, 'stalled', { reason: 'x' }); // touched now
  const resolved = db.insertOpenThread({ content: 'a resolved thread' });
  db.markOpenThreadStatus(resolved.id, 'resolved', { reason: 'x' });
  db.getDb().prepare('UPDATE open_threads SET last_touched_ts = ? WHERE id = ?').run(Date.now() - 40 * 86400000, resolved.id);

  const aged = curator.curateThreads();
  ok('exactly the stale-stalled thread is aged', aged === 1);
  ok('old stalled → abandoned', db.getOpenThread(oldStalled.id).status === 'abandoned');
  ok('fresh stalled → untouched', db.getOpenThread(freshStalled.id).status === 'stalled');
  ok('resolved (even if old) → kept, never touched', db.getOpenThread(resolved.id).status === 'resolved');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
