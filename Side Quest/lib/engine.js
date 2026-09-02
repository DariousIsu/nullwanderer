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
 * UNIFICATION stages 1 + 2 (2026-09-02, his order):
 *
 *   ONE CONFIG AUTHORITY — Echo describes its own fleet. Before spawning, the
 *   supervisor runs `python -m echo.main manifest` and takes the serve argv, the
 *   sidecar argv (paths already resolved from config.toml) and the config WARNINGS
 *   from it. The hardcoded fleet below survives only as the LAST-RESORT fallback and
 *   says so loudly when used — it "mirrored ui/electron/saga-server.cjs", a file that
 *   no longer exists, and never knew paths.rainey_db (the orchestrator opened the
 *   carve's tombstone directory every minute for months).
 *
 *   ONE LIFECYCLE CONTRACT — sidecar stdout (one JSON event per line) is READ, not
 *   discarded: each event lands in the tee under the organ's own prefix
 *   ([orchestrator] cycle 3 done …), failures at error level so self_watch mints. A
 *   sidecar that exits is RESTARTED with the same backoff/cooldown law as the engine
 *   (it used to be deleted from the map and forgotten); one that declares a heartbeat
 *   and goes silent is NAMED. /health's `ready` is honored when the engine reports it.
 *
 * Core is plain Node (lifts cleanly per the study). Pure helpers (backoff,
 * adopt/spawn decision, serve args, manifest validation, event rendering) are split
 * out for offline smoke.
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

// The LAST-RESORT fleet definition (stage 1): used only when Echo's own manifest can't be read,
// and announced as stale authority when it is. Echo's `echo/launch.py` is the truth — keep this
// list in step with it, never the other way round. Each is gated by the same NX_ECHO_DISABLE_*
// env var Echo honors; heartbeatS = how often a healthy instance speaks on stdout (null = quiet
// by design, liveness is the process alone).
function sidecarDefs() {
  return [
    { name: 'huey-consumer', disableEnv: 'NX_ECHO_DISABLE_HUEY',         args: ['-m', 'huey.bin.huey_consumer', 'echo.queue.huey', '-w', '4', '-k', 'thread', '--quiet'], heartbeatS: null },
    { name: 'pass-worker',   disableEnv: 'NX_ECHO_DISABLE_PASS_WORKER',  args: ['-m', 'echo.worker', '-w', '4'], heartbeatS: null },
    { name: 'orchestrator',  disableEnv: 'NX_ECHO_DISABLE_ORCHESTRATOR', args: ['-m', 'echo.orchestrator.run', '--checkpoint-db', 'data/skuld_checkpoints.db', '--interval-s', '60'], heartbeatS: 60 },
  ];
}

// `python -m echo.main manifest` — Echo's self-description (echo/launch.py).
function manifestArgs() { return ['-m', 'echo.main', 'manifest']; }

// Shape-check Echo's manifest and normalize it to the supervisor's own def shape. Pure; throws
// on anything the supervisor can't act on (a wrong version, no sidecars, a sidecar with no argv)
// so a half-broken manifest never silently starts half a fleet.
function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  if (m.manifest_version !== 1) throw new Error(`manifest_version ${m.manifest_version} unsupported (this supervisor speaks 1)`);
  if (!Array.isArray(m.sidecars) || !m.sidecars.length) throw new Error('manifest declares no sidecars');
  const sidecars = m.sidecars.map((s) => {
    if (!s || typeof s.name !== 'string' || !s.name || !Array.isArray(s.args) || !s.args.length) throw new Error(`manifest sidecar malformed: ${JSON.stringify(s).slice(0, 120)}`);
    return { name: s.name, disableEnv: s.disable_env || null, args: s.args.map(String), heartbeatS: Number.isFinite(s.heartbeat_s) ? s.heartbeat_s : null };
  });
  const serve = (m.serve && typeof m.serve === 'object') ? m.serve : {};
  return {
    version: 1,
    source: 'echo',
    config: m.config || null,
    sidecars,
    serve: { host: serve.host || null, port: Number.isFinite(serve.port) ? serve.port : null, args: Array.isArray(serve.args) && serve.args.length ? serve.args.map(String) : null },
    paths: (m.paths && typeof m.paths === 'object') ? m.paths : {},
    warnings: Array.isArray(m.warnings) ? m.warnings.map(String) : [],
  };
}

