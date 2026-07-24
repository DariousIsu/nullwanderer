/**
 * Offline smoke for the FACT CHECK lane (studio/verify_factcheck.js) — the second lane.
 *
 * The lane's contract is as much about what it must NOT do as what it does: it looks for INDEPENDENT
 * sources and reports corroboration and counter-evidence for the author to weigh, and it never rules
 * on whether the author cited correctly. Fully offline — search, fetch and the model are all mocked.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke_verify_factcheck.js
 */
const FC = require('../studio/verify_factcheck');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const body = (n) => 'x'.repeat(n);

// A search that returns: the SAME host the document cited, two independent outlets, and a duplicate
// of one of them (to prove one-voice-per-outlet).
const search = async () => ({ results: [
  { url: 'https://cited.example/original', title: 'The cited source' },
  { url: 'https://supporter.example/a', title: 'Supporter' },
  { url: 'https://supporter.example/b', title: 'Supporter again' },
  { url: 'https://opponent.example/c', title: 'Opponent' },
] });
const fetch = async (u) => {
  if (/supporter/.test(u)) return 'The bureau confirmed the increase was 14.6 percent. ' + body(80);
  if (/opponent/.test(u)) return 'Independent analysts put the increase closer to 9 percent. ' + body(80);
  return 'Original cited page. ' + body(80);
};
const complete = async ({ messages }) => (/confirmed/.test(messages[1].content)
  ? '{"stance":"supports","quote":"was 14.6 percent","note":"affirms the figure"}'
  : '{"stance":"counters","quote":"closer to 9 percent","note":"disputes the figure"}');

const CLAIM = { uid: 'a1.s0', claim: 'The increase was 14.6 percent.', sourceUrl: 'https://cited.example/original' };

