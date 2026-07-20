/**
 * Offline smoke for the verification harness STAGE 3 (studio/verify_resolve.js):
 * unit → source text, via the deterministic resolution ladder. No cloud, no Echo — a MOCK
 * callTool drives each rung's blocked-signal and proves the NEXT branch fires (the build-order
 * requirement for this step).
 *
 * Run: node scripts/smoke_verify_resolve.js
 */
const VR = require('../studio/verify_resolve');
const { resolveUnit, resolveUnits, isBlocked, readFetch, sourceKind, searchToolKey } = VR;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const body = (n) => 'x'.repeat(n);                 // a body of n chars (passes MIN_BODY when big)
const run = (p) => p;                              // tiny await helper for readability

// Build a mock callTool from a routing table: { toolName: (args) => result }.
function mock(table) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    const h = table[name];
    if (!h) throw new Error(`mock: no handler for ${name}`);
    return typeof h === 'function' ? h(args) : h;
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ---- blocked-signal unit tests (the one mechanical judgement) ------------------------------
  ok('200 + real body → not blocked', isBlocked({ status: 200, body: body(200) }).blocked === false);
  ok('404 → blocked http-404', (() => { const b = isBlocked({ status: 404, body: body(200) }); return b.blocked && b.reason === 'http-404'; })());
  ok('empty body → blocked', isBlocked({ status: 200, body: '' }).blocked === true);
  ok('paywall marker → blocked', isBlocked({ status: 200, body: 'Please subscribe to continue reading ' + body(80) }).reason === 'paywall');
  ok('login redirect → blocked', isBlocked({ status: 200, body: body(200), finalUrl: 'https://x.com/account/login' }).reason === 'login-redirect');
  ok('no status but body → not blocked (assume ok)', isBlocked({ body: body(200) }).blocked === false);

  // BOT/WAF INTERSTITIALS — these return HTTP 200 with a long body, so status and length both pass.
  // Letting one through is the worst failure in this pipeline: the judge reads a real page, finds the
  // claim absent, and issues a confident "not supported" against the author. Both strings below are
  // verbatim from cert CFC-2026-07-20-01, where they were printed AS the cited source passage.
  ok('cloudflare-style interstitial → blocked bot-block',
    isBlocked({ status: 200, body: 'This website is using a security service to protect itself from online attacks. ' + body(120) }).reason === 'bot-block');
  ok('WAF "actions that could trigger this block" page → blocked',
    isBlocked({ status: 200, body: 'You have been blocked. There are several actions that could trigger this block including submitting a certain word or phrase, a SQL command or malformed data. ' + body(60) }).reason === 'bot-block');
  ok('"Attention Required! | Cloudflare" → blocked',
    isBlocked({ status: 200, body: 'Attention Required! | Cloudflare ' + body(120) }).reason === 'bot-block');
  ok('"Checking your browser before accessing" → blocked',
    isBlocked({ status: 200, body: 'Checking your browser before accessing example.com ' + body(120) }).reason === 'bot-block');
  ok('"Verify you are human" → blocked',
    isBlocked({ status: 200, body: 'Verify you are human by completing the action below. ' + body(120) }).reason === 'bot-block');
  // Must NOT fire on real prose that merely discusses security services or blocking.
  ok('article ABOUT security services is not a block page',
    isBlocked({ status: 200, body: 'The committee reviewed whether a security service should be procured, and voted to block the amendment. ' + body(120) }).blocked === false);

  // ---- search-query selection -----------------------------------------------------------------
  // A two-word proper noun as the WHOLE query is how "Camaro Dragon" (a Chinese APT group) resolved
  // to Wikipedia's Chevrolet Camaro on cert CFC-2026-07-20-01.
  ok('short name-quote → falls back to the surrounding sentence',
    VR.searchQueryFor({ quote: 'Camaro Dragon', text: 'A group dubbed "Camaro Dragon" deployed a custom firmware implant.' })
      === 'A group dubbed "Camaro Dragon" deployed a custom firmware implant.');
  ok('one-word name-quote → sentence',
    VR.searchQueryFor({ quote: 'Brickstorm', text: 'Researchers named the implant "Brickstorm" in a 2026 report.' })
      === 'Researchers named the implant "Brickstorm" in a 2026 report.');
  ok('substantial quote is STILL the query (4+ words)',
    VR.searchQueryFor({ quote: 'committee rejected the amendment', text: 'the committee rejected the amendment' })
      === 'committee rejected the amendment');
  ok('long quote under 4 words still qualifies on length',
    VR.searchQueryFor({ quote: 'antidisestablishmentarianism reconsidered', text: 'ignored' })
      === 'antidisestablishmentarianism reconsidered');
  ok('no quote → text', VR.searchQueryFor({ text: 'just a claim sentence' }) === 'just a claim sentence');
  ok('query capped at 300 chars', VR.searchQueryFor({ text: 'y'.repeat(500) }).length === 300);
  ok('empty unit → empty query, no throw', VR.searchQueryFor({}) === '' && VR.searchQueryFor(null) === '');

  // readFetch tolerates JSON shape + plain-text shape
  ok('readFetch parses JSON {status,body}', readFetch({ text: JSON.stringify({ status: 200, body: 'hello world' }) }).body === 'hello world');
  ok('readFetch falls back to raw text', readFetch('just text here').body === 'just text here');

  // ---- source-kind routing -------------------------------------------------------------------
  ok('courtlistener host → court', sourceKind({ url: 'https://www.courtlistener.com/opinion/123/' }) === 'court');
  ok('sec.gov host → sec', sourceKind({ url: 'https://www.sec.gov/edgar/x' }) === 'sec');
  ok('federalregister host → fr', sourceKind({ url: 'https://www.federalregister.gov/d/2021-1' }) === 'fr');
  ok('doi → academic', sourceKind({ doi: '10.1126/science.abc' }) === 'academic');
  ok('case cite in text → court', sourceKind({ text: 'In Roe v. Wade the Court held…' }) === 'court');
  ok('plain url → web', sourceKind({ url: 'https://example.com/a' }) === 'web');
  ok('searchToolKey maps court→courtSearch', searchToolKey('court') === 'courtSearch');

  // ---- RUNG 1: direct fetch succeeds ---------------------------------------------------------
  {
    const ct = mock({ web_fetch: ({ url }) => ({ status: 200, body: 'verbatim source text ' + body(80), final_url: url }) });
    const r = await run(resolveUnit({ uid: 'a0.s0', url: 'https://gao.gov/r.pdf' }, ct));
    ok('rung1 fetch → resolved tier=fetch', r.resolved && r.tier === 'fetch');
    ok('rung1 carries source_text + source_url', /verbatim source text/.test(r.source_text) && r.source_url === 'https://gao.gov/r.pdf');
    ok('rung1 trail has exactly one ok fetch', r.trail.length === 1 && r.trail[0].ok === true);
  }

  // ---- RUNG 2: fetch blocked (paywall) → archive succeeds ------------------------------------
  {
    const ct = mock({
      web_fetch: ({ url }) => url.includes('web.archive.org')
        ? { status: 200, body: 'archived copy of the report ' + body(80), final_url: url }
        : { status: 200, body: 'subscribe to continue reading ' + body(80) },     // paywalled live page
      wayback_history: () => ({ snapshots: [{ url: 'https://web.archive.org/snap/r' }] }),
    });
    const r = await run(resolveUnit({ uid: 'a1.s0', url: 'https://news.example/r' }, ct));
    ok('rung2 paywall → archive resolves (tier=archive)', r.resolved && r.tier === 'archive', JSON.stringify(r.trail));
    ok('rung2 archive_url recorded', r.archive_url === 'https://web.archive.org/snap/r');
    ok('rung2 trail: live fetch blocked then archive ok', r.trail[0].ok === false && r.trail[0].reason === 'paywall' && r.trail.some(t => t.step === 'archive-fetch' && t.ok));
  }

  // ---- RUNG 3: live 404 + no archive + DOI → open-access resolves ----------------------------
  {
    const ct = mock({
      web_fetch: ({ url }) => url.includes('oa.example')
        ? { status: 200, body: 'open access full text ' + body(80), final_url: url }
        : { status: 404, body: '' },
      wayback_history: () => ({ snapshots: [] }),
      verify_url_history: () => ({}),
      web_resolve_oa: ({ doi }) => ({ oa_url: 'https://oa.example/' + doi }),
    });
    const r = await run(resolveUnit({ uid: 'a2.s0', url: 'https://paywall.journal/x', doi: '10.1/xyz' }, ct));
    ok('rung3 404+no-archive+doi → oa resolves (tier=oa)', r.resolved && r.tier === 'oa', JSON.stringify(r.trail.map(t => [t.step, t.ok, t.reason])));
    ok('rung3 source_url is the OA url', r.source_url === 'https://oa.example/10.1/xyz');
  }

  // ---- RUNG 4: no url, just a quote → search by kind, fetch top-N ----------------------------
  {
    const ct = mock({
      web_search: ({ query }) => ({ results: [
        { url: 'https://a.example/1', title: 'maybe' },     // will be blocked
        { url: 'https://b.example/2', title: 'good' },      // readable
      ] }),
      web_fetch: ({ url }) => url.endsWith('/1')
        ? { status: 403, body: '' }
        : { status: 200, body: 'the committee rejected the amendment ' + body(80), final_url: url },
    });
    const r = await run(resolveUnit({ uid: 'a3.s0', kind: 'quote', quote: 'committee rejected the amendment', text: 'the committee rejected the amendment' }, ct));
    ok('rung4 search → resolved tier=search', r.resolved && r.tier === 'search', JSON.stringify(r.trail.map(t => t.step)));
    ok('rung4 picked the 2nd (readable) result', r.source_url === 'https://b.example/2');
    ok('rung4 search query came from the quote', ct.calls.find(c => c.name === 'web_search').args.query === 'committee rejected the amendment');
  }

  // ---- RUNG 4 routing: academic unit hits academic_search, court unit hits courtlistener ------
  {
    const ct = mock({ academic_search: () => ({ results: [] }), web_resolve_oa: () => ({}) });
    const r = await run(resolveUnit({ uid: 'a4.s0', doi: '10.2/none', text: 'a finding (Smith et al., 2020)' }, ct));
    ok('academic unit routed to academic_search', ct.calls.some(c => c.name === 'academic_search'));
    ok('academic unit w/ dead oa + empty search → inaccessible', r.tier === 'inaccessible' && r.resolved === false);
  }
  {
    const ct = mock({ courtlistener_opinion_search: () => ({ results: [] }) });
    await run(resolveUnit({ uid: 'a5.s0', text: 'see Brown v. Board, the Court ruled' }, ct));
    ok('court unit routed to courtlistener', ct.calls.some(c => c.name === 'courtlistener_opinion_search'));
  }

  // ---- RUNG 5: everything blocked → deterministic terminal -----------------------------------
  {
    const ct = mock({
      web_fetch: () => ({ status: 500, body: '' }),
      wayback_history: () => ({ snapshots: [] }),
      verify_url_history: () => ({}),
      web_search: () => ({ results: [] }),
    });
    const r = await run(resolveUnit({ uid: 'a6.s0', url: 'https://dead.example/x', text: 'unresolvable claim' }, ct));
    ok('rung5 all blocked → inaccessible terminal', r.resolved === false && r.tier === 'inaccessible' && r.reason === 'inaccessible');
    ok('rung5 trail recorded every attempted rung', r.trail.some(t => t.step === 'fetch') && r.trail.some(t => t.step === 'archive') && r.trail.some(t => t.step === 'search'));
  }

  // ---- injected search provider (opts.search) preferred over callTool's web_search -----------
  {
    let echoSearchCalled = false;
    const ct = mock({
      web_search: () => { echoSearchCalled = true; return { results: [] }; },   // engine search keyless/empty
      web_fetch: ({ url }) => ({ status: 200, body: 'the committee rejected the amendment ' + body(80), final_url: url }),
    });
    const injectedSearch = async (q) => ({ results: [{ url: 'https://found.example/a', title: 'hit' }] });
    const r = await run(resolveUnit({ uid: 'a9.s0', kind: 'quote', quote: 'committee rejected the amendment', text: 'committee rejected the amendment' }, ct, { search: injectedSearch }));
    ok('injected search resolves a no-URL claim (tier=search)', r.resolved && r.tier === 'search' && r.source_url === 'https://found.example/a');
    ok('injected search bypasses engine web_search', echoSearchCalled === false);
    ok('trail labels the injected search', r.trail.some(t => t.step === 'search' && t.tool === 'search(injected)'));
  }

  // ---- tool-name parameterization (live wiring can remap without touching the ladder) --------
  {
    const ct = mock({ echo_fetch: ({ url }) => ({ status: 200, body: 'mapped tool worked ' + body(80), final_url: url }) });
    const r = await run(resolveUnit({ uid: 'a7.s0', url: 'https://x/y' }, ct, { tools: { fetch: 'echo_fetch' } }));
    ok('opts.tools remaps the fetch tool name', r.resolved && /mapped tool worked/.test(r.source_text));
  }

  // ---- batch resolveUnits preserves order ----------------------------------------------------
  {
    const ct = mock({ web_fetch: ({ url }) => ({ status: 200, body: 'body for ' + url + ' ' + body(80), final_url: url }) });
    const units = [{ uid: 'u0', url: 'https://s/0' }, { uid: 'u1', url: 'https://s/1' }, { uid: 'u2', url: 'https://s/2' }];
    const rs = await run(resolveUnits(units, ct));
    ok('resolveUnits returns one result per unit in order', rs.length === 3 && rs.map(r => r.uid).join(',') === 'u0,u1,u2');
    ok('resolveUnits all resolved', rs.every(r => r.resolved));
  }

  // ---- graceful when a ladder tool is unavailable (throws) → falls through, no crash ---------
  {
    const ct = mock({
      web_fetch: ({ url }) => url.includes('archive') ? { status: 200, body: 'archived ' + body(80), final_url: url } : { status: 404, body: '' },
      wayback_history: () => { throw new Error('tool offline'); },     // simulate missing tool
      verify_url_history: () => ({ archived_url: 'https://archive/v' }),
    });
    const r = await run(resolveUnit({ uid: 'a8.s0', url: 'https://x/y' }, ct));
    ok('wayback throw → falls through to verify_url_history → resolves', r.resolved && r.tier === 'archive');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
