/**
 * DEDICATED rapid-search stealth lane — a SEPARATE, HEADLESS patchright Chrome on its own
 * profile, distinct from her VISIBLE co-watched browser (lib/web.js). This is where the
 * app's programmatic search consumers (cognition's "let me find out", monologue, meetings,
 * media, research_exec, super_search) fire quick lookups WITHOUT cluttering the browsing
 * window she + Lucas are watching. Two lanes, on purpose:
 *   - THIS lane  = fast, hidden, stealth, Bing   → rapid answers
 *   - lib/web.js = visible, interactive, Google   → deeper browsing she drives
 *
 * Engine is Bing: DuckDuckGo null-routed this IP at the connection level after the old
 * shared search lane over-pinged its HTML endpoint (ERR_CONNECTION_TIMED_OUT on every DDG
 * host); Bing answers reliably and its SERP anchors carry the real destination URL.
 *
 * Own persistent profile (separate cookies / cf_clearance) so a heavy search burst here can
 * never fight her visible browser's profile lock. Launched lazily, reused across searches,
 * and every search is serialized through the single page (concurrent goto()s would race).
 */

const path = require('path');
const fs = require('fs');
const db = require('./db');

const PROFILE_DIR = path.join(path.dirname(db.DB_PATH), 'search_profile');
const SEARCH_URL = (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-us`;
const NAV_TIMEOUT = 15000;
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

let context = null;
let page = null;
let lock = Promise.resolve();

function findChrome() { for (const p of CHROME_PATHS) { try { if (fs.existsSync(p)) return p; } catch {} } return null; }

// Kill any orphaned Chrome still running THIS lane's profile before launching fresh. A hard-
// killed app never runs close(), so the persistent-context Chrome it spawned is orphaned — it
// holds the search_profile lock (blocking relaunch) AND, being off-screen-only after this fix,
// an OLD on-screen one would otherwise linger as a stray window. Matches '*search_profile*'
// only (disjoint from web.js's '*web_profile*'), and runs solely on a fresh launch
// (context === null) so it can't kill the current session's own browser.
function killStaleProfileChrome() {
  if (process.platform !== 'win32') return;
  try {
    require('child_process').execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe'\\\" | Where-Object { $_.CommandLine -like '*search_profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
      { timeout: 8000, stdio: 'ignore' }
    );
  } catch {}
}

// Hard wall-clock cap for any browser promise that could hang (page.evaluate has no built-in
// timeout). Resolves to `fallback` if the promise doesn't settle in `ms`.
function withTimeout(promise, ms, fallback) {
  let t;
  const timeout = new Promise((res) => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

// Strip an engine/verb the model may have prepended ("google …", "search for …") and wrapping
// quotes (exact-phrase match often returns nothing). Mirrors lib/web.cleanQuery.
function cleanQuery(s) {
  let q = String(s || '').trim();
  q = q.replace(/^(?:on\s+)?(?:google|bing|duck\s*duck\s*go|the\s+web|search(?:\s+for)?|look\s*up|find|google\s+for)\b[\s:]*/i, '');
  q = q.replace(/^["“'`]+|["”'`]+$/g, '').trim();
  return q || String(s || '').trim();
}

async function ensure() {
  if (context && page) {
    let closed = true; try { closed = page.isClosed(); } catch { closed = true; }
    if (!closed) return page;
    try { page = await context.newPage(); page.setDefaultTimeout(8000); return page; }
    catch { context = null; page = null; }   // context dead → relaunch below
  }
  // PATCHRIGHT (patched Playwright) drives REAL system Chrome with the automation leaks
  // neutralized — the same stealth path lib/web.js uses, but headless + a SEPARATE profile so
  // it stays invisible and never touches her visible browser.
  const pw = require('patchright');
  const executablePath = findChrome();
  if (!executablePath) throw new Error('chrome.exe/msedge.exe not found in standard paths');
  try { if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
  killStaleProfileChrome();   // clear an orphaned lane Chrome (stale lock + stray window) first
  context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    // HEADFUL, but the window is parked far OFF-SCREEN. Patchright's stealth patches are built
    // for a headed browser and don't honor headless:true — it still spawns a real (blank/black)
    // window on Windows. So instead we let it be headful and move it off every monitor via
    // --window-position: it renders SERPs normally for scraping but is never visible to Lucas.
    // (Minimizing would throttle background rendering/timers and slow searches — off-screen
    // keeps it fully live.)
    headless: false,
    executablePath,
    viewport: { width: 1280, height: 900 },
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', '--test-type', '--mute-audio',
           '--window-position=-32000,-32000', '--window-size=1280,900']
  });
  context.on('close', () => { context = null; page = null; });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  return page;
}

