/**
 * Browser interaction layer — Mode A (co-pilot user's actual Chrome).
 *
 * Architecture:
 *   1) launchChrome() — spawn Chrome with --remote-debugging-port=9222
 *      and a SEPARATE user-data-dir (her own session, not user's main one)
 *   2) connect() — Playwright connectOverCDP attaches to the debug port
 *   3) TabContext — tracks active tab, last-mentioned URL, recent tabs
 *   4) resolveTab(attr) — three-mode resolution (active | last | explicit)
 *   5) Tag handlers — browse / browse-read / browse-click / browse-type / browse-scroll
 *   6) extractA11y(page) — accessibility-tree text capped at ~2k tokens
 *
 * Stheno is text-only — no screenshots. The a11y tree gives her enough
 * semantic structure (roles, labels, headings) to act on without vision.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chatWatcher = require('./chat_watcher');

let chromium = null;  // lazy-loaded so app boots cleanly without playwright if missing

function loadPlaywright() {
  if (chromium) return chromium;
  try {
    chromium = require('playwright').chromium;
    return chromium;
  } catch (err) {
    console.error('[browser] playwright not installed:', err.message);
    return null;
  }
}

// --- State ---

let browserInstance = null;        // Playwright Browser
let chromeProcess = null;          // node child_process handle
const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

function getUserDataDir() {
  try {
    const electron = require('electron');
    if (electron.app && electron.app.getPath) {
      return path.join(electron.app.getPath('userData'), 'eloise-chrome');
    }
  } catch {}
  return path.join(process.cwd(), 'eloise-chrome');
}

// TabContext — single source of truth for tab resolution
const tabContext = {
  activeTabUrl: null,
  activeTabTitle: null,
  lastMentionedUrl: null,
  recentTabs: []  // [{ url, title, lastSeen, pageHandle }]
};

let listeners = { onStatusChange: () => {} };

function setListeners(l) {
  listeners = { ...listeners, ...l };
}

// --- Chrome launcher ---

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchChrome() {
  if (chromeProcess && !chromeProcess.killed) {
    return { ok: false, reason: 'Chrome already launched for shared mode' };
  }
  const chromePath = findChrome();
  if (!chromePath) {
    return { ok: false, reason: 'Could not find chrome.exe or msedge.exe in standard install paths' };
  }
  const userDataDir = getUserDataDir();
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `Could not create user-data-dir: ${err.message}` };
  }

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Night mode by default: Chrome's algorithmic auto-dark for ALL web contents
    // (not just sites with a dark theme). Per-page CDP setAutoDarkModeOverride in
    // trackPage() enforces it on every tab too (incl. tabs already open on connect).
    '--force-dark-mode',
    '--enable-features=WebContentsForceDark',
    'about:blank'
  ];
  try {
    // detached:true so Chrome doesn't die when the launcher pid exits.
    // On Windows, chrome.exe is itself a launcher that forks into a real
    // browser process and exits — we MUST NOT treat that exit as a real
    // disconnection. Use Playwright's browser.on('disconnected') event
    // instead (set up in connect()).
    chromeProcess = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    chromeProcess.unref();
    chromeProcess.on('exit', (code) => {
      console.log(`[browser] Chrome launcher pid exited with code ${code} (Windows fork-handoff — real browser likely still alive; ignoring)`);
      // INTENTIONALLY do not clear browserInstance here. The real disconnect
      // signal is browserInstance.on('disconnected') which fires when CDP
      // actually drops. Treat the launcher-pid exit as informational only.
      chromeProcess = null;
    });
    return { ok: true, chromePath, port: CDP_PORT };
  } catch (err) {
    return { ok: false, reason: `Spawn failed: ${err.message}` };
  }
}

// --- CDP connection ---

async function connect({ retries = 8, retryDelayMs = 600 } = {}) {
  const pw = loadPlaywright();
  if (!pw) return { ok: false, reason: 'playwright not installed' };
  if (browserInstance) return { ok: true, alreadyConnected: true };

  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      browserInstance = await pw.connectOverCDP(CDP_URL);
      break;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  if (!browserInstance) {
    return { ok: false, reason: `connectOverCDP failed after ${retries} tries: ${lastErr?.message}` };
  }

  // REAL disconnect signal: CDP socket drops. Fires when the actual browser
  // process dies (user closes the window, OS kills it, etc.) — NOT when the
  // Windows launcher pid exits during fork-handoff.
  browserInstance.on('disconnected', () => {
    console.log('[browser] CDP connection lost — browser closed');
    browserInstance = null;
    tabContext.activeTabUrl = null;
    tabContext.activeTabTitle = null;
    tabContext.recentTabs = [];
    try { listeners.onStatusChange({ connected: false }); } catch {}
  });

  // Attach page-level listeners to the default context so we track tabs as they open/close
  const contexts = browserInstance.contexts();
  for (const ctx of contexts) {
    ctx.on('page', (page) => trackPage(page));
    for (const page of ctx.pages()) trackPage(page);
  }
  await refreshTabContext();
  try { listeners.onStatusChange({ connected: true, ...statusSnapshot() }); } catch {}
  return { ok: true };
}

async function disconnect() {
  if (browserInstance) {
    try { await browserInstance.close().catch(() => {}); } catch {}
    browserInstance = null;
  }
  if (chromeProcess && !chromeProcess.killed) {
    try { chromeProcess.kill(); } catch {}
    chromeProcess = null;
  }
  tabContext.activeTabUrl = null;
  tabContext.activeTabTitle = null;
  tabContext.recentTabs = [];
  try { listeners.onStatusChange({ connected: false }); } catch {}
  return { ok: true };
}

function isConnected() {
  return !!browserInstance;
}

// --- Tab tracking ---

// Force Chrome's auto-dark on this page (night mode on all sites). Per-page CDP override —
// belt-and-suspenders with the --force-dark-mode launch flag, and the only path that reaches
// tabs already open when we connect. Best-effort: some internal pages reject the override.
async function applyDarkMode(page) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setAutoDarkModeOverride', { enabled: true });
  } catch { /* flags cover the rest; never block tab tracking on this */ }
}

