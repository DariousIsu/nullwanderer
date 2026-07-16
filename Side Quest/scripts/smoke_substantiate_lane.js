/* Smoke: lib/substantiate_lane — Slice 4, the async substantiation ("prove") lane (offline, injected probes).
 *
 * Part A (pure): decideOutcome (internal > web > none), substantiateOne (internal-first cascade + fail-soft),
 *   runTick (bounded scan, tallies, markProved, fail-soft).
 * Part B (REAL sqlite): the db queue + persist — listUnsubstantiatedObservations returns unsubstantiated
 *   entities oldest-first (not the substantiated ones); setSubstantiationForEntity flips them off the queue.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_substantiate_lane.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const SL = require('../lib/substantiate_lane');
const CS = require('../lib/curation_store');

(async () => {
  // --- decideOutcome: the cascade priority -----------------------------------------------------------
  ok(SL.decideOutcome({ internalHit: { title: 'Ohio Senate' } }).state === 'identity-confirmed', 'decideOutcome: an internal corpora match → identity-confirmed');
  ok(SL.decideOutcome({ internalHit: { title: 'Ohio Senate' } }).source === 'internal:Ohio Senate', 'decideOutcome: identity-confirmed carries the internal source label');
  ok(SL.decideOutcome({ webSources: [{ url: 'https://myparish.gov/x' }] }).state === 'source-vouched', 'decideOutcome: a real web source → source-vouched');
  ok(SL.decideOutcome({ webSources: [{ url: 'https://fandom.com/x' }] }).state === 'unsubstantiated', 'decideOutcome: a junk-only web source → still unsubstantiated (bottom floor)');
  ok(SL.decideOutcome({ webSources: [] }).state === 'unsubstantiated', 'decideOutcome: nothing found → unsubstantiated (leave for fade)');
  ok(SL.decideOutcome({ internalHit: { title: 'X' }, webSources: [{ url: 'https://a.gov/y' }] }).state === 'identity-confirmed', 'decideOutcome: internal WINS over web (internal is the first tier)');
  ok(SL.decideOutcome({ webSources: ['https://a.gov/y', { link: 'https://b.gov/z' }] }).source === 'https://a.gov/y', 'decideOutcome: accepts string / {url} / {link} shapes; returns the first real url');

  // --- substantiateOne: internal-first cascade + fail-soft --------------------------------------------
  let webCalled = false;
  const rInt = await SL.substantiateOne({ name: 'Known Org' }, { validateInternal: async () => ({ title: 'Known Org' }), searchWeb: async () => { webCalled = true; return [{ url: 'https://x.gov' }]; } });
  ok(rInt.state === 'identity-confirmed' && rInt.proved === true && webCalled === false, 'substantiateOne: internal hit → identity-confirmed, WEB probe SKIPPED (cascade order)');
  const rWeb = await SL.substantiateOne({ source_entity: 'Sheriff Office' }, { validateInternal: async () => null, searchWeb: async () => [{ url: 'https://county.gov/sheriff' }] });
  ok(rWeb.state === 'source-vouched' && rWeb.proved === true, 'substantiateOne: internal miss → web hit → source-vouched (reads source_entity too)');
  const rNone = await SL.substantiateOne({ name: 'Ghost' }, { validateInternal: async () => null, searchWeb: async () => [] });
  ok(rNone.state === 'unsubstantiated' && rNone.proved === false, 'substantiateOne: both probes miss → stays unsubstantiated');
  const rSkip = await SL.substantiateOne({ name: '  ' }, {});
  ok(rSkip.proved === false && rSkip.reason === 'no-name', 'substantiateOne: a blank name is skipped');
  const rThrow = await SL.substantiateOne({ name: 'Boom' }, { validateInternal: async () => { throw new Error('echo down'); }, searchWeb: async () => [{ url: 'https://ok.gov/b' }] });
  ok(rThrow.state === 'source-vouched', 'substantiateOne: a throwing internal probe is a MISS → falls through to web (fail-soft)');
  const rThrow2 = await SL.substantiateOne({ name: 'Boom2' }, { validateInternal: async () => null, searchWeb: async () => { throw new Error('web down'); } });
  ok(rThrow2.state === 'unsubstantiated', 'substantiateOne: a throwing web probe is a MISS → unsubstantiated (never propagates)');

  // --- runTick: bounded scan + tallies + markProved --------------------------------------------------
  const listed = [{ name: 'Alpha Org' }, { name: 'Beta Place' }, { name: 'Gamma Event' }];
  const proved = [];
  const t = await SL.runTick({
    listUnsubstantiated: async () => listed,
    validateInternal: async (n) => (n === 'Alpha Org' ? { title: 'Alpha Org' } : null),      // Alpha → internal
    searchWeb: async (n) => (n === 'Beta Place' ? [{ url: 'https://real.gov/beta' }] : []),   // Beta → web; Gamma → nothing
    markProved: async (name, state, source) => proved.push({ name, state, source }),
    cap: 3,
  });
  ok(t.scanned === 3, 'runTick: scans the whole queue within cap');
  ok(t.proved === 2 && t.internal === 1 && t.web === 1 && t.stillUnsub === 1, 'runTick: tallies internal(1) / web(1) / stillUnsub(1)');
  ok(proved.length === 2 && (proved.find((p) => p.name === 'Alpha Org') || {}).state === 'identity-confirmed', 'runTick: markProved fired for the internal hit → identity-confirmed');
  ok((proved.find((p) => p.name === 'Beta Place') || {}).state === 'source-vouched', 'runTick: markProved fired for the web hit → source-vouched');
  const t2 = await SL.runTick({ listUnsubstantiated: async () => listed, validateInternal: async () => null, searchWeb: async () => [], cap: 2 });
  ok(t2.scanned === 2, 'runTick: cap bounds the scan (2 of 3)');
  const t3 = await SL.runTick({ listUnsubstantiated: async () => { throw new Error('db down'); }, cap: 5 });
  ok(t3.scanned === 0, 'runTick: a throwing queue → scanned 0 (fail-soft, never throws)');

  // --- Part B: REAL sqlite — the queue + persist round-trip -------------------------------------------
  const tmp = path.join(os.tmpdir(), `sq_substantiate_lane_smoke_${Date.now()}.db`);
  process.env.SQ_DB_PATH = tmp;
  let realOk = true;
  try {
    const db = require('../lib/db');
    db.init();
    // two unsubstantiated entities (oldest first) + one already substantiated (must NOT be in the queue).
    CS.record(db, { feed: 'doc-decomp', sourceEntity: "Sheriff's Office", relation: 'exists', url: 'docstore:1', status: 'promoted', substantiationState: 'unsubstantiated', capturedAt: 100 });
    CS.record(db, { feed: 'doc-decomp', sourceEntity: 'County Council', relation: 'exists', url: 'docstore:2', status: 'promoted', substantiationState: 'unsubstantiated', capturedAt: 200 });
    CS.record(db, { feed: 'graph-walk', sourceEntity: 'Known Person', relation: 'exists', url: 'https://en.wikipedia.org/wiki/Known', status: 'promoted', substantiationState: 'source-vouched', capturedAt: 50 });

    const q = db.listUnsubstantiatedObservations({ limit: 10 });
    ok(q.length === 2, 'db queue: only the 2 UNSUBSTANTIATED entities (the source-vouched one is excluded)');
    ok(q[0].name === "Sheriff's Office" && q[1].name === 'County Council', 'db queue: OLDEST first (Sheriff captured_at 100 before Council 200)');

    const changed = db.setSubstantiationForEntity("Sheriff's Office", 'identity-confirmed');
    ok(changed === 1, 'db persist: setSubstantiationForEntity flips the entity off the unsubstantiated queue');
    const q2 = db.listUnsubstantiatedObservations({ limit: 10 });
    ok(q2.length === 1 && q2[0].name === 'County Council', 'db persist: the proved entity is gone; only County Council remains unsubstantiated');
    const proven = db.listKgObservations({ sourceEntity: "Sheriff's Office" });
    ok(proven[0].substantiation_state === 'identity-confirmed', 'db persist: the row is now identity-confirmed (Slice-3 promote gate will carry it long-term)');
  } catch (e) {
    realOk = false;
    console.log('  ✗ real-db section threw:', e && e.message);
    fail++;
  } finally {
    try { require('../lib/db').getDb().close(); } catch {}
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }
  }
  ok(realOk, 'real: sqlite section completed without throwing');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
