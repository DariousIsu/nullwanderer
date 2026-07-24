/**
 * Offline smoke for lib/source_reader — the ONE owner of "give me this source's readable text".
 *
 * Driven by the exact payloads that defeated the old blacklist on the live Arizona ESA op-ed
 * (reports …-2106.pdf and …-2115.pdf): a cited PDF returned as raw bytes, and a cited news article
 * returned as its HTML <head> plus JSON-LD schema. Both were long, both passed every negative rule,
 * and both became "the source" — so the judge faulted five of eight claims whose citations were fine.
 *
 * Run: node scripts/smoke_source_reader.js
 */
'use strict';
const { makeReader, classifyResource, isPdfBytes } = require('../lib/source_reader');
const { isProse, readFetch } = require('../studio/verify_resolve');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// The real shapes, verbatim in spirit.
const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n3803 0 obj <</Linearized 1/L 2431168/O 3805/E 29408>> endobj', 'latin1');
const PDF_TEXT = 'Arizona has made incremental gains in NAEP scores over the last several years, but with '
  + 'significant disparities between disadvantaged students: a 29-point gap between FRL vs. Non-FRL in '
  + 'fourth grade scores and a 24-point gap in eighth grade. Intervention is required.';
const HEAD_ONLY = '<title data-next-head="">Reading proficiency for Arizona&#x27;s 4th and 8th graders are on the decline - Axios Phoenix</title>'
  + '<meta name="description" content="A decline in reading scores in Arizona follows a national trend of post-pandemic learning loss."/>'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Reading scores fell","datePublished":"2025-01-30","author":{"@type":"Person","name":"Jeremy Duda"}}</script>';
const ARTICLE = 'Jan 30, 2025 - Reading scores for Arizona 4th and 8th graders fell. In 2024, 26% of fourth '
  + 'graders and 25% of 8th graders in Arizona were proficient in reading. Average fourth-grade scores for '
  + 'both math and reading were below the national average, according to NAEP results released this week.';

// ---- the positive test itself -----------------------------------------------------------------
// Length could never separate these: HEAD_ONLY is LONGER than the real article extract.
ok('HTML head + JSON-LD is refused as container, not accepted as an article', isProse(HEAD_ONLY).ok === false, isProse(HEAD_ONLY).why);
ok('…and length would NOT have caught it (the container is longer than the article)', HEAD_ONLY.length > ARTICLE.length,
  `head=${HEAD_ONLY.length} article=${ARTICLE.length}`);
ok('a real article extract passes', isProse(ARTICLE).ok === true, isProse(ARTICLE).why);
ok('extracted PDF prose passes', isProse(PDF_TEXT).ok === true, isProse(PDF_TEXT).why);
ok('raw PDF bytes are refused', isProse(PDF_BYTES.toString('latin1')).ok === false);
ok('a short-but-real snippet is NOT refused for being short (shape gates, length only ranks)',
  isProse('The board voted 5-2 to approve the measure. It takes effect in July.').ok === true);
ok('a bare label is refused (no sentence structure)', isProse('headline: Reading scores fell; description: a decline').ok === false);

// ---- routing ----------------------------------------------------------------------------------
ok('a .pdf url routes to pdf', classifyResource('https://azed.gov/plan.pdf') === 'pdf');
ok('a .pdf url with a query still routes to pdf', classifyResource('https://x.gov/a.pdf?v=2') === 'pdf');
ok('content-type wins when the url is extensionless', classifyResource('https://x.gov/download?id=9', 'application/pdf') === 'pdf');
ok('an article routes to html', classifyResource('https://axios.com/story', 'text/html; charset=utf-8') === 'html');
ok('an unknown binary is refused, not guessed at', classifyResource('https://x.gov/a.bin', 'application/octet-stream') === 'other');
ok('isPdfBytes checks the magic, not the header claim', isPdfBytes(PDF_BYTES) && !isPdfBytes(Buffer.from('<html>not a pdf</html>')));

(async () => {
  // ---- THE REGRESSION: a cited PDF must never reach an HTML text extractor -------------------
  {
    const calls = [];
    const read = makeReader({
      readFetch,
      callTool: async (name, args) => { calls.push(name); return { status: 200, body: PDF_BYTES.toString('latin1') }; },
      textTools: ['web_extract', 'web_fetch'],
      httpGet: async () => ({ status: 200, contentType: 'application/pdf', buffer: PDF_BYTES }),
      pdfToText: async (buf) => (isPdfBytes(buf) ? PDF_TEXT : ''),
    });
    const r = await read('https://www.azed.gov/sites/default/files/plan.pdf');
    ok('a cited PDF is read as a PDF', r.ok === true && /29-point gap/.test(r.text), JSON.stringify(r.attempts));
    ok('the HTML text extractors were never even called for it', calls.length === 0, calls.join(','));
    ok('the reader that produced it is named', r.reader === 'http+pdf-extract' && r.kind === 'pdf', JSON.stringify(r));
  }

  // ---- THE REGRESSION: a metadata stub must not end the read ---------------------------------
  {
    const read = makeReader({
      readFetch,
      callTool: async () => ({ status: 200, body: HEAD_ONLY }),      // what Echo web_extract actually returned
      textTools: ['web_extract', 'web_fetch'],
      browserRead: async () => ({ ok: true, kind: 'html', text: ARTICLE, status: 200 }),
    });
    const r = await read('https://www.axios.com/local/phoenix/2025/01/30/reading-scores');
    ok('a <head>+schema stub does not count as the article', r.ok === true && /26% of fourth/.test(r.text), JSON.stringify(r.attempts));
    ok('the browser rung actually ran (it was being skipped)', r.reader === 'browser');
    ok('the rejected attempts are recorded with WHY', r.attempts.some(a => !a.ok && /markup/.test(a.why || '')), JSON.stringify(r.attempts));
  }

  // ---- a WAF that 403s plain HTTP still yields the PDF via the browser ------------------------
  {
    const read = makeReader({
      readFetch,
      httpGet: async () => ({ status: 403, contentType: 'text/html', buffer: Buffer.from('Forbidden') }),
      browserRead: async () => ({ ok: true, kind: 'pdf', buffer: PDF_BYTES, status: 200 }),
      pdfToText: async (buf) => (isPdfBytes(buf) ? PDF_TEXT : ''),
    });
    const r = await read('https://www.azed.gov/plan.pdf');
    ok('a 403 on plain HTTP falls through to the browser for the PDF', r.ok === true && r.reader === 'browser+pdf-extract', JSON.stringify(r.attempts));
  }

  // ---- honest refusal, naming what was tried --------------------------------------------------
  {
    const read = makeReader({
      readFetch,
      callTool: async () => ({ status: 200, body: HEAD_ONLY }),
      textTools: ['web_extract'],
      browserRead: async () => ({ ok: false, error: 'goto failed: timeout' }),
    });
    const r = await read('https://dead.example/story');
    ok('when nothing yields prose the read FAILS rather than handing over container', r.ok === false);
    ok('…and the reason names every reader tried', /web_extract/.test(r.why) && /browser/.test(r.why), r.why);
    ok('markup is never returned as a consolation prize', !r.text);
  }

  // ---- the reader is optional everywhere: no deps must not throw ------------------------------
  {
    const r = await makeReader({})('https://x.example/a');
    ok('no readers injected → honest failure, no throw', r.ok === false && !!r.why);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