function trackPage(page) {
  applyDarkMode(page);
  // Initial state
  setTimeout(() => updateTabForPage(page), 250);
  // Updates as the user navigates
  page.on('framenavigated', (f) => {
    // Invalidate captured handle→locator map on a main-frame nav: an in-place
    // nav or SPA route change detaches the locators captured at the last read,
    // so B0/I0 would resolve to stale/detached elements. Drop the registry so
    // the model is forced to <browse-read/> again before acting.
    if (f === page.mainFrame()) elementRegistry.delete(page);
    updateTabForPage(page);
  });
  page.on('load', () => {
    elementRegistry.delete(page);
    updateTabForPage(page);
  });
  page.on('close', () => removeTabForPage(page));
}

async function updateTabForPage(page) {
  try {
    if (page.isClosed()) return;
    const url = page.url();
    let title = '';
    try { title = await page.title(); } catch {}
    if (!url || url === 'about:blank') {
      // still record so it's listable
    }
    const now = Date.now();
    const existing = tabContext.recentTabs.find(t => t.pageHandle === page);
    if (existing) {
      existing.url = url;
      existing.title = title;
      existing.lastSeen = now;
    } else {
      tabContext.recentTabs.push({ url, title, lastSeen: now, pageHandle: page });
      // Cap at 20
      if (tabContext.recentTabs.length > 20) {
        tabContext.recentTabs.sort((a, b) => b.lastSeen - a.lastSeen);
        tabContext.recentTabs = tabContext.recentTabs.slice(0, 20);
      }
    }
    // Best-effort active-tab detection: in a shared Chrome, the foreground tab
    // is whichever page has visibility 'visible'
    try {
      const state = await page.evaluate(() => document.visibilityState).catch(() => null);
      if (state === 'visible') {
        tabContext.activeTabUrl = url;
        tabContext.activeTabTitle = title;
      }
    } catch {}
    try { listeners.onStatusChange({ connected: true, ...statusSnapshot() }); } catch {}
  } catch (err) {
    // page is probably closed mid-update; ignore
  }
}

function removeTabForPage(page) {
  tabContext.recentTabs = tabContext.recentTabs.filter(t => t.pageHandle !== page);
  if (tabContext.activeTabUrl && !tabContext.recentTabs.find(t => t.url === tabContext.activeTabUrl)) {
    tabContext.activeTabUrl = null;
    tabContext.activeTabTitle = null;
  }
  try { listeners.onStatusChange({ connected: true, ...statusSnapshot() }); } catch {}
}

async function refreshTabContext() {
  if (!browserInstance) return;
  tabContext.recentTabs = [];
  for (const ctx of browserInstance.contexts()) {
    for (const page of ctx.pages()) {
      try {
        const url = page.url();
        const title = await page.title().catch(() => '');
        tabContext.recentTabs.push({ url, title, lastSeen: Date.now(), pageHandle: page });
      } catch {}
    }
  }
  // First tab in the list becomes a best-guess active until we get visibility events
  if (tabContext.recentTabs.length > 0 && !tabContext.activeTabUrl) {
    tabContext.activeTabUrl = tabContext.recentTabs[0].url;
    tabContext.activeTabTitle = tabContext.recentTabs[0].title;
  }
}

