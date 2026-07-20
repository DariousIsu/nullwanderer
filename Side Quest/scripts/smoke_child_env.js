/* smoke_child_env.js — Zoe must not pin Echo's agent fleet to Zoe's own model.
 *
 * Echo reads SAGA_MODEL / AGENT_MODEL_* to assign its three concurrency slots
 * (echo/saga/model_slots.py: gpt-oss:120b / kimi-k2:1t / deepseek-v3.1:671b). Zoe sets those same
 * names in .env for its own cloud fallbacks, and every Echo process Zoe spawns inherits
 * process.env — so all three slots silently collapsed onto Zoe's single mid-size model. Nothing
 * threw; the fleet just stopped being a fleet, which is precisely why it went unnoticed.
 *
 * Fully offline — forEcho is pure and the spawn sites are asserted from source.
 */
'use strict';
const childEnv = require('../lib/child_env');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const BASE = {
  SAGA_MODEL: 'gemma4:31b-cloud',
  AGENT_MODEL_SCHEDULED_BACKGROUND: 'gemma4:31b-cloud',
  AGENT_MODEL_ON_DEMAND_BACKGROUND: 'gemma4:31b-cloud',
  AGENT_MODEL_PLANNING: 'gemma4:31b-cloud',
  AGENT_MODEL_LONG_CONTEXT: 'gemma4:31b-cloud',
  ECHO_CWD: 'C:/echo', OLLAMA_API_KEY: 'secret', PATH: '/usr/bin',
};

// ── the pins do not reach the child ─────────────────────────────────────────────────────────────
{
  const out = childEnv.forEcho(BASE);
  for (const k of childEnv.MODEL_PIN_KEYS) ok(!(k in out), `${k} is not forwarded to Echo`);
  ok(childEnv.MODEL_PIN_KEYS.length === 5, 'both β.1 names AND the legacy aliases are covered');
}

// ── everything else passes through — this must not become a whitelist ───────────────────────────
{
  const out = childEnv.forEcho(BASE);
  ok(out.ECHO_CWD === 'C:/echo', 'paths pass through');
  ok(out.OLLAMA_API_KEY === 'secret', 'the cloud credential still reaches Echo (it needs it)');
  ok(out.PATH === '/usr/bin', 'PATH passes through');
}

// ── PURE: the caller's env object is never mutated ──────────────────────────────────────────────
{
  const src = { ...BASE };
  childEnv.forEcho(src);
  ok(src.SAGA_MODEL === 'gemma4:31b-cloud', 'SAFETY: the source env is untouched — Zoe keeps its own vars');
}

// ── escape hatch, for a deliberate pin ──────────────────────────────────────────────────────────
{
  const out = childEnv.forEcho({ ...BASE, ZOE_ECHO_MODEL_PASSTHROUGH: '1' });
  ok(out.SAGA_MODEL === 'gemma4:31b-cloud', 'ZOE_ECHO_MODEL_PASSTHROUGH=1 restores forwarding');
  const off = childEnv.forEcho({ ...BASE, ZOE_ECHO_MODEL_PASSTHROUGH: '0' });
  ok(!('SAGA_MODEL' in off), 'any other value keeps the strip (fails safe)');
}

// ── nothing to strip is not an error ────────────────────────────────────────────────────────────
{
  const out = childEnv.forEcho({ PATH: '/bin' });
  ok(out.PATH === '/bin' && Object.keys(out).length === 1, 'a clean env passes through unchanged');
}

// ── WIRING: every Echo spawn site actually uses it ──────────────────────────────────────────────
// Three separate spawns reach Echo (stdio MCP, the engine, the agent sidecars) and the fleet only
// stays intact if ALL of them strip. The engine's own spawn passed no `env` at all, so it inherited
// implicitly — the case a reviewer is most likely to miss.
{
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
  const echo = read('echo.js'), engine = read('engine.js');
  ok(/env: require\('\.\/child_env'\)\.forEcho\(env \|\| process\.env\)/.test(echo),
    'echo.js stdio transport strips the pins');
  ok((engine.match(/child_env'\)\.forEcho\(process\.env\)/g) || []).length === 2,
    'engine.js strips on BOTH the engine spawn and the sidecar spawn');
  ok(!/serveArgs\(this\.host, this\.port\), \{ cwd: this\.cwd, stdio:/.test(engine),
    'REGRESSION: the engine spawn no longer inherits process.env implicitly');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
