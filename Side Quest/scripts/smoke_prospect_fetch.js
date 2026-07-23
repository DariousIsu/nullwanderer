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

  // person-bio links (individual leaders on an index page)
  ok(PF.looksLikePersonLink('Jane Roe') && PF.looksLikePersonLink('J. Clay Sell') && PF.looksLikePersonLink('José N. Reyes'), 'looksLikePersonLink: real names (incl. initials/accents)');
  ok(!PF.looksLikePersonLink('Leadership Team') && !PF.looksLikePersonLink('Contact Us') && !PF.looksLikePersonLink('Careers') && !PF.looksLikePersonLink('Read More'), 'looksLikePersonLink: nav labels are NOT people');
  const persons = PF.pickPersonLinks(handleText, { max: 4 });
  ok(persons.length === 1 && persons[0].name === 'Jane Roe', 'pickPersonLinks: picks the person-name link (Jane Roe), not the nav links');

  // deepBrowse: land → read → click through 2 relevant sub-links → merge layers
  const nav = {
    _page: 'serp', _clicks: [],
    open: async () => ({ ok: true, url: 'https://duckduckgo.com/html/?q=x' }),
    openTopResult: async function () { this._page = 'index'; return { ok: true, url: 'https://acme.com/' }; },
    read: async function () {
      if (this._page === 'index') return { ok: true, url: 'https://acme.com/', text: 'Acme home. '.repeat(30) + '\nInteractive elements:\n  [L0] link: Leadership\n  [L1] link: Contact\n  [L2] link: Careers\n  [L3] link: Jane Roe' };
      if (this._page === 'leadership') return { ok: true, url: 'https://acme.com/leadership', text: 'Leadership: Jane Roe CEO, Bob Fell CFO. '.repeat(10) };
      if (this._page === 'contact') return { ok: true, url: 'https://acme.com/contact', text: 'Contact: press@acme.com, 555-1000. '.repeat(10) };
      if (this._page === 'bio') return { ok: true, url: 'https://acme.com/people/jane-roe', text: 'Jane Roe, CEO. Direct: jane.roe@acme.com, 555-2222. '.repeat(8) };
      return { ok: true, url: 'x', text: '' };
    },
    click: async function (h) { this._clicks.push(h); this._page = h === 'L0' ? 'leadership' : h === 'L1' ? 'contact' : h === 'L3' ? 'bio' : 'other'; return { ok: true, url: 'https://acme.com/' + (this._page === 'bio' ? 'people/jane-roe' : this._page) }; },
    back: async function () { this._page = 'index'; return { ok: true, url: 'https://acme.com/' }; },
  };
  const layers = await PF.deepBrowse(nav, 'Acme leadership', { maxHops: 2, maxBios: 4 });
  ok(layers.length === 4, `deepBrowse: merges landing + nav layers + a person BIO (got ${layers.length})`);
  ok(layers.every(l => l.source === 'browser'), 'deepBrowse: every layer is a browser source');
  ok(layers.some(l => /Jane Roe CEO/.test(l.text)) && layers.some(l => /press@acme.com/.test(l.text)), 'deepBrowse: captured the deeper leadership + contact pages');
  ok(layers.some(l => /jane\.roe@acme\.com/.test(l.text)), 'deepBrowse: drilled into the individual BIO for the direct email');
  ok(nav._clicks.includes('L0') && nav._clicks.includes('L1') && nav._clicks.includes('L3') && !nav._clicks.includes('L2'), 'deepBrowse: clicked nav (Leadership, Contact) + person (Jane Roe), not Careers');
  ok((await PF.deepBrowse(null, 'x')).length === 0 && (await PF.deepBrowse({ open: async () => ({ ok: false }) }, 'x')).length === 0, 'deepBrowse: no browser / failed open → [] (fail-soft)');

  // --- broker filter ---
  ok(PF.isBrokerUrl('https://www.zoominfo.com/p/Jane-Roe/123') && PF.isBrokerUrl('https://wiza.co/d/acme/jane') && PF.isBrokerUrl('https://contactout.com/Jane-Roe-99') && PF.isBrokerUrl('https://rocketreach.co/jane'), 'isBrokerUrl: flags known data-broker domains');
  ok(!PF.isBrokerUrl('https://www.duke-energy.com/our-company/leadership') && !PF.isBrokerUrl('https://raineycenter.org/about/team') && !PF.isBrokerUrl('https://floridadep.gov/contacts'), 'isBrokerUrl: real company/org/gov pages are NOT brokers');
  // deepBrowse on a broker LANDING → mints nothing (falls back)
  const brokerNav = {
    open: async () => ({ ok: true, url: 'ddg' }),
    openTopResult: async () => ({ ok: true, url: 'https://www.zoominfo.com/p/Jane-Roe/123' }),
    read: async () => ({ ok: true, url: 'https://www.zoominfo.com/p/Jane-Roe/123', text: 'Reveal Jane Roe email. '.repeat(20) + '\nInteractive elements:\n  [L0] link: Free Email Reveal' }),
    click: async () => ({ ok: true, url: 'https://www.zoominfo.com/upgrade' }), back: async () => ({ ok: true, url: 'x' }),
  };
  ok((await PF.deepBrowse(brokerNav, 'Jane Roe Acme email')).length === 0, 'deepBrowse: a data-broker landing → [] (skipped, no broker CTA minted)');
  // a PDF landing can never deep-browse — every attempt was "0 layer(s)" retried forever (live: fcoe.org loop)
  const pdfNav = {
    open: async () => ({ ok: true, url: 'ddg' }),
    openTopResult: async () => ({ ok: true, url: 'https://www.fcoe.org/files/documents/FCSS_Directory_18-19-v2.pdf' }),
    read: async () => ({ ok: true, url: 'https://www.fcoe.org/files/documents/FCSS_Directory_18-19-v2.pdf', text: '' }),
    click: async () => ({ ok: true, url: 'x' }), back: async () => ({ ok: true, url: 'x' }),
  };
  ok((await PF.deepBrowse(pdfNav, 'Fresno county schools directory')).length === 0, 'deepBrowse: a PDF landing → [] (skipped; the layered fetch reads PDFs, the browser cannot)');
  // …and the found artifact is BANKED, not discarded (Lucas: "logging the data or discarding it outright?")
  const banked = [];
  await PF.deepBrowse(pdfNav, 'Fresno county schools directory', { bankPdf: (u) => banked.push(u) });
  ok(banked.length === 1 && /FCSS_Directory/.test(banked[0]), 'a caught PDF routes to the download lane via bankPdf — the spent search compute still pays');

  // --- ARCHIVED-SOURCE detector (the 2013 Maryland Manual read as a CURRENT roster) ---
  ok(PF.isArchivedSource('https://2013mdmanual.msa.maryland.gov/msa/mdmanual/36loc/bcity/html/bcitye.html', ''), 'archived: a dated-manual subdomain flags');
  ok(PF.isArchivedSource('https://www.ojp.gov/pdffiles1/Digitization/17349NCJRS.pdf', ''), 'archived: a digitization scan path flags');
  ok(PF.isArchivedSource('https://web.archive.org/web/2019/https://x.gov/team', ''), 'archived: a wayback copy flags');
  ok(PF.isArchivedSource('https://msa.maryland.gov/page', 'Note: In this past edition of Maryland Manual, some links are to external sites. View the current Manual'), 'archived: the page\'s own past-edition banner flags');
  ok(!PF.isArchivedSource('https://www.sos.la.gov/elections-voting/find-public-officials', 'The Elected Officials Database provides a current listing of all elected public officials.'), 'a live current roster does NOT flag');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
