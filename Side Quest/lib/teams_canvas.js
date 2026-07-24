/**
 * lib/teams_canvas.js — drive Microsoft Teams inside the Canvas <webview> from the main process.
 *
 * The Teams "body" for lib/teams's dependency-injected stage machine — the exact mirror of
 * lib/meet_canvas.js, but for Teams' DOM. gmeet/teams' brain is unchanged; its hooks operate the
 * Canvas meeting pane's guest webContents via executeJavaScript (scrape) + sendInputEvent (keys/mouse),
 * so no Playwright and no dedicated browser — the meeting lives in the canvas, freeing that browser.
 *
 * TWO THINGS TEAMS HAS THAT MEET DOESN'T, handled here:
 *   • a "continue on this browser" gate before the prejoin screen (Teams pushes the desktop app first)
 *   • a LOBBY — as an external personal account she waits until the host admits her (inLobby()).
 *
 * SELECTORS ARE PROVISIONAL. Teams rotates its DOM and the web client differs from desktop; every
 * data-tid / aria-label below is a best-guess anchor to VERIFY + heal against a live Teams meeting,
 * exactly like Meet's were (recipes/gmeet_join.json is still marked verified:false). They're written
 * defensively (multiple fragments, text fallbacks) so a miss degrades rather than throws.
 *
 * createTeamsDriver(getWC) → { inMeeting, inLobby, continueOnBrowser, navigate, preClear, joinNow,
 *   enableCaptions, scrapeCaptions, scrapeAttendees, postChat, leave } — getWC() returns the live
 *   guest webContents or null.
 */
'use strict';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- caption scrape (returns "Speaker: text" lines) — PROVISIONAL Teams caption DOM ---
// Teams live captions render into a caption region; each line carries an author + text. Anchor on the
// caption container's data-tid with an aria fallback, strip the author node to get clean text.
const CAPTIONS_JS = `(() => {
  try {
    const region =
      document.querySelector('[data-tid="closed-caption-renderer"]') ||
      document.querySelector('[data-tid="closed-captions-renderer"]') ||
      document.querySelector('[class*="closedCaption" i]') ||
      Array.from(document.querySelectorAll('[aria-label*="aption" i],[role="region"][aria-label*="aption" i]')).find(e => (e.textContent||'').trim().length > 0);
    if (!region) return '';
    // Each caption line — data-tid on the chat message, else structural children.
    let rows = Array.from(region.querySelectorAll('[data-tid="closed-caption-message"], [class*="captionMessage" i], [class*="ccMessage" i]'));
    if (!rows.length) rows = Array.from(region.children);
    if (!rows.length) rows = [region];
    const lines = [];
    for (const row of rows) {
      let speaker = '';
      try {
        const auth = row.querySelector ? row.querySelector('[data-tid="author"], [class*="author" i], [class*="displayName" i]') : null;
        if (auth) speaker = (auth.textContent||'').replace(/\\s+/g,' ').trim();
      } catch {}
      let text = '';
      try {
        const c = row.cloneNode(true);
        c.querySelectorAll('[data-tid="author"], [class*="author" i], [class*="displayName" i], img').forEach(e => e.remove());
        text = (c.textContent||'').replace(/\\s+/g,' ').trim();
      } catch {}
      if (!text || text.length > 280) continue;
      lines.push(speaker ? (speaker + ': ' + text) : text);
    }
    return lines.join('\\n');
  } catch (e) { return ''; }
})()`;

// --- in-meeting check: a Teams URL + the "Leave" control present ---
const IN_MEETING_JS = `(() => {
  try {
    if (!/teams\\.(microsoft|live)\\.com/i.test(location.href)) return false;
    return !!document.querySelector('button[data-tid="hangup-main-btn"], button[data-tid="call-hangup"], button[aria-label^="Leave" i], #hangup-button');
  } catch (e) { return false; }
})()`;

// --- lobby check: she's admitted-pending (external account waiting for the host) ---
// The prejoin "Join now" is gone and a waiting message is shown, but the Leave/in-call controls
// aren't up yet. Anchor on the well-known lobby copy + data-tid.
const IN_LOBBY_JS = `(() => {
  try {
    if (!/teams\\.(microsoft|live)\\.com/i.test(location.href)) return false;
    const t = (document.body.innerText || '').toLowerCase();
    const waiting = /let you in|when the meeting starts|someone .* let you in|waiting for .* to (admit|let)|you're in the lobby|in the lobby/i.test(t);
    const inCall = !!document.querySelector('button[data-tid="hangup-main-btn"], button[data-tid="call-hangup"], button[aria-label^="Leave" i]');
    return waiting && !inCall;
  } catch (e) { return false; }
})()`;

