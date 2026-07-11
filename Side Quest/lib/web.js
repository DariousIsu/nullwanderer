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
const blockersLib = require('./blockers');
const recorder = require('./recorder');
const recipeStore = require('./recipe_store');

// Her browser is a SECOND system-Chrome instance on its own debug port + profile
// (NOT Lucas's 9222). We connect over CDP — the same proven path lib/browser.js
// uses for the shared attach — instead of Playwright's bundled chromium, which
// fails to spawn under Electron on Windows ("spawn UNKNOWN").
const PROFILE_DIR = path.join(path.dirname(db.DB_PATH), 'web_profile');
// Downloads from her research browser are Playwright-controlled — without a downloadsPath they land
// in a temp artifacts dir and get DELETED on context close. Give them a real, predictable home.
const DOWNLOADS_DIR = path.join(path.dirname(db.DB_PATH), 'downloads');

// Resolve a non-clobbering destination path for a download (pure; `exists` injectable for the smoke).
// Sanitizes the suggested filename and appends " (n)" before the extension on collision.
function downloadDest(dir, suggestedName, exists = fs.existsSync) {
  const safe = String(suggestedName || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || `download-${Date.now()}`;
  if (!exists(path.join(dir, safe))) return path.join(dir, safe);
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let i = 1;
  while (exists(path.join(dir, `${base} (${i})${ext}`))) i++;
  return path.join(dir, `${base} (${i})${ext}`);
}
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
// Google for her VISIBLE deep-browse lane — a normal-browser feel for the tab she + Lucas
// co-watch. (DDG was dropped: it null-routed this IP after the search lane over-pinged it.
// Rapid programmatic search lives in the SEPARATE hidden stealth lane, lib/search_lane.js.)
const SEARCH_URL = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
// How much page text a <web-read/> hands back. This is her PRIMARY window into a page, so it's
// generous by default and tunable up via ZOE_WEB_READ_CHARS without a code change. (Cost: the
// read is fed to cognition as a tool follow-up, so bigger = more tokens/turn — cloud handles it.)
const MAX_TEXT = Math.max(2000, Number(process.env.ZOE_WEB_READ_CHARS) || 16000);
const MAX_INTERACTIVES = 35;
const NAV_TIMEOUT = 20000;

let context = null;   // a Playwright-managed persistent context (her Chrome)
let page = null;
let registry = {};    // handle → locator
let counter = { L: 0, B: 0, I: 0, C: 0 };

// Native JS dialog (alert/confirm/prompt) waiting for a response. Registering a 'dialog'
// listener disables Playwright's default auto-dismiss, so the dialog stays open until she
// accepts/dismisses it (<web-dialog>) — with a safety timeout so it can never hang the page.
let pendingDialog = null;
function onDialog(d) {
  pendingDialog = d;
  setTimeout(() => { if (pendingDialog === d) { pendingDialog = null; d.dismiss().catch(() => {}); } }, 30000);
}

// RECIPE RECORDING (lib/recorder.js). `demo` = an explicit record-by-demonstration
// session Lucas drives (in-page listeners). `passive` = her own successful flow on an
// uncovered site, captured silently. Only ONE feeds at a time — demonstration wins.
let demo = null;
let passive = null;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

// Finalize the passive session into a candidate recipe IF it's a real multi-step flow on
// a site we don't already cover. Single clicks / covered sites are dropped as noise.
function flushPassive() {
  if (!passive) return;
  const sess = passive; passive = null;
  try {
    if (recorder.actionStepCount(sess) < 2) return;
    if (recipeStore.find(sess.site, null)) return;   // already have a recipe for this host
    const recipe = recorder.finalize(sess);
    const res = recorder.save(recipe);
    if (res.ok) console.log(`[recorder] passive recipe saved: ${res.stem} (${recipe.steps.length} steps, site ${recipe.site})`);
  } catch (e) { console.error('[recorder] flushPassive failed:', e.message); }
}

// On navigation, rotate the passive session: if we crossed to a new host, flush the old
// one and (when the new host is uncovered and no demonstration is running) start a fresh
// passive capture. The initial navigate is recorded as the recipe's open step.
function rotatePassive(url) {
  if (demo) return;                                  // demonstration takes the wheel
  const host = hostOf(url);
  if (!host) return;
  if (passive && passive.site !== host) flushPassive();
  if (!passive) {
    if (recipeStore.find(host, null)) return;        // covered → nothing to learn
    passive = recorder.newSession({ site: host, task: 'flow', source: 'passive' });
  }
  recorder.pushNavigate(passive, url, Date.now());
}

function findChrome() { for (const p of CHROME_PATHS) { try { if (fs.existsSync(p)) return p; } catch {} } return null; }

// Kill any orphaned Chrome still running HER persistent profile before we launch a fresh
// one. A hard-killed app (Stop-Process) never runs close(), so the system Chrome she
// launched is orphaned — these pile up across restarts, and MULTIPLE windows in a Meet
// both play audio (the echo) + fight over the profile lock (join flakiness/drops). Only
// runs on a fresh launch (context === null), so it can't kill the current session's browser.
function killStaleProfileChrome() {
  if (process.platform !== 'win32') return;
  try {
    require('child_process').execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe'\\\" | Where-Object { $_.CommandLine -like '*web_profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
      { timeout: 8000, stdio: 'ignore' }
    );
  } catch {}
}
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
  if (context && page) {
    // A CLOSED page/tab must not be reused — that's the "Target page has been closed"
    // error that forced a full relaunch (a visible drop+rejoin mid-meeting). If the
    // context is still alive, just reuse/recreate a tab from it — no new window.
    let closed = false; try { closed = page.isClosed(); } catch { closed = true; }
    if (!closed) return page;
    try {
      const live = context.pages().find(p => { try { return !p.isClosed(); } catch { return false; } });
      page = live || await context.newPage();
      registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
      page.setDefaultTimeout(8000);
      try { page.on('dialog', onDialog); } catch {}
      return page;
    } catch { context = null; page = null; }   // context truly dead → fall through to relaunch
  }
  // PATCHRIGHT (drop-in patched Playwright) instead of vanilla playwright: it
  // neutralizes the Runtime.enable CDP leak (the #1 Cloudflare/DataDome bot signal)
  // by running JS in isolated execution contexts, and strips the automation launch
  // flags. Driving REAL system Chrome (executablePath) headful + a persistent profile
  // is the recommended stealth setup; cf_clearance cookies then persist across runs.
  const pw = require('patchright');
  const executablePath = findChrome();
  if (!executablePath) throw new Error('chrome.exe/msedge.exe not found in standard paths');
  try { if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
  try { if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch {}
  killStaleProfileChrome();   // clear orphaned windows on her profile (echo + lock conflicts)
  context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath,
    acceptDownloads: true,                         // (default) — but pair it with downloadsPath so files persist
    downloadsPath: DOWNLOADS_DIR,                  // without this, downloads go to a temp dir + are deleted on close
    viewport: null,                                // a fixed viewport is itself a fingerprint — let it match the real window
    chromiumSandbox: true,                         // keep Chrome's sandbox on (removes the --no-sandbox warning banner + restores security)
    ignoreDefaultArgs: ['--enable-automation'],    // drop the "controlled by automated software" infobar too
    // --test-type suppresses Chrome's "unsupported command-line flag" infobar that
    // patchright's --disable-blink-features=AutomationControlled would otherwise show.
    // It's not exposed to page JS, so it doesn't weaken the stealth fingerprint.
    // --mute-audio: she's an OBSERVER (reads captions) — her browser must never OUTPUT
    // audio, or a Meet tab playing the call on the same machine echoes against Lucas's.
    args: ['--no-first-run', '--no-default-browser-check', '--test-type', '--mute-audio']
  });
  context.on('close', () => { context = null; page = null; registry = {}; });
  // Persist downloads to DOWNLOADS_DIR with their real filename (collision-safe) instead of letting
  // Playwright discard them on context close. saveAs moves the temp artifact to the friendly path.
  context.on('download', async (download) => {
    try {
      const dest = downloadDest(DOWNLOADS_DIR, download.suggestedFilename());
      await download.saveAs(dest);
      console.log('[web] download saved →', dest);
    } catch (e) { console.error('[web] download save failed:', e.message); }
  });
  // Follow newly-opened tabs: if a click (or Lucas) opens a new tab, make IT her
  // current page so she isn't stranded on the old one. Single-tab model preserved —
  // "current tab" just tracks the freshest one.
  context.on('page', (p) => {
    page = p; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    try { p.setDefaultTimeout(8000); } catch {}
    try { p.on('dialog', onDialog); } catch {}   // let her accept/dismiss native dialogs
  });
  page = context.pages()[0] || await context.newPage();
  try { page.on('dialog', onDialog); } catch {}
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

