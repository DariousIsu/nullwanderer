/* Smoke: the PULLER PIPELINE coordinator (cloud-leverage Slice 3, lib/pipeline.js). Pure — no DB / model /
 * network. Verifies target-lifecycle staging, queue partitioning + ordering, and the DISCOVER backpressure
 * gate that makes it a pipeline (not three blind lanes).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_pipeline.js
 */
'use strict';
const pipeline = require('../lib/pipeline');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- stageOf: a target's lifecycle stage from its facets ---
ok(pipeline.stageOf({ hasEmail: false, hasDeep: false }) === 'contact', 'no email → CONTACT stage');
ok(pipeline.stageOf({ hasEmail: true, hasDeep: false }) === 'enrich', 'email, not deep → ENRICH stage');
ok(pipeline.stageOf({ hasEmail: true, hasDeep: true }) === 'done', 'email + deep → done (terminal)');
ok(pipeline.stageOf(null) === 'done', 'null target → done (no crash)');
ok(pipeline.stageOf({ hasEmail: false, hasDeep: true }) === 'contact', 'no email dominates even if deep-flagged → CONTACT');

// --- partition: buckets + ordering (active-first, then freshest ts) ---
const cands = [
  { id: 1, name: 'Ann Old',    hasEmail: false, hasDeep: false, ts: 100 },   // contact, oldest
  { id: 2, name: 'Bob Fresh',  hasEmail: false, hasDeep: false, ts: 900 },   // contact, freshest
  { id: 3, name: 'Cy Active',  hasEmail: false, hasDeep: false, ts: 200 },   // contact, ACTIVE
  { id: 4, name: 'Dot Mailed', hasEmail: true,  hasDeep: false, ts: 500 },   // enrich
  { id: 5, name: 'Eve Done',   hasEmail: true,  hasDeep: true,  ts: 500 },   // done → neither queue
  { id: 6, name: '',           hasEmail: false, hasDeep: false, ts: 999 },   // no name → dropped
];
const activeKeys = new Set([pipeline._norm('Cy Active')]);
const { contact, enrich } = pipeline.partition(cands, { activeKeys });

ok(contact.length === 3, `CONTACT queue has the 3 no-email named targets — got ${contact.length}`);
ok(enrich.length === 1 && enrich[0].id === 4, 'ENRICH queue has only the emailed-not-deep target');
ok(!contact.some((t) => t.id === 5) && !enrich.some((t) => t.id === 5), 'done target (5) is in neither queue');
ok(!contact.some((t) => !t.name), 'unnamed target dropped from queues');
ok(contact[0].id === 3, 'ACTIVE target ranks FIRST in the contact queue (over fresher non-active)');
ok(contact[1].id === 2 && contact[2].id === 1, 'among non-active, FRESHEST (ts desc) leads: Bob(900) before Ann(100)');

// --- shouldDiscover: backpressure on the contact backlog ---
ok(pipeline.shouldDiscover({ contactDepth: 0, cap: 40 }) === true, 'empty backlog → DISCOVER open');
ok(pipeline.shouldDiscover({ contactDepth: 39, cap: 40 }) === true, 'backlog below cap → DISCOVER open');
ok(pipeline.shouldDiscover({ contactDepth: 40, cap: 40 }) === false, 'backlog AT cap → DISCOVER held (backpressure)');
ok(pipeline.shouldDiscover({ contactDepth: 100, cap: 40 }) === false, 'backlog over cap → DISCOVER held');
ok(pipeline.shouldDiscover({ contactDepth: 5 }) === true, 'default cap (40) applies when omitted');

// --- describe: a compact pressure line for the tick log ---
const d1 = pipeline.describe({ contact, enrich }, { cap: 40 });
ok(/contact:3/.test(d1) && /enrich:1/.test(d1) && /discover:open/.test(d1), `describe shows open discover under cap — "${d1}"`);
const d2 = pipeline.describe({ contact: new Array(50).fill({ name: 'x', hasEmail: false }), enrich: [] }, { cap: 40 });
ok(/discover:held/.test(d2), `describe shows HELD discover over cap — "${d2}"`);

// --- resilience: empty / garbage inputs never throw ---
ok((() => { try { const r = pipeline.partition(null, {}); return r.contact.length === 0 && r.enrich.length === 0; } catch { return false; } })(), 'partition(null) → empty queues, no throw');
ok((() => { try { pipeline.describe({}, {}); return true; } catch { return false; } })(), 'describe({}) → no throw');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