// --- attendee scrape (best-effort roster names) — PROVISIONAL ---
const ATTENDEES_JS = `(() => {
  try {
    const names = new Set();
    document.querySelectorAll('[data-tid="roster-list"] [data-tid*="participant" i], [data-tid="roster"] [role="listitem"], [class*="rosterList" i] [class*="participant" i]').forEach(e => {
      const nameEl = e.querySelector('[data-tid="display-name"], [class*="displayName" i]') || e;
      const t = (nameEl.textContent||'').replace(/\\s+/g,' ').trim();
      if (t && t.length <= 48 && /[a-z]/i.test(t)) names.add(t);
    });
    return Array.from(names).slice(0, 50).join('\\n');
  } catch (e) { return ''; }
})()`;

// Click the first button/link matching any of the given aria-label / text / data-tid fragments.
function clickByLabelJS(fragments) {
  const arr = JSON.stringify(fragments.map(f => f.toLowerCase()));
  return `(() => {
    try {
      const frags = ${arr};
      const els = Array.from(document.querySelectorAll('button,[role="button"],a,[data-tid]'));
      for (const f of frags) {
        const el = els.find(e => {
          const al = (e.getAttribute('aria-label')||'').toLowerCase();
          const tx = (e.textContent||'').toLowerCase().trim();
          const tid = (e.getAttribute('data-tid')||'').toLowerCase();
          return al.includes(f) || tx === f || tx.includes(f) || tid === f || tid.includes(f);
        });
        if (el) { el.click(); return f; }
      }
      return '';
    } catch (e) { return ''; }
  })()`;
}

function createTeamsDriver(getWC) {
  async function exec(js, userGesture = false) {
    const wc = getWC && getWC();
    if (!wc) return null;
    try { return await wc.executeJavaScript(js, userGesture); } catch { return null; }
  }
  function input(ev) { const wc = getWC && getWC(); if (wc) { try { wc.sendInputEvent(ev); } catch {} } }
  function nudge() { input({ type: 'mouseMove', x: 480, y: 560 }); }   // reveal auto-hiding control bar
  function key(keyCode, modifiers = []) { input({ type: 'keyDown', keyCode, modifiers }); input({ type: 'keyUp', keyCode, modifiers }); }

  async function inMeeting() { return (await exec(IN_MEETING_JS)) === true; }
  async function inLobby() { return (await exec(IN_LOBBY_JS)) === true; }

  async function navigate(url) { const wc = getWC && getWC(); if (!wc) return false; try { await wc.loadURL(url); return true; } catch { return false; } }

  // Teams pushes the desktop app first. Click "Continue on this browser" / "Join on the web instead"
  // if that gate is showing. Best-effort + idempotent — absent on a direct web-client link.
  async function continueOnBrowser() {
    nudge();
    return await exec(clickByLabelJS(['continue on this browser', 'join on the web instead', 'use the web app instead', 'joinonweb', 'continue on browser']), true);
  }

  // Dismiss any device-permission / "get the best of Teams" overlay covering the prejoin controls.
  async function preClear() { nudge(); for (let i = 0; i < 2; i++) { key('Escape'); await sleep(250); } await exec(clickByLabelJS(['close', 'dismiss', 'not now', 'continue without']), true); }

  // Pre-join: mute mic + camera, then click Join now. Returns { ok, via }.
  async function joinNow() {
    await continueOnBrowser(); await sleep(400);
    nudge(); await sleep(200);
    // Teams prejoin toggles are ON→OFF; only click when currently unmuted / camera-on (best-effort).
    await exec(clickByLabelJS(['mute microphone', 'toggle-mute', 'turn off microphone', 'mute']), true);
    await exec(clickByLabelJS(['turn camera off', 'toggle-video', 'turn off camera']), true);
    await sleep(150);
    const via = await exec(clickByLabelJS(['prejoin-join-button', 'join now', 'join meeting', 'join']), true);
    return { ok: !!via, via: via || '' };
  }

  // Captions on: Teams has no reliable global shortcut on web → walk the More (…) → Language and
  // speech → Turn on live captions menu. Best-effort multi-step; confirm via the caption region.
  async function enableCaptions() {
    nudge();
    const isOn = async () => (await exec(`!!document.querySelector('[data-tid="closed-caption-renderer"],[data-tid="closed-captions-renderer"],[class*="closedCaption" i]')`)) === true;
    if (await isOn()) return { ok: true, already: true };
    await exec(clickByLabelJS(['callingButtons-showMoreBtn', 'more actions', 'more']), true); await sleep(500);
    await exec(clickByLabelJS(['language and speech', 'language & speech']), true); await sleep(400);
    await exec(clickByLabelJS(['turn on live captions', 'turn on captions', 'live captions']), true); await sleep(500);
    return { ok: await isOn(), via: 'menu' };
  }

  async function scrapeCaptions() { return (await exec(CAPTIONS_JS)) || ''; }
  async function scrapeAttendees() { return (await exec(ATTENDEES_JS)) || ''; }

  // Post a message to the in-meeting chat. Teams' composer is a CONTENTEDITABLE rich editor (not a
  // <textarea>), so the Meet .value setter won't work — focus it, insert via execCommand, dispatch input.
  async function postChat(message) {
    nudge();
    await exec(clickByLabelJS(['chat-button', 'chat', 'open chat', 'show conversation']), true);
    await sleep(600);
    const set = await exec(`(() => {
      try {
        const box = document.querySelector('[data-tid="ckeditor"], div[role="textbox"][contenteditable="true"], [contenteditable="true"][data-tid*="input" i], [contenteditable="true"]');
        if (!box) return false;
        box.focus();
        try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, ${JSON.stringify(String(message || ''))}); }
        catch (e) { box.textContent = ${JSON.stringify(String(message || ''))}; }
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) { return false; }
    })()`, true);
    if (!set) return { ok: false, reason: 'chat composer not found' };
    await sleep(200);
    key('Return');
    return { ok: true };
  }

  // Leave the call: click Leave; fallback navigate the pane away.
  async function leave() {
    nudge();
    const via = await exec(clickByLabelJS(['hangup-main-btn', 'call-hangup', 'leave']), true);
    await sleep(700);
    if ((await inMeeting())) { await navigate('about:blank'); return { ok: true, via: 'navigate-away' }; }
    return { ok: true, via: via || 'leave-button' };
  }

  return { inMeeting, inLobby, continueOnBrowser, navigate, preClear, joinNow, enableCaptions, scrapeCaptions, scrapeAttendees, postChat, leave };
}