// Extract candidate PERSON PHOTOS from the current page: visible <img> above a min size, each with its alt
// text, filename, dimensions, and nearest heading/caption/card text — enough for a later name→photo match.
// Used by the Puller discovery lane to grab an OFFICIAL headshot off a team/bio page. Fail-soft → [].
async function pageImages({ max = 40, minSize = 64 } = {}) {
  try {
    await ensure();
    await syncActivePage();
    if (!page) return [];
    const imgs = await withTimeout(page.evaluate(({ maxN, minSz }) => {
      const nearText = (el) => {
        let n = el, hops = 0;
        while (n && hops < 4) {
          const cap = n.querySelector && n.querySelector('figcaption, h1, h2, h3, h4, h5, [class*="name"], [class*="title"]');
          if (cap && cap.textContent && cap.textContent.trim()) return cap.textContent.trim().replace(/\s+/g, ' ').slice(0, 120);
          n = n.parentElement; hops++;
        }
        const p = el.closest && el.closest('figure, li, article, [class*="card"], [class*="member"], [class*="person"], [class*="team"], [class*="profile"], [class*="staff"], [class*="bio"]');
        const t = p && p.textContent ? p.textContent.replace(/\s+/g, ' ').trim() : '';
        return t.slice(0, 120);
      };
      const out = [];
      for (const img of Array.from(document.images || [])) {
        const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
        if (w < minSz || h < minSz) continue;                       // skip icons/spacers
        if (Math.max(w, h) / Math.max(1, Math.min(w, h)) > 3) continue;  // skip banners/logos (very non-square)
        const src = img.currentSrc || img.src || '';
        if (!/^https?:/i.test(src)) continue;
        out.push({ src, alt: (img.alt || '').replace(/\s+/g, ' ').slice(0, 120), near: nearText(img), w, h });
        if (out.length >= maxN) break;
      }
      return out;
    }, { maxN: max, minSz: minSize }), 6000, []);
    return Array.isArray(imgs) ? imgs : [];
  } catch { return []; }
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
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    try { rotatePassive(p.url()); } catch {}   // passive recipe capture on uncovered sites
    const result = { ok: true, url: p.url(), title: await p.title().catch(() => '') };
    // BLOCKER CHECK — did this land on a sign-in wall / CAPTCHA / Cloudflare / paywall?
    // If so, flag it so the caller asks Lucas for help instead of her flailing. She has
    // a persistent profile, so once he logs in the cookie sticks and she won't re-ask.
    try {
      const blocker = await blockersLib.detect(p, resp);
      if (blocker && blocker.needsHuman) { result.blocker = blocker; console.log(`[web] blocker on open: ${blocker.type} (${blocker.reason})`); }
    } catch {}
    return result;
  } catch (err) { return { ok: false, reason: err.message }; }
}

