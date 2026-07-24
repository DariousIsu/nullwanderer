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
// A body of at least n chars that LOOKS LIKE EXTRACTED PROSE. It used to be 'x'.repeat(n), which was
// fine when acceptance was a length floor — but the gate is now shape (verify_resolve.isProse), and a
// wall of 'x' is not a document. A fixture that cannot pass the real gate tests nothing.
const body = (n) => {
  const s = 'The committee reviewed the report and published its findings. ';
  let out = '';
  while (out.length < n || (out.match(/\./g) || []).length < 2) out += s;
  return out;
};
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

  // ---- MULTI-SOURCE CITATIONS (live defect, 2026-07-23) --------------------------------------
  // One endnote routinely names several sources. Keeping only the first discarded the one that
  // actually carried the claim: on the Arizona ESA op-ed, note 1 cites NAEP's interactive trends
  // page AND an Axios write-up stating the claimed 26%/25% — only the trends page was ever read, so
  // the judge reported the author's own citation as unsupported.
  {
    const ct = mock({
      web_fetch: ({ url }) => url.includes('axios')
        ? { status: 200, body: 'Arizona fourth graders scored 26% proficient in reading. ' + body(80), final_url: url }
        : { status: 200, body: 'State comparison trends for 2022 to 2024. ' + body(80), final_url: url },
    });
    const u = { uid: 'a1.s0', kind: 'citation', text: 'Only 26 percent of Arizona fourth graders read at grade level.',
      url: 'https://nationsreportcard.gov/trends', urls: ['https://nationsreportcard.gov/trends', 'https://axios.com/phoenix/reading'] };
    const r = await run(resolveUnit(u, ct));
    ok('every cited url in the note is fetched, not just the first',
      ct.calls.filter(c => c.name === 'web_fetch').length === 2, JSON.stringify(ct.calls.map(c => c.args && c.args.url)));
    ok('the note\'s extra sources ride along as alternates', Array.isArray(r.alternates) && r.alternates.length === 1);
    ok('the alternate carries its OWN url and text',
      r.alternates[0].source_url === 'https://axios.com/phoenix/reading' && /26% proficient/.test(r.alternates[0].source_text));
    ok('the primary is still the first cited source (existing callers unchanged)', r.source_url === 'https://nationsreportcard.gov/trends');

    // A dead primary must not bury a working second source.
    const ct2 = mock({
      web_fetch: ({ url }) => url.includes('axios')
        ? { status: 200, body: 'Arizona fourth graders scored 26% proficient. ' + body(80), final_url: url }
        : { status: 404, body: '' },
      wayback_history: () => ({ snapshots: [] }), verify_url_history: () => ({}),
    });
    const r2 = await run(resolveUnit(u, ct2));
    ok('a dead first url falls through to the note\'s next source', r2.resolved && r2.source_url === 'https://axios.com/phoenix/reading', JSON.stringify(r2.trail.map(t => [t.step, t.ok])));
  }

  // ---- A 200 IS NOT A SOURCE (live defect, 2026-07-23, found by running the real studio button) --
  // Echo's web_extract returned the cited PDF as RAW BYTES and the cited news article as its HTML
  // METADATA ONLY. Both cleared status/length/bot/paywall, so both became THE SOURCE PASSAGE, the
  // browser rung that could actually read them never ran, and the judge — handed "%PDF-1.7 … endobj"
  // and a meta tag — faulted FIVE of eight claims whose citations were fine.
  {
    ok('raw PDF bytes are not a readable source',
      VR.isBlocked({ status: 200, body: '%PDF-1.7 %âã 3803 0 obj <</Linearized 1/L 2431168/O 3805>> endobj ' + body(200) }).blocked === true);
    ok('…and it says WHY, so the trail names the real failure',
      /binary-body/.test(VR.isBlocked({ status: 200, body: '%PDF-1.7 ' + body(200) }).reason));
    ok('a zip/image payload is refused too', VR.isBlocked({ status: 200, body: 'PK' + body(200) }).blocked === true);
    ok('prose merely MENTIONING a pdf is fine', VR.isBlocked({ status: 200, body: 'The report was published as a %PDF file. ' + body(200) }).blocked === false);

    // A thin metadata stub must not END the ladder while a better reader is still untried.
    const meta = 'headline: "Reading scores for Arizona 4th and 8th graders fell"; description: "A decline follows a national trend."';
    const ct = mock({
      web_extract: ({ url }) => /azed/.test(url) ? { status: 200, body: '%PDF-1.7 % 3803 0 obj <</Linearized 1/L 2431168>> endobj' } : { status: 200, body: meta },
      web_fetch: () => ({ status: 200, body: meta }),
    });
    const reader = async () => 'Arizona fourth graders scored 26% proficient in reading in 2024, below the national average. ' + body(600);
    const r = await run(resolveUnit({ uid: 'a1.s0', kind: 'citation', text: 'Only 26 percent read at grade level.', url: 'https://news.example/story' },
      ct, { tools: { fetch: ['web_extract', 'web_fetch'] }, readerFn: reader }));
    ok('a metadata stub does NOT stop the ladder — the real reader still runs',
      r.resolved && /26% proficient/.test(r.source_text), JSON.stringify(r.trail.map(t => [t.tool, t.ok, t.chars])));
    ok('every reader attempt is on the trail with its size', r.trail.filter(t => t.chars != null).length >= 3);

    // The binary case: web_extract "succeeds" with bytes, so the injected reader must still be reached.
    const r2 = await run(resolveUnit({ uid: 'a2.s1', kind: 'citation', text: 'a 30-point gap', url: 'https://www.azed.gov/plan.pdf' },
      ct, { tools: { fetch: ['web_extract', 'web_fetch'] }, readerFn: async () => 'a 29-point gap between FRL vs. Non-FRL in fourth grade. ' + body(600) }));
    ok('a PDF returned as bytes falls through to the reader that can extract it',
      r2.resolved && /29-point gap/.test(r2.source_text), JSON.stringify(r2.trail.map(t => [t.tool, t.ok, t.reason])));

    // ⚠️ CORRECTED BELIEF (same day): I first asserted "a thin body is accepted as a last resort".
    // That conflated SIZE with SHAPE. The stub above is not a thin document — it is the document's
    // CONTAINER, and handing container to the judge is the exact harm this lane exists to prevent.
    // When every reader returns container the honest answer is `inaccessible`, WITH the reason.
    const stubOnly = mock({ web_extract: () => ({ status: 200, body: meta }), web_fetch: () => ({ status: 200, body: meta }) });
    const r3 = await run(resolveUnit({ uid: 'a1.s9', kind: 'citation', text: 'x', url: 'https://news.example/story' },
      stubOnly, { tools: { fetch: ['web_extract', 'web_fetch'] } }));
    ok('container from every reader → inaccessible, never judged as the source',
      r3.resolved === false && r3.tier === 'inaccessible' && !r3.source_text, JSON.stringify(r3.trail.map(t => t.reason)));
    ok('…and the trail says WHY it was refused, not just that it failed',
      r3.trail.some(t => /sentence structure|markup/.test(t.reason || '')), JSON.stringify(r3.trail.map(t => t.reason)));

    // A genuinely SHORT but real extract is still a source — shape gates, length only ranks.
    const shortProse = 'The board voted 5-2 to approve the measure. It takes effect in July of next year.';
    const brief = mock({ web_extract: () => ({ status: 200, body: shortProse }) });
    const r4 = await run(resolveUnit({ uid: 'a1.s8', kind: 'citation', text: 'x', url: 'https://news.example/brief' },
      brief, { tools: { fetch: ['web_extract'] } }));
    ok('a short but real extract IS accepted (size is not the gate)',
      r4.resolved === true && /voted 5-2/.test(r4.source_text), JSON.stringify(r4));
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

  // ---- CITATION LANE (default): a source found by SEARCH is not the source the document CITED --
  // The lane asks one question — is this claim correctly sourced to the source it names? — so source
  // substitution is off unless a caller explicitly opts in (the fact-check lane does).
  {
    const ct = mock({
      web_search: () => ({ results: [{ url: 'https://b.example/2', title: 'good' }] }),
      web_fetch: ({ url }) => ({ status: 200, body: 'plausible but unrelated text ' + body(80), final_url: url }),
    });
    const r = await run(resolveUnit({ uid: 'a3.s0', kind: 'quote', quote: 'committee rejected the amendment', text: 'the committee rejected the amendment' }, ct));
    // This unit cites NOTHING (a quote with no url), so the honest terminal is `uncited` — we did not
    // fail to reach a source, there was none to reach. Either way the lane must not substitute one.
    ok('citation lane: an UNCITED claim terminates as uncited, NOT a substitute', r.resolved === false && r.tier === 'uncited', JSON.stringify(r.trail.map(t => t.step)));
    ok('citation lane: no search tool was even called', !ct.calls.some(c => c.name === 'web_search'), JSON.stringify(ct.calls.map(c => c.name)));
    // …and a claim that DOES cite a source we cannot reach stays `inaccessible`. The two must not
    // collapse: one is the author's gap, the other is ours.
    {
      const dead = mock({ web_fetch: () => ({ status: 404, body: '' }) });
      const d = await run(resolveUnit({ uid: 'a3.s9', kind: 'citation', text: 'a cited claim', url: 'https://dead.example/gone' }, dead));
      ok('citation lane: a CITED but unreachable source → inaccessible', d.resolved === false && d.tier === 'inaccessible', JSON.stringify(d));
    }
    ok('citation lane: trail records why', (r.trail.find(t => t.step === 'search') || {}).reason === 'search-disabled (citation lane: cited source only)');
  }

  // ---- RUNG 4 (fact-check lane only, allowSearch): search by kind, fetch top-N ----------------
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
    const r = await run(resolveUnit({ uid: 'a3.s0', kind: 'quote', quote: 'committee rejected the amendment', text: 'the committee rejected the amendment' }, ct, { allowSearch: true }));
    ok('rung4 search → resolved tier=search', r.resolved && r.tier === 'search', JSON.stringify(r.trail.map(t => t.step)));
    ok('rung4 picked the 2nd (readable) result', r.source_url === 'https://b.example/2');
    ok('rung4 search query came from the quote', ct.calls.find(c => c.name === 'web_search').args.query === 'committee rejected the amendment');
  }

  // ---- RUNG 4 routing: academic unit hits academic_search, court unit hits courtlistener ------
  {
    const ct = mock({ academic_search: () => ({ results: [] }), web_resolve_oa: () => ({}) });
    const r = await run(resolveUnit({ uid: 'a4.s0', doi: '10.2/none', text: 'a finding (Smith et al., 2020)' }, ct, { allowSearch: true }));
    ok('academic unit routed to academic_search', ct.calls.some(c => c.name === 'academic_search'));
    ok('academic unit w/ dead oa + empty search → inaccessible', r.tier === 'inaccessible' && r.resolved === false);
  }
  {
    const ct = mock({ courtlistener_opinion_search: () => ({ results: [] }) });
    await run(resolveUnit({ uid: 'a5.s0', text: 'see Brown v. Board, the Court ruled' }, ct, { allowSearch: true }));
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
    const r = await run(resolveUnit({ uid: 'a9.s0', kind: 'quote', quote: 'committee rejected the amendment', text: 'committee rejected the amendment' }, ct, { search: injectedSearch, allowSearch: true }));
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
