/* Smoke: lib/cloud_logic — the cloud reasoning broker. Deterministic, injected `complete` fn (no
 * network). Proves the packaging contract: validate-or-null, ONE repair retry, cache (skip identical
 * call), daily budget cap (skip over budget), fail-safe on no-cloud, and a trace row per call.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cloud_logic.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_cloudlogic_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
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

    // 1b. THE LANE THREAD-THROUGH (08-29: a bare ask inherited the ambient spend tier and the
    // intent pass was quota-starved on a live user turn). An explicit lane rides cOpts → complete.
    let laneSeen = 'unset';
    const lanec = async (msgs, opts) => { laneSeen = (opts && opts.lane) || null; return { text: '{"score":1}', model: 'test' }; };
    await cl.ask({ task: 'lane-t', input: { z: 1 }, want: 'JSON', lane: 'interactive', deps: { complete: lanec, skipBudget: true, noCache: true } });
    ok(laneSeen === 'interactive', 'ask({lane}) forwards the lane to the completion (explicit beats ambient)');
    await cl.ask({ task: 'lane-t2', input: { z: 2 }, want: 'JSON', deps: { complete: lanec, skipBudget: true, noCache: true } });
    ok(laneSeen === null, 'no lane passed → none forwarded (the ambient default is untouched)');
    // 08-29: a logless null was undiagnosable — the two silent-null doors now name themselves.
    const clSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud_logic.js'), 'utf8');
    ok(/null: no cloud source with a token this instant/.test(clSrc) && /null: model resolution failed this instant/.test(clSrc),
      'the two silent-null paths in _complete log their cause (a fast null is never anonymous again)');

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

    // 8. keyInput — the cache-key repair (2026-08-15): volatile input text + a stable key → HIT.
    // Before this, echo_pick/echo_args hashed their full input (filtered catalog / describe_tool
    // text, volatile every call) and measured ZERO cache hits in 9,600+ calls over 26h.
    let n8 = 0;
    const kc = async () => { n8++; return { text: '{"pick":"x"}', model: 't' }; };
    const k1 = await cl.ask({ task: 'kpick', input: { need: 'q', cat: 'volatile-A' }, keyInput: { need: 'q', cat: 'v1' }, want: 'j', deps: { complete: kc, skipBudget: true } });
    const k2 = await cl.ask({ task: 'kpick', input: { need: 'q', cat: 'volatile-B' }, keyInput: { need: 'q', cat: 'v1' }, want: 'j', deps: { complete: kc, skipBudget: true } });
    ok(k1 && k2 && k1.pick === 'x' && k2.pick === 'x' && n8 === 1, 'keyInput: volatile input + stable key → 2nd call cache-served (0-hits defect cured)');
    const k3 = await cl.ask({ task: 'kpick', input: { need: 'q', cat: 'volatile-C' }, keyInput: { need: 'q', cat: 'v2' }, want: 'j', deps: { complete: kc, skipBudget: true } });
    ok(k3 && n8 === 2, 'keyInput: changed key (catalog versioned by its name list) → fresh cloud call');
    const k4 = await cl.ask({ task: 'kpick', input: { need: 'q', cat: 'volatile-A' }, want: 'j', deps: { complete: kc, skipBudget: true } });
    ok(k4 && n8 === 3, 'no keyInput → full-input hashing unchanged (classify-unique-text tasks unaffected)');
    ok(parseInt(db.getMeta('cloud_logic.cache_hits') || '0', 10) >= 2, `cache hits are COUNTED now (${db.getMeta('cloud_logic.cache_hits')} — the 0-hits defect can never go invisible again)`);
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