// On a Google SERP, page.innerText('body') leads with the search box, tabs, and tools chrome
// and buries the actual results — which then got stored as a junk "reading" that fed her
// rumination. Pull the real result list (title + snippet) instead. Selectors track Google's
// current result markup (h3 title inside the result anchor; .VwiC3b snippet) and skip
// Google-internal links (maps/images/"People also ask").
const SERP_RE = /(?:^|\/\/)(?:www\.)?google\.[a-z.]+\/search/i;
async function readSerpResults() {
  try {
    const results = await withTimeout(page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const h of document.querySelectorAll('#search h3, #rso h3')) {
        const a = h.closest('a[href]');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (!/^https?:/i.test(href)) continue;
        try { if (/(?:^|\.)google\./i.test(new URL(href, location.href).hostname)) continue; } catch {}
        const title = (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        const block = a.closest('div.g, div.MjjYud, div.tF2Cxc') || a.parentElement;
        const sn = block && block.querySelector('.VwiC3b, div[data-sncf], .Uroaid, .lyLwlc');
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
    if (SERP_RE.test(page.url())) {
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

async function click(handle, { button, dbl } = {}) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no element ${handle}. Emit <web-read/> first for the handle list.` };
  try {
    // Snapshot the descriptor BEFORE the click — a navigating click detaches its element.
    const info = passive && !demo ? await recorder.captureLocator(loc) : null;
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    if (dbl) await loc.dblclick({ timeout: 5000 });
    else await loc.click({ timeout: 5000, button: /right/i.test(button || '') ? 'right' : 'left' });
    if (info) { try { recorder.pushElement(passive, info, 'click', undefined, Date.now()); } catch {} }
    registry = {};
    return { ok: true, target: handle.toUpperCase(), kind: dbl ? 'double' : (/right/i.test(button || '') ? 'right' : 'left'), url: page.url() };
  } catch (err) { return { ok: false, reason: `click ${handle} failed: ${err.message}` }; }
}

// Click a link/button by its VISIBLE TEXT (accessible name), not a handle — for the forensic excavator,
// where vision reads the screenshot and names the link to follow ("Mercury (element)"). Bypasses read()'s
// capped, chrome-heavy handle list. Prefers an exact-ish link/button match, falls back to any anchor
// containing the text. Returns { ok, url, clicked }. Fail-soft.
async function clickText(text) {
  if (!page) return { ok: false, reason: 'no page open' };
  const t = String(text || '').trim();
  if (t.length < 2) return { ok: false, reason: 'no text' };
  try {
    let loc = page.getByRole('link', { name: t }).first();
    if (!(await withTimeout(loc.count(), 1500, 0))) loc = page.getByRole('button', { name: t }).first();
    if (!(await withTimeout(loc.count(), 1500, 0))) loc = page.locator(`a:has-text(${JSON.stringify(t)}), [role=link]:has-text(${JSON.stringify(t)})`).first();
    if (!(await withTimeout(loc.count(), 1500, 0))) return { ok: false, reason: `no clickable element matching "${t}"` };
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout: 5000 });
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    return { ok: true, url: page.url(), clicked: t };
  } catch (err) { return { ok: false, reason: `clickText "${t}" failed: ${err.message}` }; }
}

async function type(handle, text) {
  if (!page) return { ok: false, reason: 'no page open' };
  if (!text) return { ok: false, reason: 'no text' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no input ${handle}. Emit <web-read/> first.` };
  try {
    await loc.fill(text, { timeout: 5000 });
    if (passive && !demo) { try { await recorder.recordLocator(passive, loc, 'fill', text); } catch {} }
    return { ok: true, selector: handle.toUpperCase(), text };
  }
  catch (err) { return { ok: false, reason: `type into ${handle} failed: ${err.message}` }; }
}

// Scroll the page to load/reveal more content — the fix for "she reads the first
// screenful and stops". read() caps body text and only sees what's rendered; on a
// long article or an infinite-scroll feed she must scroll to advance. A scroll can
// lazy-load new DOM, so we invalidate the handle registry — she must <web-read/>
// again for fresh handles. dir defaults to down; "up"/"top" scrolls back.
async function scroll(dir) {
  if (!page) return { ok: false, reason: 'no page open' };
  const down = !/\b(up|back|top)\b/i.test(dir || '');
  try {
    await withTimeout(page.evaluate((d) => window.scrollBy(0, d * Math.round(window.innerHeight * 0.9)), down ? 1 : -1), 2500, null);
    await page.waitForTimeout(400).catch(() => {});   // let lazy-loaded content settle in
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    return { ok: true, url: page.url(), dir: down ? 'down' : 'up' };
  } catch (err) { return { ok: false, reason: err.message }; }
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
// and never sees real content. Google marks each organic result with an <h3> title
// inside the result anchor; pick the first such link, skipping Google-internal chrome.
async function openTopResult() {
  if (!page) return { ok: false, reason: 'no page open' };
  try {
    const selectors = ['#rso a:has(h3)', '#search a:has(h3)', 'a:has(h3)'];
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
  try { flushPassive(); } catch {}
  try { if (context) await context.close(); } catch {}
  context = null; page = null; registry = {};
  return { ok: true };
}

// --- record-by-demonstration (Lucas drives) ---
// Start a demonstration recording: open the target site in HER browser, install the
// in-page capture listeners, and let Lucas click/type through the flow once. Passive
// capture is suspended while a demonstration is live (demonstration wins).
async function startRecording({ site, task, url } = {}) {
  try {
    const p = await ensure();
    if (passive) { try { passive.active = false; } catch {} passive = null; }   // demonstration takes over
    if (url) { try { await p.goto(toUrl(url) || url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); } catch {} }
    const inferredSite = site || hostOf(p.url());
    demo = await recorder.startDemonstration(p, { site: inferredSite, task: task || 'flow' });
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    return { ok: true, site: inferredSite, task: demo.task, url: (() => { try { return p.url(); } catch { return url || ''; } })() };
  } catch (err) { return { ok: false, reason: err.message }; }
}

function isRecording() { return !!(demo && demo.active); }

// Stop the demonstration, assemble + save the recipe. Returns { ok, recipe, save }.
function stopRecording() {
  if (!demo) return { ok: false, reason: 'not recording' };
  try {
    const recipe = recorder.finalize(demo);
    demo = null;
    const steps = (recipe.steps || []).length;
    if (!steps) return { ok: false, reason: 'nothing was recorded — no steps captured' };
    const res = recorder.save(recipe);
    if (res.ok) console.log(`[recorder] demonstration recipe saved: ${res.stem} (${steps} steps, site ${recipe.site})`);
    return { ok: res.ok, recipe, save: res, steps };
  } catch (err) { demo = null; return { ok: false, reason: err.message }; }
}

// Run a declarative recipe (recipes/*.json) against HER browser via the flow runner.
// This is the live recipe-invocation path: ensures the browser, loads the recipe, and
// replays its locator descriptors deterministically (zero model). Returns the runner's
// result ({ ok, ran, healed, blocker?, atStep?, reason? }). A needsHuman blocker comes
// back in result.blocker so the caller (byline pipeline) can ask Lucas to log in.
async function runRecipe(recipeName, vars = {}, ctx = {}) {
  const recipeStore = require('./recipe_store');
  const flowRunner = require('./flow_runner');
  const recipe = recipeStore.load(recipeName) || recipeStore.find(recipeName, ctx.task);
  if (!recipe) return { ok: false, reason: `no recipe "${recipeName}"` };
  try {
    const p = await ensure();
    registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };   // recipe drives its own locators; invalidate stale handles
    return await flowRunner.runRecipe(p, recipe, vars, ctx);
  } catch (err) { return { ok: false, reason: err.message }; }
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

// Screenshot the CURRENT page as base64 PNG, so a vision model can SEE the rendered page
// (images, charts, layout) — not just the scraped text. Viewport-only by default (the visible
// screen); fullPage on request. Caller (main) runs it through lib/vision; web.js stays model-free.
async function screenshot({ fullPage = false } = {}) {
  try {
    await ensure();
    if (!page) return { ok: false, reason: 'no page open' };
    const buf = await withTimeout(page.screenshot({ type: 'png', fullPage }), 15000, null);
    if (!buf) return { ok: false, reason: 'screenshot timed out' };
    let url = '', title = '';
    try { url = page.url(); } catch {}
    try { title = await withTimeout(page.title(), 3000, ''); } catch {}
    return { ok: true, base64: Buffer.from(buf).toString('base64'), url, title };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ============================================================================
// FULL MANIPULATION SUITE — keyboard, forms, tactile mouse, tabs, nav, waits,
// dialogs. Each is a thin wrapper over Playwright on the CURRENT page; all reset
// the handle registry when the DOM may have changed (she must <web-read/> again).
// ============================================================================

// --- keyboard ---
// Press a key or combo on the focused element (or a given input handle). Enter to submit,
// Tab to move, Escape to close, "Control+A"/"Control+F" for shortcuts, arrows to navigate.
async function press(keys, handle) {
  if (!page) return { ok: false, reason: 'no page open' };
  const k = String(keys || '').trim();
  if (!k) return { ok: false, reason: 'no key(s) — e.g. Enter, Tab, Escape, ArrowDown, "Control+A"' };
  try {
    if (handle) { const loc = resolve(handle); if (!loc) return { ok: false, reason: `no element ${handle}. <web-read/> first.` }; await loc.press(k, { timeout: 5000 }); }
    else await page.keyboard.press(k);
    registry = {};   // a submit / shortcut can navigate or repaint
    return { ok: true, pressed: k, url: page.url() };
  } catch (err) { return { ok: false, reason: `press ${k} failed: ${err.message}` }; }
}

// Clear an input/textarea handle (fill with empty string).
async function clearField(handle) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no input ${handle}. <web-read/> first.` };
  try { await loc.fill('', { timeout: 5000 }); return { ok: true, cleared: handle.toUpperCase() }; }
  catch (err) { return { ok: false, reason: `clear ${handle} failed: ${err.message}` }; }
}

// Hover a handle OR visible text — reveals dropdown menus / tooltips that only appear on hover.
async function hover(target) {
  if (!page) return { ok: false, reason: 'no page open' };
  const t = (target || '').trim();
  if (!t) return { ok: false, reason: 'no target' };
  try {
    let loc = resolve(t);
    if (!loc) {
      loc = page.getByText(t, { exact: false }).first();
      if (!(await withTimeout(loc.count(), 1500, 0))) return { ok: false, reason: `no element "${t}". <web-read/> for handles.` };
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.hover({ timeout: 5000 });
    registry = {};   // a hover-revealed menu is new DOM
    return { ok: true, hovered: t, url: page.url() };
  } catch (err) { return { ok: false, reason: `hover "${t}" failed: ${err.message}` }; }
}

// --- forms ---
// Pick a <select> option by visible label first, then by value/text.
async function selectOption(handle, value) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no dropdown ${handle}. <web-read/> first.` };
  const v = String(value || '').trim();
  if (!v) return { ok: false, reason: 'no option given' };
  try {
    let picked;
    try { picked = await loc.selectOption({ label: v }, { timeout: 4000 }); }
    catch { picked = await loc.selectOption(v, { timeout: 4000 }); }
    return { ok: true, selected: v, values: picked };
  } catch (err) { return { ok: false, reason: `select "${v}" failed: ${err.message}` }; }
}

// Check / uncheck a checkbox or radio handle.
async function setChecked(handle, checked) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no checkbox ${handle}. <web-read/> first.` };
  try {
    if (checked) await loc.check({ timeout: 4000 }); else await loc.uncheck({ timeout: 4000 });
    return { ok: true, handle: handle.toUpperCase(), checked: !!checked };
  } catch (err) { return { ok: false, reason: `${checked ? 'check' : 'uncheck'} ${handle} failed: ${err.message}` }; }
}

// Attach a LOCAL file to a file-input handle. Path must exist on disk.
async function uploadFile(handle, filePath) {
  if (!page) return { ok: false, reason: 'no page open' };
  const loc = resolve(handle);
  if (!loc) return { ok: false, reason: `no file input ${handle}. <web-read/> first.` };
  const f = String(filePath || '').trim();
  if (!f) return { ok: false, reason: 'no file path' };
  if (!fs.existsSync(f)) return { ok: false, reason: `file not found: ${f}` };
  try { await loc.setInputFiles(f, { timeout: 5000 }); return { ok: true, uploaded: f }; }
  catch (err) { return { ok: false, reason: `upload failed: ${err.message}` }; }
}

// Submit a form — press Enter on the input handle (or the focused element).
async function submit(handle) {
  if (!page) return { ok: false, reason: 'no page open' };
  try {
    const loc = handle ? resolve(handle) : null;
    if (loc) await loc.press('Enter', { timeout: 5000 }); else await page.keyboard.press('Enter');
    registry = {};
    return { ok: true, submitted: handle ? handle.toUpperCase() : 'focused', url: page.url() };
  } catch (err) { return { ok: false, reason: `submit failed: ${err.message}` }; }
}

// --- tactile: vision-guided coordinate click ---
// Click at VIEWPORT pixel (x,y) — the coordinates she reads off a <web-see> screenshot when
// the target isn't a mapped handle (canvas, custom widget, image map). Viewport-relative, so
// don't pair with a full-page <web-see>. button="right" or dbl for context-menu / double-click.
async function clickAt(x, y, { button, dbl } = {}) {
  if (!page) return { ok: false, reason: 'no page open' };
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return { ok: false, reason: 'x and y must be numbers (viewport pixels from <web-see>)' };
  try {
    if (dbl) await page.mouse.dblclick(nx, ny);
    else await page.mouse.click(nx, ny, { button: /right/i.test(button || '') ? 'right' : 'left' });
    registry = {};
    return { ok: true, x: nx, y: ny, kind: dbl ? 'double' : (/right/i.test(button || '') ? 'right' : 'left'), url: page.url() };
  } catch (err) { return { ok: false, reason: `click-xy failed: ${err.message}` }; }
}

// --- navigation ---
async function forward() {
  if (!page) return { ok: false, reason: 'no page open' };
  try { await page.goForward({ timeout: 8000, waitUntil: 'commit' }).catch(() => {}); registry = {}; return { ok: true, url: page.url() }; }
  catch (err) { return { ok: false, reason: err.message }; }
}
async function reload() {
  if (!page) return { ok: false, reason: 'no page open' };
  try { await page.reload({ timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' }).catch(() => {}); registry = {}; return { ok: true, url: page.url() }; }
  catch (err) { return { ok: false, reason: err.message }; }
}

// --- tabs ---
function livePages() { try { return context ? context.pages().filter(p => { try { return !p.isClosed(); } catch { return false; } }) : []; } catch { return []; } }
async function listTabs() {
  const pages = livePages();
  const tabs = [];
  for (let i = 0; i < pages.length; i++) {
    let url = '', title = '';
    try { url = pages[i].url(); } catch {}
    try { title = await withTimeout(pages[i].title(), 1500, ''); } catch {}
    tabs.push({ index: i, url, title, active: pages[i] === page });
  }
  return { ok: true, tabs };
}
async function newTab(target) {
  try {
    await ensure();
    const p = await context.newPage();   // context 'page' handler makes it current + attaches dialog
    page = p; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
    try { p.setDefaultTimeout(8000); } catch {}
    if (target) { const url = toUrl(target); if (url) await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
    return { ok: true, index: livePages().indexOf(p), url: p.url(), title: await p.title().catch(() => '') };
  } catch (err) { return { ok: false, reason: err.message }; }
}
async function switchTab(index) {
  const pages = livePages(); const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) return { ok: false, reason: `no tab ${index}. <web-tab-list/> to see tabs.` };
  page = pages[i]; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 };
  try { page.setDefaultTimeout(8000); await page.bringToFront(); } catch {}
  return { ok: true, index: i, url: page.url(), title: await page.title().catch(() => '') };
}
async function closeTab(index) {
  const pages = livePages(); const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) return { ok: false, reason: `no tab ${index}` };
  const target = pages[i];
  try { await target.close(); } catch {}
  if (target === page) { const live = livePages(); page = live[live.length - 1] || null; registry = {}; counter = { L: 0, B: 0, I: 0, C: 0 }; }
  return { ok: true, closed: i, url: (() => { try { return page ? page.url() : ''; } catch { return ''; } })() };
}

// --- waits ---
// A bare number = wait that many ms; anything else = wait for a CSS selector to become visible.
async function waitFor(arg) {
  if (!page) return { ok: false, reason: 'no page open' };
  const a = String(arg || '').trim();
  if (/^\d+$/.test(a)) { const ms = Math.min(parseInt(a, 10), 15000); await page.waitForTimeout(ms); return { ok: true, waited: ms }; }
  if (!a) return { ok: false, reason: 'give ms (e.g. 2000) or a CSS selector' };
  try { await page.waitForSelector(a, { timeout: 15000, state: 'visible' }); registry = {}; return { ok: true, appeared: a }; }
  catch (err) { return { ok: false, reason: `"${a}" didn't appear: ${err.message}` }; }
}

// --- dialogs (native alert/confirm/prompt) ---
async function dialog(action, promptText) {
  if (!pendingDialog) return { ok: false, reason: 'no dialog is open' };
  const d = pendingDialog; pendingDialog = null;
  try {
    if (/accept|ok|yes|confirm/i.test(action || '')) { await d.accept(promptText || undefined); return { ok: true, action: 'accept' }; }
    await d.dismiss();
    return { ok: true, action: 'dismiss' };
  } catch (err) { return { ok: false, reason: err.message }; }
}

// --- precise extraction ---
// Read one element by CSS selector: its ATTRIBUTE (attr=…) or, by default, its text. For
// pulling an exact value the capped page text / handle list doesn't surface (a link's href,
// a data-* value, a specific cell). Returns the first match.
async function getEl(selector, attr) {
  if (!page) return { ok: false, reason: 'no page open' };
  const sel = String(selector || '').trim();
  if (!sel) return { ok: false, reason: 'no selector' };
  try {
    const loc = page.locator(sel).first();
    if (!(await withTimeout(loc.count(), 1500, 0))) return { ok: false, reason: `no element matches ${sel}` };
    let value;
    if (attr) value = await loc.getAttribute(attr, { timeout: 3000 });
    else value = (await loc.innerText({ timeout: 3000 }).catch(() => '')) || (await loc.textContent().catch(() => '')) || '';
    value = (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
    return { ok: true, selector: sel, attr: attr || null, value: value.length > 2000 ? value.slice(0, 2000) + '…' : value };
  } catch (err) { return { ok: false, reason: `get ${sel} failed: ${err.message}` }; }
}

// --- run JS on the page (inspection / structured extraction / debugging) ---
// Evaluates the given EXPRESSION in the page and returns the result (objects JSON-stringified,
// else coerced to string), bounded. In-page errors come back as "ERR: …" instead of throwing.
async function evalJs(expr) {
  if (!page) return { ok: false, reason: 'no page open' };
  const code = String(expr || '').trim();
  if (!code) return { ok: false, reason: 'no expression' };
  try {
    const wrapped = `(() => { try { const __v = (${code}); return (__v !== null && typeof __v === 'object') ? JSON.stringify(__v) : String(__v); } catch (e) { return 'ERR: ' + e.message; } })()`;
    const val = await withTimeout(page.evaluate(wrapped), 6000, null);
    const s = val == null ? '' : String(val);
    return { ok: true, value: s.length > 2000 ? s.slice(0, 2000) + '…' : s };
  } catch (err) { return { ok: false, reason: `eval failed: ${err.message}` }; }
}

// --- drag and drop ---
// Drag one handle onto another (reorder, sliders, file-less DnD widgets).
async function drag(from, to) {
  if (!page) return { ok: false, reason: 'no page open' };
  const a = resolve(from), b = resolve(to);
  if (!a) return { ok: false, reason: `no source ${from}. <web-read/> first.` };
  if (!b) return { ok: false, reason: `no target ${to}. <web-read/> first.` };
  try {
    await a.dragTo(b, { timeout: 8000 });
    registry = {};
    return { ok: true, from: (from || '').toUpperCase(), to: (to || '').toUpperCase(), url: page.url() };
  } catch (err) { return { ok: false, reason: `drag ${from}→${to} failed: ${err.message}` }; }
}

// --- tags ---
const WEB_TAG_RE = /<(web-open|web-read|web-see|web-deepen|web-scroll|web-click-text|web-click-xy|web-click|web-type|web-press|web-clear|web-hover|web-select|web-check|web-uncheck|web-upload|web-submit|web-forward|web-reload|web-tab-new|web-tab-list|web-tab-switch|web-tab-close|web-wait|web-dialog|web-get|web-eval|web-drag|web-back|web-close|web-chat|web-watch|web-unwatch)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
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
    case 'web-see': {
      // Optionally scroll FIRST so she can capture below the fold (scroll="down"/"up"), or grab the
      // WHOLE page in one shot (full/whole/entire/all in the body or scroll attr). Default = viewport.
      const want = `${body || ''} ${attrs.scroll || ''}`;
      if (attrs.scroll && !/\b(full|whole|entire|all)\b/i.test(attrs.scroll)) { try { await scroll(attrs.scroll); } catch {} }
      return screenshot({ fullPage: /\b(full|whole|entire|all)\b/i.test(want) });
    }
    case 'web-deepen': return openTopResult();
    case 'web-scroll': return scroll(body || attrs.dir);
    case 'web-click': return click(body || attrs.handle, { button: attrs.button, dbl: /^(1|true|yes|dbl|double)$/i.test(attrs.dbl || attrs.double || '') });
    case 'web-click-text': return clickText(body || attrs.text);
    case 'web-click-xy': return clickAt(attrs.x, attrs.y, { button: attrs.button, dbl: /^(1|true|yes|dbl|double)$/i.test(attrs.dbl || attrs.double || '') });
    case 'web-type': return type(attrs.selector || attrs.handle || attrs.target, body);
    case 'web-press': return press(body || attrs.key || attrs.keys, attrs.selector || attrs.handle || attrs.target);
    case 'web-clear': return clearField(attrs.selector || attrs.handle || attrs.target || body);
    case 'web-hover': return hover(body || attrs.handle || attrs.text);
    case 'web-select': return selectOption(attrs.selector || attrs.handle || attrs.target, body || attrs.value || attrs.option);
    case 'web-check': return setChecked(body || attrs.handle || attrs.selector, true);
    case 'web-uncheck': return setChecked(body || attrs.handle || attrs.selector, false);
    case 'web-upload': return uploadFile(attrs.selector || attrs.handle || attrs.target, body || attrs.path || attrs.file);
    case 'web-submit': return submit(attrs.selector || attrs.handle || attrs.target || body);
    case 'web-forward': return forward();
    case 'web-reload': return reload();
    case 'web-tab-new': return newTab(body || attrs.url);
    case 'web-tab-list': return listTabs();
    case 'web-tab-switch': return switchTab(body || attrs.index || attrs.i);
    case 'web-tab-close': return closeTab(body || attrs.index || attrs.i);
    case 'web-wait': return waitFor(body || attrs.selector || attrs.ms || attrs.for);
    case 'web-dialog': return dialog(body || attrs.action, attrs.text || attrs.value);
    case 'web-get': return getEl(attrs.selector || attrs.sel || body, attrs.attr || attrs.attribute);
    case 'web-eval': return evalJs(body || attrs.js || attrs.expr);
    case 'web-drag': return drag(attrs.from || attrs.source, attrs.to || attrs.target);
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
  <web-read/>                                   — read the current page's TEXT; interactive elements come back as [L#]/[B#]/[I#] handles
  <web-see>optional question</web-see>          — actually SEE the current page (a screenshot through your vision): images, charts, photos, layout — what the text alone can't tell you. Add a question to focus it. <web-see scroll="down">…</web-see> scrolls first to capture below the fold; say "full"/"whole" (in the question or scroll=) to grab the ENTIRE page in one shot.
  <web-deepen/>                                  — on a search-results page, open the TOP result and land on the real article (don't stop at the results list)
  <web-scroll/>                                  — scroll down to load/read MORE of a long page or feed, then <web-read/> again
  <web-click>L3</web-click>                     — click a handle from the last read (<web-click handle="B2" button="right"/> or dbl="1" for right/double-click)
  <web-click-text>Sign in</web-click-text>      — click by the VISIBLE text when you can't see a handle for it
  <web-type selector="I0">text</web-type>       — type into an input handle
  <web-press selector="I0">Enter</web-press>    — press a key/combo: Enter (submit), Tab, Escape, ArrowDown, "Control+A" (selector optional — omit to press on whatever's focused)
  <web-back/>  <web-forward/>  <web-reload/>  <web-close/>

FILLING FORMS (each needs a handle from the last <web-read/>):
  <web-clear selector="I0"/>                     — empty a field
  <web-select selector="I0">Option label</web-select>   — pick a dropdown option
  <web-check>I2</web-check>  <web-uncheck>I2</web-uncheck>   — tick / untick a checkbox or radio
  <web-upload selector="I3">C:\\path\\file.pdf</web-upload>  — attach a local file to a file input
  <web-submit selector="I0"/>                     — submit the form (Enter)

TACTILE / VISION-GUIDED (when there's no handle — a canvas, custom widget, image):
  <web-hover>L3</web-hover>                       — hover a handle or visible text to reveal a menu/tooltip, then <web-read/>
  <web-click-xy x="120" y="340"/>                — click at PIXEL x,y you read off a <web-see> screenshot (viewport coords — don't use with a full-page <web-see>; button="right"/dbl="1" too)

TABS & TIMING:
  <web-tab-new>url</web-tab-new>  <web-tab-list/>  <web-tab-switch>2</web-tab-switch>  <web-tab-close>2</web-tab-close>
  <web-wait>2000</web-wait>  or  <web-wait selector=".results"/>   — pause N ms, or wait for something to appear
  <web-dialog>accept</web-dialog>  /  <web-dialog>dismiss</web-dialog>   — answer a popup alert/confirm (add text="…" for a prompt)

PRECISE EXTRACTION & INSPECTION (when <web-read/>'s text isn't enough):
  <web-get selector="a.headline" attr="href"/>   — read ONE element's attribute (omit attr= for its text)
  <web-eval>document.querySelectorAll('.price').length</web-eval>   — run a JS expression on the page and get the result back
  <web-drag from="L1" to="L5"/>                   — drag one handle onto another (reorder, sliders, drop targets)
Always <web-read/> after opening, deepening, scrolling, clicking, hovering, waiting, or switching tabs before you act again — handles are only valid from the most recent read.
Go DEEP, not wide: after a search, <web-deepen/> into the best result and actually read it; <web-scroll/> through long pages instead of skimming the top. Take notes as you go with <file-write>/<file-append>.

TALKING TO A CHARACTER / CHAT BOT (CrushOn, character.ai, etc. — when one is open in your browser):
  <web-chat speaker="Name">what you want to say to them</web-chat>
This types your line, sends it, WAITS for the character's reply to finish, and hands you their reply on your NEXT turn. Use this instead of <web-type>+<web-click> on a chat site — it bundles type+send+wait. Pick a real scene and just talk; you don't need to narrate that you're about to.`;
}

// Read cookies from her dedicated (persistent, already-signed-in) browser context. Used to PORT her
// live Google session into the canvas Meet partition so Meet loads signed-in as her (Google blocks
// interactive sign-in inside embedded webviews, but an already-authed cookie session renders fine).
// `urls` filters by URL like Playwright's context.cookies(urls); omit for all. Returns [] on failure.
async function cookies(urls) {
  try { await ensure(); return await context.cookies(urls); } catch (e) { return []; }
}

module.exports = {
  isConnected, ensure, open, read, pageImages, screenshot, click, clickText, type, back, close, openTopResult, scroll, runRecipe,
  startRecording, stopRecording, isRecording, cookies,
  chatSend, chatWatch, chatUnwatch,
  press, clearField, hover, selectOption, setChecked, uploadFile, submit, clickAt,
  forward, reload, listTabs, newTab, switchTab, closeTab, waitFor, dialog, getEl, evalJs, drag,
  parseTags, stripTags, dispatch, buildPromptBlock, toUrl, cleanQuery, WEB_TAG_RE, PROFILE_DIR,
  DOWNLOADS_DIR, downloadDest
};
