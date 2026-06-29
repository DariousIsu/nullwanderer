/* Smoke: lib/cloud_logic — the cloud reasoning broker. Deterministic, injected `complete` fn (no
 * network). Proves the packaging contract: validate-or-null, ONE repair retry, cache (skip identical
 * call), daily budget cap (skip over budget), fail-safe on no-cloud, and a trace row per call.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cloud_logic.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_cloudlogic_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const cl = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_logic');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const lastTrace = (task) => db.getDb().prepare('SELECT * FROM cloud_traces WHERE task=? ORDER BY id DESC LIMIT 1').get(task);

(async () => {
  try {
    db.init();

    // 1. happy path — default JSON validator
    let n1 = 0;
    const okc = async () => { n1++; return { text: '{"score":7}', model: 'test' }; };
    const r1 = await cl.ask({ task: 'rank', input: { a: 1 }, want: 'JSON', deps: { complete: okc, skipBudget: true, noCache: true } });
    ok(r1 && r1.score === 7, 'valid JSON parsed + returned');
    ok(n1 === 1, 'one cloud call');
    const t1 = lastTrace('rank');
    ok(t1 && t1.accepted === 1 && t1.valid === 1, 'trace logged, accepted');
    ok(t1 && t1.input_json && t1.input_json.includes('"a":1'), 'trace stored the packaged input (training data)');

    // 2. custom validator (the {same:boolean} shape the curator uses)
    const samec = async () => ({ text: 'sure — {"same": true}', model: 't' });
    const vSame = (raw) => { try { const o = JSON.parse(raw.match(/\{[\s\S]*?\}/)[0]); return { valid: typeof o.same === 'boolean', value: { same: o.same }, error: 'x' }; } catch (e) { return { valid: false, error: e.message }; } };
    const r2 = await cl.ask({ task: 'rel', input: { n: 1 }, want: 'json', validate: vSame, deps: { complete: samec, skipBudget: true, noCache: true } });
    ok(r2 && r2.same === true, 'custom validator returns its value');

    // 3. ONE repair retry recovers a valid result
    let n3 = 0;
    const flaky = async () => { n3++; return { text: n3 === 1 ? 'no json here' : '{"score":5}', model: 't' }; };
    const r3 = await cl.ask({ task: 'rep', input: { x: 1 }, want: 'json', deps: { complete: flaky, skipBudget: true, noCache: true } });
    ok(r3 && r3.score === 5, 'repair retry recovers valid result');
    ok(n3 === 2, 'exactly one repair retry (2 calls total)');
    ok(lastTrace('rep').repaired === 1, 'trace marks repaired');

    // 4. invalid twice → fail-safe null
    const bad = async () => ({ text: 'never json', model: 't' });
    const r4 = await cl.ask({ task: 'bad', input: {}, want: 'json', deps: { complete: bad, skipBudget: true, noCache: true } });
    ok(r4 === null, 'invalid after repair → null (fail-safe)');
    ok(lastTrace('bad').accepted === 0, 'trace logged not-accepted');

    // 5. no cloud configured (complete → null) → null, never throws
    const r5 = await cl.ask({ task: 'none', input: {}, want: 'j', deps: { complete: async () => null, skipBudget: true, noCache: true } });
    ok(r5 === null, 'no cloud → null');

    // 6. cache — identical (task,input,want) served without a second call
    let n6 = 0;
    const cc = async () => { n6++; return { text: '{"v":1}', model: 't' }; };
    const a = await cl.ask({ task: 'cache', input: { k: 1 }, want: 'j', deps: { complete: cc, skipBudget: true } });
    const b = await cl.ask({ task: 'cache', input: { k: 1 }, want: 'j', deps: { complete: cc, skipBudget: true } });
    ok(a && b && a.v === 1 && b.v === 1, 'both calls return the value');
    ok(n6 === 1, 'second identical call served from cache (cloud hit once)');

    // 7. budget — over the daily cap → skip (no cloud hit)
    let n7 = 0;
    const bc = async () => { n7++; return { text: '{"v":2}', model: 't' }; };
    const rb1 = await cl.ask({ task: 'bud', input: { i: 1 }, want: 'j', deps: { complete: bc, dailyCap: 1, noCache: true } });
    const rb2 = await cl.ask({ task: 'bud', input: { i: 2 }, want: 'j', deps: { complete: bc, dailyCap: 1, noCache: true } });
    ok(rb1 && rb1.v === 2, 'first call (under cap) succeeds');
    ok(rb2 === null && n7 === 1, 'second call over budget → null, no cloud hit');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
