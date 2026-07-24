/**
 * Offline smoke for studio/verify_deepcheck.js — the deep agentic verification agent.
 * All I/O injected as mocks (no network, no model). Run:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke_verify_deepcheck.js
 */
const D = require('../studio/verify_deepcheck');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// a mock model transport that records the last prompt it saw and replies with a scripted verdict JSON
function mockComplete(reply) {
  const rec = { lastUser: null, calls: 0 };
  const fn = async ({ messages }) => { rec.calls++; rec.lastUser = (messages.find(m => m.role === 'user') || {}).content || ''; return typeof reply === 'function' ? reply(rec.lastUser) : reply; };
  fn.rec = rec;
  return fn;
}

(async () => {
  // 1) clean support → V, tier deep
  {
    const c = mockComplete('{"status_code":"V","caveat":"","evidence_quote":"The Senate passed it 68-32.","confidence":0.95}');
    const r = await D.deepVerifyOne({ uid: 'a0.s0', claim: 'The Senate passed it 68-32.', sourceText: 'Roll call: the Senate passed the measure 68 to 32 in March.' , url: 'https://senate.gov/vote' }, { complete: c });
    ok('clean support → V (tier deep)', r.status_code === 'V' && r.tier === 'deep', JSON.stringify(r));
    ok('evidence_quote carried through', /68-32/.test(r.evidence_quote));
    ok('primary source recorded in sources_consulted', r.sources_consulted.some(s => s.url === 'https://senate.gov/vote'));
  }

  // 2) number differs → M with the discrepancy surfaced
  {
    const c = mockComplete('{"status_code":"M","caveat":"claim says tripled; source shows ~doubled","evidence_quote":"funding rose from 5 to 11","confidence":0.9}');
    const r = await D.deepVerifyOne({ uid: 'a3.s1', claim: 'Funding tripled from 2020 to 2024.', kind: 'numeric', sourceText: 'Funding rose from 5 to 11 over the period.', url: 'https://data.gov/x' }, { complete: c });
    ok('number mismatch → M', r.status_code === 'M', JSON.stringify(r));
    ok('discrepancy surfaced in caveat/note', /doubled/.test(r.caveat) && /doubled|tripled/.test(r.note));
  }

  // 3) paraphrase presented as a quote → QP + caveat
  {
    const c = mockComplete('{"status_code":"QP","caveat":"presented in quotation marks but paraphrased","evidence_quote":"the actual wording differs","confidence":0.8}');
    const r = await D.deepVerifyOne({ uid: 'a5.s0', claim: 'He said "we will win".', quote: 'we will win', sourceText: 'What he actually said was that victory was likely.', url: 'https://news.example/i' }, { complete: c });
    ok('paraphrase-in-quotes → QP', r.status_code === 'QP');
    ok('caveat captured', /paraphrased/.test(r.caveat));
  }

  // 4) thin source text + URL + fetch tool → reads the FULL document, and the model sees it
  {
    const full = 'FETCHED-BODY: the full primary document text that is clearly long enough to judge on. '.repeat(2);
    const fetch = async (u) => (u === 'https://statearmor.org/report.pdf' ? full : '');
    const c = mockComplete('{"status_code":"V","caveat":"","evidence_quote":"x","confidence":0.9}');
    const r = await D.deepVerifyOne({ uid: 'a1.s0', claim: 'The report is 39 pages.', sourceText: '', url: 'https://statearmor.org/report.pdf' }, { complete: c, fetch });
    ok('thin source → full doc fetched and fed to the model', /FETCHED-BODY/.test(c.fn ? '' : c.rec.lastUser), c.rec.lastUser.slice(0, 60));
    ok('fetched primary in sources_consulted', r.sources_consulted.some(s => s.url === 'https://statearmor.org/report.pdf'));
  }

  // 5) inaccessible primary + numeric → independent cross-check resolves it
  {
    const bodies = { 'https://blocked.example/p': '', 'https://independent.example/a': 'Independent dataset confirms China emitted over 13 billion tons in 2024.' };
    const fetch = async (u) => bodies[u] != null ? bodies[u] : '';
    const search = async () => [{ url: 'https://independent.example/a', title: 'Independent Data' }];
    const c = mockComplete('{"status_code":"V","caveat":"","evidence_quote":"over 13 billion tons","confidence":0.9}');
    const r = await D.deepVerifyOne({ uid: 'a2.s0', claim: 'China emitted over 13 billion tons of CO2 in 2024.', kind: 'numeric', sourceText: '', url: 'https://blocked.example/p' }, { complete: c, fetch, search });
    ok('blocked primary NOT in sources_consulted', !r.sources_consulted.some(s => s.url === 'https://blocked.example/p'));
    ok('independent source consulted', r.sources_consulted.some(s => s.url === 'https://independent.example/a'));
    ok('model saw the independent passage', /Independent dataset confirms/.test(c.rec.lastUser));
  }

  // 6) cross-check gating: numeric triggers a search; a plain quote does NOT (unless forced)
  {
    const search1 = mockComplete(null); // reuse recorder shape via a counter
    let numCalls = 0, quoteCalls = 0;
    const c = mockComplete('{"status_code":"V","confidence":0.9}');
    await D.deepVerifyOne({ uid: 'n', claim: 'x', kind: 'numeric', sourceText: 'a source passage long enough to judge on here', url: 'https://a/b' }, { complete: c, fetch: async () => 'body long enough here to count as ok', search: async () => { numCalls++; return []; } });
    await D.deepVerifyOne({ uid: 'q', claim: 'y', kind: 'quote', sourceText: 'a source passage long enough to judge on here', url: 'https://a/b' }, { complete: c, fetch: async () => 'body long enough here to count as ok', search: async () => { quoteCalls++; return []; } });
    ok('numeric kind triggers cross-check search', numCalls === 1, `numCalls=${numCalls}`);
    ok('quote kind does NOT cross-check by default', quoteCalls === 0, `quoteCalls=${quoteCalls}`);
  }

  // 7) cross-check skips the CITED domain (wants an independent source)
  {
    const fetch = async (u) => 'a body from ' + u + ' long enough to count as a real passage here';
    const search = async () => [{ url: 'https://cited.example/other', title: 'same domain' }, { url: 'https://other.example/z', title: 'independent' }];
    const c = mockComplete('{"status_code":"V","confidence":0.9}');
    const r = await D.deepVerifyOne({ uid: 'a', claim: 'c', kind: 'numeric', sourceText: 'primary passage that is plenty long to judge on', url: 'https://cited.example/main' }, { complete: c, fetch, search });
    ok('cross-check skips cited domain → picks independent host', r.sources_consulted.some(s => /other\.example/.test(s.url)) && !r.sources_consulted.some(s => /cited\.example\/other/.test(s.url)));
  }

  // 8) no model injected → deterministic stub
  {
    const r = await D.deepVerifyOne({ uid: 's', claim: 'the sky is blue today', sourceText: 'the sky is blue today and clear' }, {});
    ok('no model → deep-stub tier', r.tier === 'deep-stub' && ['V', 'VP', 'NS'].includes(r.status_code), JSON.stringify(r));
  }

  // 9) parseVerdict robustness (raw JSON, fenced JSON, STATUS= fallback)
  {
    ok('parseVerdict: raw JSON', D.parseVerdict('{"status_code":"VC","caveat":"tight"}').status_code === 'VC');
    ok('parseVerdict: fenced JSON', D.parseVerdict('```json\n{"status_code":"M"}\n```').status_code === 'M');
    ok('parseVerdict: STATUS= fallback', D.parseVerdict('STATUS=V | some prose').status_code === 'V');
    ok('parseVerdict: garbage → ERR invalid (NEVER a verdict)', (() => { const v = D.parseVerdict('completely unparseable ~~~'); return v.status_code === 'ERR' && v.valid === false; })());
    ok('parseVerdict: a stale NK from the model reads as NS, not "no internal record"', D.parseVerdict('{"status_code":"NK"}').status_code === 'NS');
  }

  // 10) locatePassage returns the claim-relevant window of a large source, under the cap
  {
    const big = ('filler paragraph about unrelated things.\n\n').repeat(200) + 'THE KEY FACT: China emitted 13 billion tons.\n\n' + ('more filler.\n\n').repeat(200);
    const loc = await D.locatePassage(big, 'China emitted 13 billion tons', { maxPassage: 1000 });
    ok('locatePassage keeps the relevant window', /THE KEY FACT/.test(loc) && loc.length <= 1000, `len=${loc.length}`);

    // REGRESSION (live defect, 2026-07-23): with an ASYNC embedder injected, the ranking used to
    // score `cosine(Promise, Promise)` → 0 for every chunk. Every chunk tying collapses the ranking
    // to document order, so the judge is handed THE FIRST N CHARS of a large source rather than the
    // relevant ones — it then reports a good citation as unsupported because it never saw the line.
    // The real case was a 202,673-char state literacy PDF containing the exact figure under review.
    {
      // A deliberately BAD async embedder: it ranks the key chunk top only if it is actually awaited.
      const embed = async (t) => (/THE KEY FACT/.test(t) || /13 billion/.test(t)) ? [1, 0] : [0, 1];
      const cosine = (a, b) => (a && b && a.length === b.length) ? a[0] * b[0] + a[1] * b[1] : 0;
      const withEmbed = await D.locatePassage(big, 'China emitted 13 billion tons', { maxPassage: 1000, embed, cosine });
      ok('an ASYNC embedder is awaited, so the relevant chunk actually wins',
        /THE KEY FACT/.test(withEmbed), `got: ${String(withEmbed).slice(0, 80)}`);
      ok('locatePassage resolves to a string, never a Promise', typeof withEmbed === 'string');
    }

    // REGRESSION (live defect, 2026-07-23): "locate" must keep the RELEVANT chunks, not as many as
    // fit. Once maxPassage was sized from the model's real context (100,000), the old byte-only loop
    // kept ~800 of a 1,636-paragraph PDF's chunks — the right one included, ranked #0 — and the judge
    // missed the line in 80,000 chars of surrounding document and called a good citation unsupported.
    {
      // Must exceed the 100,000 cap or locatePassage correctly short-circuits and returns it whole.
      const filler = (tag) => Array.from({ length: 1500 }, (_, i) => `${tag} paragraph number ${i} concerning unrelated municipal zoning and procurement topics.`).join('\n\n');
      const many = filler('early') + '\n\nTHE KEY FACT: China emitted 13 billion tons.\n\n' + filler('late');
      const loc = await D.locatePassage(many, 'China emitted 13 billion tons', { maxPassage: 100000 });
      ok('a huge cap does not drown the relevant chunk in the whole document',
        /THE KEY FACT/.test(loc) && loc.length < 8000, `len=${loc.length}`);
      ok('the chunk budget is respected', loc.split('\n\n').length <= 40, `chunks=${loc.split('\n\n').length}`);
    }
  }

  // 11) A SOURCE WITH NO BLANK LINES MUST STILL BE SEARCHED (live defect, 2026-07-23, third run).
  // lib/search_lane's browser reader ends with `.replace(/\s+/g, ' ')`, so every page it returns has
  // ZERO newlines. locatePassage chunked on /\n{2,}/ only, so such a body produced ONE chunk, hit the
  // `chunks.length <= 1` branch, and returned clip(body, cap) — THE FIRST N CHARACTERS, with no
  // retrieval at all, while still presenting itself as a located passage.
  // Live consequence: a cited 13,000-word case study that says ESA money bought "diamonds, lingerie,
  // big screen TVs, iPhones, and Kenmore appliances" was judged against its INTRODUCTION, and the
  // studio ruled "not supported by cited source" against a citation that was exactly right — a
  // fabricated indictment of the author produced by a whitespace regex two modules away.
  {
    const sentence = (i) => `Paragraph ${i} discusses enrollment procedures and district budgeting at length. `;
    const collapsed = Array.from({ length: 600 }, (_, i) => sentence(i)).join('')
      + 'ESA funds were spent on diamonds, lingerie, big screen TVs, iPhones, and Kenmore appliances. '
      + Array.from({ length: 600 }, (_, i) => sentence(600 + i)).join('');
    ok('the fixture really is the shape the browser returns (no newlines at all)', !/\n/.test(collapsed));

    const loc = await D.locatePassage(collapsed, 'Nobody serious defends ESA dollars going to diamond rings.', { maxPassage: 2000 });
    ok('a newline-free source is still SEARCHED, not truncated to its head',
      /diamonds, lingerie/.test(loc), `got head instead: ${String(loc).slice(0, 90)}…`);
    ok('…and the located window still respects the cap', loc.length <= 2000, `len=${loc.length}`);

    // The same trap one step less extreme: single newlines, no blank lines (many text extractors).
    const singleNl = Array.from({ length: 400 }, (_, i) => sentence(i)).join('\n')
      + '\nESA funds were spent on diamonds and lingerie.\n'
      + Array.from({ length: 400 }, (_, i) => sentence(400 + i)).join('\n');
    const loc2 = await D.locatePassage(singleNl, 'ESA dollars going to diamond rings', { maxPassage: 2000 });
    ok('single-newline text is searched too', /diamonds and lingerie/.test(loc2), `got: ${String(loc2).slice(0, 90)}…`);
  }

  // 12) deepVerifyAll preserves order
  {
    const c = mockComplete('{"status_code":"V","confidence":0.9}');
    const rs = await D.deepVerifyAll([{ uid: 'u0', claim: 'a', sourceText: 'aaaa long enough passage here to judge' }, { uid: 'u1', claim: 'b', sourceText: 'bbbb long enough passage here to judge' }], { complete: c });
    ok('deepVerifyAll preserves input order', rs[0].uid === 'u0' && rs[1].uid === 'u1' && rs.length === 2);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
