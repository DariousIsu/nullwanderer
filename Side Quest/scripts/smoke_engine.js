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

  global.fetch = realFetch;
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