// Extract Bing SERP results (title + REAL url + snippet). Bing anchors usually carry the real
// destination href; some are wrapped in bing.com/ck/a?…&u=a1<base64url> — decode that back.
async function readBingSerp(p, max = 8) {
  return await withTimeout(p.evaluate((maxN) => {
    const unwrap = (href) => {
      if (!href) return '';
      if (/bing\.com\/ck\/a/i.test(href)) {
        try {
          const m = href.match(/[?&]u=a1([^&]+)/);
          if (m) { let s = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); }
        } catch {}
        return '';
      }
      if (/^https?:/i.test(href)) return href;
      return '';
    };
    const out = [];
    for (const b of document.querySelectorAll('li.b_algo')) {
      // Prefer the headline anchor (h2 a). A bare 'h2 a, a.tilk' would return the FIRST match
      // in DOM order — and Bing's breadcrumb a.tilk sits ABOVE the h2, so it'd steal the title.
      const a = b.querySelector('h2 a') || b.querySelector('a.tilk');
      if (!a) continue;
      const title = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const url = unwrap(a.getAttribute('href') || a.href || '');
      if (!title || !url) continue;
      const sn = b.querySelector('.b_caption p, p.b_lineclamp2, p.b_lineclamp3, .b_algoSlug');
      const snippet = sn ? (sn.innerText || sn.textContent || '').replace(/\s+/g, ' ').trim() : '';
      out.push({ title, url, snippet });
      if (out.length >= maxN) break;
    }
    return out;
  }, max), 5000, []);
}

// Serialize searches through the single page (concurrent goto()s on one tab race).
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});   // never let a rejection poison the chain
  return run;
}

/**
 * Rapid search. Returns the same shape lib/web_search.search produces:
 * { query, results:[{title,url,snippet}] }. THROWS if the browser can't launch (no Chrome,
 * launch failure) so lib/web_search can fall back to a raw fetch. An empty results array is
 * a valid answer (real no-hits), NOT a fall-back trigger.
 */
