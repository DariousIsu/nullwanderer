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
  context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,                                // hidden lane — never a window on her screen
    executablePath,
    viewport: { width: 1280, height: 900 },
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', '--test-type', '--mute-audio']
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

async function close() {
  try { if (context) await context.close(); } catch {}
  context = null; page = null;
  return { ok: true };
}

function isConnected() { return !!(context && page); }

module.exports = { search, close, ensure, isConnected, cleanQuery, PROFILE_DIR, SEARCH_URL };
