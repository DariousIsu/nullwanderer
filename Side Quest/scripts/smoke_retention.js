/* Smoke: lib/retention — short-term store tidying (Slice 3). Proves the keep/prune/delete decision across
 * the retention window, the pointer body a pruned doc keeps, and the batch plan. Pure: no model/file/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_retention.js
 */
'use strict';
const R = require('../lib/retention');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const old = NOW - 10 * DAY;     // older than the 7-day window
const fresh = NOW - 1 * DAY;    // within the window

// --- classify: keep cases ---
ok(R.classify({ promoted: 0, body: 'x'.repeat(500), created_ts: old }, { now: NOW }) === 'keep', 'un-promoted → keep (still working memory)');
ok(R.classify({ promoted: 1, promoted_ref: 'echo:5', body: 'x'.repeat(500), updated_ts: fresh }, { now: NOW }) === 'keep', 'promoted but within window → keep (full body)');

// --- classify: prune (echo-promoted, past window, full body) ---
const echoOld = { id: 1, promoted: 1, promoted_ref: 'echo:1185', body: 'x'.repeat(5000), understanding: 'huddle notes', updated_ts: old };
ok(R.classify(echoOld, { now: NOW }) === 'prune', 'echo-promoted + past window + full body → prune');

// --- classify: already-trimmed echo doc → keep (no re-prune loop) ---
const trimmed = { id: 2, promoted: 1, promoted_ref: 'echo:1185', body: R.pointerFor({ promoted_ref: 'echo:1185', understanding: 'huddle notes' }), understanding: 'huddle notes', updated_ts: old };
ok(R.classify(trimmed, { now: NOW }) === 'keep', 'already trimmed to its pointer → keep (idempotent)');

// --- classify: delete (skip-marked / no echo ref, past window) ---
ok(R.classify({ id: 3, promoted: 1, promoted_ref: 'skipped:thin', body: 'tiny', updated_ts: old }, { now: NOW }) === 'delete', 'skip-marked + past window → delete');

// --- pointerFor ---
const ptr = R.pointerFor({ promoted_ref: 'echo:1185', understanding: 'Rainey huddle action items' });
ok(/Filed to long-term storage — echo:1185/.test(ptr) && /Rainey huddle action items/.test(ptr), 'pointer carries the Echo ref + understanding');
ok(R.pointerFor({ promoted_ref: 'echo:9' }) === '[Filed to long-term storage — echo:9]', 'pointer without understanding is just the marker');

// --- plan over a batch ---
const plan = R.plan([
  echoOld,                                                                              // prune
  { id: 4, promoted: 1, promoted_ref: 'skipped:thin', body: 'x', updated_ts: old },     // delete
  { id: 5, promoted: 0, body: 'x'.repeat(500), created_ts: old },                       // keep
  { id: 6, promoted: 1, promoted_ref: 'echo:7', body: 'x'.repeat(500), updated_ts: fresh }, // keep (fresh)
], { now: NOW });
ok(plan.prune.length === 1 && plan.prune[0].id === 1 && /echo:1185/.test(plan.prune[0].pointer), 'plan prunes the aged echo doc with its pointer');
ok(plan.delete.length === 1 && plan.delete[0] === 4, 'plan deletes the aged skip-marked doc only');

// --- fail-safe ---
ok(R.classify(null, { now: NOW }) === 'keep', 'null doc → keep (no throw)');
ok(JSON.stringify(R.plan(null)) === '{"prune":[],"delete":[]}', 'plan(null) → empty plan (no throw)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
