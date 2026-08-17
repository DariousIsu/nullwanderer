'use strict';
/* smoke_keepalive.js — keep_alive policy for local vs cloud model calls (2026-08-16, Lucas).
 * The demoted-cold front FALLBACK loads gemma4:12b LOCALLY only when the cloud is throttled/down. The old
 * hardcoded keep_alive:'24h' pinned it in the RX 7900 XT's VRAM for a full day after one transient blip.
 * _keepAlive: cloud base (proxied to ollama.com, holds no local VRAM) → '24h' harmless; local base → a SHORT
 * window so the fallback unloads when idle. Run: node scripts/smoke_keepalive.js */
const { _keepAlive, OLLAMA_BASE } = require('../lib/ollama');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

ok(_keepAlive('https://ollama.com') === '24h', 'a CLOUD base (ollama.com) → 24h (harmless — no local VRAM held)');
ok(_keepAlive(OLLAMA_BASE) === '5m', 'the LOCAL base → 5m (short — fallback unloads when idle, VRAM freed)');
ok(_keepAlive(undefined) === '5m', 'undefined base (defaults local) → 5m');
ok(_keepAlive(null) === '5m', 'null base → 5m (never squats VRAM)');
// A -cloud model (e.g. gemma4:31b-cloud) is called against the LOCAL daemon (base=OLLAMA_BASE), which proxies
// it to ollama.com — no local weights held, so a 5m keep_alive on it is harmless. The 24h branch is only for
// a caller that passes an explicit remote base. Both branches are safe; the only thing that MATTERS is that a
// real LOCAL model (the front fallback) no longer pins 24h.
ok(_keepAlive(OLLAMA_BASE) === _keepAlive(undefined), 'a -cloud call via the local daemon (base=OLLAMA_BASE) gets the same short window — harmless, no local weights');

// env override
const _saved = process.env.ZOE_LOCAL_KEEP_ALIVE;
process.env.ZOE_LOCAL_KEEP_ALIVE = '90s';
ok(_keepAlive(OLLAMA_BASE) === '90s', 'ZOE_LOCAL_KEEP_ALIVE overrides the local default');
ok(_keepAlive('https://ollama.com') === '24h', 'the override does NOT touch cloud (still 24h)');
if (_saved === undefined) delete process.env.ZOE_LOCAL_KEEP_ALIVE; else process.env.ZOE_LOCAL_KEEP_ALIVE = _saved;

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
