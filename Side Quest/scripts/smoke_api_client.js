/* Smoke: lib/api_catalog + lib/api_client — the API management stream foundation. Proves catalog integrity
 * and that each AUTH STYLE (query / header / bearer / POST body) builds the right request, plus the call
 * path with a mocked fetch + config (no network, no real keys). Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_api_client.js */
'use strict';
const catalog = require('../lib/api_catalog');
const client = require('../lib/api_client');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== catalog integrity =====
const all = catalog.list();
ok(all.length >= 11, `catalog has all APIs (${all.length})`);
ok(all.every((a) => a.id && a.name && a.baseUrl && a.keyEnv && a.auth && a.auth.type), 'every entry has id/name/baseUrl/keyEnv/auth');
ok(new Set(catalog.ids()).size === all.length, 'ids are unique');
ok(all.every((a) => ['query', 'header', 'bearer', 'body'].includes(a.auth.type)), 'every auth.type is a known style');
ok(catalog.get('fred') && catalog.get('FRED').id === 'fred', 'get() is case-insensitive');
ok(catalog.get('nope') === null, 'get() unknown → null');
ok(catalog.byCategory('markets').length >= 3 && catalog.categories().includes('economics'), 'byCategory + categories work');

// ===== buildRequest: each auth style =====
const q = client.buildRequest(catalog.get('fred'), 'series/observations', { params: { series_id: 'GDP', file_type: 'json' }, key: 'KFRED' });
ok(q.url === 'https://api.stlouisfed.org/fred/series/observations?series_id=GDP&file_type=json&api_key=KFRED' && q.method === 'GET', 'query auth: key appended as ?api_key=, params preserved');

const h = client.buildRequest(catalog.get('newsapi'), 'everything', { params: { q: 'ai' }, key: 'KNEWS' });
ok(h.headers['X-Api-Key'] === 'KNEWS' && /\/v2\/everything\?q=ai$/.test(h.url) && !/KNEWS/.test(h.url), 'header auth: key in X-Api-Key header, NOT the URL');

const b = client.buildRequest(catalog.get('notion'), 'users/me', { key: 'KNOTION' });
ok(b.headers.Authorization === 'Bearer KNOTION' && b.headers['Notion-Version'] === '2022-06-28', 'bearer auth: Authorization: Bearer + the extra Notion-Version header');

const body = client.buildRequest(catalog.get('bls'), 'timeseries/data/', { body: { seriesid: ['LNS14000000'], startyear: '2023' }, key: 'KBLS' });
const parsed = JSON.parse(body.body);
ok(body.method === 'POST' && parsed.registrationkey === 'KBLS' && parsed.seriesid[0] === 'LNS14000000' && !/KBLS/.test(body.url), 'body auth: POST, key merged into JSON body as registrationkey, not the URL');

ok(client.buildRequest(catalog.get('fred'), 'https://absolute.example/x', { key: 'K' }).url.startsWith('https://absolute.example/x'), 'buildRequest honors an absolute URL path');

// ===== call(): mocked fetch + config =====
const KEYS = { FRED_API_KEY: 'K_FRED', NEWS_API_KEY: 'K_NEWS', NOTION_API_KEY: '' };  // notion key missing on purpose
const mockConfig = { get: (name) => (Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : '') };
let seen = null;
const mockFetch = async (url, opts) => { seen = { url, ...opts }; return { ok: true, status: 200, text: async () => JSON.stringify({ got: 'data', url }) }; };

(async () => {
  const r = await client.call('fred', 'series/observations', { params: { series_id: 'GDP' }, fetch: mockFetch, config: mockConfig });
  ok(r.ok && r.status === 200 && r.data.got === 'data', 'call: returns normalized { ok, status, data }');
  ok(/api_key=K_FRED/.test(seen.url), 'call: resolved the FRED key from the (mock) keyring and injected it');

  const rn = await client.call('newsapi', 'top-headlines', { params: { country: 'us' }, fetch: mockFetch, config: mockConfig });
  ok(rn.ok && seen.headers['X-Api-Key'] === 'K_NEWS', 'call: header-auth API sends the key as a header');

  const miss = await client.call('notion', 'users/me', { fetch: mockFetch, config: mockConfig });
  ok(miss.ok === false && /missing key NOTION_API_KEY/.test(miss.error), 'call: missing keyring value → clear error, no fetch attempted');

  const unknown = await client.call('bogus', 'x', { fetch: mockFetch, config: mockConfig });
  ok(unknown.ok === false && /unknown api/.test(unknown.error), 'call: unknown api → error');

  const bad = await client.call('fred', 'x', { config: mockConfig, fetch: async () => { throw new Error('network down'); } });
  ok(bad.ok === false && /network down/.test(bad.error), 'call: fetch error is caught, returns ok:false (never throws)');

  // ===== keyStatus (management view) =====
  const status = client.keyStatus({ config: mockConfig });
  const fredS = status.find((s) => s.id === 'fred');
  const notionS = status.find((s) => s.id === 'notion');
  ok(fredS.hasKey === true && notionS.hasKey === false, 'keyStatus reports which keyring keys are present (no values)');
  ok(status.every((s) => !('key' in s) && !('value' in s)), 'keyStatus never leaks key values');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
