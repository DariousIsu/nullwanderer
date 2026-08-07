'use strict';
/* smoke_deferral_pause.js — the quota-deferral PAUSE contract at its propagation root.
 * A typed {deferred:true} throw from the completion model must RETHROW out of runOperator (so the
 * opt-in caller can pause the thread) while every other failure keeps the legacy shape (null /
 * finalize-with-null) — the false-validated grinder fix: a deferred pass must be distinguishable
 * from a dry pass. Run: node scripts/smoke_deferral_pause.js */
const path = require('path');
const { runOperator } = require(path.join(__dirname, '..', 'lib', 'operator'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

const deferredErr = () => { const e = new Error('quota: research deferred — over burn-down pace'); e.deferred = true; e.lane = 'research'; return e; };

(async () => {
  // 1) First completion deferred → rethrows typed (NOT a silent null).
  let caught = null;
  try { await runOperator({ userMessage: 'q', deps: { complete: async () => { throw deferredErr(); }, tools: {} } }); }
  catch (e) { caught = e; }
  ok('first-call deferral rethrows', !!(caught && caught.deferred === true));
  ok('rethrown error carries the lane', caught && caught.lane === 'research');

  // 2) Plain (non-deferred) failure keeps the legacy contract: null when no steps were gathered.
  let res2 = 'sentinel', threw2 = false;
  try { res2 = await runOperator({ userMessage: 'q', deps: { complete: async () => { throw new Error('boom'); }, tools: {} } }); }
  catch { threw2 = true; }
  ok('plain failure does not throw', !threw2);
  ok('plain failure with no steps returns null', res2 === null);

  // 3) Mid-run deferral (a step already gathered) still rethrows — pause beats a half-finalized
  //    answer that downstream would mistake for real (empty-ish) work.
  let calls = 0, caught3 = null;
  const complete3 = async () => {
    calls++;
    if (calls === 1) return '{"thought":"look","action":{"tool":"probe","args":{}}}';
    throw deferredErr();
  };
  try { await runOperator({ userMessage: 'q', deps: { complete: complete3, tools: { probe: async () => 'probe result: 42' } } }); }
  catch (e) { caught3 = e; }
  ok('mid-run deferral rethrows', !!(caught3 && caught3.deferred === true));

  // 4) Mid-run PLAIN failure keeps the legacy salvage: finalize from gathered steps, no throw.
  let calls4 = 0, res4 = null, threw4 = false;
  const complete4 = async () => {
    calls4++;
    if (calls4 === 1) return '{"thought":"look","action":{"tool":"probe","args":{}}}';
    throw new Error('boom');
  };
  try { res4 = await runOperator({ userMessage: 'q', deps: { complete: complete4, tools: { probe: async () => 'probe result: 42' } } }); }
  catch { threw4 = true; }
  ok('mid-run plain failure does not throw', !threw4);
  ok('mid-run plain failure salvages gathered steps', !!(res4 && Array.isArray(res4.steps) && res4.steps.length === 1));

  console.log(`smoke_deferral_pause: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
