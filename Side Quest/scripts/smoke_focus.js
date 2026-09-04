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
  // open_threads ids RESTART after a full delete (INTEGER PRIMARY KEY, no AUTOINCREMENT), so per-id focus
  // meta (origin / beat / stopped) from an earlier section would leak onto a later section's thread.
  db.getDb().prepare("DELETE FROM meta WHERE key LIKE 'focus.%'").run();
  db.getDb().prepare("DELETE FROM meta WHERE key LIKE 'thread.%'").run();   // lineage stamps (spawned_from) are per-id too
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

  // --- ORIGIN → TIER (usage law, Lucas 2026-09-03: "she's still firing on validate elected officials
  // state by state when there is very incomplete work outstanding"). A beat-minted focus is EXPANSION by
  // construction and never carries the directed flag; directed is his word only; expansion yields to
  // directed. The canvas gate's origin stamp (Slice P) is still persisted — the tier is what the
  // driver, the scheduler and the pass gate key on. ---
  console.log('\nfocus origin → tier (user = DIRECTED, beat = EXPANSION; both DRIVEN):');
  reset();
  const uOrig = await focus.setFromDirective('study every right-of-center think tank');
  ok('a USER directive persists origin=user', focus.originOf(uOrig.focus.id) === 'user');
  ok('originOf accepts a focus object too', focus.originOf(uOrig.focus) === 'user');
  ok('a user directive is DIRECTED and DRIVEN, never expansion', focus.isDirected(uOrig.focus) && focus.isDriven(uOrig.focus) && !focus.isExpansion(uOrig.focus));
  ok('⭐ a beat seed YIELDS to his directed focus (null; his focus keeps the slot)',
    (await focus.setExpansion('Compile the county-level governing board for Adams County, Wisconsin')) === null && focus.getCurrent().id === uOrig.focus.id && focus.isDirected(focus.getCurrent()));
  reset();
  const bOrig = await focus.setExpansion('Compile the county-level governing board for Adams County, Wisconsin');
  ok('a BEAT seed persists origin=beat (the per-county canvas-flood source)', !!bOrig && focus.originOf(bOrig.focus.id) === 'beat');
  ok('⭐ the beat focus is EXPANSION, never DIRECTED (directed is his word only)', focus.isExpansion(focus.getCurrent()) === true && focus.isDirected(focus.getCurrent()) === false);
  ok('…but it IS driven (the directed driver still owns the mechanics)', focus.isDriven(focus.getCurrent()) === true);
  ok('the run state records the split (directed:false, expansion:true)', (() => { const s = JSON.parse(db.getMeta('focus_state')); return s.directed === false && s.expansion === true; })());
  let eLast; for (let i = 0; i < focus.MAX_TICKS + 4; i++) eLast = focus.recordOutcome(bOrig.focus, { progressed: true });
  ok(`expansion keeps the DRIVEN caps (continues past MAX_TICKS=${focus.MAX_TICKS} like a directed run)`, eLast.action === 'continue');
  const legacyBeatFocus = focus.getCurrent();
  const viaLegacy = await focus.setFromDirective('Compile the county-level governing board for Adams County, Wisconsin', null, { origin: 'beat' });
  ok('the legacy { origin: "beat" } option on setFromDirective routes to the same expansion door', !!viaLegacy && focus.isExpansion(focus.getCurrent()) && !focus.isDirected(focus.getCurrent()));
  const disp2 = await focus.setFromDirective('catalog every right-of-center energy think tank');
  ok('⭐ a user directive DISPLACES an expansion focus (expansion yields to his word)', !!disp2 && focus.isDirected(focus.getCurrent()) === true && focus.getCurrent().id !== legacyBeatFocus.id);
  ok('an unknown/legacy focus id defaults to user (canvas never suppresses a real run)', focus.originOf(999999) === 'user');
  // THE RESUME-DRIFT CURE. Measured 09-03: 88 beat-tagged threads carried origin=user — the scheduler's
  // RESUME call, setCurrent(thread, {directed:true}), defaulted the stamp — so a resumed sweep passed the
  // idle gate as his work and ran at his-order cadence. Origin is now DERIVED from the durable stamps:
  // a beat-tagged thread not born from his turn is expansion however it is re-pointed, and the stamp heals.
  reset();
  const drifted = db.insertOpenThread({ content: 'VALIDATE the elected officials of every county in Kansas' });
  db.setMeta(`focus.${drifted.id}.beat`, 'county-commissions-ks');
  db.setMeta(`focus.${drifted.id}.origin`, 'user');                      // the laundered stamp, as found live
  const re = focus.setCurrent(drifted.id, { directed: true });          // the scheduler's RESUME call, verbatim
  ok('⭐ RESUMING a beat-tagged thread yields EXPANSION even when {directed:true} is passed', !!re && focus.isExpansion(re) && !focus.isDirected(re) && focus.isDriven(re));
  ok('⭐ …and REWRITES the laundered origin stamp back to beat (self-healing on resume)', focus.originOf(drifted.id) === 'beat');
  // ADOPTION stays his: a beat-tagged thread BORN FROM HIS TURN ("compile leadership for all Louisiana
  // parishes", which the LA beat runs AS his request) is directed — his word, never the sweep's.
  reset();
  const sid = db.getDb().prepare('INSERT INTO sessions (started_at) VALUES (?)').run(Date.now()).lastInsertRowid;
  const hisTurn = db.insertTurn({ sessionId: sid, speaker: 'user', content: 'compile leadership data for all Louisiana parishes' });
  const adopted = db.insertOpenThread({ content: 'compile leadership data for all Louisiana parishes', sourceTurnId: hisTurn.id });
  db.setMeta(`focus.${adopted.id}.beat`, 'county-commissions-la');
  const ad = focus.setCurrent(adopted.id, { directed: true, origin: 'user' });
  ok('an ADOPTED thread (born from his turn, beat-tagged) stays DIRECTED — his word', !!ad && focus.isDirected(ad) && !focus.isExpansion(ad));
  const ad2 = focus.setCurrent(adopted.id, { directed: true });        // re-pointed with no origin → derived from his turn
  ok('…and re-pointing it with no origin still derives user (born from his turn outranks the beat tag)', !!ad2 && focus.isDirected(ad2) && focus.originOf(adopted.id) === 'user');
  // LEGACY STATE (the boot that carries this change): a focus_state written before the split has no
  // `expansion` field — a beat-tagged current focus must read as expansion, not as his directed work.
  reset();
  const legacy = db.insertOpenThread({ content: 'VALIDATE the elected officials of every county in Iowa' });
  db.setMeta(`focus.${legacy.id}.beat`, 'county-commissions-ia');
  db.setMeta('current_focus_id', String(legacy.id));
  db.setMeta('focus_state', JSON.stringify({ id: legacy.id, ticks: 3, strikes: 0, startedTs: Date.now(), directed: true }));
  ok('⭐ a pre-split focus_state (no expansion field) on a beat-tagged focus reads EXPANSION, not directed',
    focus.isExpansion(focus.getCurrent()) && !focus.isDirected(focus.getCurrent()) && focus.isDriven(focus.getCurrent()));
  reset();
  const legacyHis = db.insertOpenThread({ content: 'study every right-of-center think tank overnight' });
  db.setMeta('current_focus_id', String(legacyHis.id));
  db.setMeta('focus_state', JSON.stringify({ id: legacyHis.id, ticks: 3, strikes: 0, startedTs: Date.now(), directed: true }));
  ok('a pre-split focus_state on an UNTAGGED focus still reads DIRECTED (his overnight task survives the cycle)',
    focus.isDirected(focus.getCurrent()) && !focus.isExpansion(focus.getCurrent()));

  // --- SELF-DIRECTED LINEAGE (cut 20). Measured 09-03: 41 threads the subconscious spawned from its own
  // synthesis (thread.<id>.spawned_from='subc'), 39 stamped origin=user and seeded as "HIS research thread"
  // at user cadence (#4210 was a tension read out of the engine's own log). Hers is EXPANSION. ---
  console.log('\nself-directed lineage (subconscious-born = EXPANSION, never his word):');
  reset();
  const own = db.insertOpenThread({ content: 'Investigate: Determine whether the database is locked errors are transient or persistent' });
  db.setMeta(`thread.${own.id}.spawned_from`, 'subc');
  ok('selfLineage reads the subconscious stamp', focus.selfLineage(own.id) === 'subc' && focus.isSelfSpawned(own.id) === true);
  ok('a thread with no lineage stamp is not self-spawned', focus.selfLineage(999999) === null && focus.isSelfSpawned(999999) === false);
  const ownF = focus.setCurrent(own.id, { directed: true });            // the user-work driver's seed call, verbatim
  ok('⭐ a subconscious-born thread pointed with {directed:true} is EXPANSION, not directed', !!ownF && focus.isExpansion(ownF) && !focus.isDirected(ownF) && focus.isDriven(ownF));
  ok('…and its origin stamp is subc', focus.originOf(own.id) === 'subc');
  ok('the run state records the split (directed:false, expansion:true)', (() => { const s = JSON.parse(db.getMeta('focus_state')); return s.directed === false && s.expansion === true; })());
  const dispSelf = await focus.setFromDirective('catalog every right-of-center energy think tank');
  ok('⭐ a user directive DISPLACES her own investigation (expansion yields to his word)', !!dispSelf && focus.isDirected(focus.getCurrent()) && focus.getCurrent().id !== own.id);
  reset();
  const laundered = db.insertOpenThread({ content: 'Investigate: why the audit writer retried twenty times' });
  db.setMeta(`thread.${laundered.id}.spawned_from`, 'subc');
  db.setMeta(`focus.${laundered.id}.origin`, 'user');                    // the laundered stamp, as found live on #4210
  const lf = focus.setCurrent(laundered.id, { directed: true });
  ok('⭐ a laundered user stamp on a subconscious-born thread HEALS to subc on re-point', !!lf && focus.isExpansion(lf) && !focus.isDirected(lf) && focus.originOf(laundered.id) === 'subc');
  ok('a beat seed displaces her investigation (both expansion; the beat lane keeps its turn)', !!(await focus.setExpansion('Compile the county-level governing board for Adams County, Wisconsin')) && focus.getCurrent().id !== laundered.id);
  // lineage through a parent: run-closure's children inherit
  const childOfOwn = db.insertOpenThread({ content: 'follow-up: which tools time out under the lock' });
  db.setMeta(`thread.${childOfOwn.id}.spawned_from`, String(laundered.id));
  ok('a child spawned FROM her thread is hers (lineage recurses)', focus.selfLineage(childOfOwn.id) === 'subc');
  const beatParent = db.insertOpenThread({ content: 'VALIDATE the elected officials of every county in Kansas' });
  db.setMeta(`focus.${beatParent.id}.beat`, 'county-commissions-ks');
  const childOfBeat = db.insertOpenThread({ content: 'follow-up: the Sedgwick County commission roster' });
  db.setMeta(`thread.${childOfBeat.id}.spawned_from`, String(beatParent.id));
  ok('a child spawned from a BEAT thread is the sweep\'s (beat)', focus.selfLineage(childOfBeat.id) === 'beat');
  const hisT = await focus.setFromDirective('study every right-of-center think tank');
  const childOfHis = db.insertOpenThread({ content: 'follow-up: which think tanks publish energy modeling' });
  db.setMeta(`thread.${childOfHis.id}.spawned_from`, String(hisT.focus.id));
  ok('a child spawned from HIS thread stays his (no self lineage)', focus.selfLineage(childOfHis.id) === null && !focus.isSelfSpawned(childOfHis.id));
  const cf = focus.setCurrent(childOfHis.id, { directed: true });
  ok('…and pointing it yields DIRECTED (his word by lineage)', !!cf && focus.isDirected(cf) && !focus.isExpansion(cf));
  // the pre-split legacy state on a self-spawned current focus reads expansion via the durable stamp
  reset();
  const legacySelf = db.insertOpenThread({ content: 'Investigate: the parlor 429 pattern' });
  db.setMeta(`thread.${legacySelf.id}.spawned_from`, 'subc');
  db.setMeta('current_focus_id', String(legacySelf.id));
  db.setMeta('focus_state', JSON.stringify({ id: legacySelf.id, ticks: 3, strikes: 0, startedTs: Date.now(), directed: true }));
  ok('a pre-split focus_state on a subconscious-born focus reads EXPANSION, not directed', focus.isExpansion(focus.getCurrent()) && !focus.isDirected(focus.getCurrent()));

  // --- THE LIVE WIRING: structural pins over main.js / lib/monologue.js — the sites that must key on the
  // RIGHT predicate (isDriven = mechanics; isDirected = his word). A regression here is the disease back. ---
  console.log('\nthe live wiring (main.js / lib/monologue.js sites):');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const monoSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monologue.js'), 'utf8');
    ok('seedBeatRun mints the primary beat focus as EXPANSION (setExpansion), never through setFromDirective',
      /focusLib\.setExpansion\(beat\.goal\)/.test(mainSrc) && !/setFromDirective\(beat\.goal/.test(mainSrc));
    ok('the directed driver tick drives DRIVEN foci (directed + expansion)',
      /if \(!focus \|\| !focusLib\.isDriven\(focus\)\) \{ stopDirectedFocusDriver\(\); return; \}/.test(mainSrc));
    ok('⭐ the beat pass gate reads the TIER (isExpansion), never the once-laundered origin stamp',
      /const _focusOrigin = focusLib\.isExpansion\(focus\) \? 'beat' : 'user';/.test(mainSrc));
    ok('_focusSpendTier and _userDirectedActive key on isDirected alone (one definition of "his word")',
      /function _focusSpendTier\(focus\) \{\s*try \{ return \(focus && require\('\.\/lib\/focus'\)\.isDirected\(focus\)\) \? 'directed' : 'research'; \}/.test(mainSrc)
      && /return !!\(f && focusLib\.isDirected\(f\)\);\s*\/\/ usage law/.test(mainSrc));
    ok('the scheduler never preempts a DIRECTED focus and rotates only DRIVEN beat foci',
      /if \(focus && focusLib\.isDriven\(focus\)\) \{\s*if \(focusLib\.isDirected\(focus\)\) return;/.test(mainSrc));
    ok('a user-stop and a user-redirect both stamp focus.<id>.stopped (a thread he set down is never auto-resumed)',
      (mainSrc.match(/db\.setMeta\(`focus\.\$\{f\.id\}\.stopped`, String\(Date\.now\(\)\)\)/g) || []).length >= 2);
    ok('⭐ the user-work driver sees his OUTSTANDING started threads (open newest-first pool + the resumable predicate)',
      /resumableOf: _resumableOf/.test(mainSrc) && /getActiveOpenThreads\(200, \{ includeStalled: false, newestFirst: true \}\)/.test(mainSrc)
      && /if \(\(db\.getMeta\(`focus\.\$\{id\}\.origin`\) \|\| ''\) !== 'user'\) return false;/.test(mainSrc) && /if \(db\.getMeta\(`focus\.\$\{id\}\.stopped`\)\) return false;/.test(mainSrc));
    ok('the boot lost-pointer resume skips beat-tagged threads (no laundering at boot)',
      /originOf\(t\.id\) === 'user' && !\(db\.getMeta\(`focus\.\$\{t\.id\}\.beat`\) \|\| ''\)\.trim\(\)/.test(mainSrc));
    ok('the adopted-thread seed stamps origin user explicitly (his thread, run by the beat)',
      /focusLib\.setCurrent\(adopted\.id, \{ directed: true, origin: 'user' \}\)/.test(mainSrc));
    ok('the monologue leaves DRIVEN foci to the driver; its bandwidth preemption keys on isDirected alone',
      /if \(activeFocus && focusLib\.isDriven\(activeFocus\)\) activeFocus = null;/.test(monoSrc)
      && /function _userDirectedActive\(\) \{\s*try \{ const fl = require\('\.\/focus'\); const f = fl\.getCurrent\(\); return !!\(f && fl\.isDirected\(f\)\); \}/.test(monoSrc));
  }

  // --- BACKGROUND research workers (parallelism): must NEVER touch the primary pointer ---
  console.log('\nbackground workers (parallelism) — isolation from the primary focus:');
  reset();
  const primary = fresh('PRIMARY: the focus chat + leash see');
  ok('primary focus is current', focus.getCurrent() && focus.getCurrent().id === primary.id);
  const wRow = db.insertOpenThread({ content: 'WORKER: a concurrent background beat' });
  const w = focus.setBackground(wRow.id);
  ok('setBackground activates the worker thread', w && db.getOpenThread(wRow.id).status === 'active');
  ok('setBackground does NOT change the current pointer (chat still sees the primary)', focus.getCurrent() && focus.getCurrent().id === primary.id);
  const o1 = focus.recordOutcomeBackground(db.getOpenThread(wRow.id), { progressed: true });
  ok('recordOutcomeBackground continues on its own bgstate', o1.action === 'continue');
  ok('worker outcome did NOT disturb the primary pointer', focus.getCurrent() && focus.getCurrent().id === primary.id);
  const o2 = focus.recordOutcomeBackground(db.getOpenThread(wRow.id), { control: { type: 'done', note: 'converged' } });
  ok('recordOutcomeBackground closes the worker thread (resolved)', o2.action === 'resolved' && db.getOpenThread(wRow.id).status === 'resolved');
  ok('closing a worker leaves the PRIMARY focus intact (never yanked from chat)', focus.getCurrent() && focus.getCurrent().id === primary.id);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
