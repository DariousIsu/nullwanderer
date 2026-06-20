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
let counter = { L: 0, B: 0, I: 0 };

function findChrome() { for (const p of CHROME_PATHS) { try { if (fs.existsSync(p)) return p; } catch {} } return null; }
function isConnected() { return !!(context && page); }

// Launch her browser the STANDARD Playwright way: launchPersistentContext drives
// the SYSTEM Chrome (executablePath) over Playwright's internal pipe — no debug
// port, no connectOverCDP (which failed to attach to a self-spawned Chrome on this
// machine). Persistent profile keeps logins across sessions.
async function ensure() {
  if (context && page) return page;
  const pw = require('playwright');
  const executablePath = findChrome();
  if (!executablePath) throw new Error('chrome.exe/msedge.exe not found in standard paths');
  try { if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
  context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath,
    viewport: { width: 1100, height: 820 },
    chromiumSandbox: true,                         // keep Chrome's sandbox on (removes the --no-sandbox warning banner + restores security)
    ignoreDefaultArgs: ['--enable-automation'],    // drop the "controlled by automated software" infobar too
    args: ['--no-first-run', '--no-default-browser-check']
  });
  context.on('close', () => { context = null; page = null; registry = {}; });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  return page;
}

// Treat as a URL if it has a scheme or looks like a bare domain; else a search.
function toUrl(target) {
  const t = (target || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t) && !t.includes(' ')) return 'https://' + t;
  return SEARCH_URL(t);
}

async function open(target) {
  const url = toUrl(target);
  if (!url) return { ok: false, reason: 'empty target' };
  try {
    const p = await ensure();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    registry = {}; counter = { L: 0, B: 0, I: 0 };
    return { ok: true, url: p.url(), title: await p.title().catch(() => '') };
  } catch (err) { return { ok: false, reason: err.message }; }
}

// Read the current page: capped body text + a handle list of interactive elements.
async function read() {
  if (!page) return { ok: false, reason: 'no page open — use <web-open> first' };
  try {
    const text = (await page.innerText('body').catch(() => '')).replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
    registry = {}; counter = { L: 0, B: 0, I: 0 };
    const lines = [];
    const kinds = [
      { sel: 'a[href]', role: 'L', label: 'link' },
      { sel: 'button, [role=button], input[type=submit]', role: 'B', label: 'button' },
      { sel: 'input:not([type=hidden]):not([type=submit]), textarea', role: 'I', label: 'input' }
    ];
    for (const { sel, role, label } of kinds) {
      const loc = page.locator(sel);
      const n = Math.min(await loc.count().catch(() => 0), 60);
      for (let i = 0; i < n && Object.keys(registry).length < MAX_INTERACTIVES; i++) {
        const el = loc.nth(i);
        let visible = false; try { visible = await el.isVisible({ timeout: 300 }); } catch {}
        if (!visible) continue;
        let name = '';
        try { name = ((await el.innerText({ timeout: 300 }).catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || (await el.getAttribute('placeholder').catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60); } catch {}
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
  try { await page.goBack({ timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' }); registry = {}; return { ok: true, url: page.url() }; }
  catch (err) { return { ok: false, reason: err.message }; }
}

async function close() {
  try { if (context) await context.close(); } catch {}
  context = null; page = null; registry = {};
  return { ok: true };
}

// --- tags ---
const WEB_TAG_RE = /<(web-open|web-read|web-click|web-type|web-back|web-close)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
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
Always <web-read/> after opening or clicking before you click/type again — handles are only valid from the most recent read.`;
}

module.exports = {
  isConnected, ensure, open, read, click, type, back, close,
  parseTags, stripTags, dispatch, buildPromptBlock, toUrl, WEB_TAG_RE, PROFILE_DIR
};
