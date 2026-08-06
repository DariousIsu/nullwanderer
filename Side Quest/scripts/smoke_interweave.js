/* Smoke: lib/interweave.js — M4.2 intersection pass (offline, temp DB — never the live sq.db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_interweave.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), `iw_smoke_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
process.env.SQ_DB_PATH = TMP;

const dbm = require('../lib/db');
dbm.init();
const tp = require('../lib/touchpoint');
const iw = require('../lib/interweave');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const NOW = 1754400000000;
  const d = dbm.getDb();

  // ---- seed the RECEIVING side: a thread, an interest, a focus covered index, a fake inquiry ----
  d.prepare("INSERT INTO open_threads (id, content, status, created_ts, last_touched_ts) VALUES (7, 'map the Rainey Center board and its Louisiana partners', 'active', ?, ?)").run(NOW - 86400e3, NOW - 3600e3);
  d.prepare("INSERT INTO open_threads (id, content, status, created_ts, last_touched_ts) VALUES (8, 'resolved thing about the Brookings Institution', 'resolved', ?, ?)").run(NOW - 86400e3, NOW - 3600e3);
  d.prepare("INSERT INTO interests (topic, slug, status, created_ts) VALUES ('neuromorphic computing', 'neuro', 'active', ?)").run(NOW - 86400e3);
  dbm.setMeta('focus.31.covered', JSON.stringify(['Cato Institute', 'Heritage Foundation']));
  d.prepare("INSERT INTO open_threads (id, content, status, created_ts, last_touched_ts) VALUES (31, 'think tank research run', 'active', ?, ?)").run(NOW - 86400e3, NOW - 3600e3);
  const fakeInquiry = { listActive: () => [{ id: 12, question: 'which parishes contract with the Cleco utility for generation?' }] };

  // ---- concept sets ----
  const sets = iw.conceptSets({ db: dbm, deps: { inquiry: fakeInquiry, openThreads: { isAutonomousMapping: () => false } } });
  ok(sets.some((s) => s.key === 'thread:7'), 'sets: active thread present');
  ok(!sets.some((s) => s.key === 'thread:8'), 'sets: resolved thread excluded');
  ok(sets.some((s) => s.key === 'inquiry:12'), 'sets: open inquiry present');
  const focusSet = sets.find((s) => s.key === 'focus:31');
  ok(!!focusSet && focusSet.keys && focusSet.keys.size === 2 && /think tank research run/.test(focusSet.label), 'sets: focus covered index present, labeled from its thread');
  ok(sets.some((s) => s.kind === 'interest'), 'sets: active interest present');

  // ---- fresh touchpoints: a meeting touched Rainey Center + Cato Institute + a generic hub ----
  tp.record({ name: 'Rainey Center', type: 'organization', stream: { kind: 'meeting', key: 'doc:9', label: 'Meeting — LAMP' }, ref: '9', now: NOW - 1000 });
  tp.record({ name: 'Cato Institute', type: 'organization', stream: { kind: 'meeting', key: 'doc:9', label: 'Meeting — LAMP' }, ref: '9', now: NOW - 900 });
  tp.record({ name: 'Cleco', type: 'organization', stream: { kind: 'canvas_drop', key: 'doc:44', label: 'utility roster' }, ref: '44', now: NOW - 800 });

  const fresh = tp.fresh({ sinceMs: 86400e3, now: NOW });
  const cands = iw.intersect({ fresh, sets, brake: {}, now: NOW });
  ok(cands.some((c) => c.entityKey === tp.keyOf('Rainey Center') && c.to.key === 'thread:7'), 'join: meeting-touched entity matches his thread (text containment)');
  ok(cands.some((c) => c.entityKey === tp.keyOf('Cato Institute') && c.to.key === 'focus:31'), 'join: entity matches a focus covered index (exact key membership)');
  ok(cands.some((c) => c.entityKey === tp.keyOf('Cleco') && c.to.key === 'inquiry:12'), 'join: drop-touched entity matches her open inquiry');
  ok(cands.every((c) => c.from && c.from.key !== c.to.key), 'join: no self-joins');

  // ---- short-name guard: "AI" must not text-match everything ----
  tp.record({ name: 'AI', type: 'concept', stream: { kind: 'doc', key: 'doc:55', label: 'ai paper' }, ref: '55', now: NOW - 500 });
  const fresh2 = tp.fresh({ sinceMs: 86400e3, now: NOW });
  const cands2 = iw.intersect({ fresh: fresh2, sets, brake: {}, now: NOW });
  ok(!cands2.some((c) => c.entity === 'AI'), 'guard: a <4-char normalized name never text-matches');

  // ---- hub guard: an entity claimed by many streams/sets is suppressed ----
  const hubSets = [];
  for (let i = 0; i < 8; i++) hubSets.push({ kind: 'thread', key: `thread:${100 + i}`, label: `t${i}`, text: 'louisiana state government work stream' });
  const hubFresh = [{ entity: 'Louisiana', entity_key: tp.keyOf('Louisiana'), entity_type: 'location', streams: [{ kind: 'doc', key: 'doc:70', label: 'x', ts: NOW }] }];
  ok(iw.intersect({ fresh: hubFresh, sets: hubSets, brake: {}, now: NOW }).length === 0, 'guard: hub entity (matches everywhere) suppressed');

  // ---- surfacing brake: same pair braked within 24h, resurfaces after ----
  const one = cands.find((c) => c.to.key === 'thread:7');
  const brake = { [one.brakeKey]: NOW - 3600e3 };
  ok(!iw.intersect({ fresh, sets, brake, now: NOW }).some((c) => c.brakeKey === one.brakeKey), 'brake: a pair surfaced an hour ago is silent');
  const brakeOld = { [one.brakeKey]: NOW - 25 * 3600e3 };
  ok(iw.intersect({ fresh, sets, brake: brakeOld, now: NOW }).some((c) => c.brakeKey === one.brakeKey), 'brake: the pair resurfaces after 24h');

  // ---- manifestLines: end-to-end, stamps the brake, capped ----
  const lines = iw.manifestLines({ db: dbm, deps: { inquiry: fakeInquiry, openThreads: { isAutonomousMapping: () => false } }, now: NOW });
  ok(lines.length > 0 && lines.length <= iw.MAX_CANDIDATES, `manifest: lines produced within cap (${lines.length})`);
  ok(lines.some((l) => /Rainey Center/.test(l) && /\[thread:7\]/.test(l)), 'manifest: a line names the entity + carries the receiving stream token');
  const ledger = JSON.parse(dbm.getMeta(iw.BRAKE_KEY) || '{}');
  ok(Object.keys(ledger).length >= lines.length, 'manifest: surfaced pairs stamped into the brake ledger');
  const lines2 = iw.manifestLines({ db: dbm, deps: { inquiry: fakeInquiry, openThreads: { isAutonomousMapping: () => false } }, now: NOW + 60e3 });
  ok(lines2.length === 0, 'manifest: immediately re-asking surfaces nothing (brake holds)');

  // ---- M4.3: parseReceiver + fileLeverageNote ----
  ok(iw.parseReceiver('Cleco leverage for [inquiry:12] on utilities').key === 'inquiry:12', 'parseReceiver: inquiry token recovered from a build target');
  ok(iw.parseReceiver('note for [thread:7]').kind === 'thread' && iw.parseReceiver('x [focus:31] y').kind === 'focus', 'parseReceiver: thread + focus tokens recovered');
  ok(iw.parseReceiver('no token here') === null, 'parseReceiver: no token → null');

  // thread receiver: progress note lands on the thread
  const f1 = iw.fileLeverageNote({ receiver: { kind: 'thread', id: 7, key: 'thread:7' }, artifactPath: 'notes/autonomy/x.md', gist: 'Rainey board overlaps his Louisiana partners list', deps: { db: dbm }, now: NOW });
  ok(f1.filed && f1.how === 'thread-progress-note' && f1.surfaced, `file: thread receiver filed + surfaced (${f1.how})`);
  const tnotes = JSON.parse(d.prepare('SELECT progress_notes FROM open_threads WHERE id = 7').get().progress_notes || '[]');
  ok(tnotes.some((n) => /leverage note.*x\.md/i.test(n.progress)), 'file: the thread carries the leverage progress note');

  // inquiry receiver: evidence appends, the line's own state untouched
  const inq = require('../lib/inquiry');
  const opened = inq.open({ question: 'which parishes contract with Cleco for generation across Louisiana?', deps: { db: dbm }, nowMs: NOW });
  d.prepare("UPDATE inquiries SET next_step = 'check the PSC filings', gist = 'two parishes confirmed' WHERE id = ?").run(opened.id);
  const f2 = iw.fileLeverageNote({ receiver: { kind: 'inquiry', id: opened.id, key: `inquiry:${opened.id}` }, artifactPath: 'notes/autonomy/cleco.md', gist: 'the utility roster names the Cleco generation contacts', deps: { db: dbm }, now: NOW });
  ok(f2.filed && f2.how === 'inquiry-evidence', `file: inquiry receiver filed (${f2.how})`);
  const irow = d.prepare('SELECT evidence, next_step, gist FROM inquiries WHERE id = ?').get(opened.id);
  ok(JSON.parse(irow.evidence || '[]').some((e) => e.cite === 'notes/autonomy/cleco.md'), 'file: inquiry evidence carries the cited note');
  ok(irow.next_step === 'check the PSC filings' && irow.gist === 'two parishes confirmed', 'file: the inquiry\'s OWN state (next_step/gist) is untouched');

  // interest receiver: honest unsupported, still surfaced; junk input refused
  const f3 = iw.fileLeverageNote({ receiver: { kind: 'interest', id: 1, key: 'interest:1' }, artifactPath: 'n.md', deps: { db: dbm }, now: NOW });
  ok(!f3.filed && /unsupported/.test(f3.how) && f3.surfaced, 'file: interest receiver is honestly unsupported but still surfaced');
  ok(!iw.fileLeverageNote({ receiver: null, artifactPath: 'n.md', deps: { db: dbm } }).filed, 'file: no receiver → refused');
  const inb = d.prepare("SELECT COUNT(*) n FROM inbound_messages WHERE source = 'interweave'").get().n;
  ok(inb >= 3, `file: inbound door carries the surfacings (${inb})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { dbm.getDb().close(); } catch {}
  try { fs.unlinkSync(TMP); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
