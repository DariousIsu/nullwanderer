/* Smoke: lib/site_crawler — THE SITE-SWEEP WALKER (hermetic, temp sq.db, injected doors).
 * The frontier site_ledger draws on every read finally gets WALKED. Proves: the order surface
 * (start / status-never-starts / stop / clarify); robots + sitemap parsing; the bootstrap tick
 * (seed fetch + sitemap → frontier); walk ticks (drain, TTL reuse without a fetch, robots skip,
 * binary skip, frontier self-extension from harvested links, honest counters); completion detected
 * only when pending is empty, with an exact-counts report; one sweep at a time; the swept-host
 * leash-bypass authority; and the main.js/work_state wiring pins (driver, door, both leash
 * bypasses, status line). Re-starving any of these fails here.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_site_crawler.js
 */
const path = require('path'), os = require('os'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_smoke_crawler_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';
const db = require(`${ROOT}/lib/db`);
const SL = require(`${ROOT}/lib/site_ledger`);
const SC = require(`${ROOT}/lib/site_crawler`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    db.init();

    // ── the order surface ─────────────────────────────────────────────────────────────────────
    let m = SC.orderMatch('run the deep crawl on catahoulaparish.gov');
    ok(m && m.kind === 'start' && m.target === 'catahoulaparish.gov', 'gap_plan go-phrase "run the deep crawl on X" → start with the domain');
    m = SC.orderMatch('sweep the whole site at https://www.stmarys.net/council');
    ok(m && m.kind === 'start' && /stmarys\.net/.test(m.target), 'whole-site sweep with a URL → start with the URL');
    m = SC.orderMatch('did the site sweep finish yet?');
    ok(m && m.kind === 'status', 'a question-shaped mention → status, NEVER a start');
    m = SC.orderMatch('did the deep crawl of catahoulaparish.gov finish?');
    ok(m && m.kind === 'status', 'question + a named host still → status (a target never overrides question shape)');
    m = SC.orderMatch('run the deep crawl on x.gov — is it ready to go?');
    ok(m && m.kind === 'start', 'a STRONG imperative (run) beats incidental status words');
    m = SC.orderMatch('stop the site sweep');
    ok(m && m.kind === 'stop', 'stop order routes to stop');
    m = SC.orderMatch('go run a whole-site crawl on that parish site');
    ok(m && m.kind === 'clarify', 'imperative with no nameable site → clarify (ask, never guess)');
    m = SC.orderMatch('the full crawl of catahoulaparish.gov never happened');
    ok(m && m.kind === 'status', 'a complaint-shaped mention → status, never an auto-start (the plan asks, it never just does)');
    ok(SC.orderMatch('tell me about the bill census') === null, 'unrelated text never matches');

    // ── robots + sitemap parsing ──────────────────────────────────────────────────────────────
    const rules = SC.parseRobots('User-agent: googlebot\nDisallow: /google-only\n\nUser-agent: *\nDisallow: /admin\nDisallow: /*.php$\nSitemap: https://x.gov/sm.xml\n');
    ok(rules.disallow.length === 2 && rules.disallow[0] === '/admin', 'robots: only the * group\u2019s rules apply (other UA groups ignored)');
    ok(rules.sitemaps.length === 1, 'robots: Sitemap lines collected');
    ok(SC.robotsBlocked('https://x.gov/admin/users', rules), 'robots: prefix Disallow blocks');
    ok(SC.robotsBlocked('https://x.gov/page.php', rules), 'robots: wildcard + $ pattern blocks');
    ok(!SC.robotsBlocked('https://x.gov/council', rules), 'robots: unlisted path passes');
    const locs = SC.parseSitemap('<urlset><url><loc>https://x.gov/a</loc></url><url><loc> https://x.gov/b </loc></url></urlset>');
    ok(locs.length === 2 && locs[1] === 'https://x.gov/b', 'sitemap: locs parsed and trimmed');

    // ── lifecycle: start / one-at-a-time ──────────────────────────────────────────────────────
    const st = SC.startSweep('https://x.gov/', { reason: 'smoke', requestedBy: 'smoke' });
    ok(st.ok && st.host === 'x.gov', 'startSweep creates the active sweep');
    ok(SC.startSweep('https://other.org/').busy, 'one sweep at a time — a second host is refused while active');
    ok(SC.startSweep('https://www.x.gov/again').already, 'restarting the same host (www-blind) reports the existing sweep');
    ok(SC.isSweptHost('www.x.gov'), 'isSweptHost: the active host authorizes the leash bypass (www-blind)');
    ok(!SC.isSweptHost('unrelated.com'), 'isSweptHost: an unswept host does not');

    // ── bootstrap tick: robots + seed + sitemap → frontier ────────────────────────────────────
    const fetched = [];
    const mkEsc = (links) => async (url) => { fetched.push(url); return { ok: true, text: 'y'.repeat(400), via: 'plain fetch', links, finalUrl: url }; };
    const rawGets = [];
    const rawGet = async (url) => {
      rawGets.push(url);
      if (/robots\.txt$/.test(url)) return 'User-agent: *\nDisallow: /private\nSitemap: https://x.gov/sm.xml\n';
      if (/sm\.xml$/.test(url)) return '<urlset><url><loc>https://x.gov/from-sitemap</loc></url></urlset>';
      return null;
    };
    const noSleep = async () => {};
    let r = await SC.sweepTick({ escalate: mkEsc(['https://x.gov/council', 'https://x.gov/private/x', 'https://x.gov/report.pdf', 'https://other.org/away']), rawGet, sleep: noSleep, log: () => {} });
    ok(r.status === 'active' && r.say.length === 1 && /underway/.test(r.say[0]), 'bootstrap tick narrates the start');
    ok(fetched.length === 1 && fetched[0] === 'https://x.gov', 'bootstrap fetched exactly the seed page');
    const plan0 = SL.getPlan('x.gov');
    const urls0 = plan0.urls.map((e) => e.url);
    ok(urls0.includes('https://x.gov/from-sitemap'), 'sitemap locs entered the frontier');
    ok(urls0.includes('https://x.gov/council') && !urls0.includes('https://other.org/away'), 'seed links entered; foreign-host links never do');

    // ── walk ticks: robots skip, binary skip, self-extension, counters ────────────────────────
    fetched.length = 0;
    r = await SC.sweepTick({ escalate: mkEsc(['https://x.gov/deep-page']), rawGet, sleep: noSleep, log: () => {}, bite: 10 });
    ok(!fetched.includes('https://x.gov/private/x'), 'robots-disallowed page was never fetched');
    ok(!fetched.some((u) => /report\.pdf/.test(u)), 'a PDF never goes through the page ladder (no downloadPdf door injected → counted, skipped)');
    ok(fetched.includes('https://x.gov/deep-page'), 'the frontier SELF-EXTENDS — a link harvested mid-walk gets walked in the same sweep');
    ok(r.status === 'done', 'completion detected once pending is empty');
    const rep = r.say.join(' ');
    ok(/COMPLETE/.test(rep) && /ONE source/.test(rep), 'completion report delivered, carrying the one-source origin doctrine');
    const fin = SC.lastSweep();
    ok(fin.status === 'done' && fin.skipped_robots === 1 && fin.skipped_binary === 1, `honest counters (robots ${fin.skipped_robots}, binary ${fin.skipped_binary})`);
    ok(fin.pages_fetched >= 3, `pages_fetched counts live fetches (${fin.pages_fetched})`);
    ok(SC.isSweptHost('x.gov'), 'isSweptHost: a recently finished sweep still authorizes decomposition (the decompose lag window)');

    // ── TTL reuse — "each page only once", both layers ────────────────────────────────────────
    // Layer 1 (plan-entry): a link ALREADY in the ledger at buildPlan time enters the frontier as
    // done — the walker never even sees it. Layer 2 (walker): a page read by ANOTHER lane
    // mid-sweep is served from the ledger by shouldSkip and counted as reused.
    SL.record('https://y.org/preheld', { kind: 'page', chars: 900 });
    const st2 = SC.startSweep('https://y.org/', { requestedBy: 'smoke' });
    ok(st2.ok, 'a second sweep starts after the first completed');
    await SC.sweepTick({ escalate: mkEsc(['https://y.org/preheld', 'https://y.org/midread', 'https://y.org/fresh']), rawGet: async () => null, sleep: noSleep, log: () => {} });   // bootstrap
    const planY = SL.getPlan('y.org');
    ok(planY.urls.some((e) => e.url === 'https://y.org/preheld' && e.status === 'done'), 'plan-entry dedup: a pre-held page enters the frontier already done');
    SL.record('https://y.org/midread', { kind: 'page', chars: 700 });   // another lane reads it mid-sweep
    fetched.length = 0;
    r = await SC.sweepTick({ escalate: mkEsc([]), rawGet: async () => null, sleep: noSleep, log: () => {}, bite: 10 });
    ok(!fetched.includes('https://y.org/preheld') && !fetched.includes('https://y.org/midread') && fetched.includes('https://y.org/fresh'), 'neither held page re-fetched; the fresh page fetched');
    ok(SC.lastSweep().pages_reused === 1, 'the walker-layer reuse is counted, not hidden');

    // ── stop order ────────────────────────────────────────────────────────────────────────────
    const st3 = SC.startSweep('https://z.gov/', { requestedBy: 'smoke' });
    ok(st3.ok && SC.stopSweep({}).ok && !SC.activeSweep(), 'stopSweep ends the active sweep');
    ok(SC.standingLine() && /z\.gov/.test(SC.standingLine()), 'standingLine reports the last sweep, measured');

    // ── re-sweep = refresh: stale done-entries reopen; fresh ones stay done ───────────────────
    const later = Date.now() + SL.DEFAULT_TTL_MS + 60000;
    const st4 = SC.startSweep('https://x.gov/', { requestedBy: 'smoke', now: later });
    ok(st4.ok && st4.reopened > 0, `a re-sweep past the TTL reopens stale plan entries (${st4.reopened}) instead of instantly "completing"`);
    ok(SL.getPlan('x.gov').urls.some((e) => e.status === 'pending'), 'the reopened frontier is walkable again');
    SC.stopSweep({});

    // ── wiring pins (main.js + work_state + the ladder pass-through) ──────────────────────────
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    ok(/sweepTick\(\{/.test(main), 'main.js: the walker driver rides the metabolism tick');
    ok(/orderMatch\(userMessage\)/.test(main), 'main.js: the sweep door reads the user turn');
    ok(/THE SWEEP ORGAN OWNS THIS ORDER/.test(main) && /do NOT search, fetch, enumerate/.test(main),
      'main.js: the start block carries the OWNERSHIP RAIL (live catch #1: the agent loop ran its own ad-hoc crawl and claimed completion)');
    ok(/never claim "no crawl state exists"/.test(main), 'main.js: the ledger-row-is-the-state rail (live catch #1: false absence claim over an existing sweep row)');
    ok(/isSweptHost\(_swHost\)/.test(main), 'main.js: _docLeashOk carries the swept-host bypass');
    ok(/isSweptHost\(_swHost2\)/.test(main), 'main.js: the download-ingest leash carries the swept-host bypass');
    const ws = fs.readFileSync(path.join(ROOT, 'lib', 'work_state.js'), 'utf8');
    ok(/site_crawler'\)\.standing\(\)/.test(ws), 'work_state: the sweep is visible to whole-plate status (never a composed absence)');
    const fe = fs.readFileSync(path.join(ROOT, 'lib', 'fetch_escalation.js'), 'utf8');
    ok(/links: r\.links \|\| null/.test(fe), 'fetch_escalation: the plain-fetch door passes harvested links through');
    const wsr = fs.readFileSync(path.join(ROOT, 'lib', 'web_search.js'), 'utf8');
    ok(/finalUrl,/.test(wsr) && /links,/.test(wsr), 'web_search.fetchPage returns links + finalUrl (the fetch lane can feed a frontier)');
  } catch (e) {
    fail++;
    console.error('  ✗ smoke crashed:', e.message, e.stack);
  } finally {
    try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
