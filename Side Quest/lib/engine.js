/**
 * engine — Zoe's supervisor for the absorbed Echo Python engine.
 *
 * Phase 1 of the absorption (ZOE_HOST_ARCHITECTURE.md, locked 2026-06-23): Zoe's
 * app becomes the SOLE launcher/owner of the engine (`python -m echo.main serve
 * --transport http`). Until standalone Echo retires it runs in parallel, so this
 * is TRANSITION-SAFE by design:
 *
 *   ADOPT-OR-SPAWN — probe :8765/health first. If a healthy engine is already up
 *   (the standalone Echo app, or a prior Zoe spawn), ADOPT it: use it, never spawn
 *   a competitor on the same port. Only SPAWN when the port is dead. We only
 *   supervise/restart/kill what WE spawned — an adopted external engine is left alone.
 *
 * Core is plain Node (lifts cleanly per the study). Pure helpers (backoff,
 * adopt/spawn decision, serve args) are split out for offline smoke.
 */
const { spawn } = require('child_process');

const HOST = process.env.ECHO_HOST || '127.0.0.1';
const PORT = parseInt(process.env.ECHO_PORT || '8765', 10);
const ECHO_PYTHON = process.env.ECHO_PYTHON || 'python';
const ECHO_CWD = process.env.ECHO_CWD || null;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;

// ---- pure helpers (offline-tested) --------------------------------------

// Exponential backoff with cap (mirrors Echo's restart supervisor).
function nextBackoff(attempt, { base = 1000, cap = 60000 } = {}) {
  return Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
}

// What to do given a health probe result.
//   healthy            -> 'adopt' (something's already serving; never double-spawn)
//   !healthy + allowed -> 'spawn'
//   !healthy + !allowed-> 'down'
function decideAction(healthy, { spawnIfDown = true } = {}) {
  if (healthy) return 'adopt';
  return spawnIfDown ? 'spawn' : 'down';
}

// The engine launch argv (HTTP transport on the shared port).
function serveArgs(host = HOST, port = PORT) {
  return ['-m', 'echo.main', 'serve', '--transport', 'http', '--host', host, '--port', String(port)];
}

// ---- I/O ----------------------------------------------------------------

async function probeHealth(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy({ timeoutMs = 45000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

class EngineSupervisor {
  constructor(opts = {}) {
    this.host = opts.host || HOST;
    this.port = opts.port || PORT;
    this.python = opts.python || ECHO_PYTHON;
    this.cwd = opts.cwd || ECHO_CWD;
    this.spawnFn = opts.spawnFn || spawn;       // injectable for tests
    this.onLog = opts.onLog || (() => {});
    this.child = null;
    this.owned = false;       // true only if WE spawned the engine
    this.adopted = false;     // true if we're using a pre-existing external engine
    this._shuttingDown = false;
    this._restarts = [];      // timestamps, for the 5-in-60s window
  }

  // Adopt a running engine if present; else spawn + wait for health.
  async ensure({ spawnIfDown = true, bootTimeoutMs = 45000 } = {}) {
    const healthy = await probeHealth();
    const action = decideAction(healthy, { spawnIfDown });
    if (action === 'adopt') {
      this.adopted = true; this.owned = false;
      this.onLog(`engine: adopted existing on :${this.port} (not spawning)`);
      return { state: 'adopted', pid: null };
    }
    if (action === 'down') {
      this.onLog(`engine: down on :${this.port}, spawn disabled`);
      return { state: 'down', pid: null };
    }
    return this._spawn(bootTimeoutMs);
  }

  async _spawn(bootTimeoutMs) {
    if (!this.cwd) { this.onLog('engine: ECHO_CWD unset — cannot spawn'); return { state: 'failed', error: 'ECHO_CWD unset' }; }
    this.onLog(`engine: spawning ${this.python} ${serveArgs(this.host, this.port).join(' ')} (cwd ${this.cwd})`);
    this.child = this.spawnFn(this.python, serveArgs(this.host, this.port), { cwd: this.cwd, stdio: 'ignore', windowsHide: true });
    this.owned = true; this.adopted = false;
    this.child.on('exit', (code) => this._onExit(code));
    const ok = await waitHealthy({ timeoutMs: bootTimeoutMs });
    if (!ok) { this.onLog('engine: spawned but never became healthy'); return { state: 'failed', pid: this.child && this.child.pid }; }
    this.onLog(`engine: spawned + healthy (pid ${this.child.pid})`);
    return { state: 'spawned', pid: this.child.pid };
  }

  _onExit(code) {
    if (this._shuttingDown || !this.owned) return;
    const now = Date.now();
    this._restarts = this._restarts.filter(t => now - t < 60000);
    this._restarts.push(now);
    if (this._restarts.length > 5) { this.onLog('engine: >5 restarts in 60s — giving up (backoff window tripped)'); return; }
    const delay = nextBackoff(this._restarts.length - 1);
    this.onLog(`engine: exited (code ${code}) — restarting in ${delay}ms (attempt ${this._restarts.length})`);
    setTimeout(() => { if (!this._shuttingDown) this._spawn(45000); }, delay);
  }

  // Tree-kill ONLY what we spawned (never an adopted external engine).
  async shutdown() {
    this._shuttingDown = true;
    if (!this.owned || !this.child || this.child.killed) return;
    const pid = this.child.pid;
    if (process.platform === 'win32') {
      try { this.spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch { try { this.child.kill(); } catch {} }
    } else {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.onLog(`engine: shutdown (tree-killed pid ${pid})`);
  }

  status() {
    return { owned: this.owned, adopted: this.adopted, pid: this.child ? this.child.pid : null, port: this.port };
  }
}

module.exports = {
  EngineSupervisor,
  probeHealth,
  waitHealthy,
  // pure helpers (exported for the smoke)
  nextBackoff,
  decideAction,
  serveArgs,
  HEALTH_URL,
};
