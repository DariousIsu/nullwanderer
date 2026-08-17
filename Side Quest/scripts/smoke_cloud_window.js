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
    // M3.3c — the curator's own cloud call must resolve the window too (it ran a 131k model at 8192).
    const cur = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud_curator.js'), 'utf8');
    const curCode = cur.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(!/num_ctx: 8192/.test(curCode), 'REGRESSION: the curator cloud call no longer hardcodes num_ctx 8192');
    ok(/require\('\.\/cloud_window'\)\.resolve\(/.test(cur), 'the curator resolves the model window before completing (M3.3c)');
    const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(!/think: false,[\s\S]{0,120}num_predict: 900/.test(m), 'REGRESSION: the reply call no longer pins 900 output tokens');
  }

  // ── cognitionWindow: idle cognition budgets against the model that WILL serve ─────────────────
  // The heartbeat trims its own prompt (fitToWindow) BEFORE streamCognition picks cloud-vs-local, so it
  // must know the window up front. cognitionWindow runs the SAME cloud-source check streamCognition does.
  {
    const { cognitionWindow } = require('../lib/ollama');
    const cloudSrc = () => [{ tier: 'cloud', token: 'x', base: 'https://ollama.com' }];
    const localOnly = () => [{ tier: 'local', token: null, base: null }];
    const kimi = () => 'kimi-k2.6';

    const c = await cognitionWindow({ sources: cloudSrc, subconsciousModel: kimi, resolve: async () => ({ num_ctx: 131072 }) });
    ok(c.isCloud === true && c.num_ctx === 131072, "cloud source configured → the heartbeat budgets against kimi's real window, not 8192");

    const l = await cognitionWindow({ sources: localOnly, subconsciousModel: kimi, resolve: async () => ({ num_ctx: 131072 }) });
    ok(l.isCloud === false && l.num_ctx === 8192, 'no cloud source → hold the 8192 floor (local gemma really is 8k)');

    const t = await cognitionWindow({ sources: cloudSrc, subconsciousModel: kimi, resolve: async () => { throw new Error('probe down'); } });
    ok(t.num_ctx === 8192, 'FAIL-SAFE: a window-resolution failure holds the floor — an idle tick never throws');

    const n = await cognitionWindow({ sources: cloudSrc, subconsciousModel: () => '', resolve: async () => ({ num_ctx: 131072 }) });
    ok(n.num_ctx === 8192, 'no subconscious model configured → floor');
  }

  // ── the END-TO-END EFFECT: the resolved window is what stops the 73×/run history amputation ──
  // A realistic heartbeat prompt (~29k chars) fits with ZERO drops at the cloud window but is trimmed
  // at 8192 — the exact behaviour the boot_p46 run showed 73 times.
  {
    const { fitToWindow } = require('../lib/context');
    const big = [{ role: 'system', content: 'S'.repeat(4000) }];
    for (let i = 0; i < 40; i++) big.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn '.repeat(120) });   // ~29k chars total
    const atCloud = fitToWindow(big.map(m => ({ ...m })), { numCtx: 131072, numPredict: 1200 });
    ok(atCloud.report === null, 'at the cloud window the full heartbeat history fits — no turns dropped');
    const at8192 = fitToWindow(big.map(m => ({ ...m })), { numCtx: 8192, numPredict: 1200 });
    ok(at8192.report && at8192.report.droppedTurns > 0, 'at the old 8192 the same prompt loses turns (the bug we removed)');
  }

  // ── WIRING: the heartbeat cloud path no longer hardcodes the local window ─────────────────────
  // This guard checked cloud_logic / cloud_curator / main but MISSED heartbeat.js — which is exactly how
  // the 8192 survived there for the one cloud call that trims its own prompt. Pin it so it cannot regress.
  {
    const fs = require('fs'), path = require('path');
    const hb = fs.readFileSync(path.join(__dirname, '..', 'lib', 'heartbeat.js'), 'utf8');
    const hbCode = hb.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(!/num_ctx: ?8192/.test(hbCode) && !/numCtx: ?8192/.test(hbCode), 'REGRESSION: the heartbeat no longer hardcodes the 8192 local window on its cloud path');
    ok(/cognitionWindow\(\)/.test(hbCode), "the heartbeat resolves the serving model's window before fitting + sending");
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
