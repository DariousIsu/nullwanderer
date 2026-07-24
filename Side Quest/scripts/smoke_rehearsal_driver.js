/* Smoke: lib/rehearsal_driver — O2 THE REHEARSAL DRIVER (slice 5). Deterministic: every dep injected
 * (fake rehearsal speaking its real STRING contract, fake cloud picks, in-memory meta + procedures).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_rehearsal_driver.js
 */
'use strict';
const drv = require('../lib/rehearsal_driver');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

function freshDeps({ picks = [], testResults = [], editResults = [], writeResults = [], diffs = [] } = {}) {
  const mem = new Database(':memory:');
  mem.exec(`CREATE TABLE procedures (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, trigger_text TEXT, steps TEXT,
    check_text TEXT, applicability TEXT, provenance TEXT, met INTEGER DEFAULT 0, unmet INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', created_ts INTEGER, last_used_ts INTEGER)`);
  const meta = new Map();
  const landed = [];
  const deps = {
    db: { getMeta: (k) => (meta.has(k) ? meta.get(k) : null), setMeta: (k, v) => meta.set(k, String(v)), getDb: () => mem },
    rehearsal: {
      create: ({ slug }) => `sandbox "${slug}" created — 120 source files copied to a working COPY (the live program is untouched).`,
      edit: () => (editResults.length ? editResults.shift() : 'edited lib/x.js in sandbox "t" (one exact match replaced).'),
      writeFile: ({ path: p }) => (writeResults.length ? writeResults.shift() : `wrote ${p} (42 chars) in sandbox "t".`),
      test: async () => (testResults.length ? testResults.shift() : '[sandbox "t" gate passed]\nPASS — 1 ok, 0 failed'),
      diff: () => (diffs.length ? diffs.shift() : 'sandbox "t" — 1 file(s) changed vs live:\n=== lib/x.js\n- old\n+ new'),
      discard: () => 'discarded',
    },
    ask: async () => (picks.length ? picks.shift() : { action: 'test', why: 'looks done' }),
    land: (doc) => { landed.push(doc); return { id: 42, landed: true }; },
    fs: { readFileSync: () => 'the current sandbox file content' },
    sandboxDir: 'X:/nonexistent-covered-by-fs-injection',
  };
  return { deps, meta, mem, landed };
}

