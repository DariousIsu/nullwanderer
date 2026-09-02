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

// Clip a child's stderr chunk for the tee WITHOUT losing its cause. A Python traceback puts
// the exception on its LAST line; the head-only slice (audit S27's cap) teed 295 identical
// "orchestrator cycle N failed" headers over five hours and never once the OperationalError
// that explained them. Keep the head AND the tail; the cap still bounds the tee.
function clipForLog(s, max = 600) {
  s = String(s);
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return `${s.slice(0, half)} … ${s.slice(-half)}`;
}

// The engine launch argv (HTTP transport on the shared port).
function serveArgs(host = HOST, port = PORT) {
  return ['-m', 'echo.main', 'serve', '--transport', 'http', '--host', host, '--port', String(port)];
}

// The agent-execution sidecars standalone Echo runs alongside the engine (mirrors
// ui/electron/saga-server.cjs exactly): the saga.db huey consumer, the jobs.db pass worker, and
// the LangGraph orchestrator that DISPATCHES queued agent runs (delegate_to_*). Without these,
// delegated agents sit 'queued' forever and no model is ever called. Each is gated by the same
// NX_ECHO_DISABLE_* env var Echo honors.
function sidecarDefs() {
  return [
    { name: 'huey-consumer', disableEnv: 'NX_ECHO_DISABLE_HUEY',         args: ['-m', 'huey.bin.huey_consumer', 'echo.queue.huey', '-w', '1', '-k', 'thread', '--quiet'] },
    { name: 'pass-worker',   disableEnv: 'NX_ECHO_DISABLE_PASS_WORKER',  args: ['-m', 'echo.worker', '-w', '2'] },
    { name: 'orchestrator',  disableEnv: 'NX_ECHO_DISABLE_ORCHESTRATOR', args: ['-m', 'echo.orchestrator.run', '--checkpoint-db', 'data/skuld_checkpoints.db', '--interval-s', '60'] },
  ];
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
    this.startSidecars = opts.startSidecars !== false;   // only meaningful on the owned/spawn path
    this.sidecars = opts.sidecars || sidecarDefs();
    this.sidecarProcs = {};   // name -> child (ONLY what WE spawned; never an adopted fleet)
  }

  // Adopt a running engine if present; else spawn + wait for health.
  // SINGLE-FLIGHT (08-08 fresh46): two concurrent ensure() callers both probed a not-yet-up port
  // and both spawned — the loser of the bind race exited code 1 and seeded the respawn loop below.
  async ensure({ spawnIfDown = true, bootTimeoutMs = 45000 } = {}) {
    if (this._ensuring) return this._ensuring;
    this._ensuring = this._ensureInner({ spawnIfDown, bootTimeoutMs })
      .finally(() => { this._ensuring = null; });
    return this._ensuring;
  }

  async _ensureInner({ spawnIfDown, bootTimeoutMs }) {
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
    // Explicit env (it defaulted to inheriting process.env) so the engine itself gets the same
    // model-pin stripping as its sidecars — Saga's own slot is resolved in this process.
    this.child = this.spawnFn(this.python, serveArgs(this.host, this.port), { cwd: this.cwd, env: require('./child_env').forEcho(process.env), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.owned = true; this.adopted = false;
    // capture the child's stderr (audit S27: it was stdio:'ignore', so the Python traceback that
    // explains a per-cycle crash was discarded at the source — undiagnosable from the app side).
    try { if (this.child.stderr) this.child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.onLog(`[engine:stderr] ${clipForLog(s, 600)}`); }); } catch {}
    this.child.on('exit', (code) => this._onExit(code));
    const ok = await waitHealthy({ timeoutMs: bootTimeoutMs });
    if (!ok) { this.onLog('engine: spawned but never became healthy'); return { state: 'failed', pid: this.child && this.child.pid }; }
    // WHO answered? (08-08 fresh46 zombie loop): a duplicate spawn lost the bind race and DIED,
    // but the health probe passed because the OTHER engine answered — so this logged "spawned +
    // healthy" for a dead child, and its exit re-triggered a respawn, 11+ cycles around a healthy
    // service. If our child has already exited by the time health passes, the health is someone
    // else's: ADOPT them instead of claiming the corpse. (exitCode: null while running; loose !=
    // so an injected fake child without the field still reads as alive.)
    if (this.child && this.child.exitCode != null) {
      this.adopted = true; this.owned = false;
      this.onLog(`engine: our spawn exited (code ${this.child.exitCode}) but :${this.port} is healthy — an existing engine holds the port; adopting it`);
      return { state: 'adopted', pid: null };
    }
    this.onLog(`engine: spawned + healthy (pid ${this.child.pid})`);
    if (this.startSidecars) this._startSidecars();   // owned engine → bring up the agent fleet
    return { state: 'spawned', pid: this.child.pid };
  }

  // Spawn the agent-execution sidecars (mirrors saga-server.cjs argv/env). ONLY called from the
  // owned/spawn path — an adopted external Echo already runs these via its own saga-server, so we
  // never start competing queue consumers. We supervise/kill only what we spawn.
  _startSidecars() {
    // The sidecars ARE the agent fleet, so this is where Zoe's model pins did the most damage —
    // every spawned agent ran on Zoe's single model instead of its slot's (lib/child_env.js).
    const env = { ...require('./child_env').forEcho(process.env), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    for (const def of this.sidecars) {
      if (process.env[def.disableEnv] === '1') { this.onLog(`sidecar ${def.name}: disabled via ${def.disableEnv}`); continue; }
      if (this.sidecarProcs[def.name]) continue;
      try {
        const proc = this.spawnFn(this.python, def.args, { cwd: this.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        this.sidecarProcs[def.name] = proc;
        try { if (proc.stderr) proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.onLog(`[sidecar ${def.name}:stderr] ${clipForLog(s, 600)}`); }); } catch {}   // audit S27 (+ tail kept)
        proc.on('exit', (code) => { this.onLog(`sidecar ${def.name}: exited (code ${code})`); delete this.sidecarProcs[def.name]; });
        this.onLog(`sidecar ${def.name}: spawned (pid ${proc.pid})`);
      } catch (e) { this.onLog(`sidecar ${def.name}: spawn failed — ${e.message}`); }
    }
  }

  // Tree-kill the sidecars we spawned (Windows taskkill /T /F). No-op if we never started any.
  _stopSidecars() {
    for (const [name, proc] of Object.entries(this.sidecarProcs)) {
      if (!proc || proc.killed) continue;
      const pid = proc.pid;
      if (process.platform === 'win32') {
        try { this.spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
        catch { try { proc.kill(); } catch {} }
      } else { try { proc.kill('SIGTERM'); } catch {} }
      this.onLog(`sidecar ${name}: shutdown (tree-killed pid ${pid})`);
    }
    this.sidecarProcs = {};
  }

  _onExit(code) {
    if (this._shuttingDown || !this.owned) return;
    // THE CYCLE-BREAKER (08-08 fresh46): before respawning, ask whether the port is ALREADY served.
    // If it is, our exit was a bind-race loss (or the service was taken over) — respawning here just
    // mints another loser and the loop never ends. Adopt the healthy holder and stand down.
    probeHealth().then((healthy) => {
      if (this._shuttingDown || !this.owned) return;
      if (healthy) {
        this.adopted = true; this.owned = false; this.child = null;
        this.onLog(`engine: our child exited (code ${code}) but :${this.port} is HEALTHY — an existing engine holds the port; adopting, not respawning`);
        return;
      }
      const now = Date.now();
      this._restarts = this._restarts.filter(t => now - t < 60000);
      this._restarts.push(now);
      if (this._restarts.length > 5) {
        // NOT terminal (audit S13): giving up forever left every Echo capability dead until a full
        // app restart, while the heartbeat only re-attached the suit and never re-armed the engine.
        // Cool down, clear the window, and try once more — a transient cause (env fix, port
        // collision cleared) recovers on its own; a persistent one just re-cools.
        const coolMs = 5 * 60 * 1000;
        this.onLog(`engine: >5 restarts in 60s — cooling down ${Math.round(coolMs / 60000)}min, then one more attempt`);
        setTimeout(() => { if (!this._shuttingDown && this.owned) { this._restarts = []; this._spawn(45000); } }, coolMs);
        return;
      }
      const delay = nextBackoff(this._restarts.length - 1);
      this.onLog(`engine: exited (code ${code}) — restarting in ${delay}ms (attempt ${this._restarts.length})`);
      setTimeout(() => { if (!this._shuttingDown) this._spawn(45000); }, delay);
    }).catch(() => {});
  }

  // Tree-kill ONLY what we spawned (never an adopted external engine).
  async shutdown() {
    this._shuttingDown = true;
    this._stopSidecars();   // owned-only; no-op when we never spawned a fleet (adopt path)
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
    const sidecars = Object.fromEntries(Object.entries(this.sidecarProcs).map(([n, p]) => [n, p ? p.pid : null]));
    return { owned: this.owned, adopted: this.adopted, pid: this.child ? this.child.pid : null, port: this.port, sidecars };
  }
}

module.exports = {
  EngineSupervisor,
  probeHealth,
  waitHealthy,
  // pure helpers (exported for the smoke)
  nextBackoff,
  decideAction,
  clipForLog,
  serveArgs,
  sidecarDefs,
  HEALTH_URL,
};
