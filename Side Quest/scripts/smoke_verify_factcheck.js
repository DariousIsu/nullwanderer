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
    const got = await FC.gatherSources(CLAIM, { search, fetch });
    ok('the CITED host is excluded (same site is not corroboration)', !got.some(s => /cited\.example/.test(s.url)), JSON.stringify(got.map(s => s.url)));
    ok('one voice per outlet (duplicate host dropped)', got.filter(s => /supporter\.example/.test(s.url)).length === 1);
    ok('gathered both independent outlets', got.length === 2, JSON.stringify(got.map(s => s.url)));
    const capped = await FC.gatherSources(CLAIM, { search, fetch, sources: 1 });
    ok('respects the source cap', capped.length === 1);
    ok('no search/fetch injected → gathers nothing, no throw', (await FC.gatherSources(CLAIM, {})).length === 0);
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
    ok('searched but found nothing → says so', empty.stance === 'no-independent-source' && empty.searched === true && /no independent source/.test(empty.note));

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
