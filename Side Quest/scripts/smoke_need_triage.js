/* Smoke: lib/need_triage — P0b, the needs get consumed (triage contract, pressure rule, external
 * ask) + source asserts on the autonomy-tick wiring. Pure/offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_need_triage.js
 */
'use strict';
const nt = require('../lib/need_triage');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- triage contract ---
const inp = nt.triageInput({ need: 'parse XLS roster files into contacts', born_from: 'inquiry-54-t4', recurrence: 3 });
ok(inp.need === 'parse XLS roster files into contacts' && inp.bornFrom === 'inquiry-54-t4' && inp.recurrence === 3, 'input carries need + provenance + recurrence');
ok(!('recurrence' in nt.triageInput({ need: 'x'.repeat(20) })), 'single-occurrence needs omit the recurrence field');
const want = nt.triageWant();
ok(/"buildable"\|"external"\|"research"\|"junk"/.test(want) && /build_sketch/.test(want) && /study_query/.test(want), 'want names the four classes + the build fields');
ok(/paid database.*is external, not buildable/i.test(want) && /parse XLS.*is buildable/i.test(want) && /who funds X.*is research/i.test(want), 'want carries the calibration examples (strict about buildable)');

// --- validator ---
ok(nt.triageValidator('{"class":"buildable","reason":"r","build_sketch":"s","study_query":"q","ask":""}').valid === true, 'validator accepts a buildable verdict');
ok(nt.triageValidator('<think>{"class":"junk"}</think>{"class":"external","reason":"needs a subscription","ask":"an FDO login"}').valid === true, 'validator strips think blocks first');
ok(nt.triageValidator('{"class":"maybe"}').valid === false && nt.triageValidator('prose').valid === false, 'a non-verdict is rejected');

// --- duePressure: the deterministic selection rule ---
const now = 10_000_000;
const GAP = 30 * 60 * 1000;
const mkNeeds = () => [
  { id: 3, status: 'open', created_ts: 300, triage: 'buildable' },
  { id: 1, status: 'open', created_ts: 100, triage: null },
  { id: 2, status: 'open', created_ts: 200, triage: 'buildable' },
  { id: 4, status: 'rehearsing', created_ts: 50, triage: 'buildable' },
];
ok(nt.duePressure({ needs: mkNeeds(), lastRehearseTs: now - 1000, nowMs: now, gapMs: GAP }) === null, 'inside the calm gap → nothing is due (needs-work paces itself)');
let d = nt.duePressure({ run: { status: 'active', slug: 'r' }, needs: mkNeeds(), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'iterate', 'a live run is advanced before anything opens (one-at-a-time)');
d = nt.duePressure({ run: { status: 'parked', slug: 'r' }, needs: [], lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'iterate', 'a parked run resumes under pressure too');
d = nt.duePressure({ run: { status: 'discarded' }, needs: mkNeeds(), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'triage' && d.needId === 1, 'no live run → the OLDEST untriaged open need is triaged first');
d = nt.duePressure({ needs: mkNeeds().filter((n) => n.id !== 1), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'open' && d.needId === 2, 'all triaged → the oldest BUILDABLE open need opens (rehearsing rows never re-picked)');
ok(nt.duePressure({ needs: [{ id: 9, status: 'open', created_ts: 1, triage: 'external' }], lastRehearseTs: 0, nowMs: now }) === null, 'a queue of only non-buildable needs forces nothing');
ok(nt.duePressure({}) === null, 'empty world → null, no throw');

// --- renderExternalAsk ---
const ask1 = nt.renderExternalAsk([{ id: 1, need: 'FDO access', ask: 'a Foundation Directory Online subscription' }]);
ok(/One capability I can't build myself/.test(ask1) && /Foundation Directory Online subscription/.test(ask1), 'single blocked need → the one-sentence ask');
const ask2 = nt.renderExternalAsk([{ need: 'a' }, { need: 'b', ask: 'DCA portal credentials' }, { need: 'c' }, { need: 'd' }]);
ok(/^3 capabilities I can't build myself/.test(ask2), 'the header counts the LISTED asks (capped), not the pile');
ok(/\(1\) a \(2\) DCA portal credentials \(3\) c/.test(ask2) && !/\(4\)/.test(ask2), 'multi asks are numbered, prefer the ask over the raw need, and cap at 3');
ok(nt.renderExternalAsk([]) === '' && nt.renderExternalAsk(null) === '', 'nothing blocked → no message');

// --- wiring (source asserts): the pressure is IN the tick, gated, and routes all four classes ---
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/_forced = await _needsPressure\(now\)/.test(m) && /_forced \|\| await autonomy\.decide/.test(m), 'the tick consults needs-pressure BEFORE the idle lottery, and a forced move wins');
  ok(/if \(_userDirectedActive\(\)\) return null;\s*\/\/ his work owns the bandwidth/.test(m), 'pressure yields to directed work (preemption)');
  ok(/quota_gate'\)\.allow\('research', \{ quiet: true \}\)/.test(m), 'pressure runs on the RESEARCH quota lane (idle-lane rate starvation inverted the stated priority)');
  ok(/blocked_external/.test(m) && /routed_research/.test(m) && /parked as junk/.test(m), 'all three non-buildable routes exist (external / research / junk)');
  ok(/needs\.external_surfaced_at/.test(m) && /24 \* 3600e3/.test(m), 'the external ask is consolidated + throttled to once a day');
  ok(/TRIAGE SKETCH:/.test(m), 'a buildable verdict seeds the study block for the rehearsal open');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