(async () => {
  // ---- stance parsing ------------------------------------------------------------------------
  ok('parses a clean JSON stance', FC.parseStance('{"stance":"supports","quote":"q","note":"n"}').stance === 'supports');
  ok('parses a fenced stance', FC.parseStance('```json\n{"stance":"counters"}\n```').stance === 'counters');
  ok('tolerates a bare word', FC.parseStance('this source supports the claim').stance === 'supports');
  // The SAFE default: an unparseable answer must never become a "counter" the author must answer for.
  ok('garbage → unrelated, never counters', FC.parseStance('%%%').stance === 'unrelated');
  ok('empty → unrelated', FC.parseStance('').stance === 'unrelated' && FC.parseStance(null).stance === 'unrelated');

  // ---- aggregation ---------------------------------------------------------------------------
  ok('support only → corroborated', FC.aggregate([{ stance: 'supports' }]) === 'corroborated');
  ok('counter only → contested', FC.aggregate([{ stance: 'counters' }]) === 'contested');
  ok('both → mixed (the record is split; say so)', FC.aggregate([{ stance: 'supports' }, { stance: 'counters' }]) === 'mixed');
  ok('all unrelated → no-independent-source', FC.aggregate([{ stance: 'unrelated' }]) === 'no-independent-source');
  ok('nothing found → no-independent-source', FC.aggregate([]) === 'no-independent-source');

  // ---- gathering: INDEPENDENT means independent ----------------------------------------------
  {
    const { sources: got, hits, sameHost } = await FC.gatherSources(CLAIM, { search, fetch });
    ok('the CITED host is excluded (same site is not corroboration)', !got.some(s => /cited\.example/.test(s.url)), JSON.stringify(got.map(s => s.url)));
    ok('one voice per outlet (duplicate host dropped)', got.filter(s => /supporter\.example/.test(s.url)).length === 1);
    ok('gathered both independent outlets', got.length === 2, JSON.stringify(got.map(s => s.url)));
    ok('gathering reports what it saw, not just what it kept', hits > 0 && sameHost > 0, JSON.stringify({ hits, sameHost }));
    const capped = await FC.gatherSources(CLAIM, { search, fetch, sources: 1 });
    ok('respects the source cap', capped.sources.length === 1);
    ok('no search/fetch injected → gathers nothing, no throw', (await FC.gatherSources(CLAIM, {})).sources.length === 0);
  }

  // ---- REGRESSION (latent defect, 2026-07-23): the lane must be able to READ a search result -----
  // callTool returns the MCP envelope {content:[{text:'…json…'}]}. This module hand-rolled
  // `results||items||hits`, which finds no `results` key on an envelope and yields ZERO hits — so
  // every claim came back "no independent source addressed this claim" while the lane was simply
  // blind. main.js currently injects a pre-unwrapped search fn, so this was latent, not live; it
  // would go live the moment anyone relied on the documented callTool fallback.
  {
    const envelope = { content: [{ type: 'text', text: JSON.stringify({ results: [
      { url: 'https://indep.example/a', title: 'Independent A' },
    ] }) }] };
    ok('an MCP envelope is read, not silently dropped', FC.readHits(envelope).length === 1, JSON.stringify(FC.readHits(envelope)));
    ok('a bare array still reads', FC.readHits([{ url: 'https://x.example/1' }]).length === 1);
    ok('a {results:[…]} object still reads', FC.readHits({ results: [{ link: 'https://y.example/2' }] }).length === 1);

    const r = await FC.factCheckOne(
      { uid: 'u1', claim: 'the index rose 15 percent', sourceUrl: 'https://cited.example/x' },
      { search: async () => envelope, fetch: async () => 'Records show the index rose 15 percent last year, analysts said, confirming the figure.',
        complete: async () => JSON.stringify({ stance: 'supports', quote: 'the index rose 15 percent', note: 'affirms' }) });
    ok('a claim with a real corroborating source is NOT reported as unsourced', r.stance === 'corroborated', JSON.stringify(r));
  }

  // ---- REFERENCE PAGES AND HOMEPAGES ARE NOT SOURCES (live defect, 2026-07-23) -----------------
  // Searching "Only 25 percent of eighth graders do." live returned merriam-webster.com/dictionary/only
  // and match.com — both were fetched with the browser and handed to the model to rule on the claim.
  // Same class as cert CFC-2026-07-20-01's two Cambridge Dictionary "consulted sources".
  {
    const U = FC.isUsableSource;
    ok('a dictionary entry is refused', !U('https://www.merriam-webster.com/dictionary/only'));
    ok('a dictionary PATH on any host is refused', !U('https://example.org/dictionary/percent'));
    ok('a bare homepage is refused', !U('https://www.match.com/') && !U('https://lorex.com'));
    ok('a real article is kept', U('https://www.azcentral.com/story/news/education/2025/naep-arizona-scores'));
    ok('garbage input is refused, not thrown on', !U('') && !U(null) && !U('not a url'));

    // …and it is refused BEFORE any fetch, so a junk hit costs neither a browser read nor a model call.
    let fetched = 0;
    const g = await FC.gatherSources(
      { uid: 'u', claim: 'the index rose 15 percent last year in the state', sourceUrl: 'https://cited.example/x' },
      { search: async () => ({ results: [
        { url: 'https://www.merriam-webster.com/dictionary/index', title: 'index' },
        { url: 'https://match.com/', title: 'match' },
        { url: 'https://news.example/real-story', title: 'Real story' },
      ] }),
      fetch: async () => { fetched++; return 'Records show the index rose 15 percent last year, the office said.'; },
      complete: async () => JSON.stringify({ stance: 'supports', quote: 'rose 15 percent', note: 'ok' }) });
    ok('junk results are rejected before they are fetched', fetched === 1, `fetched=${fetched}`);
    ok('the real article still gets through', g.sources.length === 1 && /news\.example/.test(g.sources[0].url));
    ok('rejections are counted, not hidden', g.unusable === 2, JSON.stringify(g));
    ok('and the note says the results were unusable, not that the record is silent',
      /reference pages or site homepages/.test(FC.nothingFoundNote(true, { hits: 2, sources: 0, fetchFailed: 0, sameHost: 0, unusable: 2 })));
  }

  // ---- A SENTENCE IS NOT ALWAYS A QUERY --------------------------------------------------------
  // A claim that leans on its paragraph ("Only 25 percent of eighth graders do.") names no subject,
  // so searching it alone returns pages about the word "only".
  {
    const thin = { claim: 'Only 25 percent of eighth graders do.',
      context: 'Arizona fourth graders have below-average reading proficiency. Only 26 percent read at grade level. Only 25 percent of eighth graders do.' };
    const q = FC.searchQueryFor(thin);
    ok('a context-free claim is searched WITH its paragraph', /Arizona/.test(q) && /eighth graders/.test(q), q);
    const full = { claim: 'Arizona fourth graders have below-average reading proficiency compared to the rest of the nation.', context: 'some paragraph' };
    ok('a self-sufficient claim is searched on its own', FC.searchQueryFor(full) === full.claim, FC.searchQueryFor(full));
    ok('no context available → still searches the claim, never empty', FC.searchQueryFor({ claim: 'Only 25 percent do.' }) === 'Only 25 percent do.');
    ok('the query stays within the engine limit', FC.searchQueryFor({ claim: 'x y.', context: 'z '.repeat(500) }).length <= 300);
  }

  // ---- "nothing found" must say WHICH nothing --------------------------------------------------
  // Our failure to search and the record's silence are different facts; printing ours in the
  // record's voice is how a lane stays dead for a whole run without anyone noticing.
  {
    const n = FC.nothingFoundNote;
    ok('no tools wired → says the lane was not wired', /unavailable/.test(n(false, { hits: 0, sources: 0, fetchFailed: 0, sameHost: 0 })));
    ok('search came back empty → says so', /returned no results/.test(n(true, { hits: 0, sources: 0, fetchFailed: 0, sameHost: 0 })));
    ok('every hit unreadable → says so, not "nothing addressed it"', /could not read/.test(n(true, { hits: 3, sources: 0, fetchFailed: 3, sameHost: 0 })));
    ok('only the cited site answered → says so', /own site/.test(n(true, { hits: 2, sources: 0, fetchFailed: 0, sameHost: 2 })));
    ok('genuinely read + genuinely silent → the honest finding', /none addressed this claim/.test(n(true, { hits: 3, sources: 2, fetchFailed: 0, sameHost: 0 })));
  }

  // ---- one claim end to end -------------------------------------------------------------------
  {
    const r = await FC.factCheckOne(CLAIM, { search, fetch, complete });
    ok('stance is mixed when the record is split', r.stance === 'mixed', r.stance);
    ok('supporting source listed', r.supporting.length === 1 && /supporter\.example/.test(r.supporting[0].url));
    ok('countering source listed FOR CONSIDERATION', r.countering.length === 1 && /opponent\.example/.test(r.countering[0].url));
    ok('each source carries its deciding quote', r.countering[0].quote === 'closer to 9 percent');
    ok('note summarises the split', /1 supporting/.test(r.note) && /1 countering/.test(r.note), r.note);
    ok('output carries NO verdict on the author\'s citation',
      !('status_code' in r) && !('verdict' in r) && !('grade' in r), JSON.stringify(Object.keys(r)));
  }

  // ---- degraded paths --------------------------------------------------------------------------
  {
    const none = await FC.factCheckOne(CLAIM, {});
    ok('no tools → no-independent-source, searched:false', none.stance === 'no-independent-source' && none.searched === false);
    ok('no tools → says WHY (never implies a clean check)', /unavailable/.test(none.note), none.note);

    const empty = await FC.factCheckOne(CLAIM, { search: async () => ({ results: [] }), fetch });
    // Note names the ACTUAL cause. "no independent source addressed this claim" was printed whether
    // the record was silent, the search returned nothing, or every page failed to open — three
    // different facts, one sentence, and two of them ours rather than the record's.
    ok('searched but found nothing → says which nothing', empty.stance === 'no-independent-source' && empty.searched === true && /returned no results/.test(empty.note), empty.note);

    const thrower = await FC.factCheckOne(CLAIM, { search: async () => { throw new Error('provider down'); }, fetch });
    ok('search failure is contained', thrower.stance === 'no-independent-source');
  }

  // ---- many claims ------------------------------------------------------------------------------
  {
    const claims = [CLAIM, { uid: 'a2.s0', claim: 'A second claim.' }, { uid: 'a3.s0', claim: 'A third claim.' }];
    const all = await FC.factCheckAll(claims, { search, fetch, complete, concurrency: 2 });
    ok('one result per claim, input order preserved', all.length === 3 && all.map(a => a.uid).join(',') === 'a1.s0,a2.s0,a3.s0');
    ok('every result carries a valid stance', all.every(a => FC.STANCES.includes(a.stance)));
    const oneBad = await FC.factCheckAll([{ uid: 'x', claim: 'c' }], { search: async () => { throw new Error('boom'); }, fetch, complete });
    ok('a failing claim degrades to no-independent-source, not a crash', oneBad.length === 1 && oneBad[0].stance === 'no-independent-source');
    ok('empty input → empty output', (await FC.factCheckAll([], {})).length === 0);
  }

  // ---- stub path (no model injected) --------------------------------------------------------------
  {
    const r = await FC.factCheckOne(CLAIM, { search, fetch });      // no `complete`
    ok('runs offline without a model (deterministic stub)', FC.STANCES.includes(r.stance));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
