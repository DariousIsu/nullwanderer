/**
 * Offline smoke for lib/engine.js — the absorbed-engine supervisor's pure logic
 * + the adopt/spawn decision via an injected fake spawn (no real process / no Echo).
 *
 * Run: node scripts/smoke_engine.js
 */
const E = require('../lib/engine');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- nextBackoff (exponential, capped) ---
ok('backoff attempt 0 = base', E.nextBackoff(0) === 1000);
ok('backoff attempt 1 = 2x', E.nextBackoff(1) === 2000);
ok('backoff attempt 3 = 8x', E.nextBackoff(3) === 8000);
ok('backoff caps at 60s', E.nextBackoff(20) === 60000);
ok('backoff clamps negative', E.nextBackoff(-5) === 1000);

// --- decideAction (adopt-or-spawn) ---
ok('healthy → adopt (never double-spawn)', E.decideAction(true) === 'adopt');
ok('down + allowed → spawn', E.decideAction(false, { spawnIfDown: true }) === 'spawn');
ok('down + disallowed → down', E.decideAction(false, { spawnIfDown: false }) === 'down');
ok('healthy wins even if spawn disabled', E.decideAction(true, { spawnIfDown: false }) === 'adopt');

// --- serveArgs ---
const args = E.serveArgs('127.0.0.1', 8765);
ok('serveArgs targets echo.main serve http', args.join(' ') === '-m echo.main serve --transport http --host 127.0.0.1 --port 8765', args.join(' '));

// --- clipForLog (audit S27 follow-up): a clipped traceback keeps its LAST line — the cause ---
// The live shape: 295 teed "orchestrator cycle N failed" headers, never the OperationalError
// on the traceback's final line, because the head-only slice cut it every time.
const tb = 'Traceback (most recent call last):\n' + '  File "graph.py", line 129, in observe_state\n'.repeat(30) + 'sqlite3.OperationalError: unable to open database file';
const clipped = E.clipForLog(tb, 600);
ok('clipForLog bounds the chunk to the cap', tb.length > 600 && clipped.length <= 600, `len=${clipped.length}`);
ok('clipForLog keeps the head', clipped.startsWith('Traceback (most recent call last):'));
ok('clipForLog keeps the TAIL (the exception line)', clipped.endsWith('sqlite3.OperationalError: unable to open database file'));
ok('clipForLog passes a short chunk through untouched', E.clipForLog('short line', 600) === 'short line');

