/**
 * lib/source_reader — "give me this cited source's readable TEXT."
 *
 * ONE owner for a question the verification ladder had been answering with a growing blacklist.
 * Every reader failure this studio has shipped came from the same two gaps:
 *
 *   1. NO ROUTING BY RESOURCE TYPE. A `.pdf` url was handed to an HTML text extractor first, because
 *      the ladder tried readers in a fixed order regardless of what the resource IS. That is
 *      guaranteed wrong, and it is how a cited state literacy plan reached the judge as
 *      "%PDF-1.7 % 3803 0 obj <</Linearized 1/L 2431168…>> endobj" — while the very same bytes,
 *      given to the PDF extractor this app already owns, yield 202,673 characters of clean text.
 *
 *   2. NO POSITIVE DEFINITION OF A USABLE SOURCE. Acceptance was "not obviously bad": a paywall
 *      regex, then a bot-block regex, then binary magic, then a length floor — one rule per
 *      incident, each defeated by the next payload shape. A page's <head> plus its JSON-LD article
 *      schema is long, passes every blacklist, and is not the article. Judging a claim against it
 *      produces a confident, fabricated "not supported" against a citation that was fine.
 *
 * So this module ROUTES first and VALIDATES second, and the validation is the positive test
 * `verify_resolve.isProse` — the single definition of "usable" in the system.
 *
 *   readSource(url) -> { ok:true,  text, kind, reader, chars, status, attempts }
 *                    | { ok:false, why, attempts }
 *
 * `attempts` always lists every reader tried with the reason it was rejected, so an "inaccessible"
 * finding can name what happened instead of blaming the author's sourcing for our missing capability.
 *
 * Every dependency is INJECTED (callTool, browserRead, pdfToText, httpGet) so this runs identically
 * offline in a smoke and live in the app, exactly like the studio/verify_* modules it serves.
 */
'use strict';

const { isProse } = require('../studio/verify_resolve');

const PDF_URL = /\.pdf(?:[?#]|$)/i;
const PDF_CTYPE = /application\/pdf/i;
const HTML_CTYPE = /text\/html|application\/xhtml|text\/plain/i;
const PDF_MAGIC = '%PDF-';

/**
 * What KIND of resource is this? URL first (cheap, no request), Content-Type when we have one.
 * 'other' is a deliberate refusal: we do not guess at a payload no reader here can turn into prose.
 */
function classifyResource(url, contentType) {
  const ct = String(contentType || '');
  if (PDF_CTYPE.test(ct) || PDF_URL.test(String(url || ''))) return 'pdf';
  if (!ct || HTML_CTYPE.test(ct)) return 'html';
  return 'other';
}

const isPdfBytes = (buf) => !!(buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === PDF_MAGIC);

/**
 * @param {object} deps
 *   httpGet(url)     -> { status, contentType, buffer }   plain HTTP, browser-shaped headers
 *   pdfToText(buf)   -> string                            doc_extract.extractPdf via a temp file
 *   browserRead(url) -> { ok, kind:'pdf'|'html', text?, buffer? }   the real-browser last resort
 *   callTool(n,args) -> MCP result                        Echo's text extractors (html only)
 *   textTools        -> ['web_extract','web_fetch']       tried in order, HTML resources only
 *   readFetch(raw)   -> { status, body }                  verify_resolve's tolerant body reader
 */
function makeReader(deps = {}) {
  const { httpGet, pdfToText, browserRead, callTool, readFetch } = deps;
  const textTools = Array.isArray(deps.textTools) ? deps.textTools.filter(Boolean) : ['web_extract'];

  async function readSource(url) {
    const attempts = [];
    const note = (reader, ok, why, chars) => { attempts.push({ reader, ok, why: why || null, chars: chars || 0 }); };
    // Best PROSE wins on length; anything failing the shape test can never win at all.
    let best = null;
    const offer = (reader, text, status) => {
      const p = isProse(text);
      note(reader, p.ok, p.why, (text || '').length);
      if (!p.ok) return false;
      if (!best || text.length > best.text.length) best = { text, reader, status: status || 200 };
      return true;
    };

    let kind = classifyResource(url);

    // ---- PDF: never hand it to an HTML text extractor. Bytes → the PDF extractor, full stop. ----
    if (kind === 'pdf' && typeof pdfToText === 'function') {
      if (typeof httpGet === 'function') {
        try {
          const r = await httpGet(url);
          if (r && r.status >= 200 && r.status < 300 && isPdfBytes(r.buffer)) offer('http+pdf-extract', await pdfToText(r.buffer), r.status);
          else note('http+pdf-extract', false, r ? `HTTP ${r.status}${isPdfBytes(r.buffer) ? '' : ' / not %PDF bytes'}` : 'no response');
        } catch (e) { note('http+pdf-extract', false, `threw: ${e && e.message}`); }
      }
      // A host that screens plain HTTP still serves a real browser (azed.gov 403s node fetch with
      // any headers and hands the browser 2.4 MB).
      if (!best && typeof browserRead === 'function') {
        try {
          const r = await browserRead(url);
          if (r && r.ok && r.kind === 'pdf' && isPdfBytes(r.buffer)) offer('browser+pdf-extract', await pdfToText(r.buffer), r.status);
          else if (r && r.ok && r.kind === 'html' && r.text) { kind = 'html'; offer('browser', r.text, r.status); }   // the url lied about being a pdf
          else note('browser+pdf-extract', false, (r && r.error) || 'no pdf bytes');
        } catch (e) { note('browser+pdf-extract', false, `threw: ${e && e.message}`); }
      }
      return best
        ? { ok: true, text: best.text, kind, reader: best.reader, chars: best.text.length, status: best.status, attempts }
        : { ok: false, why: `could not read the cited PDF — ${attempts.map(a => `${a.reader}: ${a.why}`).join('; ') || 'no reader available'}`, attempts };
    }

    // ---- HTML (and unknown): the text extractors first, the browser when they return container ----
    if (typeof callTool === 'function' && typeof readFetch === 'function') {
      for (const tool of textTools) {
        try {
          const fr = readFetch(await callTool(tool, { url }));
          if (fr && fr.status != null && (fr.status < 200 || fr.status >= 300)) { note(tool, false, `HTTP ${fr.status}`, 0); continue; }
          offer(tool, (fr && fr.body) || '', fr && fr.status);
        } catch (e) { note(tool, false, `threw: ${e && e.message}`); }
      }
    }
    // Run the browser whenever no extractor produced PROSE — this is the rung that was being skipped
    // because a metadata stub counted as success.
    if (!best && typeof browserRead === 'function') {
      try {
        const r = await browserRead(url);
        if (r && r.ok && r.kind === 'html' && r.text) offer('browser', r.text, r.status);
        else if (r && r.ok && r.kind === 'pdf' && typeof pdfToText === 'function' && isPdfBytes(r.buffer)) {
          kind = 'pdf'; offer('browser+pdf-extract', await pdfToText(r.buffer), r.status);   // served a pdf from an extensionless url
        } else note('browser', false, (r && r.error) || 'no readable text');
      } catch (e) { note('browser', false, `threw: ${e && e.message}`); }
    }

    return best
      ? { ok: true, text: best.text, kind, reader: best.reader, chars: best.text.length, status: best.status, attempts }
      : { ok: false, why: `no reader produced readable text — ${attempts.map(a => `${a.reader}: ${a.why}`).join('; ') || 'no reader available'}`, attempts };
  }

  return readSource;
}

module.exports = { makeReader, classifyResource, isPdfBytes, PDF_URL, PDF_MAGIC };
