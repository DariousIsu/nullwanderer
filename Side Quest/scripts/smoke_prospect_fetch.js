/* Smoke: lib/prospect_fetch — browser-first fetching for the Puller lane. Fully offline: the browser
 * `dispatch`, webSearch, and fallback are all mocked. Verifies the confirm→approve→session flow, the
 * navigate→extract→close path, and the fail-soft fallback when the browser is unavailable.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_prospect_fetch.js
 */
'use strict';
const PF = require('../lib/prospect_fetch');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// A mock echoSuit.dispatch: returns { ok, text } where text is the tool's JSON payload. `script` maps a
// tool name → its payload; `calls` records the sequence. A confirm-gated open needs an approval first.
function mockDispatch(script) {
  const calls = [];
  const d = async ({ name, args }) => { calls.push({ name, args }); const v = typeof script[name] === 'function' ? script[name](args, calls) : script[name]; return { ok: true, text: JSON.stringify(v == null ? {} : v) }; };
  d.calls = calls;
  return d;
}

(async () => {
  // --- openSession: direct session_id ---
  const d1 = mockDispatch({ browser_open_session: { session_id: 'S1' } });
  ok((await PF.openSession(d1)) === 'S1', 'openSession: direct grant → session_id');

  // --- openSession: confirm gate → auto-approve → re-open → session ---
  let approved = null;
  const d2 = mockDispatch({
    browser_open_session: (args) => args && args.approval_id ? { session_id: 'S2' } : { status: 'confirmation_required', approval_id: 'A9' },
    os_approval_resolve: (args) => { approved = args; return { ok: true }; },
  });
  ok((await PF.openSession(d2)) === 'S2', 'openSession: confirmation_required → approve → re-open → session');
  ok(approved && approved.approval_id === 'A9' && approved.approved === true, 'openSession: auto-approves the pending confirmation');

  // --- openSession: permission denied → null ---
  const d3 = mockDispatch({ browser_open_session: { error: 'permission_denied', reason: 'not granted' } });
  // ok:true but payload has no session_id and no confirmation → treated as unavailable
  ok((await PF.openSession(d3)) === null, 'openSession: no session / denied → null');

  // --- browserGet: navigate + extract the rendered text, then close ---
  const dGet = mockDispatch({
    browser_open_session: { session_id: 'S1' },
    browser_navigate: { ok: true },
    browser_extract: { text: 'Leadership team: Jane Roe, Chief Executive Officer. Bob Fell, CFO. '.repeat(6) },
    browser_close_session: { ok: true },
  });
  const got = await PF.browserGet(dGet, 'https://acme.com/leadership');
  ok(got && /Jane Roe/.test(got.text) && got.url === 'https://acme.com/leadership', 'browserGet: returns the rendered inner text + url');
  ok(dGet.calls.some(c => c.name === 'browser_close_session'), 'browserGet: always closes the session');
  ok(await PF.browserGet(dGet, 'file:///etc/passwd') === null && await PF.browserGet(dGet, 'ftp://x') === null, 'browserGet: rejects non-http(s) urls (SSRF-safe)');

  // --- browserGet: thin page → null ---
  const dThin = mockDispatch({ browser_open_session: { session_id: 'S1' }, browser_navigate: {}, browser_extract: { text: 'tiny' }, browser_close_session: {} });
  ok(await PF.browserGet(dThin, 'https://x.com') === null, 'browserGet: too-thin page → null');

  // --- makeWebFetcher: browser-first (search → browser scrape) ---
  const dScrape = mockDispatch({
    browser_open_session: { session_id: 'S1' },
    browser_navigate: {},
    browser_extract: { text: 'Our team — Ada Lovelace, Head of AI. '.repeat(10) },
    browser_close_session: {},
  });
  let fellBack = false;
  const fetcher = PF.makeWebFetcher({
    dispatch: dScrape,
    webSearch: async () => ({ results: [{ url: 'https://acme.com/team' }, { url: 'https://acme.com/about' }] }),
    fallback: async () => { fellBack = true; return [{ text: 'wiki', url: 'w', source: 'web:wikipedia' }]; },
  });
  const res = await fetcher('Acme leadership team');
  ok(res.length >= 1 && res[0].source === 'browser' && /Ada Lovelace/.test(res[0].text), 'makeWebFetcher: browser-first — scrapes the searched page');
  ok(!fellBack, 'makeWebFetcher: does NOT fall back when the browser succeeds');

  // --- makeWebFetcher: browser unavailable → fallback layered fetch ---
  const dDenied = mockDispatch({ browser_open_session: { error: 'permission_denied' } });
  let fb2 = false;
  const fetcher2 = PF.makeWebFetcher({
    dispatch: dDenied,
    webSearch: async () => ({ results: [{ url: 'https://acme.com/team' }] }),
    fallback: async () => { fb2 = true; return [{ text: 'corpus text', url: 'echo:kb#1', source: 'echo:kb' }]; },
  });
  const res2 = await fetcher2('Acme');
  ok(fb2 && res2.length === 1 && res2[0].source === 'echo:kb', 'makeWebFetcher: browser denied → falls back to the layered fetch');

  // --- makeWebFetcher: no search + no fallback → [] (never throws) ---
  const res3 = await PF.makeWebFetcher({ dispatch: dDenied })('x');
  ok(Array.isArray(res3) && res3.length === 0, 'makeWebFetcher: no sources → [] (fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