// The live driver, registered by main once the Canvas window exists. canvasTeamsDeps() reads it.
let _liveDriver = null;
function setLiveDriver(d) { _liveDriver = d; }
function getLiveDriver() { return _liveDriver; }

// Build the dependency set teams.runTick expects, backed by the canvas Teams driver. Mirrors
// meet_canvas.canvasMeetDeps — same shape, plus inLobby/continueOnBrowser for the lobby stage. The
// memory + web-search plumbing (storeMeeting / retrieve / webLookup) is reused UNCHANGED.
function canvasTeamsDeps() {
  const driver = _liveDriver;
  const web = {
    async runRecipe(name, args = {}) {
      if (!driver) return { ok: false, reason: 'no canvas teams driver' };
      if (name === 'teams_join') { const r = await driver.joinNow(); return { ok: !!r.ok, reason: r.ok ? '' : 'join control not found' }; }
      if (name === 'teams_post_chat') { return await driver.postChat(args.message); }
      return { ok: false, reason: `unsupported recipe ${name}` };
    },
    async read() { return { ok: false, text: '' }; },
    async ensure() { return null; },
  };
  return {
    web,
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').meetingModel(),
    scrapeAttendees: () => driver ? driver.scrapeAttendees() : '',
    scrapeCaptions: () => driver ? driver.scrapeCaptions() : '',
    enableCaptions: () => driver ? driver.enableCaptions() : { ok: false },
    inMeeting: () => driver ? driver.inMeeting() : false,
    inLobby: () => driver ? driver.inLobby() : false,
    continueOnBrowser: () => driver ? driver.continueOnBrowser() : '',
    leaveMeeting: () => driver ? driver.leave() : { ok: false },
    preClear: () => driver ? driver.preClear() : undefined,
    postChat: (_web, message) => driver ? driver.postChat(message) : { ok: false, reason: 'no driver' },
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'meeting', content, source: opts.source || 'teams', importance: opts.importance == null ? 0.75 : opts.importance }); } catch { return null; } },
    retrieve: async (q) => { try { return await require('./memory').retrieve(q, { k: 3, preferLeaf: true }); } catch { return []; } },
    webLookup: async (q) => {
      try { const { results } = await require('./web_search').search(q); return (results || []).slice(0, 4).map(r => `- ${r.title}${r.snippet ? ': ' + r.snippet : ''}`).join('\n'); }
      catch { return ''; }
    },
  };
}

module.exports = { createTeamsDriver, setLiveDriver, getLiveDriver, canvasTeamsDeps, CAPTIONS_JS, IN_MEETING_JS, IN_LOBBY_JS, ATTENDEES_JS, clickByLabelJS };
