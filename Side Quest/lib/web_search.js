/**
 * Search + page-fetch wrapper. `search()` PRIMARY path is the dedicated hidden stealth lane
 * (lib/search_lane — headless Bing), with this file's raw Bing fetch as the fallback for when
 * that browser can't launch (no Chrome / launch failure / offline test). Engine is Bing:
 * DuckDuckGo null-routed this IP after the lane over-pinged its HTML endpoint.
 */

const BING_ENDPOINT = 'https://www.bing.com/search';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_RESULTS = 5;
const TIMEOUT_MS = 8000;

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ''));
}

function unwrapBingUrl(href) {
  // Most Bing result anchors carry the real URL; some are wrapped in bing.com/ck/a?…&u=a1<b64url>.
  if (!href) return '';
  if (/bing\.com\/ck\/a/i.test(href)) {
    const m = href.match(/[?&]u=a1([^&]+)/);
    if (m) {
      try { let s = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64').toString('utf8'); }
      catch { return ''; }
    }
    return '';
  }
  if (href.startsWith('http')) return href;
  return '';
}

function parseBingResults(html) {
  const results = [];
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(html)) !== null && results.length < MAX_RESULTS) {
    const block = blockMatch[1];
    // Title + link live inside the result's <h2><a href="…">…</a></h2>
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapBingUrl(decodeHtmlEntities(linkMatch[1]));
    const title = stripTags(linkMatch[2]).trim();
    if (!title || !url) continue;

    let snippet = '';
    const snippetPatterns = [
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
      /<div[^>]*class="[^"]*b_algoSlug[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<p[^>]*>([\s\S]*?)<\/p>/i
    ];
    for (const re of snippetPatterns) {
      const m = block.match(re);
      if (m) {
        const s = stripTags(m[1]).trim();
        if (s) { snippet = s.length > 280 ? s.slice(0, 280) + '…' : s; break; }
      }
    }

    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Fetch a URL and extract main readable text content.
 * Strips script/style/nav/footer/header/aside; collapses whitespace.
 * Returns { title, text, url, ok, error? }.
 */
async function fetchPage(url, { maxChars = 4000, timeoutMs = 8000, signal, reuse = false } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, url, error: 'invalid url' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: 'not http(s)' };

  // NEVER-SAME-PAGE-TWICE, fetch lane (measured 2026-08-08: springfield.il.us CityCouncilHome at
  // 139 visits with doc_id NULL — this lane counted visits but held nothing; 110 of 615 active
  // urls carried a doc). reuse is OPT-IN (the idle lanes pass it; an escalation-ladder fetch after
  // a browser failure stays live): within the ledger's content TTL a held copy answers with zero
  // network. The ingest at the success path below is UNCONDITIONAL — every read heals the pointer.
  if (reuse) {
    try {
      const sl = require('./site_ledger');
      const sk = sl.shouldSkip(url);
      if (sk.skip && sk.row && sk.row.doc_id) {
        const doc = require('./db').getDb().prepare('SELECT title, body FROM documents WHERE id = ?').get(sk.row.doc_id);
        if (doc && doc.body) {
          console.log(`[web-fetch] ledger reuse — ${String(url).slice(0, 100)} (${sk.why}) → held doc #${sk.row.doc_id}, no fetch`);
          const t = String(doc.body);
          return { ok: true, url, title: doc.title || '', text: t.length > maxChars ? t.slice(0, maxChars) + '…' : t, truncated: t.length > maxChars, dedup: true };
        }
      }
    } catch { /* reuse is an optimization — any failure falls through to the live fetch */ }
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') || '';
    // SPREADSHEET LANE (2026-07-23): a data source published as a spreadsheet used to die on the
    // content-type wall below — inquiry #1 ground through 8 touches on exactly this. Parse it to a
    // bounded text table shaped like any page read, so every consumer downstream is unchanged.
    const sheetLib = require('./spreadsheet');
    if (sheetLib.isSpreadsheet({ url, contentType })) {
      const buf = Buffer.from(await res.arrayBuffer());
      const parsed = await sheetLib.toBoundedText(buf, { url, cap: Math.max(maxChars, 4000) });
      if (!parsed.ok) return { ok: false, url, error: parsed.error };
      try { require('./site_ledger').record(url, { kind: 'spreadsheet', chars: parsed.text.length }); } catch {}
      return { ok: true, url, title: parsed.title, text: parsed.text, truncated: parsed.truncated };
    }
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return { ok: false, url, error: `unsupported content-type: ${contentType}` };
    }
    const html = await res.text();
    if (!html) return { ok: false, url, error: 'empty body' };

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : '';

    // Strip non-content blocks
    let body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<form[\s\S]*?<\/form>/gi, ' ');

    // Prefer <article>, <main>, or <body> if present
    const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    let content = articleMatch ? articleMatch[1]
                : mainMatch ? mainMatch[1]
                : body;

    const text = stripTags(content).replace(/\s+/g, ' ').trim();
    const truncated = text.length > maxChars;
    // land the FULL text (pre-truncation) as the URL's one living doc; ingest's own guards
    // (SERP, <200ch shell) decide junk. Fallback keeps the bare visit count on any failure.
    try { require('./web').ingestReading(url, title, text); }
    catch { try { require('./site_ledger').record(url, { kind: 'fetch', chars: text.length }); } catch {} }
    return {
      ok: true,
      url,
      title,
      text: truncated ? text.slice(0, maxChars) + '…' : text,
      truncated
    };
  } catch (err) {
    return { ok: false, url, error: err.message || String(err) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Public search. PRIMARY path is the dedicated hidden stealth lane (lib/search_lane — a
 * separate headless patchright Chrome running Bing, kept OUT of her visible browsing window).
 * Falls back to the raw Bing fetch below only when that browser can't launch (no Chrome,
 * launch failure, offline test env), or when forced off with ZOE_SEARCH_VIA_BROWSER=0. An
 * empty result from the lane is trusted as a real no-hits answer and is NOT re-queried (that
 * would defeat the point). Same return shape either way: { query, results:[{title,url,snippet}] }.
 */
async function search(query, opts = {}) {
  if (!query || !query.trim()) return { query, results: [] };
  const trimmed = query.trim().slice(0, 240);

  if (process.env.ZOE_SEARCH_VIA_BROWSER !== '0') {
    try {
      const r = await require('./search_lane').search(trimmed, { signal: opts.signal });
      if (r && Array.isArray(r.results)) {
        return { query: trimmed, results: r.results.slice(0, MAX_RESULTS) };
      }
    } catch {
      // stealth lane unavailable → fall through to the raw Bing fetch
    }
  }
  return searchRaw(query, opts);
}

// Raw HTML-scrape of Bing. Retained as the fallback for when the stealth lane can't run (e.g.
// no Chrome, or a headless smoke). Bing answers a plain GET from this IP; DDG does not.
async function searchRaw(query, { signal } = {}) {
  if (!query || !query.trim()) return { query, results: [] };
  const trimmed = query.trim().slice(0, 240);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // honor outside signal too
  if (signal) signal.addEventListener('abort', () => ctrl.abort());

  try {
    const url = `${BING_ENDPOINT}?q=${encodeURIComponent(trimmed)}&setlang=en-us`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
    const html = await res.text();
    const results = parseBingResults(html);
    return { query: trimmed, results };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { search, fetchPage };