// --- ADOPT path: a fake-healthy engine must NOT spawn ---
(async () => {
  // monkeypatch probeHealth by overriding global fetch to a healthy response
  const realFetch = global.fetch;
  let spawnCalls = 0;
  const fakeSpawn = () => { spawnCalls++; return { pid: 999, on() {}, kill() {}, killed: false }; };

  global.fetch = async () => ({ ok: true });   // engine "up"
  let sup = new E.EngineSupervisor({ cwd: 'x', spawnFn: fakeSpawn });
  let r = await sup.ensure();
  ok('ADOPT when healthy: state=adopted', r.state === 'adopted', r.state);
  ok('ADOPT when healthy: did NOT spawn', spawnCalls === 0, `spawnCalls=${spawnCalls}`);
  ok('ADOPT: owned=false, adopted=true', sup.status().owned === false && sup.status().adopted === true);
  // shutdown must NOT kill an adopted external engine
  await sup.shutdown();
  ok('ADOPT: shutdown leaves external alone (no kill spawn)', spawnCalls === 0);

  // --- SPAWN path: dead engine + spawnIfDown=false → "down", no spawn ---
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };  // engine "down"
  sup = new E.EngineSupervisor({ cwd: 'x', spawnFn: fakeSpawn });
  r = await sup.ensure({ spawnIfDown: false });
  ok('DOWN + spawn disabled: state=down, no spawn', r.state === 'down' && spawnCalls === 0, `${r.state}/${spawnCalls}`);

  // --- sidecar fleet (agent-execution workers) ---
  ok('sidecarDefs = huey + pass-worker + orchestrator', (() => {
    const d = E.sidecarDefs();
    return d.length === 3
      && d.find(x => x.name === 'huey-consumer').args.join(' ').includes('huey.bin.huey_consumer')
      && d.find(x => x.name === 'pass-worker').args.join(' ').includes('echo.worker')
      && d.find(x => x.name === 'orchestrator').args.join(' ').includes('echo.orchestrator.run');
  })());

  let sideCalls = 0;
  const sideSpawn = () => { sideCalls++; return { pid: 1000 + sideCalls, on() {}, kill() {}, killed: false }; };

  const s2 = new E.EngineSupervisor({ cwd: 'x', spawnFn: sideSpawn });
  s2._startSidecars();
  ok('owned _startSidecars spawns all 3', Object.keys(s2.status().sidecars).length === 3 && sideCalls === 3, `calls=${sideCalls}`);

  process.env.NX_ECHO_DISABLE_PASS_WORKER = '1';
  const s3 = new E.EngineSupervisor({ cwd: 'x', spawnFn: sideSpawn });
  const before = sideCalls;
  s3._startSidecars();
  ok('NX_ECHO_DISABLE_PASS_WORKER skips that sidecar (2 of 3)', (sideCalls - before) === 2 && !s3.status().sidecars['pass-worker']);
  delete process.env.NX_ECHO_DISABLE_PASS_WORKER;

  await s2.shutdown();
  ok('shutdown clears spawned sidecars', Object.keys(s2.status().sidecars).length === 0);

  // adopt path must NOT start a competing fleet
  global.fetch = async () => ({ ok: true });
  const s4 = new E.EngineSupervisor({ cwd: 'x', spawnFn: sideSpawn });
  await s4.ensure();
  ok('ADOPT path starts NO sidecars', s4.status().adopted === true && Object.keys(s4.status().sidecars).length === 0);

  // ── THE ZOMBIE-RESPAWN LOOP (08-08 fresh46: 11+ duplicate spawns around a healthy engine) ──────

  // (a) child exits while the port is HEALTHY → adopt the holder, do NOT respawn
  let zSpawns = 0, zExit = null;
  const zSpawn = () => { zSpawns++; return { pid: 500 + zSpawns, on(ev, fn) { if (ev === 'exit') zExit = fn; }, kill() {}, killed: false }; };
  global.fetch = async () => { throw new Error('down'); };            // port down → spawn path
  const z1 = new E.EngineSupervisor({ cwd: 'x', spawnFn: zSpawn, startSidecars: false });
  const zr = await z1.ensure({ bootTimeoutMs: 10 });                  // spawns, never healthy → 'failed'
  ok('setup: spawn attempted while down', zSpawns === 1 && zr.state === 'failed');
  global.fetch = async () => ({ ok: true });                          // NOW someone serves the port
  zExit(1);                                                           // our child dies (bind-race loss)
  await new Promise(r => setTimeout(r, 30));                          // let the async probe settle
  ok('exit + port healthy → ADOPT, no respawn', z1.status().adopted === true && z1.status().owned === false && zSpawns === 1, `spawns=${zSpawns}`);

  // (b) child exits while the port is DOWN → the respawn path still works (backoff ~1s)
  let dSpawns = 0, dExit = null;
  const dSpawn = () => { dSpawns++; return { pid: 600 + dSpawns, on(ev, fn) { if (ev === 'exit') dExit = fn; }, kill() {}, killed: false }; };
  global.fetch = async () => { throw new Error('down'); };
  const z2 = new E.EngineSupervisor({ cwd: 'x', spawnFn: dSpawn, startSidecars: false });
  await z2.ensure({ bootTimeoutMs: 10 });
  dExit(1);
  await new Promise(r => setTimeout(r, 1200));                        // nextBackoff(0)=1000ms
  ok('exit + port down → respawn proceeds', dSpawns >= 2, `spawns=${dSpawns}`);
  z2._shuttingDown = true;                                            // stop further respawns

  // (c) health passed but OUR child already died → the health is someone else's: adopt, no fleet
  let cSpawns = 0;
  const cSpawn = () => { cSpawns++; return { pid: 700, exitCode: 1, on() {}, kill() {}, killed: false }; };
  let probes = 0;
  global.fetch = async () => { probes++; if (probes === 1) throw new Error('down'); return { ok: true }; };
  const z3 = new E.EngineSupervisor({ cwd: 'x', spawnFn: cSpawn });   // sidecars ON — must still not start
  const cr = await z3.ensure();
  ok('dead child at health-pass → adopted (not "spawned")', cr.state === 'adopted', cr.state);
  ok('dead child at health-pass → no sidecar fleet', Object.keys(z3.status().sidecars).length === 0);

  // (d) single-flight: concurrent ensure() calls share one probe/spawn
  let fSpawns = 0;
  const fSpawn = () => { fSpawns++; return { pid: 800, on() {}, kill() {}, killed: false }; };
  global.fetch = async () => { await new Promise(r => setTimeout(r, 20)); throw new Error('down'); };
  const z4 = new E.EngineSupervisor({ cwd: 'x', spawnFn: fSpawn, startSidecars: false });
  const [r1, r2] = await Promise.all([z4.ensure({ bootTimeoutMs: 10 }), z4.ensure({ bootTimeoutMs: 10 })]);
  ok('concurrent ensure() → ONE spawn (single-flight)', fSpawns === 1 && r1 === r2, `spawns=${fSpawns}`);

  // ── audit S13/S27: giveup is NOT terminal + child stderr is captured ──
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
    ok('S13: >5-restart giveup schedules a cooldown re-arm, not permanent death', /cooling down[\s\S]{0,200}this\._restarts = \[\];[\s\S]{0,40}this\._spawn/.test(src));
    ok('S27: the engine child pipes stderr (not stdio:ignore) and logs it', /stdio: \['ignore', 'ignore', 'pipe'\]/.test(src) && /engine:stderr/.test(src));
    ok('S27: sidecars pipe stderr too', /sidecar \$\{def\.name\}:stderr/.test(src));
  }

  // ── UNIFICATION stage 1 (09-02): the fleet comes from Echo's manifest ─────────────────────────
  {
    const fakeManifest = {
      manifest_version: 1, config: 'C:/echo/config.toml',
      serve: { host: '127.0.0.1', port: 8765, args: ['-m', 'echo.main', 'serve', '--transport', 'http', '--host', '127.0.0.1', '--port', '8765'] },
      sidecars: [
        { name: 'huey-consumer', disable_env: 'NX_ECHO_DISABLE_HUEY', args: ['-m', 'huey.bin.huey_consumer', 'echo.queue.huey'], heartbeat_s: null },
        { name: 'orchestrator', disable_env: 'NX_ECHO_DISABLE_ORCHESTRATOR', args: ['-m', 'echo.orchestrator.run', '--checkpoint-db', 'C:/echo/data/ck.db', '--rainey-db', 'C:/echo/data/foundations/civic_graph.db'], heartbeat_s: 60 },
      ],
      paths: { rainey_db: 'C:/echo/data/foundations/civic_graph.db' }, warnings: ['paths.corpus_root missing'],
    };
    const v = E.validateManifest(fakeManifest);
    ok('validateManifest: normalizes sidecars (disable_env→disableEnv, heartbeat_s→heartbeatS)', v.source === 'echo' && v.sidecars.length === 2 && v.sidecars[1].disableEnv === 'NX_ECHO_DISABLE_ORCHESTRATOR' && v.sidecars[1].heartbeatS === 60 && v.sidecars[0].heartbeatS === null);
    ok('validateManifest: the orchestrator argv carries the resolved --rainey-db', v.sidecars[1].args.includes('--rainey-db'));
    let threw = 0;
    for (const bad of [null, {}, { manifest_version: 2, sidecars: [{ name: 'x', args: ['a'] }] }, { manifest_version: 1, sidecars: [] }, { manifest_version: 1, sidecars: [{ name: 'x', args: [] }] }]) { try { E.validateManifest(bad); } catch { threw++; } }
    ok('validateManifest: rejects wrong version / no sidecars / empty argv (never half a fleet)', threw === 5, `threw=${threw}`);

    const mLogs = [], mErrs = [], mSpawns = [];
    const mSpawn = (cmd, args) => { mSpawns.push(args); return { pid: 2000 + mSpawns.length, on() {}, kill() {}, killed: false }; };
    const m1 = new E.EngineSupervisor({ cwd: 'x', spawnFn: mSpawn, manifestFn: async () => fakeManifest, onLog: (l) => mLogs.push(l), onError: (l) => mErrs.push(l) });
    await m1._loadManifest();
    m1.owned = true; m1._startSidecars();
    ok('manifest → the fleet IS the manifest (2 sidecars, not the built-in 3)', Object.keys(m1.status().sidecars).length === 2 && mSpawns.some((a) => a.includes('--rainey-db')), JSON.stringify(Object.keys(m1.status().sidecars)));
    ok('manifest warnings are teed at ERROR level (self_watch-mintable)', mErrs.some((l) => /manifest WARNING — paths\.corpus_root missing/.test(l)));
    ok('status() names the authority', !!m1.status().manifest && m1.status().manifest.source === 'echo' && m1.status().manifest.warnings === 1);
    ok('serve argv comes from the manifest when the port agrees', m1._serveArgs().join(' ') === fakeManifest.serve.args.join(' '));
    await m1.shutdown();

    const fErrs = []; const fSpawn = () => ({ pid: 3000, on() {}, kill() {}, killed: false });
    const m2 = new E.EngineSupervisor({ cwd: 'x', spawnFn: fSpawn, manifestFn: async () => { throw new Error('python exploded'); }, onLog() {}, onError: (l) => fErrs.push(l) });
    await m2._loadManifest();
    ok('manifest unavailable → BUILT-IN fleet (3) + an error line naming the stale authority', m2.sidecars.length === 3 && m2.status().manifest.source === 'builtin' && fErrs.some((l) => /manifest unavailable \(python exploded\).*BUILT-IN/.test(l)), fErrs.join(' | '));
    ok('the built-in fleet stays in step with Echo: the orchestrator declares a 60s heartbeat', E.sidecarDefs().find((d) => d.name === 'orchestrator').heartbeatS === 60);
    const m3 = new E.EngineSupervisor({ cwd: 'x', spawnFn: fSpawn, onLog() {}, onError() {} });
    let m3ok = false; try { await m3._loadManifest(); m3ok = m3.status().manifest.source === 'builtin'; } catch {}
    ok('an injected spawnFn without a manifestFn resolves to the built-in fleet at once (tests never hang)', m3ok);
    ok('manifestArgs is the Echo CLI door', E.manifestArgs().join(' ') === '-m echo.main manifest');
  }

  // ── UNIFICATION stage 2 (09-02): the sidecar lifecycle contract ───────────────────────────────
  {
    const d1 = E.describeEvent({ event: 'cycle_done', cycle: 3, dispatched: 1, skipped: 2, finish_reason: 'no_runnable_passes', elapsed_s: 1.2 });
    ok('describeEvent: cycle_done renders at log level', d1.level === 'log' && /cycle 3 done: 1 dispatched, 2 skipped, no_runnable_passes/.test(d1.text), d1.text);
    const d2 = E.describeEvent({ event: 'cycle_failed', cycle: 4, error: 'OperationalError: unable to open database file' });
    ok('describeEvent: cycle_failed is ERROR level and carries the cause', d2.level === 'error' && /cycle 4 FAILED: OperationalError: unable to open database file/.test(d2.text));
    ok('describeEvent: config_error is ERROR level', E.describeEvent({ event: 'config_error', error: 'rainey_db is a directory (tombstone)', rainey_db: 'C:/x/rainey.db' }).level === 'error');
    ok('describeEvent: an unknown *_error event defaults to ERROR level, others to log', E.describeEvent({ event: 'weird_error', x: 1 }).level === 'error' && E.describeEvent({ event: 'something', x: 1 }).level === 'log');

    // stdout events reach the tee under the organ's OWN prefix; failures at error level
    const organ = []; const handlers = {};
    const oSpawn = () => ({ pid: 4000, on(ev, fn) { handlers[ev] = fn; }, kill() {}, killed: false, stdout: { on(ev, fn) { handlers.stdout = fn; } }, stderr: { on() {} } });
    const o1 = new E.EngineSupervisor({ cwd: 'x', spawnFn: oSpawn, sidecars: [{ name: 'orchestrator', disableEnv: null, args: ['-m', 'x'], heartbeatS: 60 }], manifestFn: async () => { throw new Error('n/a'); }, onLog() {}, onError() {}, onOrgan: (n, t, l) => organ.push([n, t, l]) });
    o1.owned = true; o1._startSidecars();
    handlers.stdout(Buffer.from('{"event": "start", "rainey_db": "C:/civic.db", "interval_s": 60, "classes": ["maintain"]}\n{"event": "cycle_done", "cycle": 1, "dispatched": 0, "skipped": 0, "finish_reason": "no_runnable_passes", "elapsed_s": 0.4}\n{"event": "cycle_fail'));
    handlers.stdout(Buffer.from('ed", "cycle": 2, "error": "boom"}\nplain text line\n'));
    ok('sidecar stdout → one organ line per JSON event, under [orchestrator]', organ.length === 4 && organ[0][0] === 'orchestrator' && /started \(rainey_db C:\/civic\.db/.test(organ[0][1]) && /cycle 1 done/.test(organ[1][1]), JSON.stringify(organ).slice(0, 220));
    ok('a chunk split mid-line is reassembled; cycle_failed lands at ERROR level', organ[2][1] === 'cycle 2 FAILED: boom' && organ[2][2] === 'error');
    ok('a non-JSON stdout line is teed raw', organ[3][1] === 'plain text line' && organ[3][2] === 'log');
    const st = o1.status().organs.orchestrator;
    ok('status(): per-organ liveness (alive, last event age, heartbeat)', !!st && st.alive && st.lastEventAgoMs != null && st.lastEventAgoMs < 5000 && st.heartbeatS === 60, JSON.stringify(st));

    // silence: a heartbeat organ that misses 5 beats is NAMED at error level, not killed
    const sErrs = []; o1.onError = (l) => sErrs.push(l);
    o1._checkSilence(Date.now() + 60 * 1000 * E.SIDECAR_SILENCE_FACTOR + 60e3);
    ok('silence past 5 missed beats → one SILENT error line (process left alive)', sErrs.length === 1 && /sidecar orchestrator: SILENT for \d+min/.test(sErrs[0]) && o1.status().organs.orchestrator.silent === true, sErrs[0]);
    o1._checkSilence(Date.now() + 60 * 1000 * E.SIDECAR_SILENCE_FACTOR + 120e3);
    ok('silence is flagged ONCE per silence', sErrs.length === 1);
    handlers.stdout(Buffer.from('{"event": "cycle_done", "cycle": 3}\n'));
    ok('the next event clears the silence flag', o1.status().organs.orchestrator.silent === false);
    await o1.shutdown();

    // exit → restart under the backoff law (attempt 1 = 1s)
    let rSpawns = 0; const rErrs = []; const rHandlers = {};
    const rSpawn = () => { rSpawns++; return { pid: 5000 + rSpawns, on(ev, fn) { rHandlers[ev] = fn; }, kill() {}, killed: false }; };
    const r1 = new E.EngineSupervisor({ cwd: 'x', spawnFn: rSpawn, sidecars: [{ name: 'pass-worker', disableEnv: null, args: ['-m', 'x'], heartbeatS: null }], onLog() {}, onError: (l) => rErrs.push(l) });
    r1.owned = true; r1._startSidecars();
    rHandlers.exit(1);
    ok('a sidecar exit is announced at ERROR level with the restart delay', rErrs.some((l) => /sidecar pass-worker: exited \(code 1\) — restarting in 1000ms \(attempt 1\)/.test(l)) && Object.keys(r1.status().sidecars).length === 0, rErrs.join(' | '));
    await new Promise((r) => setTimeout(r, 1200));
    ok('…and it IS restarted (a dead sidecar used to be deleted and forgotten)', rSpawns === 2 && r1.status().sidecars['pass-worker'] === 5002 && r1.status().organs['pass-worker'].exits === 1, `spawns=${rSpawns}`);
    r1._shuttingDown = true; rHandlers.exit(0);
    await new Promise((r) => setTimeout(r, 1200));
    ok('no restart during shutdown', rSpawns === 2);
    await r1.shutdown();

    // /health readiness: ready:false is NOT healthy; a body without the field keeps the old contract
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, ready: false, pid: 1 }) });
    ok('probeHealth: ready:false → not healthy (listening ≠ serving)', (await E.probeHealth()) === false);
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, pid: 1 }) });
    ok('probeHealth: no ready field → healthy (older engines)', (await E.probeHealth()) === true);
  }

  global.fetch = realFetch;
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