async function search(query, { signal } = {}) {
  const q = cleanQuery(String(query || '').trim()).slice(0, 240);
  if (!q) return { query: '', results: [] };
  if (signal && signal.aborted) return { query: q, results: [] };
  return withLock(async () => {
    const p = await ensure();
    await p.goto(SEARCH_URL(q), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const results = await readBingSerp(p, 8);
    return { query: q, results: Array.isArray(results) ? results : [] };
  });
}

/**
 * READ one url with the REAL browser — the last resort when plain HTTP cannot get the page.
 *
 * Some sources simply are not reachable by `fetch`. A live editor run took HTTP 403 from azed.gov
 * on a cited PDF with both a bot UA and full browser headers: the host wants a real browser (TLS
 * fingerprint, JS challenge, cf_clearance cookie), and this lane already IS one, on a warm profile
 * that has solved those challenges before. Without this rung the studio reports a perfectly good
 * citation as unreachable, which reads to the author as THEIR sourcing failing.
 *
 * Returns { ok, kind:'pdf'|'html', text?, buffer?, title?, status, url }.
 * PDFs come back as BYTES (from the navigation response — the browser's own network stack, so the
 * WAF has already been satisfied) for the caller to run through a PDF extractor; Chrome's built-in
 * viewer renders a PDF into a plugin whose text `innerText` cannot see.
 *
 * Shares the lane's single page and its lock, so a read can never race a search.
 */
async function read(url, { timeoutMs = NAV_TIMEOUT } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, url: target, error: 'not http(s)' };
  return withLock(async () => {
    const p = await ensure();
    const isPdfBytes = (b) => !!(b && b.length > 4 && b.slice(0, 5).toString('latin1') === '%PDF-');

    // A PDF is fetched, never navigated to. Navigating hands it to Chrome's viewer extension and
    // the navigation body becomes the viewer shell. Instead: land on the ORIGIN (an ordinary page,
    // which is what satisfies the WAF and banks its cookie), then run a SAME-ORIGIN fetch inside
    // the page — the browser's own network stack, cookies and TLS fingerprint included. The
    // context's `request` client is NOT equivalent: it is a separate HTTP stack and azed.gov 403s
    // it exactly as it 403s node's fetch.
    if (/\.pdf(?:[?#]|$)/i.test(target)) {
      let origin = ''; try { origin = new URL(target).origin; } catch { origin = ''; }
      if (origin) {
        try {
          await p.goto(origin, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          const b64 = await withTimeout(p.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include' });
              if (!r.ok) return null;
              const bytes = new Uint8Array(await r.arrayBuffer());
              if (bytes.length > 40 * 1024 * 1024) return null;      // don't marshal a huge blob
              let s = '', CH = 0x8000;
              for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
              return btoa(s);
            } catch { return null; }
          }, target), Math.max(timeoutMs, 30000), null);
          if (b64) {
            const buf = Buffer.from(b64, 'base64');
            if (isPdfBytes(buf)) return { ok: true, kind: 'pdf', buffer: buf, status: 200, url: target };
          }
        } catch { /* fall through to the plain navigation path below */ }
      }
    }

    let resp = null;
    try { resp = await p.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
    catch (e) { return { ok: false, url: target, error: `goto failed: ${e.message}` }; }
    const status = resp ? resp.status() : 0;
    const ctype = (resp && (resp.headers()['content-type'] || '')) || '';
    const looksPdf = /application\/pdf/i.test(ctype) || /\.pdf(?:[?#]|$)/i.test(target);

    if (looksPdf) {
      // ⚠️ `resp.body()` on a PDF navigation does NOT return the PDF. Chrome hands the URL to its
      // built-in viewer extension, so the navigation body is 536 bytes of viewer-shell HTML
      // ("<!doctype html>…chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css").
      // Handing THAT to a PDF extractor would put fabricated content under a real citation — the
      // same wrong-source failure this whole lane exists to prevent. So: navigate first (that is
      // what satisfies the WAF and banks the cookie), then pull the bytes with the context's HTTP
      // client, which inherits this profile's cookies — and REQUIRE the %PDF magic before believing
      // any of it.
      let buffer = null;
      try {
        const r = await context.request.get(target, { timeout: timeoutMs });
        if (r.ok()) { const b = await r.body(); if (isPdfBytes(b)) buffer = b; }
      } catch { /* fall through to the navigation body */ }
      if (!buffer) { try { const b = await resp.body(); if (isPdfBytes(b)) buffer = b; } catch { /* none */ } }
      if (buffer) return { ok: true, kind: 'pdf', buffer, status, url: target };
      return { ok: false, url: target, status, error: 'pdf bytes unavailable (viewer shell only)' };
    }

    if (status && (status < 200 || status >= 300)) return { ok: false, url: target, status, error: `HTTP ${status}` };
    /* eslint-disable no-undef -- this callback is serialized into the PAGE, where `document` exists */
    const got = await withTimeout(p.evaluate(() => {
      const pick = document.querySelector('article') || document.querySelector('main') || document.body;
      for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form']) {
        for (const n of (pick ? pick.querySelectorAll(sel) : [])) n.remove();
      }
      return { title: document.title || '', text: (pick && (pick.innerText || pick.textContent) || '').replace(/\s+/g, ' ').trim() };
    }), 8000, null);
    /* eslint-enable no-undef */
    if (!got || !got.text) return { ok: false, url: target, status, error: 'no readable text' };
    return { ok: true, kind: 'html', text: got.text, title: got.title, status, url: target };
  });
}

async function close() {
  try { if (context) await context.close(); } catch {}
  context = null; page = null;
  return { ok: true };
}

function isConnected() { return !!(context && page); }

module.exports = { search, read, close, ensure, isConnected, cleanQuery, PROFILE_DIR, SEARCH_URL };
