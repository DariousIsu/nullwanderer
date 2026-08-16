'use strict';
/* smoke_swarm_cap.js — the swarm concurrency cap-raise + 429 backoff (2026-08-16).
 * Two pure pieces:
 *   (1) config.maxWorkers() — the env-tunable ceiling both _workerCount() and the "swarm <X> with N
 *       workers" override clamp to. Default 12 (raised from the old hardcoded 8, proven safe on
 *       ollama.com); ZOE_MAX_WORKERS overrides; clamped 1..20.
 *   (2) ollama._maybeBackoff429 — the cloud choke-point decision: retry a TRANSIENT concurrency-429
 *       (jittered backoff) but NEVER a different 429 (daily quota) or a spent budget or an aborted call.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_swarm_cap.js
 */
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // ── (1) config.maxWorkers() — env-tunable ceiling, default 12, clamped 1..20 ──────────────────────────────
  delete process.env.ZOE_MAX_WORKERS;
  const cfg = require('../lib/config');
  ok(cfg.maxWorkers() === 12, `default ceiling is 12 (got ${cfg.maxWorkers()}) — was hardcoded 8`);
  process.env.ZOE_MAX_WORKERS = '10'; ok(cfg.maxWorkers() === 10, 'ZOE_MAX_WORKERS=10 honored');
  process.env.ZOE_MAX_WORKERS = '50'; ok(cfg.maxWorkers() === 20, 'absurd value clamped to 20 (provider hard limit)');
  process.env.ZOE_MAX_WORKERS = '0'; ok(cfg.maxWorkers() === 12, 'invalid (0) falls back to default 12');
  process.env.ZOE_MAX_WORKERS = 'nonsense'; ok(cfg.maxWorkers() === 12, 'non-numeric falls back to default 12');
  delete process.env.ZOE_MAX_WORKERS;

  // ── (2) _maybeBackoff429 — retry a transient concurrency-429, never a different 429 ────────────────────────
  const { _maybeBackoff429, _CONCURRENCY_429_RE } = require('../lib/ollama');
  const fastOpts = { maxRetries: 3, baseMs: 1 };   // baseMs:1 keeps the smoke sub-ms per backoff

  ok(_CONCURRENCY_429_RE.test('too many concurrent requests'), 'matcher catches the live message "too many concurrent requests"');
  ok(!_CONCURRENCY_429_RE.test('you have exceeded your daily quota'), 'matcher does NOT catch a daily-quota message');

  ok(await _maybeBackoff429(429, '{"error":"too many concurrent requests"}', 0, null, 'gemma4:31b-cloud', fastOpts) === true,
    'transient concurrency-429, attempt 0 → backs off (true)');
  ok(await _maybeBackoff429(429, 'too many concurrent requests', 2, null, 'm', fastOpts) === true,
    'concurrency-429 at attempt 2 (last allowed) → still backs off');
  ok(await _maybeBackoff429(429, 'too many concurrent requests', 3, null, 'm', fastOpts) === false,
    'retry budget spent (attempt 3 of max 3) → gives up (false)');
  ok(await _maybeBackoff429(429, 'exceeded your daily quota', 0, null, 'm', fastOpts) === false,
    'a NON-concurrency 429 (daily quota) → NOT retried (surfaced honestly)');
  ok(await _maybeBackoff429(500, 'internal error', 0, null, 'm', fastOpts) === false,
    'a non-429 (500) → not retried here');
  ok(await _maybeBackoff429(429, 'too many concurrent requests', 0, { signal: { aborted: true } }, 'm', fastOpts) === false,
    'already aborted (watchdog/maxTimer fired) → does not wait');

  // it genuinely WAITS (returns after a real delay) — proves it's a backoff, not a no-op
  {
    const t0 = Date.now();
    await _maybeBackoff429(429, 'too many concurrent requests', 1, null, 'm', { maxRetries: 3, baseMs: 20 });
    const waited = Date.now() - t0;
    ok(waited >= 15, `attempt 1 with baseMs=20 waited ~${waited}ms (≥15) — a real backoff, jittered`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
