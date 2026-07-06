/* Smoke: lib/prospect_fetch — browser-first fetching for the Puller lane, through HER browser (injected
 * browserSearch). Fully offline: browserSearch + fallback are mocked.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_prospect_fetch.js
 */
'use strict';
const PF = require('../lib/prospect_fetch');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- pageResult: shapes a her-browser read, drops thin pages ---
ok(PF.pageResult({ text: 'x'.repeat(300), url: 'https://a.com/team' }).source === 'browser', 'pageResult: >=minText → a browser source row');
ok(PF.pageResult({ text: 'x'.repeat(300), url: 'https://a.com/team' }).url === 'https://a.com/team', 'pageResult: carries the landed url');
ok(PF.pageResult({ text: 'tiny' }) === null, 'pageResult: too-thin page → null');
ok(PF.pageResult(null) === null, 'pageResult: no read → null');

(async () => {
  // --- makeWebFetcher: her browser succeeds → used, no fallback ---
  let fellBack = false;
  const fetcher = PF.makeWebFetcher({
    browserSearch: async () => [{ text: 'Our team — Ada Lovelace, Head of AI. '.repeat(10), url: 'https://acme.com/team', source: 'browser' }],
    fallback: async () => { fellBack = true; return [{ text: 'wiki', url: 'w', source: 'web:wikipedia' }]; },
  });
  const res = await fetcher('Acme leadership team');
  ok(res.length === 1 && res[0].source === 'browser' && /Ada Lovelace/.test(res[0].text), 'makeWebFetcher: her browser first — returns the read page');
  ok(!fellBack, 'makeWebFetcher: does NOT fall back when her browser succeeds');

  // --- her browser yields nothing → fallback ---
  let fb2 = false;
  const fetcher2 = PF.makeWebFetcher({
    browserSearch: async () => [],   // blocker / nav fail / not connected
    fallback: async () => { fb2 = true; return [{ text: 'corpus', url: 'echo:kb#1', source: 'echo:kb' }]; },
  });
  const res2 = await fetcher2('Acme');
  ok(fb2 && res2.length === 1 && res2[0].source === 'echo:kb', 'makeWebFetcher: her browser empty → falls back to the layered fetch');

  // --- her browser throws → fallback (fail-soft) ---
  let fb3 = false;
  const res3 = await PF.makeWebFetcher({ browserSearch: async () => { throw new Error('boom'); }, fallback: async () => { fb3 = true; return [{ text: 't', url: 'u', source: 'echo:kb' }]; } })('x');
  ok(fb3 && res3.length === 1, 'makeWebFetcher: her browser throws → fallback (never propagates)');

  // --- neither → [] ---
  const res4 = await PF.makeWebFetcher({})('x');
  ok(Array.isArray(res4) && res4.length === 0, 'makeWebFetcher: no sources → [] (fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
