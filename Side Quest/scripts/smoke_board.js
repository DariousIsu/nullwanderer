/* Smoke: lib/board — the workstream board + resource locks (conductor slice 2a). Deterministic:
 * temp SQ_DB_PATH; no model/network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_board.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMPDIR = path.join(os.tmpdir(), `sq_board_${process.pid}`);
process.env.SQ_DB_PATH = path.join(TMPDIR, 'sq.db');
const db = require('../lib/db'); db.init();
const board = require('../lib/board');
const act = require('../lib/activity');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = 1753300000000;

(async () => {
  // --- lifecycle: start → running → finish ---
  const a = board.start({ lane: 'autonomy', kind: 'research', target: 'neuromorphic funding landscape', nowMs: NOW });
  ok(a.id != null && !a.blocked, 'a run registers');
  let live = board.running({ nowMs: NOW });
  ok(live.length === 1 && live[0].lane === 'autonomy' && /neuromorphic/.test(live[0].target), 'the board shows the live run');
  board.finish(a.id, { status: 'done', note: 'ok — 3 tool steps', nowMs: NOW + 60e3 });
  ok(board.running({ nowMs: NOW + 60e3 }).length === 0, 'finish clears it from the live board');
  ok(db.getDb().prepare('SELECT status, note FROM workstreams WHERE id = ?').get(a.id).status === 'done', 'the history row keeps the outcome');

  // --- locks: contention, release, the reserved slot ---
  ok(board.acquire('db_maintenance:echo', { lane: 'autonomy', nowMs: NOW }) === true, 'a free resource is acquirable');
  ok(board.acquire('db_maintenance:echo', { lane: 'news', nowMs: NOW + 1000 }) === false, 'a HELD resource blocks a second taker (≤1 maintenance per store)');
  board.release('db_maintenance:echo');
  ok(board.acquire('db_maintenance:echo', { lane: 'news', nowMs: NOW + 2000 }) === true, 'release frees it');
  board.release('db_maintenance:echo');
  ok(board.acquire(board.RESERVED_SLOT, { lane: 'autonomy', nowMs: NOW }) === false, `${board.RESERVED_SLOT} is the chat's — NEVER allocatable`);

  // --- the cloud pool ---
  const s1 = board.acquireCloudSlot({ lane: 'autonomy', nowMs: NOW });
  const s2 = board.acquireCloudSlot({ lane: 'subc', nowMs: NOW });
  const s3 = board.acquireCloudSlot({ lane: 'late', nowMs: NOW });
  ok(s1 === 'cloud_slot_2' && s2 === 'cloud_slot_3', 'pool slots allocate in order');
  ok(s3 === null, 'an exhausted pool returns null — the taker skips, never queues');
  board.release(s1); board.release(s2);

  // --- start+resource is ONE decision ---
  board.acquire('db_maintenance:sq', { lane: 'x', nowMs: NOW });
  const blocked = board.start({ lane: 'autonomy', kind: 'maintain', target: 'dedup', resource: 'db_maintenance:sq', nowMs: NOW });
  ok(blocked.id === null && blocked.blocked === true, 'a run that cannot have its resource does not register as running');
  board.release('db_maintenance:sq');
  const held = board.start({ lane: 'autonomy', kind: 'maintain', target: 'dedup', resource: 'db_maintenance:sq', nowMs: NOW });
  ok(held.id != null, 'with the resource free, start acquires + registers together');
  board.finish(held.id, { nowMs: NOW + 1000 });
  ok(board.acquire('db_maintenance:sq', { lane: 'y', nowMs: NOW + 2000 }) === true, 'finish releases the run\'s resource');
  board.release('db_maintenance:sq');

  // --- heartbeat self-healing: a crashed lane can never wedge a slot shut ---
  const c = board.start({ lane: 'autonomy', kind: 'research', target: 'crashy', resource: 'cloud_slot_2', nowMs: NOW });
  ok(c.id != null, 'the doomed run registered holding a slot');
  const later = NOW + board.STALE_MS + 60e3;   // it never beats again
  ok(board.acquire('cloud_slot_2', { lane: 'next', nowMs: later }) === true, 'a stale lock expires — the next taker gets the slot');
  board.release('cloud_slot_2');
  const crashed = db.getDb().prepare('SELECT status, note FROM workstreams WHERE id = ?').get(c.id);
  ok(crashed.status === 'failed' && /stale/.test(crashed.note), 'the crashed run reads as failed (stale), never as running');
  const d = board.start({ lane: 'memory', kind: 'promote-pass', nowMs: later });
  board.beat(d.id, { nowMs: later + board.STALE_MS - 60e3 });
  ok(board.running({ nowMs: later + board.STALE_MS + 30e3 }).some((r) => r.id === d.id), 'a beating run stays alive past the stale window');
  board.finish(d.id, { nowMs: later + board.STALE_MS + 40e3 });

  // --- manifest lines + the activity snapshot ---
  const m = board.start({ lane: 'autonomy', kind: 'corroborate', target: 'Acme PAC single-source cluster', nowMs: later });
  db.setMeta('scribe_active', '1');
  const lines = board.manifestLines({ nowMs: later + 60e3 });
  ok(lines.some((l) => /\[autonomy\] corroborate/.test(l) && /Acme PAC/.test(l)), 'manifest lines carry lane/kind/target');
  ok(lines.some((l) => /\[scribe\] live meeting/.test(l)), 'the scribe rides as a virtual row (its own meta, unrewired)');
  ok(lines.some((l) => /cloud_slot_1 reserved for chat/.test(l)), 'the slot summary states the standing reservation');
  db.setMeta('scribe_active', '0');

  const sum = act.summarize({ streams: [{ lane: 'autonomy', kind: 'corroborate', target: 'Acme PAC', agoMin: 12 }] });
  ok(sum.active === 1 && /corroborate/.test(sum.block) && /Acme PAC/.test(sum.block) && /12m in/.test(sum.block), '"what are you doing?" answers from board streams');
  ok(act.summarize({}).active === 0 && /background stream/.test(act.summarize({}).block), 'an empty board stays an honest "nothing active"');
  board.finish(m.id, { nowMs: later + 120e3 });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
