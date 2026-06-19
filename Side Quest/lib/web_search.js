/**
 * Lightweight DuckDuckGo HTML search wrapper.
 * No API key, no auth. Fragile to DDG HTML changes — works as of mid-2026.
 */

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 SideQuest/0.1';
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

function unwrapDdgUrl(href) {
  // DDG wraps result URLs in /l/?uddg=<encoded>&...; extract original
  if (!href) return '';
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return href; }
  }
  // Sometimes the href is already absolute
  if (href.startsWith('http')) return href;
  return '';
}

function parseResults(html) {
  const results = [];
  const blockRe = /<div[^>]*class="[^"]*result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(html)) !== null && results.length < MAX_RESULTS) {
    const block = blockMatch[1];
    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const title = stripTags(titleMatch[2]).trim();
    const url = unwrapDdgUrl(titleMatch[1]);
    if (!title || !url) continue;

    let snippet = '';
    const snippetPatterns = [
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/,
      /<(?:div|span|p)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/,
      /<(?:div|span|p)[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/,
      /<(?:div|span|p)[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/
    ];
    for (const re of snippetPatterns) {
      const m = block.match(re);
      if (m) {
        const s = stripTags(m[1]).trim();
        if (s) { snippet = s; break; }
      }
    }

    // Fallback: strip the whole block, remove the title, take remaining prose
    if (!snippet) {
      const blockText = stripTags(block).replace(/\s+/g, ' ').trim();
      const idx = blockText.indexOf(title);
      const after = idx >= 0 ? blockText.slice(idx + title.length).trim() : blockText;
      // skip leading URL-ish text
      const cleaned = after.replace(/^[^a-zA-Z]*(?:https?:\/\/\S+\s*)?/, '').trim();
      if (cleaned.length > 30) {
        snippet = cleaned.length > 280 ? cleaned.slice(0, 280) + '…' : cleaned;
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
async function fetchPage(url, { maxChars = 4000, timeoutMs = 8000, signal } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, url, error: 'invalid url' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: 'not http(s)' };

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

async function search(query, { signal } = {}) {
  if (!query || !query.trim()) return { query, results: [] };
  const trimmed = query.trim().slice(0, 240);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // honor outside signal too
  if (signal) signal.addEventListener('abort', () => ctrl.abort());

  try {
    const body = `q=${encodeURIComponent(trimmed)}&kl=us-en`;
    const res = await fetch(DDG_HTML_ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html'
      },
      body,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
    const html = await res.text();
    const results = parseResults(html);
    return { query: trimmed, results };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { search, fetchPage };
