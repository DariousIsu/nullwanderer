/* Smoke: lib/usage_meter — the pure token-usage roll-up behind the canvas usage pill.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_usage_meter.js
 */
'use strict';
const um = require('../lib/usage_meter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const T = 1_000_000_000_000;   // a fixed base timestamp (deterministic)
const HOUR = um.HOUR_MS, DAY = um.DAY_MS;

um.reset();
// three calls across two models, spread over the last few hours
um.record('gemma4:12b', 1000, T - 2 * HOUR);
um.record('gpt-oss:120b', 3000, T - 30 * 60 * 1000);   // 30 min ago
um.record('gemma4:12b', 500, T - 5 * 60 * 1000);        // 5 min ago

let s = um.summary({ now: T, windowMs: DAY, rateMs: HOUR });
ok(s.total === 4500, `daily total sums all in-window (${s.total})`);
ok(s.byModel['gpt-oss:120b'] === 3000 && s.byModel['gemma4:12b'] === 1500, 'per-model breakdown correct');
ok(Object.keys(s.byModel)[0] === 'gpt-oss:120b', 'byModel sorted desc (biggest first)');
ok(s.rate === 3500, `60-min rate counts only the last hour (${s.rate})`);
ok(s.calls === 3, 'call count');

// window pruning: a 15-min window drops the 2h-old + 30-min-old, keeps the 5-min one
s = um.summary({ now: T, windowMs: 15 * 60 * 1000 });
ok(s.total === 500 && s.calls === 1, '15-min window keeps only the recent call');

// old entries beyond retention are pruned on record (memory bounded)
um.reset();
um.record('m', 100, T - 40 * HOUR);   // older than RETAIN
um.record('m', 200, T);
ok(um._size() === 1, 'retention prune drops entries older than the horizon');
ok(um.summary({ now: T }).total === 200, 'only the retained entry counts');

// fail-soft inputs
um.reset();
um.record('m', 0); um.record('m', -5); um.record('m', NaN); um.record('m', 'x');
ok(um._size() === 0, 'zero/negative/NaN/non-number tokens are ignored');
ok(um.summary({}).total === 0, 'empty meter → 0, no crash');

// tokensOf: both usage shapes
ok(um.tokensOf({ prompt_tokens: 10, eval_tokens: 20 }) === 30, 'tokensOf: normalized shape');
ok(um.tokensOf({ prompt_eval_count: 7, eval_count: 8 }) === 15, 'tokensOf: raw Ollama shape');
ok(um.tokensOf(null) === 0 && um.tokensOf({}) === 0, 'tokensOf: junk → 0');

// ── ⭐ #115: the ring carries LANE so quota can split the hour ──
{
  um.reset();
  const t0 = Date.now();
  um.record('m1', 100, t0, 'directed');
  um.record('m1', 40, t0, 'research');
  um.record('m2', 7, t0);   // untagged → '?'
  const bg = um.byModelSince(t0 - 1000, t0 + 1000, { lanes: ['research', 'idle', '?'] });
  ok(bg.m1 === 40 && bg.m2 === 7, '⭐ byModelSince filters to background lanes; untagged counts as background (safe-biased)');
  const all = um.byModelSince(t0 - 1000, t0 + 1000);
  ok(all.m1 === 140 && all.m2 === 7, 'no filter → all lanes');
  um.persist(t0 + 1, { setMeta: (k, v) => { globalThis.__ring = v; }, force: true });
  um.reset();
  um.restore(t0 + 2, { getMeta: () => globalThis.__ring });
  ok(um.byModelSince(t0 - 1000, t0 + 1000, { lanes: ['directed'] }).m1 === 100, 'the lane tag survives persist/restore');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
