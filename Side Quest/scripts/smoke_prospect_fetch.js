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

  // === MULTI-LAYER: pickFollowLinks + deepBrowse ===
  const handleText = 'Body text.\nInteractive elements:\n  [L0] link: Home\n  [L1] link: Leadership Team\n  [L2] link: Jane Roe\n  [L3] link: Contact Us\n  [L4] link: Careers\n  [L5] link: Meet the Team Dedicated to Building a Better Future';
  const follow = PF.pickFollowLinks(handleText, { maxHops: 3 });
  ok(follow.length === 2 && follow.some(f => f.name === 'Leadership Team') && follow.some(f => f.name === 'Contact Us'), 'pickFollowLinks: keeps only relevant nav (Leadership/Contact), drops Home/Careers');
  ok(!follow.some(f => f.name === 'Jane Roe'), 'pickFollowLinks: a person-name link that is not nav-relevant is not auto-followed');
  ok(!follow.some(f => /Meet the Team/.test(f.name)), 'pickFollowLinks: a long hero heading (>4 words) is NOT treated as a nav link');
  ok(PF.pickFollowLinks('no handles here').length === 0, 'pickFollowLinks: no handles → []');

  // deepBrowse: land → read → click through 2 relevant sub-links → merge layers
  const nav = {
    _page: 'serp', _clicks: [],
    open: async () => ({ ok: true, url: 'https://duckduckgo.com/html/?q=x' }),
    openTopResult: async function () { this._page = 'index'; return { ok: true, url: 'https://acme.com/' }; },
    read: async function () {
      if (this._page === 'index') return { ok: true, url: 'https://acme.com/', text: 'Acme home. '.repeat(30) + '\nInteractive elements:\n  [L0] link: Leadership\n  [L1] link: Contact\n  [L2] link: Careers' };
      if (this._page === 'leadership') return { ok: true, url: 'https://acme.com/leadership', text: 'Leadership: Jane Roe CEO, Bob Fell CFO. '.repeat(10) };
      if (this._page === 'contact') return { ok: true, url: 'https://acme.com/contact', text: 'Contact: press@acme.com, 555-1000. '.repeat(10) };
      return { ok: true, url: 'x', text: '' };
    },
    click: async function (h) { this._clicks.push(h); this._page = h === 'L0' ? 'leadership' : h === 'L1' ? 'contact' : 'other'; return { ok: true, url: 'https://acme.com/' + this._page }; },
    back: async function () { this._page = 'index'; return { ok: true, url: 'https://acme.com/' }; },
  };
  const layers = await PF.deepBrowse(nav, 'Acme leadership', { maxHops: 3 });
  ok(layers.length === 3, `deepBrowse: merges landing + 2 drilled layers (got ${layers.length})`);
  ok(layers.every(l => l.source === 'browser'), 'deepBrowse: every layer is a browser source');
  ok(layers.some(l => /Jane Roe CEO/.test(l.text)) && layers.some(l => /press@acme.com/.test(l.text)), 'deepBrowse: captured the deeper leadership + contact pages');
  ok(nav._clicks.includes('L0') && nav._clicks.includes('L1') && !nav._clicks.includes('L2'), 'deepBrowse: clicked the relevant links (Leadership, Contact), not Careers');
  ok((await PF.deepBrowse(null, 'x')).length === 0 && (await PF.deepBrowse({ open: async () => ({ ok: false }) }, 'x')).length === 0, 'deepBrowse: no browser / failed open → [] (fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
