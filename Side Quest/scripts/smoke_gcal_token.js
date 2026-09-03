/* smoke_gcal_token.js — the Google token bridge never blocks the caller (lib/gcal, freeze cut 17).
 *
 * The profiler (boot_p268, under runChatTurn): `26% spawn via fetchToken (lib/gcal.js:33)` — a chat turn
 * asked isConnected(), the cached token was near expiry, and getToken shelled to Echo's interpreter on
 * the main thread. Now getToken is stale-while-revalidate: it answers with what it holds while valid,
 * kicks ONE background refresh (a worker in the app; an injected fetchFn here), and never waits.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_gcal_token.js
 */
'use strict';
const G = require('../lib/gcal');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  G._resetForTest();
  let calls = 0, resolveFetch = null;
  const fetchFn = () => { calls++; return new Promise((r) => { resolveFetch = r; }); };
  const now = 1_700_000_000_000, HOUR = 3600e3;

  const a = G.getToken({ fetchFn, now }), b = G.getToken({ fetchFn, now }), c = G.getToken({ fetchFn, now });
  ok(a === null && b === null && c === null, 'nothing held → null at once (the caller is never blocked on a shell)');
  ok(calls === 1, 'three callers kick ONE refresh');
  resolveFetch({ token: 'tok-1', expMs: now + HOUR }); await tick();
  ok(G.getToken({ fetchFn, now }) === 'tok-1' && calls === 1, 'after the refresh lands, the token answers with no further fetch');
  ok(G.isConnected({ fetchFn, now }) === true, 'isConnected reads the held token');

  const near = now + HOUR - 60e3;
  ok(G.getToken({ fetchFn, now: near }) === 'tok-1' && calls === 2, '⭐ within 2 min of expiry: the still-valid token answers AND one refresh is kicked (stale-while-revalidate)');
  ok(G.getToken({ fetchFn, now: near }) === 'tok-1' && calls === 2, 'a second caller during that refresh joins it — no second shell');
  resolveFetch({ token: 'tok-2', expMs: near + HOUR }); await tick();
  ok(G.getToken({ fetchFn, now: near }) === 'tok-2', 'the refreshed token replaces the old one');

  const late = near + 2 * HOUR;
  ok(G.getToken({ fetchFn, now: late }) === null && calls === 3, 'an expired token is never handed out — null, and a refresh is kicked');
  resolveFetch(null); await tick();
  ok(G.getToken({ fetchFn, now: late }) === null && calls === 4, 'a failed refresh caches nothing; the next call kicks again');
  resolveFetch({ token: 'tok-3', expMs: late + HOUR }); await tick();
  ok(G.getToken({ fetchFn, now: late }) === 'tok-3', 'the next success is held');

  ok(G.getToken({ fetchFn, now: late, force: true }) === null && calls === 5, 'force → a refresh is kicked and nothing is answered from the cache');
  resolveFetch({ token: 'tok-4', expMs: late + HOUR }); await tick();
  ok(G.getToken({ fetchFn, now: late }) === 'tok-4', 'the forced refresh lands');

  const wp = G.warm({ fetchFn, now: late });
  ok(calls === 6, 'warm() kicks a refresh (the post-boot beat)');
  resolveFetch({ token: 'tok-5', expMs: late + HOUR });
  const rec = await wp;
  ok(rec && rec.token === 'tok-5' && G.getToken({ fetchFn, now: late }) === 'tok-5', 'warm() resolves to the held record');

  let threw = false;
  try { G.refresh({ fetchFn: () => { throw new Error('boom'); } }); await tick(); } catch { threw = true; }
  ok(!threw && G.getToken({ fetchFn, now: late }) === 'tok-5', 'a fetcher that throws never surfaces — the held token stays');

  G._resetForTest();
  ok(G.getToken({}) === null && G.isConnected({}) === false, 'no interpreter configured → null, never a throw, no worker');
  ok((await G.fetchTokenInWorker({})) === null, 'the worker door with no python/cwd resolves null');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke_gcal_token crashed:', e); process.exit(1); });