// Render one sidecar stdout event (the orchestrator's one-JSON-per-line protocol) as a tee line.
// Returns { text, level } — level 'error' for the events self_watch must see as failures.
function describeEvent(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const kind = String(e.event || '');
  switch (kind) {
    case 'start': return { level: 'log', text: `started (rainey_db ${e.rainey_db || '?'} · interval ${e.interval_s || '?'}s · classes ${Array.isArray(e.classes) ? e.classes.join(',') : '?'}${e.dry_run ? ' · DRY RUN' : ''})` };
    case 'cycle_done': return { level: 'log', text: `cycle ${e.cycle} done: ${e.dispatched || 0} dispatched, ${e.skipped || 0} skipped, ${e.finish_reason || 'completed'} (${e.elapsed_s != null ? e.elapsed_s : '?'}s)` };
    case 'cycle_failed': return { level: 'error', text: `cycle ${e.cycle} FAILED: ${e.error || 'unknown error'}` };
    case 'config_error': return { level: 'error', text: `CONFIG ERROR: ${e.error || 'unknown'}${e.rainey_db ? ` (rainey_db ${e.rainey_db})` : ''} — refusing to loop` };
    case 'resume_drained': return { level: 'log', text: `resume signals drained: ${e.count} (cycle ${e.cycle})` };
    case 'resume_drain_error': return { level: 'error', text: `resume-signal drain FAILED at cycle ${e.cycle}: ${e.error || 'unknown'}` };
    case 'checkpoints_pruned': return { level: 'log', text: `checkpoints pruned: ${e.deleted} (cycle ${e.cycle})` };
    case 'exit': return { level: 'log', text: `exited after ${e.cycles_completed != null ? e.cycles_completed : '?'} cycle(s)` };
    default: {
      const rest = { ...e }; delete rest.event;
      const body = JSON.stringify(rest); const isErr = /error|fail/i.test(kind);
      return { level: isErr ? 'error' : 'log', text: `${kind || 'event'} ${body.length > 200 ? body.slice(0, 200) + '…' : body}` };
    }
  }
}

// ---- I/O ----------------------------------------------------------------

let _lastHealth = null;   // the last /health body the probe saw (pid, ready, tools) — for status()

