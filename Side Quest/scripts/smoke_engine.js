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

  global.fetch = realFetch;
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
