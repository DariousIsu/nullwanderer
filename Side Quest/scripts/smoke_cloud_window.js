/* smoke_cloud_window.js — a cloud model gets ITS window, not the local model's.
 *
 * Every cloud call asked for num_ctx 8192 — the LOCAL model's window, hardcoded when the local model
 * made every call, and it followed the work up to the cloud. Measured live 2026-07-20:
 *
 *     gpt-oss:120b 131,072 · kimi-k2.6 262,144 · qwen3.5:397b 262,144
 *     deepseek-v4-pro 524,288 · minimax-m3 524,288      …all requested at 8,192
 *
 * 1.6% of deepseek's window. And a small window is not an ERROR — it silently drops the tail, which
 * is why nothing ever surfaced it, and why every cap in the codebase (grounding 4,600 chars,
 * readings 2,600, tool results 4,000) was sized to fit inside it.
 *
 * Offline — modelContext is injected, so no network or model is touched.
 */
'use strict';
const win = require('../lib/cloud_window');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const ENV = ['ZOE_CLOUD_NUM_CTX', 'ZOE_CLOUD_CTX_MAX', 'ZOE_CLOUD_NUM_PREDICT'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
const ctxOf = (n) => ({ modelContext: async () => n });

(async () => {
  // ── the real windows are used ────────────────────────────────────────────────────────────────
  {
    clearEnv(); win._resetCache();
    const r = await win.resolve({ model: 'deepseek-v4-pro', deps: ctxOf(524288) });
    ok(r.num_ctx > 8192, 'REGRESSION: a frontier model is no longer pinned to the local 8192');
    ok(r.num_ctx === win.DEFAULT_MAX, 'clamped to the working ceiling, not the whole 524k window');
    ok(r.discovered === 524288 && r.source === 'discovered', 'the discovered window is reported');
  }
  {
    clearEnv(); win._resetCache();
    const r = await win.resolve({ model: 'gpt-oss:120b', deps: ctxOf(131072) });
    ok(r.num_ctx === 131072, 'a model at exactly the ceiling gets its full window');
  }

  // ── FAIL-SAFE: discovery failure must return TODAY's behaviour, never a guess ─────────────────
  // Asking for a window the endpoint rejects would break live turns; 8192 is known to work.
  {
    clearEnv(); win._resetCache();
    const r = await win.resolve({ model: 'mystery', deps: { modelContext: async () => { throw new Error('offline'); } } });
    ok(r.num_ctx === win.FLOOR && r.source === 'floor', 'discovery THROWS → the 8192 floor');
    win._resetCache();
    const r2 = await win.resolve({ model: 'mystery', deps: ctxOf(null) });
    ok(r2.num_ctx === win.FLOOR, 'discovery returns nothing → the 8192 floor');
    win._resetCache();
    const r3 = await win.resolve({ model: null, deps: ctxOf(999999) });
    ok(r3.num_ctx === win.FLOOR, 'no model name → the floor');
  }

  // ── never NARROWER than today ────────────────────────────────────────────────────────────────
  {
    clearEnv(); win._resetCache();
    const r = await win.resolve({ model: 'tiny', deps: ctxOf(2048) });
    ok(r.num_ctx === win.FLOOR, 'a small discovered window cannot regress us below 8192');
  }

  // ── the OUTPUT cap was its own truncation source ──────────────────────────────────────────────
  {
    clearEnv(); win._resetCache();
    const r = await win.resolve({ model: 'gpt-oss:120b', deps: ctxOf(131072) });
    ok(r.num_predict > 900, 'the reply budget is no longer the old 900-token cap');
    ok(r.num_predict === win.DEFAULT_PREDICT, 'default output budget applied');
  }

  // ── operator overrides ───────────────────────────────────────────────────────────────────────
  {
    clearEnv(); win._resetCache();
    process.env.ZOE_CLOUD_NUM_CTX = '32000';
    const r = await win.resolve({ model: 'deepseek-v4-pro', deps: ctxOf(524288) });
    ok(r.num_ctx === 32000 && r.source === 'override', 'ZOE_CLOUD_NUM_CTX pins the window');
    clearEnv(); win._resetCache();
    process.env.ZOE_CLOUD_CTX_MAX = '524288';
    const r2 = await win.resolve({ model: 'deepseek-v4-pro', deps: ctxOf(524288) });
    ok(r2.num_ctx === 524288, 'ZOE_CLOUD_CTX_MAX raises the ceiling to the full window');
    clearEnv(); win._resetCache();
    process.env.ZOE_CLOUD_NUM_PREDICT = '8000';
    const r3 = await win.resolve({ model: 'x', deps: ctxOf(131072) });
    ok(r3.num_predict === 8000, 'ZOE_CLOUD_NUM_PREDICT raises the output budget');
    clearEnv();
  }

  // ── discovery is cached — a model's window does not change ───────────────────────────────────
  {
    clearEnv(); win._resetCache();
    let calls = 0;
    const deps = { modelContext: async () => { calls++; return 131072; } };
    await win.resolve({ model: 'gpt-oss:120b', deps });
    await win.resolve({ model: 'gpt-oss:120b', deps });
    await win.resolve({ model: 'gpt-oss:120b', deps });
    ok(calls === 1, 'the window is discovered ONCE per model, not per turn');
  }

  // ── WIRING: streamCloud actually uses it ─────────────────────────────────────────────────────
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud_logic.js'), 'utf8');
    // Comments quote the old value deliberately, so check CODE lines only.
    const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(!/num_ctx: 8192/.test(code), 'REGRESSION: NO cloud path in cloud_logic still hardcodes 8192');
    // _complete + streamCloud + the exported resolveWindow (which callers use to BUDGET a package
    // against the same window the call will get). At least the first two must be there.
    ok((src.match(/require\('\.\/cloud_window'\)\.resolve\(/g) || []).length >= 2,
      'both cloud paths resolve the window — _complete carries the grounded answer draft');
    ok(/async function resolveWindow/.test(src),
      'callers can ask what window the NEXT call gets, instead of guessing and mis-budgeting');
    ok(/num_ctx: win\.num_ctx/.test(src), 'the resolved window reaches the request');
    ok(/num_predict = null/.test(src), 'num_predict defaults to unset so the window sizes it');
    const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(!/think: false,[\s\S]{0,120}num_predict: 900/.test(m), 'REGRESSION: the reply call no longer pins 900 output tokens');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