async function probeHealth(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    if (!res.ok) return false;
    // Stage 2: an engine that reports `ready:false` is listening but not serving yet — not healthy.
    // Older engines (no field) and non-JSON bodies keep the old ok-is-healthy contract.
    try { const j = typeof res.json === 'function' ? await res.json() : null; if (j && typeof j === 'object') { _lastHealth = j; if (j.ready === false) return false; } } catch {}
    return true;
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

// Read Echo's manifest: `python -m echo.main manifest` (async — never blocks the main thread at boot).
function readManifest({ python = ECHO_PYTHON, cwd = ECHO_CWD, timeoutMs = 20000, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!cwd) return reject(new Error('ECHO_CWD unset'));
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(tm); fn(v); };
    let proc;
    try { proc = spawnFn(python, manifestArgs(), { cwd, env: require('./child_env').forEcho(process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return reject(e); }
    const tm = setTimeout(() => { try { proc.kill(); } catch {} finish(reject, new Error(`manifest timed out after ${timeoutMs}ms`)); }, timeoutMs);
    try { if (proc.stdout) proc.stdout.on('data', (d) => { out += String(d); }); } catch {}
    try { if (proc.stderr) proc.stderr.on('data', (d) => { err += String(d); }); } catch {}
    proc.on('error', (e) => finish(reject, e));
    proc.on('exit', (code) => {
      if (code !== 0) return finish(reject, new Error(`manifest exit ${code}: ${clipForLog(err.trim(), 300)}`));
      try { finish(resolve, validateManifest(JSON.parse(out))); } catch (e) { finish(reject, new Error(`manifest unreadable: ${e.message}`)); }
    });
  });
}

const SIDECAR_SILENCE_FACTOR = 5;   // a heartbeat organ is "silent" after 5 missed beats
// Boot budget. The engine's boot is dominated by the external MCP mounts ([[mcp_connections]]: the
// BlenderMCP mount retries a dead socket three times before giving up, ~43s on 09-02) — the old 45s
// cap missed a healthy engine by ONE second on boot_p246 and stranded the whole fleet. 90s is the
// cap; and a child that outlives the cap ALIVE is watched for a late boot (below), never abandoned.
const BOOT_TIMEOUT_MS = 90000;
const LATE_BOOT_POLL_MS = 5000;
const LATE_BOOT_CEILING_MS = 5 * 60 * 1000;

class EngineSupervisor {
  constructor(opts = {}) {
    this.host = opts.host || HOST;
    this.port = opts.port || PORT;
    this.python = opts.python || ECHO_PYTHON;
    this.cwd = opts.cwd || ECHO_CWD;
    this.spawnFn = opts.spawnFn || spawn;       // injectable for tests
    this.onLog = opts.onLog || (() => {});
    this.onError = opts.onError || this.onLog;  // error-level lines (self_watch-mintable in main)
    // Organ lines: (name, text, level) — the tee gets `[orchestrator] cycle 3 done …` under the
    // organ's OWN prefix so self_watch can lane it; default folds into onLog/onError.
    this.onOrgan = opts.onOrgan || ((name, text, level) => (level === 'error' ? this.onError : this.onLog)(`[${name}] ${text}`));
    this.child = null;
    this.owned = false;       // true only if WE spawned the engine
    this.adopted = false;     // true if we're using a pre-existing external engine
    this._shuttingDown = false;
    this._restarts = [];      // timestamps, for the 5-in-60s window
    this.startSidecars = opts.startSidecars !== false;   // only meaningful on the owned/spawn path
    // Stage 1: the fleet comes from Echo's manifest (loaded before the spawn). An explicit
    // opts.sidecars wins (tests); the built-in list is the announced last resort.
    this._explicitSidecars = opts.sidecars || null;
    this.sidecars = opts.sidecars || null;
    // Default: read Echo's manifest with the REAL spawn. An injected spawnFn (a test double) with no
    // manifestFn can't answer a manifest read — its fake child never exits — so that combination
    // resolves to the built-in fleet at once instead of hanging on a 20s timeout.
    this.manifestFn = opts.manifestFn || (opts.spawnFn
      ? (() => Promise.reject(new Error('no manifestFn injected beside the injected spawnFn')))
      : (() => readManifest({ python: this.python, cwd: this.cwd })));
    this.manifest = null;     // { source: 'echo'|'builtin', warnings, config, error? }
    this.sidecarProcs = {};   // name -> child (ONLY what WE spawned; never an adopted fleet)
    this._sidecarState = {};  // name -> { restarts: [ts], exits, lastEventTs, silent, starts }
    this._staleIv = null;
    // late-boot watch knobs (injectable for the smoke)
    this._healthIntervalMs = opts.healthIntervalMs || 1500;
    this._latePollMs = opts.latePollMs || LATE_BOOT_POLL_MS;
    this._lateCeilingMs = opts.lateCeilingMs || LATE_BOOT_CEILING_MS;
    this._lateIv = null;
  }

  // Adopt a running engine if present; else spawn + wait for health.
  // SINGLE-FLIGHT (08-08 fresh46): two concurrent ensure() callers both probed a not-yet-up port
  // and both spawned — the loser of the bind race exited code 1 and seeded the respawn loop below.
  async ensure({ spawnIfDown = true, bootTimeoutMs = BOOT_TIMEOUT_MS } = {}) {
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

  // Stage 1: ask Echo how it launches. Sets this.manifest + this.sidecars. Never throws — a
  // failure falls back to the built-in fleet and SAYS SO at error level (stale authority).
  async _loadManifest() {
    try {
      const m = await this.manifestFn();
      const v = (m && m.source === 'echo' && Array.isArray(m.sidecars)) ? m : validateManifest(m);
      this.manifest = v;
      if (!this._explicitSidecars) this.sidecars = v.sidecars;
      for (const w of v.warnings) this.onError(`engine: manifest WARNING — ${w}`);
      if (v.serve.port && v.serve.port !== this.port) this.onError(`engine: manifest says port ${v.serve.port} but the supervisor is configured for ${this.port} — two readers of config.toml disagree; using ${this.port}`);
      this.onLog(`engine: manifest from Echo — ${v.sidecars.length} sidecar(s), ${v.warnings.length} warning(s)${v.config ? ` (${v.config})` : ''}`);
      return true;
    } catch (e) {
      this.manifest = { source: 'builtin', error: (e && e.message) || String(e), warnings: [], config: null };
      if (!this._explicitSidecars) this.sidecars = sidecarDefs();
      this.onError(`engine: manifest unavailable (${this.manifest.error}) — using the BUILT-IN fleet definition, a stale authority; Echo's config.toml is the truth`);
      return false;
    }
  }

  _serveArgs() {
    const m = this.manifest;
    if (m && m.source === 'echo' && m.serve && m.serve.args && (!m.serve.port || m.serve.port === this.port)) return m.serve.args;
    return serveArgs(this.host, this.port);
  }

  async _spawn(bootTimeoutMs) {
    if (!this.cwd) { this.onLog('engine: ECHO_CWD unset — cannot spawn'); return { state: 'failed', error: 'ECHO_CWD unset' }; }
    await this._loadManifest();
    const args = this._serveArgs();
    this.onLog(`engine: spawning ${this.python} ${args.join(' ')} (cwd ${this.cwd})`);
    // Explicit env (it defaulted to inheriting process.env) so the engine itself gets the same
    // model-pin stripping as its sidecars — Saga's own slot is resolved in this process.
    this.child = this.spawnFn(this.python, args, { cwd: this.cwd, env: require('./child_env').forEcho(process.env), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.owned = true; this.adopted = false;
    // capture the child's stderr (audit S27: it was stdio:'ignore', so the Python traceback that
    // explains a per-cycle crash was discarded at the source — undiagnosable from the app side).
    try { if (this.child.stderr) this.child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.onLog(`[engine:stderr] ${clipForLog(s, 600)}`); }); } catch {}
    this.child.on('exit', (code) => this._onExit(code));
    const ok = await waitHealthy({ timeoutMs: bootTimeoutMs, intervalMs: this._healthIntervalMs });
    if (!ok) {
      // THE LATE BOOT (boot_p246, 09-02): the engine turned healthy one second after the cap and the
      // supervisor had already given up — no sidecars, no orchestrator, a fleet of nothing beside a
      // healthy engine. A child that is still ALIVE past the cap is a slow boot, not a dead one: keep
      // polling; when it answers, start the fleet as if it had been on time. A child that DIED is the
      // real failure (and _onExit already owns the respawn law).
      const alive = this.child && this.child.exitCode == null;
      this.onError(`engine: not healthy after ${Math.round(bootTimeoutMs / 1000)}s — child ${alive ? `ALIVE (pid ${this.child.pid}); watching for a late boot up to ${Math.round(this._lateCeilingMs / 60000)}min` : 'exited'}`);
      if (alive) this._watchLateBoot(bootTimeoutMs);
      return { state: 'failed', pid: this.child && this.child.pid, lateWatch: !!alive };
    }
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

  // Poll a slow child until it answers (then bring up the fleet) or the ceiling passes (then say so).
  _watchLateBoot(alreadyWaitedMs = 0) {
    if (this._lateIv) return;
    const startedAt = Date.now();
    const child = this.child;
    this._lateIv = setInterval(async () => {
      if (this._shuttingDown || this.child !== child || !this.owned) { this._clearLateWatch(); return; }
      if (child.exitCode != null) { this._clearLateWatch(); return; }   // it died — _onExit owns that
      if (await probeHealth()) {
        this._clearLateWatch();
        this.onLog(`engine: LATE-healthy (pid ${child.pid}) after ${Math.round((alreadyWaitedMs + Date.now() - startedAt) / 1000)}s — bringing up the fleet now`);
        if (this.startSidecars) this._startSidecars();
        return;
      }
      if (Date.now() - startedAt > this._lateCeilingMs) {
        this._clearLateWatch();
        this.onError(`engine: still not healthy ${Math.round((alreadyWaitedMs + this._lateCeilingMs) / 60000)}min after spawn (pid ${child.pid} alive) — giving up the late watch; the heartbeat keeps attaching`);
      }
    }, this._latePollMs);
    this._lateIv.unref?.();
  }

  _clearLateWatch() { if (this._lateIv) { clearInterval(this._lateIv); this._lateIv = null; } }

  _stateFor(name) {
    if (!this._sidecarState[name]) this._sidecarState[name] = { restarts: [], exits: 0, starts: 0, lastEventTs: 0, silent: false };
    return this._sidecarState[name];
  }

  // Spawn the agent-execution sidecars (Echo's manifest, else the announced built-in list). ONLY
  // called from the owned/spawn path — an adopted external Echo already runs these via its own
  // saga-server, so we never start competing queue consumers. We supervise/kill only what we spawn.
  _startSidecars() {
    if (!this.sidecars) this.sidecars = this._explicitSidecars || sidecarDefs();
    for (const def of this.sidecars) {
      if (def.disableEnv && process.env[def.disableEnv] === '1') { this.onLog(`sidecar ${def.name}: disabled via ${def.disableEnv}`); continue; }
      if (this.sidecarProcs[def.name]) continue;
      this._spawnSidecar(def);
    }
    if (!this._staleIv) { this._staleIv = setInterval(() => this._checkSilence(), 60 * 1000); this._staleIv.unref?.(); }
  }

  _spawnSidecar(def) {
    // The sidecars ARE the agent fleet, so this is where Zoe's model pins did the most damage —
    // every spawned agent ran on Zoe's single model instead of its slot's (lib/child_env.js).
    const env = { ...require('./child_env').forEcho(process.env), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    const st = this._stateFor(def.name);
    try {
      // Stage 2: stdout is PIPED and read — one JSON event per line is the sidecar contract.
      const proc = this.spawnFn(this.python, def.args, { cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.sidecarProcs[def.name] = proc;
      st.starts++; st.lastEventTs = Date.now(); st.silent = false;
      let buf = '';
      try { if (proc.stdout) proc.stdout.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); this._onSidecarLine(def, line); } }); } catch {}
      try { if (proc.stderr) proc.stderr.on('data', (d) => { const s = String(d).trim(); st.lastEventTs = Date.now(); if (s) this.onLog(`[sidecar ${def.name}:stderr] ${clipForLog(s, 600)}`); }); } catch {}   // audit S27 (+ tail kept)
      proc.on('exit', (code) => this._onSidecarExit(def, code));
      this.onLog(`sidecar ${def.name}: spawned (pid ${proc.pid})${st.starts > 1 ? ` (start #${st.starts})` : ''}`);
    } catch (e) { this.onError(`sidecar ${def.name}: spawn failed — ${e.message}`); }
  }

  // One stdout line from a sidecar: a JSON event renders under the organ's own prefix; anything
  // else is teed raw (clipped). Every line is a heartbeat.
  _onSidecarLine(def, line) {
    const s = String(line).trim();
    if (!s) return;
    const st = this._stateFor(def.name);
    st.lastEventTs = Date.now();
    if (st.silent) { st.silent = false; this.onLog(`sidecar ${def.name}: speaking again`); }
    let ev = null;
    if (s[0] === '{') { try { ev = JSON.parse(s); } catch { ev = null; } }
    if (ev && typeof ev === 'object' && ev.event) { const d = describeEvent(ev); this.onOrgan(def.name, d.text, d.level); }
    else this.onOrgan(def.name, clipForLog(s, 400), 'log');
  }

  // A sidecar died. Announce at error level (self_watch-mintable), then RESTART under the same
  // law as the engine: backoff per attempt, >5 in 60s → 5-min cooldown then one more try. Never
  // during shutdown, never for a fleet we don't own.
  _onSidecarExit(def, code) {
    delete this.sidecarProcs[def.name];
    const st = this._stateFor(def.name);
    st.exits++;
    if (this._shuttingDown || !this.owned) { this.onLog(`sidecar ${def.name}: exited (code ${code})`); return; }
    const now = Date.now();
    st.restarts = st.restarts.filter((t) => now - t < 60000);
    st.restarts.push(now);
    if (st.restarts.length > 5) {
      const coolMs = 5 * 60 * 1000;
      this.onError(`sidecar ${def.name}: exited (code ${code}) — >5 restarts in 60s, cooling down ${Math.round(coolMs / 60000)}min, then one more attempt`);
      setTimeout(() => { if (!this._shuttingDown && this.owned && !this.sidecarProcs[def.name]) { st.restarts = []; this._spawnSidecar(def); } }, coolMs).unref?.();
      return;
    }
    const delay = nextBackoff(st.restarts.length - 1);
    this.onError(`sidecar ${def.name}: exited (code ${code}) — restarting in ${delay}ms (attempt ${st.restarts.length})`);
    setTimeout(() => { if (!this._shuttingDown && this.owned && !this.sidecarProcs[def.name]) this._spawnSidecar(def); }, delay).unref?.();
  }

  // A heartbeat organ (the orchestrator speaks every cycle) that has missed SIDECAR_SILENCE_FACTOR
  // beats while its process is still alive is NAMED once per silence — not killed: a long
  // dispatch is a legitimate reason to be quiet, and the operator/self_watch decide what it means.
  _checkSilence(nowMs = Date.now()) {
    for (const def of this.sidecars || []) {
      if (!def.heartbeatS || !this.sidecarProcs[def.name]) continue;
      const st = this._stateFor(def.name);
      const ageMs = nowMs - (st.lastEventTs || 0);
      if (!st.silent && st.lastEventTs && ageMs > def.heartbeatS * 1000 * SIDECAR_SILENCE_FACTOR) {
        st.silent = true;
        this.onError(`sidecar ${def.name}: SILENT for ${Math.round(ageMs / 60000)}min (expected a heartbeat every ${def.heartbeatS}s; process pid ${this.sidecarProcs[def.name].pid} still alive)`);
      }
    }
  }

  // Tree-kill the sidecars we spawned (Windows taskkill /T /F). No-op if we never started any.
  _stopSidecars() {
    if (this._staleIv) { clearInterval(this._staleIv); this._staleIv = null; }
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
        setTimeout(() => { if (!this._shuttingDown && this.owned) { this._restarts = []; this._spawn(BOOT_TIMEOUT_MS); } }, coolMs);
        return;
      }
      const delay = nextBackoff(this._restarts.length - 1);
      this.onLog(`engine: exited (code ${code}) — restarting in ${delay}ms (attempt ${this._restarts.length})`);
      setTimeout(() => { if (!this._shuttingDown) this._spawn(BOOT_TIMEOUT_MS); }, delay);
    }).catch(() => {});
  }

  // Tree-kill ONLY what we spawned (never an adopted external engine).
  async shutdown() {
    this._shuttingDown = true;
    this._clearLateWatch();
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

  status(nowMs = Date.now()) {
    const sidecars = Object.fromEntries(Object.entries(this.sidecarProcs).map(([n, p]) => [n, p ? p.pid : null]));
    // Stage 2: per-organ liveness for the status vector — pid, last-event age, restarts, silence.
    const organs = {};
    for (const def of this.sidecars || []) {
      const st = this._sidecarState[def.name];
      const proc = this.sidecarProcs[def.name];
      organs[def.name] = { pid: proc ? proc.pid : null, alive: !!proc, lastEventAgoMs: st && st.lastEventTs ? nowMs - st.lastEventTs : null, exits: st ? st.exits : 0, silent: !!(st && st.silent), heartbeatS: def.heartbeatS || null };
    }
    const m = this.manifest;
    return {
      owned: this.owned, adopted: this.adopted, pid: this.child ? this.child.pid : null, port: this.port, sidecars, organs,
      manifest: m ? { source: m.source, warnings: (m.warnings || []).length, config: m.config || null, error: m.error || null } : null,
      health: _lastHealth,
    };
  }
}

module.exports = {
  EngineSupervisor,
  probeHealth,
  waitHealthy,
  readManifest,
  // pure helpers (exported for the smoke)
  nextBackoff,
  decideAction,
  clipForLog,
  serveArgs,
  sidecarDefs,
  manifestArgs,
  validateManifest,
  describeEvent,
  SIDECAR_SILENCE_FACTOR,
  BOOT_TIMEOUT_MS,
  HEALTH_URL,
};
