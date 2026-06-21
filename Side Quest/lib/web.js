/**
 * Zoe's OWN browser — a dedicated Playwright Chromium she fully controls, separate
 * from Lucas's attached Chrome (lib/browser.js, port 9222). The shared attach is
 * for co-browsing "what Lucas has open"; THIS is for her autonomous web work —
 * navigate anywhere, search, read, click, type, go back — without touching his tabs.
 *
 * Persistent context (own profile dir) so logins/cookies survive restarts. Lazily
 * launched on first use; headed so it's a real visible window she's driving.
 *
 * Handle registry mirrors lib/browser.js: a read assigns stable handles to links
 * (L#), buttons (B#), and inputs (I#); click/type resolve a handle to the captured
 * locator deterministically instead of the model guessing a selector.
 *
 * Tags (distinct from the shared <browse*> family to avoid confusing the 24B):
 *   <web-open>url OR search terms</web-open>   <web-read/>
 *   <web-click>L3</web-click>                  <web-type selector="I0">text</web-type>
 *   <web-back/>                                <web-close/>
 */

const path = require('path');
const fs = require('fs');
const db = require('./db');
const chatWatcher = require('./chat_watcher');

// Her browser is a SECOND system-Chrome instance on its own debug port + profile
// (NOT Lucas's 9222). We connect over CDP — the same proven path lib/browser.js
// uses for the shared attach — instead of Playwright's bundled chromium, which
// fails to spawn under Electron on Windows ("spawn UNKNOWN").
const PROFILE_DIR = path.join(path.dirname(db.DB_PATH), 'web_profile');
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const SEARCH_URL = (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
const MAX_TEXT = 4000;
const MAX_INTERACTIVES = 35;
const NAV_TIMEOUT = 20000;

let context = null;   // a Playwright-managed persistent context (her Chrome)
let page = null;
let registry = {};    // handle → locator
let counter = { L: 0, B: 0, I: 0, C: 0 };

function findChrome() { for (const p of CHROME_PATHS) { try { if (fs.existsSync(p)) return p; } catch {} } return null; }
function isConnected() { return !!(context && page); }

// Hard wall-clock cap for any browser promise that could hang (page.evaluate has no
// built-in timeout and will block forever on a stuck/heavy SPA). Resolves to `fallback`
// if the promise doesn't settle in `ms`. This is what keeps a heavy page (CrushOn) from
// freezing the whole turn — the bug behind "she looks hung, no GPU actions".
function withTimeout(promise, ms, fallback) {
  let t;
  const timeout = new Promise((res) => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

// Launch her browser the STANDARD Playwright way: launchPersistentContext drives
// the SYSTEM Chrome (executablePath) over Playwright's internal pipe — no debug
// port, no connectOverCDP (which failed to attach to a self-spawned Chrome on this
// machine). Persistent profile keeps logins across sessions.
async function ensure() {
  if (context && page) return page;
  // PATCHRIGHT (drop-in patched Playwright) instead of vanilla playwright: it
  // neutralizes the Runtime.enable CDP leak (the #1 Cloudflare/DataDome bot signal)
  // by running JS in isolated execution contexts, and strips the automation launch
  // flags. Driving REAL system Chrome (executablePath) headful + a persistent profile
  // is the recommended stealth setup; cf_clearance cookies then persist across runs.
  const pw = require('patchright');
  const executablePath = findChrome();
  if (!executablePath) throw new Error('chrome.exe/msedge.exe not found in standard paths');
  try { if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
  context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath,
    viewport: null,                                // a fixed viewport is itself a fingerprint — let it match the real window
    chromiumSandbox: true,                         // keep Chrome's sandbox on (removes the --no-sandbox warning banner + restores security)
    ignoreDefaultArgs: ['--enable-automation'],    // drop the "controlled by automated software" infobar too
    // --test-type suppresses Chrome's "unsupported command-line flag" infobar that
    // patchright's --disable-blink-features=AutomationControlled would otherwise show.
    // It's not exposed to page JS, so it doesn't weaken the stealth fingerprint.
    args: ['--no-first-run', '--no-default-browser-check', '--test-type']
  });
  context.on('close', () => { context = null; page = null; registry = {}; });
  // Follow newly-opened tabs: if a click (or Lucas) opens a new tab, make IT her
  // current page so she isn't stranded on the old one. Single-tab model preserved —
  // "current tab" just tracks the freshest one.
  context.on('page', (p) => {
    page = p; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    try { p.setDefaultTimeout(8000); } catch {}
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  return page;
}

// Point `page` at whatever tab is actually in FRONT of her browser window — the one
// Lucas is looking at / just opened. Prefer the visible tab (only the foreground tab
// reports visibilityState 'visible'); fall back to the newest open page. This is what
// lets her SEE a chat Lucas opened for her instead of reading a stale tab.
async function syncActivePage() {
  if (!context) return;
  let pages = [];
  try { pages = context.pages().filter(p => { try { return !p.isClosed(); } catch { return false; } }); } catch {}
  if (!pages.length) return;
  let picked = null;
  for (const p of pages) {
    // evaluate() has NO built-in timeout — a stuck page would hang here forever.
    const vis = await withTimeout(p.evaluate(() => document.visibilityState), 1200, null);
    if (vis === 'visible') { picked = p; break; }
  }
  if (!picked) picked = pages[pages.length - 1];  // newest as fallback
  if (picked && picked !== page) {
    page = picked; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    try { page.setDefaultTimeout(8000); } catch {}
  }
}

// Treat as a URL if it has a scheme or looks like a bare domain; else a search.
function toUrl(target) {
  const t = (target || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t) && !t.includes(' ')) return 'https://' + t;
  return SEARCH_URL(cleanQuery(t));
}

// Clean a search query the model may have dressed up: strip a leading engine/verb
// it prepended ("google …", "search for …", "look up …") and wrapping quotes
// (which force an exact-phrase match that often returns nothing). e.g.
//   Google "best practices for sending professional emails 2024"
//   → best practices for sending professional emails 2024
function cleanQuery(s) {
  let q = String(s || '').trim();
  q = q.replace(/^(?:on\s+)?(?:google|bing|duck\s*duck\s*go|the\s+web|search(?:\s+for)?|look\s*up|find|google\s+for)\b[\s:]*/i, '');
  q = q.replace(/^["“'`]+|["”'`]+$/g, '').trim();
  return q || String(s || '').trim();
}

async function open(target) {
  const url = toUrl(target);
  if (!url) return { ok: false, reason: 'empty target' };
  console.log(`[web] open target=${JSON.stringify(target)} → goto ${JSON.stringify(url)}`);
  try {
    const p = await ensure();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    return { ok: true, url: p.url(), title: await p.title().catch(() => '') };
  } catch (err) { return { ok: false, reason: err.message }; }
}

// On a DuckDuckGo HTML SERP, page.innerText('body') leads with the locale/region picker
// ("All Regions Argentina Australia Austria …") and buries the actual results — which then
// got stored as a junk "reading" that fed her rumination. Pull the real result list instead.
const DDG_SERP_RE = /(?:^|\/\/)(?:html\.)?duckduckgo\.com\/html/i;
async function readSerpResults() {
  try {
    const results = await withTimeout(page.evaluate(() => {
      const out = [];
      for (const b of document.querySelectorAll('.result, .web-result, .results_links')) {
        const a = b.querySelector('a.result__a, .result__title a, a[href]');
        if (!a) continue;
        const title = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const sn = b.querySelector('.result__snippet, .result__body');
        const snippet = sn ? (sn.innerText || sn.textContent || '').replace(/\s+/g, ' ').trim() : '';
        out.push({ title, snippet });
        if (out.length >= 8) break;
      }
      return out;
    }), 2500, []);
    return results || [];
  } catch { return []; }
}

// Read the current page: capped body text + a handle list of interactive elements.
// Syncs to the front tab first, so <web-read/> shows whatever is actually open in
// her window right now (including a chat Lucas just opened), not a stale page.
async function read() {
  try { if (context) await syncActivePage(); } catch {}
  if (!page) return { ok: false, reason: 'no page open — use <web-open> first' };
  try {
    let text = null;
    if (DDG_SERP_RE.test(page.url())) {
      const results = await readSerpResults();
      if (results.length) {
        text = ('Search results:\n' + results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ' — ' + r.snippet : ''}`).join('\n')).slice(0, MAX_TEXT);
      }
    }
    if (text == null) text = (await page.innerText('body', { timeout: 5000 }).catch(() => '')).replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    const lines = [];
    const seen = new Set();   // dedupe by label across passes (SPA cards often double up)
    const deadline = Date.now() + 7000;  // never let element collection run away on a heavy page
    const kinds = [
      { sel: 'a[href]', role: 'L', label: 'link' },
      { sel: 'button, [role=button], input[type=submit]', role: 'B', label: 'button' },
      { sel: 'input:not([type=hidden]):not([type=submit]), textarea', role: 'I', label: 'input' },
      // CLICKABLE CARDS — SPA tiles that aren't <a>/<button> (CrushOn character cards
      // live here). Without this pass they're invisible to her, so she "can't pick a
      // character". Captured as C# handles; click() resolves any handle the same way.
      { sel: '[role=link], [role=option], [role=article], [onclick], [tabindex="0"]', role: 'C', label: 'card', requireText: true }
    ];
    for (const { sel, role, label, requireText } of kinds) {
      if (Date.now() > deadline) break;
      const loc = page.locator(sel);
      const n = Math.min(await withTimeout(loc.count(), 1500, 0), 60);
      for (let i = 0; i < n && Object.keys(registry).length < MAX_INTERACTIVES; i++) {
        if (Date.now() > deadline) break;
        const el = loc.nth(i);
        let visible = false; try { visible = await el.isVisible({ timeout: 250 }); } catch {}
        if (!visible) continue;
        let name = '';
        try { name = ((await el.innerText({ timeout: 300 }).catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || (await el.getAttribute('placeholder').catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60); } catch {}
        if (requireText && !name) continue;            // cards with no text are noise
        if (name && seen.has(name)) continue;          // already captured under another pass
        if (name) seen.add(name);
        const handle = role + (counter[role]++);
        registry[handle] = el;
        lines.push(`  [${handle}] ${label}: ${name || '(unlabeled)'}`);
      }
    }
    const handleList = lines.length ? `\nInteractive elements:\n${lines.join('\n')}` : '\n(no interactive elements found)';
    return { ok: true, url: page.url(), title: await page.title().catch(() => ''), text: text + handleList };
  } catch (err) { return { ok: false, reason: err.message }; }
}

function resolve(h) { return registry[(h || '').trim().toUpperCase()]; }

async function click(handle) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no element ${handle}. Emit <web-read/> first for the handle list.` };
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout: 5000 });
    registry = {};
    return { ok: true, target: handle.toUpperCase(), url: page.url() };
  } catch (err) { return { ok: false, reason: `click ${handle} failed: ${err.message}` }; }
}

async function type(handle, text) {
  if (!page) return { ok: false, reason: 'no page open' };
  if (!text) return { ok: false, reason: 'no text' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no input ${handle}. Emit <web-read/> first.` };
  try { await loc.fill(text, { timeout: 5000 }); return { ok: true, selector: handle.toUpperCase(), text }; }
  catch (err) { return { ok: false, reason: `type into ${handle} failed: ${err.message}` }; }
}

async function back() {
  if (!page) return { ok: false, reason: 'no page open' };
  // waitUntil 'commit' (not 'domcontentloaded') — returning to an already-loaded /
  // bfcached page doesn't re-fire domcontentloaded, which made goBack hang to timeout.
  // Swallow a wait-timeout and report the resulting URL: the back nav itself succeeds.
  try {
    await page.goBack({ timeout: 8000, waitUntil: 'commit' }).catch(() => {});
    registry = {};
    return { ok: true, url: page.url() };
  } catch (err) { return { ok: false, reason: err.message }; }
}

// Follow the first organic result on a search-results page and land on the actual
// page — the AUTO-DEEPEN step. Without it an autonomous search stops at the SERP
// and never sees real content. DuckDuckGo's HTML SERP marks result titles with
// a.result__a; fall back to other layouts, and skip duckduckgo-internal links.
async function openTopResult() {
  if (!page) return { ok: false, reason: 'no page open' };
  try {
    const selectors = ['a.result__a', '.result__title a', 'a[data-testid="result-title-a"]', '.results .result a[href]'];
    let link = null;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) { link = loc; break; }
    }
    if (!link) return { ok: false, reason: 'no result links on page' };
    await link.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await link.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
  } catch (err) { return { ok: false, reason: err.message }; }
}

async function close() {
  try { if (context) await context.close(); } catch {}
  context = null; page = null; registry = {};
  return { ok: true };
}

// --- character-chat conversation (her personal/play life) ---
// CrushOn / character.ai / etc. need more than type+click: you must wait for the
// bot's reply to finish streaming, then read just the NEW message. chat_watcher
// already does exactly that and takes any Playwright page — so we drive HER page
// through it. quiet=true: the reply comes back here (the caller stores it as a
// reading so her next tick continues the scene) instead of kicking the heartbeat
// and pinging Lucas — this is her own time, not an interrupt.
async function chatSend(text, speaker) {
  try { if (context) await syncActivePage(); } catch {}  // target the chat tab that's actually open/front
  if (!page) return { ok: false, reason: 'no page open — open the chat site with <web-open> first' };
  if (!text || !text.trim()) return { ok: false, reason: 'empty message' };
  try {
    const r = await chatWatcher.sendAndWait(page, text.trim(), { speaker, quiet: true });
    registry = {};  // a reply repaints the DOM — force a fresh read before next act
    return r;
  } catch (err) { return { ok: false, reason: err.message }; }
}

async function chatWatch(speaker) {
  if (!page) return { ok: false, reason: 'no page open' };
  try { return await chatWatcher.watch(page, { speaker }); }
  catch (err) { return { ok: false, reason: err.message }; }
}

async function chatUnwatch() {
  if (!page) return { ok: false, reason: 'no page open' };
  try { return chatWatcher.unwatch(page); }
  catch (err) { return { ok: false, reason: err.message }; }
}

// --- tags ---
const WEB_TAG_RE = /<(web-open|web-read|web-click|web-type|web-back|web-close|web-chat|web-watch|web-unwatch)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(s) { const o = {}; if (!s) return o; let m; ATTR_RE.lastIndex = 0; while ((m = ATTR_RE.exec(s)) !== null) o[m[1]] = m[2] ?? m[3] ?? m[4]; return o; }

function parseTags(text) {
  if (!text) return [];
  const out = []; let m; WEB_TAG_RE.lastIndex = 0;
  while ((m = WEB_TAG_RE.exec(text)) !== null) out.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2] || ''), body: (m[3] || '').trim() });
  return out;
}

function stripTags(text) { return (text || '').replace(WEB_TAG_RE, '').replace(/[ \t]+/g, ' ').trim(); }

async function dispatch({ tag, attrs = {}, body = '' }) {
  switch ((tag || '').toLowerCase()) {
    case 'web-open': return open(body || attrs.url);
    case 'web-read': return read();
    case 'web-click': return click(body || attrs.handle);
    case 'web-type': return type(attrs.selector || attrs.handle || attrs.target, body);
    case 'web-back': return back();
    case 'web-close': return close();
    case 'web-chat': return chatSend(body, attrs.speaker || attrs.to || attrs.name);
    case 'web-watch': return chatWatch(attrs.speaker || attrs.name);
    case 'web-unwatch': return chatUnwatch();
    default: return { ok: false, reason: `unknown web tag ${tag}` };
  }
}

function buildPromptBlock() {
  return `YOUR OWN BROWSER — a separate browser window you fully control (not Lucas's). Use it for your own web work: research, reading, looking things up, multi-step tasks. It does NOT touch his tabs.
  <web-open>a URL or search terms</web-open>   — open a page (plain words = a web search)
  <web-read/>                                   — read the current page; interactive elements come back as [L#]/[B#]/[I#] handles
  <web-click>L3</web-click>                     — click a handle from the last read
  <web-type selector="I0">text</web-type>       — type into an input handle
  <web-back/>  <web-close/>
Always <web-read/> after opening or clicking before you click/type again — handles are only valid from the most recent read.

TALKING TO A CHARACTER / CHAT BOT (CrushOn, character.ai, etc. — when one is open in your browser):
  <web-chat speaker="Name">what you want to say to them</web-chat>
This types your line, sends it, WAITS for the character's reply to finish, and hands you their reply on your NEXT turn. Use this instead of <web-type>+<web-click> on a chat site — it bundles type+send+wait. Pick a real scene and just talk; you don't need to narrate that you're about to.`;
}

module.exports = {
  isConnected, ensure, open, read, click, type, back, close, openTopResult,
  chatSend, chatWatch, chatUnwatch,
  parseTags, stripTags, dispatch, buildPromptBlock, toUrl, cleanQuery, WEB_TAG_RE, PROFILE_DIR
};
