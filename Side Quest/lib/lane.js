/* lib/lane.js — WHICH LANE IS THIS CALL ON? (ambient, concurrency-safe)
 *
 * Measured problem (route observation log, 2026-07-19): `autonomous` was 1 on 2,630 of 130,797
 * rows — 2%. It is supposed to mark every Echo call made by the unattended research loop, and that
 * loop is the overwhelming majority of our traffic. So the flag was very nearly a constant.
 *
 * Not a logging bug — a PLUMBING one. `runCloudOperator({autonomous:true})` knows the answer, but
 * the operator's tools live in a module-level `operatorTools` map and are invoked as
 * `operatorTools[k](args)`. The handler that eventually calls `echoSuit.dispatch` has no way to
 * learn which run it belongs to, so `opts.autonomous` was left unset and defaulted to false.
 *
 * WHY AMBIENT RATHER THAN PLUMBED: route_obs already faced this exact shape with `focus_id` (dead
 * on every row because nothing passed `opts.focusId`) and resolved it by reading the AMBIENT focus
 * inside record() rather than threading a parameter through dozens of call sites — a plumbed value
 * can drift out of sync at any site that forgets it, an ambient one cannot. Same choice here.
 *
 * WHY AsyncLocalStorage AND NOT A MODULE-LEVEL FLAG: up to 3 operator runs are in flight at once
 * (research.max_concurrent leaves a cloud slot free for chat), so a single shared flag would be
 * read by whichever run happened to be executing — a foreground chat turn racing two background
 * research passes would be labelled autonomous, which is precisely backwards for a flag whose
 * whole purpose is to tell those two apart. AsyncLocalStorage keeps one value per async execution
 * chain, so each run reads its own.
 *
 * Fail-soft everywhere: if the store is unavailable, `current()` returns an empty context and every
 * caller falls back to its explicit argument. This must never be able to break a dispatch.
 */
'use strict';

let _als = null;
try {
  const { AsyncLocalStorage } = require('async_hooks');
  _als = new AsyncLocalStorage();
} catch { _als = null; }   // no async_hooks → ambient lane simply never resolves; explicit args still work

// Run `fn` with `ctx` as the ambient lane for everything it awaits, however deeply nested.
// Returns whatever fn returns (including its promise), so callers can `await lane.run(...)`.
function run(ctx, fn) {
  if (!_als || typeof fn !== 'function') return typeof fn === 'function' ? fn() : undefined;
  try { return _als.run({ ...(ctx || {}) }, fn); } catch { return fn(); }
}

// The ambient lane for the current async execution, or {} outside any run().
function current() {
  if (!_als) return {};
  try { return _als.getStore() || {}; } catch { return {}; }
}

// Convenience: is this call on the unattended loop? `explicit` (an opts.autonomous the caller
// actually passed) always wins, so a call site that knows better is never overridden by ambient.
function isAutonomous(explicit) {
  if (explicit === true || explicit === false) return explicit;
  return !!current().autonomous;
}

// ── SPEND TIER (2026-08-12 review H2/M5) ─────────────────────────────────────────────────────────
// The quota tier a cloud call bills to. The old default in runCloudOperator keyed 'directed' on
// GLOBAL focus state (_userDirectedActive), so background passes that ran ALONGSIDE Lucas's
// standing focus self-labeled 'directed' and — post-cf2b5ef — escaped the pace governor entirely
// (a large share of the measured 300-516k/hr hot burn). And condenseComplete (~20 sites incl. the
// autonomous research organize/merge/topical steps on the 120B) passed no lane at all, defaulting
// 'interactive' and bypassing the choke-point gate. The cure is this module's own doctrine:
// AMBIENT over plumbed. An orchestrator declares its tier ONCE via run({spendTier}), every cloud
// call it awaits inherits it, and the resolution order is pure and testable:
//   explicit (the call site knows best) → ambient (the run declared it) → autonomous ? 'research'
//   (an unattended run NEVER defaults to an ungated tier) → undefined (interactive/legacy).
// 'directed' is EARNED by the focus being driven (user-origin, not beat) — never inferred from
// what happens to be globally current.
function resolveSpendTier({ explicit, ambient, autonomous } = {}) {
  if (explicit != null) return explicit;
  if (ambient != null) return ambient;
  return autonomous ? 'research' : undefined;
}
function ambientSpendTier() { return current().spendTier; }

module.exports = { run, current, isAutonomous, resolveSpendTier, ambientSpendTier };
