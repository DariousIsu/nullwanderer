/**
 * Phase B backtest — Focus layer (working memory / continuous intention).
 *
 * Deterministic, no model. Isolated DB. Proves the focus lifecycle and — most
 * importantly — that a focus CANNOT loop forever: strikes, hard caps, and the
 * focus-scoped StuckDetector all terminate it.
 *
 * Run: node scripts/smoke_focus.js  (under electron-as-node — see run cmd)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_focus_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const blackboard = require('../lib/blackboard');
const focus = require('../lib/focus');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() {
  db.getDb().prepare('DELETE FROM agent_events').run();
  db.getDb().prepare('DELETE FROM open_threads').run();
  db.getDb().prepare('DELETE FROM knowledge').run(); // clear tombstones between sections
  db.setMeta('current_focus_id', '');
  db.setMeta('focus_state', '');
}
// Create a fresh active focus and return its thread row.
function fresh(goal = 'study how to write a better cold pitch email') {
  const row = db.insertOpenThread({ content: goal });
  return focus.setCurrent(row.id);
}

async function run() {
  db.init();
  console.log('Phase B backtest — focus layer\n');

  // --- pointer + lifecycle ---
  console.log('pointer + lifecycle:');
  reset();
  ok('no focus initially', focus.getCurrent() === null && focus.isActive() === false);
  const f = fresh();
  ok('setCurrent activates a focus', !!f && focus.isActive());
  ok('getCurrent returns the active focus', focus.getCurrent().id === f.id);
  ok('focus_set event written to blackboard', blackboard.forFocus(f.id).some(e => e.kind === 'focus_set'));
  ok('thread promoted pending→active', db.getOpenThread(f.id).status === 'active');
  db.markOpenThreadStatus(f.id, 'resolved', { reason: 'test' });
  ok('resolved thread → getCurrent clears pointer + returns null', focus.getCurrent() === null);

  // --- S3: self-set research focus is DEMOTED while the autonomic scheduler owns research ---
  console.log('\nS3 demotion (autonomic on → heartbeat surfacing-only):');
  reset();
  const prevAuto = process.env.ZOE_AUTONOMIC; delete process.env.ZOE_AUTONOMIC;   // default = autonomic ON
  ok('setFromText is suppressed when the scheduler owns research', (await focus.setFromText('<focus>learn to structure a cold pitch email</focus>')) === null && !focus.isActive());

  // --- self-set from a thought (legacy path, kill switch ZOE_AUTONOMIC=0) ---
  console.log('\nself-set from <focus> tag (ZOE_AUTONOMIC=0 restores it):');
  reset();
  process.env.ZOE_AUTONOMIC = '0';
  const set = await focus.setFromText('I keep botching these — <focus>learn to structure a cold pitch email</focus> maybe.');
  ok('setFromText creates + activates focus (kill switch)', !!set && focus.isActive());
  ok('goal extracted from tag', set.goal === 'learn to structure a cold pitch email');
  ok('second setFromText no-ops while one is active', (await focus.setFromText('<focus>another goal entirely</focus>')) === null);
  if (prevAuto === undefined) delete process.env.ZOE_AUTONOMIC; else process.env.ZOE_AUTONOMIC = prevAuto;
  ok('stripControlTags removes the tag', focus.stripControlTags('a <focus>x y z</focus> b').trim() === 'a  b'.trim());

  // --- novelty ---
  console.log('\nnovelty measurement:');
  reset();
  const fn = fresh();
  blackboard.append({ source: 'monologue', kind: 'thought', focusId: fn.id, content: 'lead with the specific ask up front' });
  ok('repeat of an existing step is NOT novel', focus.isNovel(fn.id, blackboard.signature('Lead with the specific ASK up front!')) === false);
  ok('a genuinely new step IS novel', focus.isNovel(fn.id, blackboard.signature('keep it under 120 words')) === true);
  ok('blank signature is never novel', focus.isNovel(fn.id, '') === false);

  // --- strikes: no-progress ticks stall the focus (cannot loop forever) ---
  console.log('\nstrike counter (no-progress → stall):');
  reset();
  const fs1 = fresh();
  ok('strike 1 → continue', focus.recordOutcome(fs1, { progressed: false }).action === 'continue');
  ok('strike 2 → continue', focus.recordOutcome(fs1, { progressed: false }).action === 'continue');
  const s3 = focus.recordOutcome(fs1, { progressed: false });
  ok('strike 3 → STALLED', s3.action === 'stalled' && s3.reason === 'no-progress strikes');
  ok('stalled focus is no longer active', focus.isActive() === false);
  ok('thread marked stalled in DB', db.getOpenThread(fs1.id).status === 'stalled');

  console.log('\nprogress resets the strike counter:');
  reset();
  const fs2 = fresh();
  focus.recordOutcome(fs2, { progressed: false });   // strike 1
  focus.recordOutcome(fs2, { progressed: true });    // reset
  focus.recordOutcome(fs2, { progressed: false });   // strike 1 again
  const cont = focus.recordOutcome(fs2, { progressed: false }); // strike 2
  ok('still continuing after progress reset the counter', cont.action === 'continue');

  // --- tick cap ---
  console.log('\ntick cap:');
  reset();
  const ft = fresh();
  let last, ticksRun = 0;
  for (let i = 0; i < focus.MAX_TICKS + 2; i++) { last = focus.recordOutcome(ft, { progressed: true }); ticksRun++; if (last.action !== 'continue') break; } // always progress, still capped
  ok(`stalled at MAX_TICKS=${focus.MAX_TICKS} despite progress`, last.action === 'stalled' && last.reason === 'tick cap' && ticksRun === focus.MAX_TICKS);

  // --- wall-clock cap (deterministic via state tampering) ---
  console.log('\nwall-clock cap:');
  reset();
  const fw = fresh();
  const st = JSON.parse(db.getMeta('focus_state'));
  st.startedTs = Date.now() - (focus.MAX_WALLCLOCK_MS + 1000);
  db.setMeta('focus_state', JSON.stringify(st));
  const wc = focus.recordOutcome(fw, { progressed: true });
  ok('stalled on wall-clock cap even while progressing', wc.action === 'stalled' && wc.reason === 'wall-clock cap');

  // --- control tags ---
  console.log('\ncontrol tags:');
  reset();
  const fd = fresh();
  const done = focus.recordOutcome(fd, { control: { type: 'done', note: 'landed on a 3-line template' } });
  ok('<focus-done> → resolved', done.action === 'resolved');
  ok('resolved thread status persisted', db.getOpenThread(fd.id).status === 'resolved');
  reset();
  const fst = fresh();
  const stl = focus.recordOutcome(fst, { control: { type: 'stalled', reason: 'need info I cannot get' } });
  ok('<focus-stalled> → stalled', stl.action === 'stalled');
  ok('parseControlTags reads done', focus.parseControlTags('ok <focus-done>x</focus-done>').type === 'done');
  ok('parseControlTags reads stalled', focus.parseControlTags('<focus-stalled>why</focus-stalled>').type === 'stalled');

  // --- focus-scoped stuck abort ---
  console.log('\nfocus-scoped stuck abort:');
  reset();
  const fk = fresh();
  for (let i = 0; i < 3; i++) blackboard.append({ source: 'monologue', kind: 'thought', focusId: fk.id, content: 'the same circular thought' });
  const st2 = focus.recordOutcome(fk, { progressed: false });
  ok('3 identical focus thoughts → stalled via stuck detector', st2.action === 'stalled' && st2.reason.startsWith('stuck:'));

  // --- DIRECTED focus (Lucas-assigned overnight task): chat entry-point + overnight caps ---
  console.log('\ndirected focus (user-assigned, overnight):');
  reset();
  const dres = await focus.setFromDirective('study every right-of-center think tank: who they are, staff, and contacts');
  ok('setFromDirective creates + activates a focus', !!dres && !!dres.focus && focus.isActive());
  ok('the active focus is flagged directed', focus.isDirected(focus.getCurrent()) === true);
  // overnight tick cap: a directed focus survives FAR past the self-spawned MAX_TICKS (8)
  let dlast;
  for (let i = 0; i < focus.MAX_TICKS + 4; i++) dlast = focus.recordOutcome(dres.focus, { progressed: true });
  ok(`directed focus still CONTINUES past MAX_TICKS=${focus.MAX_TICKS} (ran ${focus.MAX_TICKS + 4})`, dlast.action === 'continue');
  // overnight strike tolerance: stalls at MAX_STRIKES_DIRECTED, not the tight 3
  reset();
  const dstrk = await focus.setFromDirective('research X overnight in depth');
  let dstrikeLast;
  for (let i = 0; i < focus.MAX_STRIKES_DIRECTED; i++) dstrikeLast = focus.recordOutcome(dstrk.focus, { progressed: false });
  ok(`directed focus tolerates >${focus.MAX_STRIKES} strikes, stalls at MAX_STRIKES_DIRECTED=${focus.MAX_STRIKES_DIRECTED}`,
    dstrikeLast.action === 'stalled' && dstrikeLast.reason === 'no-progress strikes');
  // overnight wall-clock cap (much larger than the 10-min musing cap)
  reset();
  const dwc = await focus.setFromDirective('compile a long dossier overnight');
  const dst = JSON.parse(db.getMeta('focus_state'));
  ok('directed state carries the directed flag', dst.directed === true);
  dst.startedTs = Date.now() - (focus.MAX_WALLCLOCK_MS_DIRECTED + 1000);
  db.setMeta('focus_state', JSON.stringify(dst));
  ok('directed survives a duration that would cap a normal focus',
    focus.MAX_WALLCLOCK_MS_DIRECTED > focus.MAX_WALLCLOCK_MS);
  const dwcOut = focus.recordOutcome(dwc.focus, { progressed: true });
  ok('directed stalls only at its OWN (overnight) wall-clock cap', dwcOut.action === 'stalled' && dwcOut.reason === 'wall-clock cap');
  // displacement + idempotency
  reset();
  fresh('a self-spawned musing about email tone');   // a normal (non-directed) focus
  ok('a self-spawned focus is NOT directed', focus.isDirected(focus.getCurrent()) === false);
  const disp = await focus.setFromDirective('catalog every right-of-center energy think tank');
  ok('a directive DISPLACES a self-spawned musing', !!disp && focus.isDirected(focus.getCurrent()) === true);
  const dup = await focus.setFromDirective('catalog every right-of-center energy think tank');
  ok('a near-identical follow-up does NOT spawn a duplicate (idempotent)', dup.focus.id === disp.focus.id);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