(async () => {
  // --- start: the contract ---
  {
    const { deps } = freshDeps();
    ok(!drv.start({ slug: 'a', goal: 'too short', suite: 'smoke_x.js', deps }).ok, 'a short goal refuses');
    ok(!drv.start({ slug: 'a', goal: 'make the board smoke cover the stale-lock sweep end to end', suite: 'not-a-suite', deps }).ok, 'a non-smoke suite refuses');
    const s = drv.start({ slug: 'board-sweep', goal: 'make the board smoke cover the stale-lock sweep end to end', suite: 'smoke_board.js', files: ['lib/board.js'], deps });
    ok(s.ok && s.run.slug === 'board-sweep' && s.run.status === 'active', 'a real run starts and journals (slug parsed from the create sentence)');
    ok(!drv.start({ slug: 'second', goal: 'a second run while one is active must be refused here', suite: 'smoke_board.js', deps }).ok, 'one run at a time — an active run blocks a second');
    ok(/board-sweep.*active.*iteration 0/.test(drv.manifestLine({ deps })), 'manifestLine carries the run state');
  }

  // --- validateEditPick: the §6 L2 envelope ---
  ok(drv.validateEditPick('{"action":"edit","path":"lib/x.js","find":"old text here","replace":"new text","why":"fix"}').valid, 'a real edit pick validates');
  ok(drv.validateEditPick('{"action":"give_up","why":"the suite tests a live socket"}').valid, 'give_up is first-class');
  ok(!drv.validateEditPick('{"action":"edit","path":"lib/x.js","find":"same","replace":"same"}').valid, 'find===replace refuses');
  ok(!drv.validateEditPick('no json').valid, 'garbage refuses');
  // --- R2: new_file is a first-class action (build a python tool that doesn't exist yet) ---
  ok(drv.validateEditPick('{"action":"new_file","path":"tools/parse.py","content":"import sys\\nprint(42)","why":"the tool"}').valid, 'a new_file pick validates (path + content)');
  ok(!drv.validateEditPick('{"action":"new_file","path":"tools/parse.py","content":""}').valid, 'new_file with empty content refuses');

  // --- R2 iterate: a new_file creates the file and stays active (not yet judged) ---
  {
    const { deps } = freshDeps({ picks: [{ action: 'new_file', path: 'tools/parse.py', content: 'print(1)', why: 'the tool' }] });
    drv.start({ slug: 't', goal: 'build a python tool that parses the fine schedule table', suite: 'smoke_parse.js', files: ['tools/parse.py'], deps });
    const r = await drv.iterate({ deps });
    ok(r.ok && r.status === 'active' && /created tools\/parse\.py/.test(r.note), 'a new_file creates the tool and keeps the run active for the next step');
    const run = drv.load({ deps });
    ok(run.edits.length === 1 && run.edits[0].kind === 'new_file' && run.edits[0].ok === true, 'the journal records the new_file honestly');
    ok(/wrote tools\/parse\.py/.test(run.lastResult), 'the write confirmation rides into the next attempt');
  }
  // --- R2 iterate: a refused new_file rides the next attempt (same contract as a failed edit) ---
  {
    const { deps } = freshDeps({
      picks: [{ action: 'new_file', path: 'lib/x.js', content: 'evil', why: 'nope' }],
      writeResults: ['cannot write: a NEW file may only be a python tool (tools/<name>.py) or its harness (scripts/smoke_<name>.js) — change existing source with rehearsal_edit'],
    });
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', deps });
    const r = await drv.iterate({ deps });
    ok(r.status === 'active' && /new_file refused/.test(r.note), 'a new_file outside the tool tree is refused, run stays active');
    ok(/NEW_FILE FAILED/.test(drv.load({ deps }).lastResult), 'the refusal rides the next attempt verbatim');
  }
  // --- R2 test-first birth: a harness suite that does not exist yet reports missing and RIDES (so
  // the picker knows to write it) — this is what makes "no smoke matches → author the bar" driveable ---
  {
    const { deps } = freshDeps({
      picks: [{ action: 'test', why: 'try the born suite' }],
      testResults: ['no such suite in the sandbox: scripts/smoke_born.js'],
    });
    drv.start({ slug: 't', goal: 'build a python tool test-first and originate its harness smoke_born.js', suite: 'smoke_born.js', deps });
    const r = await drv.iterate({ deps });
    ok(r.status === 'active' && /still failing/.test(r.note), 'a not-yet-written harness suite reports missing and rides the next attempt');
    ok(/no such suite/.test(drv.load({ deps }).lastResult), 'the "no such suite" signal rides so the picker knows to write the harness');
  }

  // --- iterate: the failure rides the next attempt (44f8052, the load-bearing mechanic) ---
  {
    const { deps } = freshDeps({
      picks: [{ action: 'edit', path: 'lib/x.js', find: 'not present', replace: 'y', why: 'try' }],
      editResults: ['cannot edit: the find-text does not appear in lib/x.js — read the file and match it EXACTLY'],
    });
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', files: ['lib/x.js'], deps });
    const r = await drv.iterate({ deps });
    ok(r.ok && r.status === 'active' && /refused/.test(r.note), 'a refused edit keeps the run active');
    const run = drv.load({ deps });
    ok(/EDIT FAILED/.test(run.lastResult) && /match it EXACTLY/.test(run.lastResult), 'the exact-match refusal rides the next attempt verbatim');
    ok(run.edits.length === 1 && run.edits[0].ok === false, 'the journal records the refused edit honestly');
  }

  // --- iterate: fail → fail with unchanged diff → STUCK + a crystallized constraint ---
  {
    const { deps, mem } = freshDeps({
      picks: [
        { action: 'edit', path: 'lib/x.js', find: 'a', replace: 'b', why: '1' },
        { action: 'edit', path: 'lib/x.js', find: 'c', replace: 'd', why: '2' },
        { action: 'test', why: '3' },
      ],
      testResults: [
        '[sandbox "t" gate FAILED (non-zero exit)]\nFAIL — 3 ok, 1 failed',
        '[sandbox "t" gate FAILED (non-zero exit)]\nFAIL — 3 ok, 1 failed',
        '[sandbox "t" gate FAILED (non-zero exit)]\nFAIL — 3 ok, 1 failed',
      ],
      diffs: ['same-diff', 'same-diff', 'same-diff', 'same-diff', 'same-diff', 'same-diff'],
    });
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', deps });
    await drv.iterate({ deps });                       // fail #1 (streak 0, sig banked)
    await drv.iterate({ deps });                       // fail #2 unchanged diff (streak 1)
    const r3 = await drv.iterate({ deps });            // fail #3 unchanged diff (streak 2 → stuck)
    ok(r3.status === 'stuck', 'same failure with an unchanged diff → the run STOPS instead of grinding');
    ok(mem.prepare("SELECT COUNT(*) n FROM procedures WHERE kind='constraint'").get().n === 1, 'the lesson crystallizes as a constraint row');
  }

  // --- iterate: green suite → full gate → the R2 proposal card is the ONLY exit ---
  {
    const { deps, landed } = freshDeps({
      picks: [{ action: 'edit', path: 'lib/x.js', find: 'a', replace: 'b', why: 'the fix' }],
      testResults: ['[sandbox "t" gate passed]\nPASS — 4 ok, 0 failed', '[sandbox "t" gate passed]\nALL PASS — 301 ok, 0 failed'],
    });
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', deps });
    const r = await drv.iterate({ deps });
    ok(r.status === 'green' && r.docId === 42, 'suite green → FULL gate green → the run exits green with a proposal card');
    ok(landed.length === 1 && landed[0].source === 'rehearsal' && /Nothing self-adopts \(R3\)/.test(landed[0].body),
      'the card is a document carrying the diff + the R3 stance — nothing self-adopts');
    ok(/gate passed/.test(landed[0].body), 'the card carries the gate verdict');
  }

  // --- suite green but FULL gate red → stays active, gate output rides ---
  {
    const { deps } = freshDeps({
      picks: [{ action: 'test', why: 'check' }],
      testResults: ['[sandbox "t" gate passed]\nPASS — 4 ok, 0 failed', '[sandbox "t" gate FAILED (non-zero exit)]\nFAILURES — 300 passed, 1 failed'],
    });
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', deps });
    const r = await drv.iterate({ deps });
    ok(r.status === 'active' && /full gate red/.test(r.note) && /FULL GATE failed/.test(drv.load({ deps }).lastResult),
      'a green suite never exits past a red gate — the gate output rides the next attempt');
  }

  // --- budget parks (a bound defers, never disappears); resume refreshes it ---
  {
    const { deps } = freshDeps();
    drv.start({ slug: 't', goal: 'a goal long enough to pass the start contract check', suite: 'smoke_x.js', deps });
    const run = drv.load({ deps }); run.iteration = drv.ITER_BUDGET;
    deps.db.setMeta(drv.RUN_KEY, JSON.stringify(run));
    const r = await drv.iterate({ deps });
    ok(r.status === 'parked' && /resumable/.test(r.note), 'the iteration budget PARKS the run, honestly and resumably');
    const rs = drv.resume({ deps });
    ok(rs.ok && drv.load({ deps }).status === 'active' && drv.load({ deps }).iteration === 0, 'resume reactivates with a fresh budget');
    ok(drv.discard({ deps }).ok && drv.load({ deps }) === null, 'discard clears the run and the sandbox');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