// Called when user message OR Eloise's text mentions a URL or known tab title
function noteMention(textOrUrl) {
  if (!textOrUrl) return;
  // Direct URL match
  const urlRe = /https?:\/\/[^\s<>"')\]]+/i;
  const m = String(textOrUrl).match(urlRe);
  if (m) {
    tabContext.lastMentionedUrl = m[0];
    return;
  }
  // Tab-title fuzzy match
  const lower = String(textOrUrl).toLowerCase();
  for (const t of tabContext.recentTabs) {
    if (!t.title) continue;
    if (lower.includes(t.title.toLowerCase().slice(0, 30))) {
      tabContext.lastMentionedUrl = t.url;
      return;
    }
  }
}

// --- Tab resolution chain ---

function resolveTab(attr) {
  if (!browserInstance) return null;
  if (tabContext.recentTabs.length === 0) return null;

  const a = (attr || 'active').toString().trim().toLowerCase();

  // 1. active / empty → active tab
  if (!a || a === 'active') {
    if (tabContext.activeTabUrl) {
      const found = tabContext.recentTabs.find(t => t.url === tabContext.activeTabUrl);
      if (found) return found.pageHandle;
    }
    return tabContext.recentTabs[0]?.pageHandle || null;
  }

  // 2. last → most-recently-mentioned URL. Prefer an EXACT url match first; a
  // bare-origin mention (e.g. "https://crushon.ai") would otherwise prefix-match
  // the wrong deep-linked tab. Only fall back to startsWith when nothing matches.
  if (a === 'last') {
    if (tabContext.lastMentionedUrl) {
      const exact = tabContext.recentTabs.find(t => t.url === tabContext.lastMentionedUrl);
      if (exact) return exact.pageHandle;
      const prefix = tabContext.recentTabs.find(t => t.url.startsWith(tabContext.lastMentionedUrl));
      if (prefix) {
        console.log(`[browser] tab="last": no exact match for ${tabContext.lastMentionedUrl}, falling back to prefix match ${prefix.url}`);
        return prefix.pageHandle;
      }
    }
    console.log('[browser] tab="last": no url match, falling back to most-recent tab');
    return tabContext.recentTabs[0]?.pageHandle || null;
  }

  // 3a. numeric index
  if (/^\d+$/.test(a)) {
    const idx = parseInt(a, 10);
    if (idx >= 0 && idx < tabContext.recentTabs.length) return tabContext.recentTabs[idx].pageHandle;
    return null;
  }

  // 3b. title:phrase
  if (a.startsWith('title:')) {
    const needle = a.slice('title:'.length).trim().toLowerCase();
    if (!needle) return null;
    const found = tabContext.recentTabs.find(t => (t.title || '').toLowerCase().includes(needle));
    return found?.pageHandle || null;
  }

  // 3c. URL substring match
  const found = tabContext.recentTabs.find(t => t.url.toLowerCase().includes(a));
  return found?.pageHandle || null;
}

// --- Status snapshot for the renderer + prompt injection ---

function statusSnapshot() {
  return {
    activeUrl: tabContext.activeTabUrl,
    activeTitle: tabContext.activeTabTitle,
    tabCount: tabContext.recentTabs.length,
    tabs: tabContext.recentTabs.slice(0, 10).map((t, i) => ({
      index: i, url: t.url, title: t.title
    })),
    lastMentioned: tabContext.lastMentionedUrl
  };
}

/**
 * Build the BROWSER block injected into Stheno + gemma prompts when connected.
 * Listed tabs + the tag syntax instructions.
 */
function buildPromptBlock() {
  if (!browserInstance || tabContext.recentTabs.length === 0) return '';
  const active = tabContext.activeTabUrl;
  const lines = [];
  lines.push(`BROWSER ACCESS — YOU CAN ACT ON THESE TABS IN LUCAS'S CHROME WINDOW.`);
  lines.push(``);
  lines.push(`CRITICAL: to actually look at a page, READ a page, CLICK a button, TYPE, or SCROLL, you MUST EMIT THE CORRESPONDING TAG in your <think> or <say>. Describing what you'll do does NOT do it. Only the literal tag triggers the action.`);
  lines.push(``);
  lines.push(`WRONG (this does nothing — Lucas will not see any page activity, and you will get no content back):`);
  lines.push(`  <say>Let me take a look at the CrushOn AI page and see what's there.</say>`);
  lines.push(``);
  lines.push(`RIGHT (this actually reads the page and the content appears in your next-turn context):`);
  lines.push(`  <think>I want to look at what Lucas has open. <browse-read/> Let me see what comes back.</think>`);
  lines.push(`  <say>Looking now.</say>`);
  lines.push(``);
  lines.push(`OPEN TABS IN LUCAS'S CHROME:`);
  tabContext.recentTabs.slice(0, 8).forEach((t, i) => {
    const marker = (t.url === active) ? ' [active — what Lucas is looking at right now]' : '';
    const title = (t.title || '(no title)').slice(0, 70);
    const url = t.url.length > 80 ? t.url.slice(0, 80) + '…' : t.url;
    lines.push(`  [${i}]${marker} "${title}" — ${url}`);
  });
  lines.push(``);
  lines.push(`YOUR BROWSER TAGS (emit literally — exact characters including angle brackets):`);
  lines.push(`  <browse-read/>                            — READ the active tab and put its text in your next context`);
  lines.push(`  <browse-read tab="2"/>                    — read tab by index`);
  lines.push(`  <browse-read tab="last"/>                 — read most-recently-mentioned URL`);
  lines.push(`  <browse-read tab="crushon.ai"/>           — read by URL substring`);
  lines.push(`  <browse-see/>                             — SEE the active tab (a screenshot through your vision): images, charts, photos, layout the text can't show. <browse-see tab="2"/> for a specific tab.`);
  lines.push(`  <browse>https://...</browse>              — OPEN a NEW tab to a URL`);
  lines.push(`  <browse tab="active">https://...</browse>  — navigate the CURRENT tab to a URL (in place, no new tab)`);
  lines.push(`  <browse-close tab="2"/>                   — CLOSE a tab by index/domain/title (frees clutter)`);
  lines.push(`  <browse-click>B0</browse-click>           — CLICK by element HANDLE (from a read)`);
  lines.push(`  <browse-type selector="I0">query</browse-type>  — TYPE into an input HANDLE (from a read)`);
  lines.push(`  <browse-scroll>down 2</browse-scroll>     — SCROLL the page (up|down + N pages)`);
  lines.push(``);
  lines.push(`ALWAYS <browse-read/> BEFORE clicking or typing. The read returns a numbered list of`);
  lines.push(`the page's real buttons/links/inputs with handles like [B0] [L3] [I0]. Click/type by`);
  lines.push(`naming a handle you saw in that list — never invent a selector or guess button text.`);
  lines.push(`Read → see the handles → act on a handle. Acting blind without reading first will fail.`);
  lines.push(``);
  lines.push(`CHAT-BOT INTERACTION (special tags for when the active tab is a chat-bot site like crushon.ai, character.ai, etc):`);
  lines.push(`  <chat-send speaker="Aiden">your message text</chat-send>   — TYPE + SEND a message AND wait for the bot's reply (auto-detects when reply finishes streaming up to 45s; reply arrives in your NEXT context as <incoming from="Aiden">...)`);
  lines.push(`  <chat-watch speaker="Aiden"/>                              — start watching the active tab so when the bot replies, you get notified`);
  lines.push(`  <chat-unwatch/>                                            — stop watching`);
  lines.push(``);
  lines.push(`Use <chat-send> instead of separate <browse-type> + <browse-click>Send</browse-click> when the active tab is a chat bot — it bundles type+submit+wait and you'll see the response next turn.`);
  lines.push(``);
  lines.push(`When Lucas asks you to look at, interact with, explore, check, read, or do anything to a page — EMIT THE TAG. Default to <browse-read/> first to actually see what's there before commenting on it.`);
  return lines.join('\n') + '\n';
}

// --- Action handlers ---

async function actionBrowse(url, tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  if (!url || !/^https?:\/\//i.test(url.trim())) return { ok: false, reason: `invalid URL "${url}"` };
  try {
    // If a tab is specified, navigate THAT tab in place. Otherwise open a new tab.
    // tab="active" / tab="2" / tab="domain" → in-place navigation (no clutter).
    let page;
    if (tabAttr) {
      page = resolveTab(tabAttr);
      if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr}" to navigate in place` };
    } else {
      const ctx = browserInstance.contexts()[0];
      page = await ctx.newPage();
      trackPage(page);
    }
    await page.goto(url.trim(), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await updateTabForPage(page);
    tabContext.lastMentionedUrl = url.trim();
    return { ok: true, url: url.trim(), title: await page.title().catch(() => ''), inPlace: !!tabAttr };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function actionClose(tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  if (!tabAttr) return { ok: false, reason: 'browse-close requires tab="N" / tab="domain" / tab="title:..." — refusing to guess which tab to close' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr}" to close` };
  // Don't let her close the only tab (would leave Chrome empty / break the session)
  if (tabContext.recentTabs.length <= 1) return { ok: false, reason: 'only one tab open — not closing it' };
  const url = page.url();
  const title = await page.title().catch(() => '');
  // HARD GUARD #1 — never close Lucas's ACTIVE/foreground tab. This is the shared co-pilot
  // Chrome; the active tab is the one he's using right now. (The "she closed my active shared
  // tab thinking she left the meeting" failure.)
  if (tabContext.activeTabUrl && url === tabContext.activeTabUrl) {
    return { ok: false, reason: "refusing to close the active/foreground tab — that's the tab Lucas is using right now" };
  }
  // HARD GUARD #2 — a Google Meet tab in the SHARED browser is never hers to close. Leaving a
  // meeting happens in HER OWN browser via the gmeet stepper (Leave call), not by closing a
  // tab here. Closing it cannot "leave the meeting" and only risks nuking Lucas's window.
  if (/meet\.google\.com\//i.test(url)) {
    return { ok: false, reason: "that's a Google Meet tab in the shared browser — leaving a meeting is handled in my own browser, not by closing Lucas's tab" };
  }
  try {
    elementRegistry.delete(page);
    removeTabForPage(page);
    await page.close();
    return { ok: true, closed: { url, title } };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function actionRead(tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr || 'active'}"` };
  try {
    const text = await extractA11y(page);
    const url = page.url();
    const title = await page.title().catch(() => '');
    return { ok: true, url, title, text };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function actionClick(target, tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab` };
  if (!target || target.trim().length === 0) return { ok: false, reason: 'empty click target' };
  const t = target.trim();

  // PRIMARY: handle resolution (B0/L3 from the last read). Deterministic — the
  // element was captured at read time, no guessing.
  const handleMatch = t.match(/\b([BL]\d+)\b/i);
  if (handleMatch) {
    const reg = getRegistry(page);
    const loc = reg && reg[handleMatch[1].toUpperCase()];
    if (loc) {
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await loc.click({ timeout: 4000 });
        return { ok: true, target: handleMatch[1].toUpperCase() };
      } catch (err) {
        return { ok: false, reason: `handle ${handleMatch[1]} found but click failed: ${err.message}. Try <browse-read/> again — the page may have changed.` };
      }
    }
    return { ok: false, reason: `no element with handle ${handleMatch[1]}. Emit <browse-read/> first to get the current handle list.` };
  }

  // FALLBACK: fuzzy text match (when she names visible text instead of a handle)
  const attempts = [
    () => page.getByRole('button', { name: t, exact: false }),
    () => page.getByRole('link', { name: t, exact: false }),
    () => page.getByText(t, { exact: false }).first()
  ];
  for (const attempt of attempts) {
    try {
      const loc = attempt();
      await loc.click({ timeout: 3000 });
      return { ok: true, target: t };
    } catch {}
  }
  return { ok: false, reason: `no element matched "${t}". Emit <browse-read/> first and click by its [handle].` };
}

async function actionType(selector, text, tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: 'could not resolve tab' };
  if (!selector || !text) return { ok: false, reason: 'selector and text required' };
  const sel = selector.trim();

  // PRIMARY: input handle (I0 from the last read)
  const handleMatch = sel.match(/\b(I\d+)\b/i);
  if (handleMatch) {
    const reg = getRegistry(page);
    const loc = reg && reg[handleMatch[1].toUpperCase()];
    if (loc) {
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await loc.fill(text, { timeout: 4000 });
        return { ok: true, selector: handleMatch[1].toUpperCase(), text };
      } catch (err) {
        return { ok: false, reason: `input ${handleMatch[1]} found but fill failed: ${err.message}` };
      }
    }
    return { ok: false, reason: `no input with handle ${handleMatch[1]}. Emit <browse-read/> first.` };
  }

  // FALLBACK: CSS selector or label
  try {
    let loc;
    if (sel.startsWith('#') || sel.startsWith('.') || sel.includes('[')) {
      loc = page.locator(sel);
    } else {
      loc = page.getByRole('textbox', { name: sel, exact: false });
      if (!(await loc.count())) loc = page.getByPlaceholder(sel);
    }
    await loc.fill(text, { timeout: 3000 });
    return { ok: true, selector: sel, text };
  } catch (err) {
    return { ok: false, reason: `${err.message}. Emit <browse-read/> first and type into an input [handle].` };
  }
}

async function actionScroll(spec, tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: 'could not resolve tab' };
  const m = String(spec || 'down 1').toLowerCase().match(/(up|down)\s*(\d+)?/);
  if (!m) return { ok: false, reason: `invalid scroll spec "${spec}"` };
  const dir = m[1] === 'up' ? -1 : 1;
  const count = parseInt(m[2] || '1', 10);
  try {
    await withEvalTimeout(page.evaluate(({ d, n }) => {
      window.scrollBy({ top: d * n * window.innerHeight, left: 0, behavior: 'instant' });
    }, { d: dir, n: count }), 'scroll');
    return { ok: true, direction: m[1], count };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// --- A11y tree → text ---

const MAX_A11Y_CHARS = 5000;  // ~1200 tokens for body
const MAX_INTERACTIVES = 40;
// Hard ceiling for otherwise-unguarded page.evaluate / a11y-snapshot calls so a
// hung renderer can't block the dispatch loop forever. Other actions already
// pass per-call timeouts; this is the fallback for the ones that don't.
const EVAL_TIMEOUT_MS = 8000;

// Wrap a promise so it rejects if it hasn't settled within EVAL_TIMEOUT_MS.
function withEvalTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'page.evaluate'} timed out after ${EVAL_TIMEOUT_MS}ms`)), EVAL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Per-page registry of interactive elements, keyed by stable handle (B0/L3/I0…).
// Populated on each read; click/type resolve handles to live Playwright locators
// deterministically instead of the model guessing CSS selectors blind.
// Map<page, { B0: locator, L3: locator, I0: locator, ... }>
const elementRegistry = new Map();

function getRegistry(page) {
  return elementRegistry.get(page) || null;
}
function setRegistry(page, handles) {
  elementRegistry.set(page, handles);
}

async function extractA11y(page) {
  let bodyText = '';
  try {
    const snap = await withEvalTimeout(page.accessibility.snapshot({ interestingOnly: true }), 'a11y-snapshot');
    const lines = [];
    walkA11y(snap, lines, 0);
    bodyText = lines.join('\n');
    if (bodyText.length > MAX_A11Y_CHARS) bodyText = bodyText.slice(0, MAX_A11Y_CHARS) + '\n…(truncated)';
  } catch (err) {
    try {
      const body = await page.locator('body').innerText({ timeout: 3000 });
      bodyText = (body || '').slice(0, MAX_A11Y_CHARS);
    } catch {
      bodyText = '(could not extract page content)';
    }
  }

  // Second pass: list INTERACTIVE elements so she knows what's clickable/typeable.
  // Without this she sees page text but doesn't realize "Mizuki, The Fired Mini Boss"
  // is a clickable card she could open.
  const interactives = await extractInteractives(page);
  let interactivesText = '';
  if (interactives.buttons.length || interactives.links.length || interactives.inputs.length) {
    const parts = ['\n\n--- INTERACTIVE ELEMENTS ON THIS PAGE ---',
                   'To act, name the HANDLE in brackets — not a guessed selector.'];
    if (interactives.buttons.length > 0) {
      parts.push(`BUTTONS — click with <browse-click>HANDLE</browse-click>:`);
      interactives.buttons.slice(0, 15).forEach(b => parts.push(`  [${b.handle}] "${b.label}"`));
    }
    if (interactives.links.length > 0) {
      parts.push(`LINKS — follow with <browse-click>HANDLE</browse-click>:`);
      interactives.links.slice(0, 20).forEach(l => parts.push(`  [${l.handle}] "${l.label}"`));
    }
    if (interactives.inputs.length > 0) {
      parts.push(`INPUTS — type with <browse-type selector="HANDLE">your text</browse-type>:`);
      interactives.inputs.slice(0, 8).forEach(i => parts.push(`  [${i.handle}] ${i.kind} "${i.label}"`));
    }
    parts.push(`Example: to click "${(interactives.buttons[0] || interactives.links[0]).label}" emit <browse-click>${(interactives.buttons[0] || interactives.links[0]).handle}</browse-click>`);
    interactivesText = parts.join('\n');
  }

  return bodyText + interactivesText;
}

/**
 * Pull clickable + typeable elements from the page, assign each a STABLE HANDLE
 * (B0/B1… buttons, L0… links, I0… inputs), capture the live Playwright locator
 * for each, and store the handle→locator map in the registry for this page.
 *
 * Returns { buttons:[{handle,label}], links:[{handle,label}], inputs:[{handle,label,kind}] }
 * for display. click/type later resolve the handle to the captured locator —
 * the model never guesses a selector, it just names a handle it can see.
 */
async function extractInteractives(page) {
  const buttons = [];
  const links = [];
  const inputs = [];
  const handles = {};  // handle -> live locator

  try {
    // BUTTONS
    let btnLocators = await page.getByRole('button').all();
    if (btnLocators.length === 0) {
      btnLocators = await page.locator('button, [role="button"], [type="submit"]').all();
    }
    for (const loc of btnLocators.slice(0, MAX_INTERACTIVES)) {
      try {
        const txt = (await loc.textContent({ timeout: 600 }))?.trim().replace(/\s+/g, ' ');
        if (txt && txt.length > 0 && txt.length < 80 && !buttons.some(b => b.label === txt)) {
          const handle = 'B' + buttons.length;
          handles[handle] = loc;
          buttons.push({ handle, label: txt });
          if (buttons.length >= 15) break;
        }
      } catch {}
    }
    // LINKS
    let linkLocators = await page.getByRole('link').all();
    if (linkLocators.length === 0) {
      linkLocators = await page.locator('a[href], [role="link"]').all();
    }
    for (const loc of linkLocators.slice(0, MAX_INTERACTIVES)) {
      try {
        const txt = (await loc.textContent({ timeout: 600 }))?.trim().replace(/\s+/g, ' ');
        if (txt && txt.length > 0 && txt.length < 120 && !links.some(l => l.label === txt)) {
          const handle = 'L' + links.length;
          handles[handle] = loc;
          links.push({ handle, label: txt });
          if (links.length >= 20) break;
        }
      } catch {}
    }
    // Clickable divs/spans for SPA card UIs — appended to buttons
    if (buttons.length + links.length < 5) {
      const clickyLocators = await page.locator('[onclick], [tabindex="0"]').all();
      for (const loc of clickyLocators.slice(0, 20)) {
        try {
          const txt = (await loc.textContent({ timeout: 600 }))?.trim().replace(/\s+/g, ' ');
          if (txt && txt.length > 2 && txt.length < 80 && !buttons.some(b => b.label === txt)) {
            const handle = 'B' + buttons.length;
            handles[handle] = loc;
            buttons.push({ handle, label: txt });
            if (buttons.length >= 15) break;
          }
        } catch {}
      }
    }
    // INPUTS
    const inputLocators = await page.locator('input, textarea, [contenteditable="true"], [role="textbox"]').all();
    for (const loc of inputLocators.slice(0, MAX_INTERACTIVES)) {
      try {
        const attrs = await loc.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          placeholder: el.getAttribute('placeholder') || '',
          name: el.getAttribute('name') || '',
          id: el.getAttribute('id') || '',
          ariaLabel: el.getAttribute('aria-label') || ''
        }));
        // Only register FILLABLE inputs — skip checkbox/radio/button/submit/etc.
        // (a checkbox-type input like a hamburger menu is not typeable)
        const NON_FILLABLE = ['hidden','file','checkbox','radio','button','submit','reset','image','range','color'];
        if (attrs.tag === 'input' && NON_FILLABLE.includes(attrs.type)) continue;
        // Only register VISIBLE inputs — responsive layouts often render a hidden
        // duplicate (e.g. Wikipedia's collapsed-nav search) that can't be filled.
        if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
        const label = attrs.ariaLabel || attrs.placeholder || attrs.name || attrs.id || '(unnamed)';
        const kind = attrs.tag === 'textarea' ? 'textarea' :
                     attrs.type === 'search' ? 'search' :
                     attrs.type === 'password' ? 'password' :
                     attrs.type === 'email' ? 'email' :
                     attrs.tag === 'input' ? `input[${attrs.type || 'text'}]` :
                     attrs.tag;
        const handle = 'I' + inputs.length;
        handles[handle] = loc;
        inputs.push({ handle, label, kind });
        if (inputs.length >= 8) break;
      } catch {}
    }
  } catch (err) {
    // best-effort — return whatever we got
  }

  setRegistry(page, handles);
  return { buttons, links, inputs };
}

function walkA11y(node, lines, depth) {
  if (!node || depth > 10) return;
  const role = node.role || '';
  const name = (node.name || '').replace(/\s+/g, ' ').trim();
  // Skip noise roles
  const skip = role === 'none' || role === 'generic' || role === 'presentation';
  if (!skip) {
    if (name || ['heading', 'link', 'button', 'textbox', 'list', 'image'].includes(role)) {
      const indent = '  '.repeat(Math.min(depth, 6));
      const label = name ? `${role}: ${name.slice(0, 200)}` : role;
      lines.push(`${indent}${label}`);
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) walkA11y(c, lines, depth + (skip ? 0 : 1));
  }
}

// --- Tag parser ---

const BROWSER_TAG_RE = /<(browse(?:-read|-see|-click|-type|-scroll|-close)?|chat-(?:send|watch|unwatch))\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(attrStr) {
  const out = {};
  if (!attrStr) return out;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Find all browser tags in a chunk of text and return them as a list of
 * { tag, attrs, body } objects. Used by main.js to dispatch after Stheno
 * (or gemma) emits a response.
 */
function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m;
  BROWSER_TAG_RE.lastIndex = 0;
  while ((m = BROWSER_TAG_RE.exec(text)) !== null) {
    tags.push({
      tag: m[1].toLowerCase(),
      attrs: parseAttrs(m[2] || ''),
      body: (m[3] || '').trim()
    });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(BROWSER_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

/**
 * WRONG-BROWSER GUARD. A bare <browse>URL</browse> is an OPEN of a new page — that is
 * HER OWN web work, which belongs in HER dedicated browser (lib/web.js), NOT Lucas's
 * shared co-pilot Chrome on :9222. The model keeps reaching for <browse> when it means
 * "go look something up," landing her research in the wrong window. Split those opens out
 * as <web-open> tags for her browser; everything else (browse-read/click/type/scroll/
 * close — legitimately glancing at / acting on what Lucas already has open) passes through.
 * Used by EVERY dispatch path (chat, heartbeat, monologue) so the redirect is uniform.
 * Returns { browserTags (shared-Chrome only), redirectedOpens (<web-open> for her browser) }.
 */
function splitBrowseOpens(parsed) {
  const browserTags = [], redirectedOpens = [];
  for (const t of (parsed || [])) {
    const url = (t && t.tag === 'browse') ? (t.body || (t.attrs && t.attrs.url)) : null;
    if (url) redirectedOpens.push({ tag: 'web-open', attrs: {}, body: url });
    else browserTags.push(t);
  }
  return { browserTags, redirectedOpens };
}

/**
 * Dispatch a single parsed tag to its handler. Returns the result for logging
 * or for storing as a reading.
 */
// Screenshot a shared-browser tab (Lucas's open page) as base64 PNG so a vision model can SEE it.
// resolveTab(null) → the active tab. Model-free; main runs it through lib/vision.
async function actionSee(tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr || 'active'}"` };
  try {
    const buf = await page.screenshot({ type: 'png' });
    return { ok: true, base64: Buffer.from(buf).toString('base64'), url: page.url(), title: await page.title().catch(() => '') };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function dispatch({ tag, attrs, body }) {
  switch (tag.toLowerCase()) {
    case 'browse':
      return actionBrowse(body, attrs.tab);
    case 'browse-close':
      return actionClose(attrs.tab);
    case 'browse-read':
      return actionRead(attrs.tab);
    case 'browse-see':
      return actionSee(attrs.tab);
    case 'browse-click':
      return actionClick(body, attrs.tab);
    case 'browse-type':
      return actionType(attrs.selector || attrs.target, body, attrs.tab);
    case 'browse-scroll':
      return actionScroll(body || attrs.direction, attrs.tab);
    case 'chat-send':
      return chatSend(body, attrs.tab || attrs.target, attrs.speaker);
    case 'chat-watch':
      return chatWatchTag(attrs.tab, attrs.speaker);
    case 'chat-unwatch':
      return chatUnwatchTag(attrs.tab);
    default:
      return { ok: false, reason: `unknown tag ${tag}` };
  }
}

// --- Chat-watcher tag handlers ---

async function chatSend(text, tabAttr, speaker) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr || 'active'}"` };
  if (!text || text.trim().length === 0) return { ok: false, reason: 'empty chat-send body' };
  return chatWatcher.sendAndWait(page, text.trim(), { speaker });
}

async function chatWatchTag(tabAttr, speaker) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: `could not resolve tab="${tabAttr || 'active'}"` };
  return chatWatcher.watch(page, { speaker });
}

async function chatUnwatchTag(tabAttr) {
  if (!browserInstance) return { ok: false, reason: 'browser not connected' };
  const page = resolveTab(tabAttr);
  if (!page) return { ok: false, reason: 'could not resolve tab' };
  return chatWatcher.unwatch(page);
}

/**
 * Build a short ACTION nudge for the depth-2 (just-before-user-message) slot.
 * Fires only when browser is connected AND the user message has any keyword
 * hinting at page interaction. This sits in the recency slot to beat the
 * pattern-matching attractor where Stheno just narrates instead of emitting tags.
 */
// Keyword → likely intended verb mapping. Different user requests need different
// tag emissions. "Pick one" / "select" → click. "Type X" / "send X" → type.
// "Scroll" → scroll. Anything else page-related → read first.
const BROWSER_ACTION_KEYWORDS = /\b(look at|take a look|check|explore|interact|see what|read|read the|on the page|the open tab|active tab|the tab|click|scroll|navigate|open|browse|the page|this page|that page|the site|this site|what.s on|examine|pick|select|choose|tap|press|type|send|enter|fill|message|reply|launch|start)\b/i;
const CLICK_HINTS = /\b(pick|select|choose|click|tap|press|hit|open|launch|start|go to|navigate to)\b/i;
const TYPE_HINTS = /\b(type|send|enter|fill|message|reply|write|tell\s+(him|her|them|it))\b/i;
const SCROLL_HINTS = /\b(scroll|page down|page up|scroll down|scroll up|further down|further up)\b/i;

function buildActionNudge(userMessage) {
  if (!browserInstance) return null;
  if (!userMessage) return null;
  if (!BROWSER_ACTION_KEYWORDS.test(userMessage)) return null;

  const activeTitle = (tabContext.activeTabTitle || '(no active tab)').slice(0, 80);

  // Figure out the most-likely intended verb so the nudge points to the right tag
  const wantsClick = CLICK_HINTS.test(userMessage);
  const wantsType = TYPE_HINTS.test(userMessage);
  const wantsScroll = SCROLL_HINTS.test(userMessage);

  const lines = [
    `[ACTION REQUIRED — Lucas just asked you to act on a browser tab. Active tab: "${activeTitle}".`,
    ``,
    `You MUST emit a literal browser tag in your <think> to actually do anything. Describing what you'll do does nothing — only the tag triggers real action.`,
    ``
  ];

  if (wantsType) {
    lines.push(`Lucas wants you to TYPE something. Steps:`);
    lines.push(`  1. First emit <browse-read/> to see what inputs exist (the INTERACTIVE ELEMENTS section lists inputs with HANDLES like [I0] [I1])`);
    lines.push(`  2. Then on your next turn emit <browse-type selector="I0">your text here</browse-type> — name the input HANDLE you saw, never a guessed selector`);
    lines.push(`  3. If there's a Send/Submit button, also <browse-click>B0</browse-click> naming its handle from the read`);
  } else if (wantsClick) {
    // Check if the user named a specific target (proper noun, quoted phrase, "one of the X")
    // — if so, push for immediate click. Otherwise read first.
    const hasNamedTarget = /"[^"]+"|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/.test(userMessage);
    lines.push(`Lucas wants you to CLICK something.`);
    if (hasNamedTarget) {
      lines.push(`He named a specific target. EMIT THE CLICK NOW:`);
      lines.push(`  <browse-click>exact name of the target as it appears on the page</browse-click>`);
      lines.push(`Do NOT read first if you already know what to click. Just click.`);
      lines.push(`If you need to verify what the page calls it, you can also emit <browse-read/> BEFORE the click in the same turn.`);
    } else {
      lines.push(`Steps:`);
      lines.push(`  1. Emit <browse-read/> NOW to see the INTERACTIVE ELEMENTS list (buttons + links)`);
      lines.push(`  2. Then in your next turn, emit <browse-click>exact label from that list</browse-click>`);
      lines.push(`  If you can see the target in your current reading already, click directly without reading again.`);
    }
  } else if (wantsScroll) {
    lines.push(`Emit <browse-scroll>down 1</browse-scroll> (or "up 1") to scroll the page.`);
  } else {
    lines.push(`Default to <browse-read/> first to see the page. Then on your next turn, click/type/scroll as needed using:`);
    lines.push(`  <browse-click>button or link text</browse-click>`);
    lines.push(`  <browse-type selector="...">text to type</browse-type>`);
    lines.push(`  <browse-scroll>down 1</browse-scroll>`);
  }

  lines.push(``);
  lines.push(`EMIT THE TAG NOW.]`);
  return lines.join('\n');
}

module.exports = {
  launchChrome,
  connect,
  disconnect,
  isConnected,
  noteMention,
  statusSnapshot,
  buildPromptBlock,
  buildActionNudge,
  parseTags,
  stripTags,
  splitBrowseOpens,
  dispatch,
  setListeners,
  // exported for tests
  resolveTab,
  refreshTabContext
};
