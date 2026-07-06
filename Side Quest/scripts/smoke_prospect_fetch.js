/* Smoke: lib/prospect_fetch — browser-first fetching for the Puller lane, through HER browser (injected
 * pageFetch). Fully offline: pageFetch, webSearch, and fallback are mocked.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_prospect_fetch.js
 */
'use strict';
const PF = require('../lib/prospect_fetch');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // --- browserGet: reads a page through the injected browser ---
  const goodFetch = async (url) => ({ text: 'Leadership team: Jane Roe, Chief Executive Officer. Bob Fell, CFO. '.repeat(6), url });
  const got = await PF.browserGet(goodFetch, 'https://acme.com/leadership');
  ok(got && /Jane Roe/.test(got.text) && got.url === 'https://acme.com/leadership', 'browserGet: returns the page text + url via her browser');
  ok(await PF.browserGet(goodFetch, 'file:///etc/passwd') === null && await PF.browserGet(goodFetch, 'ftp://x') === null, 'browserGet: rejects non-http(s) urls (SSRF-safe)');
  ok(await PF.browserGet(async () => ({ text: 'tiny', url: 'u' }), 'https://x.com') === null, 'browserGet: too-thin page → null');
  ok(await PF.browserGet(async () => null, 'https://x.com') === null, 'browserGet: browser returned nothing → null');
  ok(await PF.browserGet(async () => { throw new Error('boom'); }, 'https://x.com') === null, 'browserGet: browser threw → null (fail-soft)');

  // --- makeWebFetcher: browser-first (search → her browser reads the page) ---
  let fellBack = false;
  const fetcher = PF.makeWebFetcher({
    pageFetch: async (url) => ({ text: 'Our team — Ada Lovelace, Head of AI. '.repeat(10), url }),
    webSearch: async () => ({ results: [{ url: 'https://acme.com/team' }, { url: 'https://acme.com/about' }] }),
    fallback: async () => { fellBack = true; return [{ text: 'wiki', url: 'w', source: 'web:wikipedia' }]; },
  });
  const res = await fetcher('Acme leadership team');
  ok(res.length >= 1 && res[0].source === 'browser' && /Ada Lovelace/.test(res[0].text), 'makeWebFetcher: browser-first — reads the searched page');
  ok(!fellBack, 'makeWebFetcher: does NOT fall back when the browser succeeds');

  // --- makeWebFetcher: browser unavailable → fallback layered fetch ---
  let fb2 = false;
  const fetcher2 = PF.makeWebFetcher({
    pageFetch: async () => null,   // her browser not connected / blocked
    webSearch: async () => ({ results: [{ url: 'https://acme.com/team' }] }),
    fallback: async () => { fb2 = true; return [{ text: 'corpus text', url: 'echo:kb#1', source: 'echo:kb' }]; },
  });
  const res2 = await fetcher2('Acme');
  ok(fb2 && res2.length === 1 && res2[0].source === 'echo:kb', 'makeWebFetcher: browser yields nothing → falls back to the layered fetch');

  // --- makeWebFetcher: no search + no fallback → [] (never throws) ---
  const res3 = await PF.makeWebFetcher({ pageFetch: async () => null })('x');
  ok(Array.isArray(res3) && res3.length === 0, 'makeWebFetcher: no sources → [] (fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
