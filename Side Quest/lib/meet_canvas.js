/**
 * lib/meet_canvas.js — drive Google Meet inside the Canvas <webview> from the main process.
 *
 * This is the "new body" for lib/gmeet's dependency-injected stage machine: gmeet's brain is
 * unchanged, but instead of a Playwright page on her dedicated CDP browser, its hooks operate the
 * Canvas Meet pane's guest webContents (captured in main on did-attach-webview). All DOM work goes
 * through webContents.executeJavaScript (scrape) + sendInputEvent (keys/mouse), so no Playwright and
 * no dedicated browser — the meeting lives in the canvas, freeing that browser for parallel work.
 *
 * The scrape JS mirrors gmeet's battle-tested caption/attendee logic (aria-anchored, class fallbacks,
 * speaker-badge removal). Click/scrape selectors verify against a live meeting (Meet rotates classes).
 *
 * createMeetDriver(getWC) → { inMeeting, preClear, joinNow, enableCaptions, scrapeCaptions,
 *   scrapeAttendees, postChat, leave, navigate } — getWC() returns the live guest webContents or null.
 */
'use strict';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- caption scrape (returns "Speaker: text" lines) — mirrors gmeet.liveScrapeCaptions ---
const CAPTIONS_JS = `(() => {
  try {
    const region =
      document.querySelector('[role="region"][aria-label*="aptions" i]') ||
      Array.from(document.querySelectorAll('[aria-live]')).find(e => (e.textContent||'').trim().length > 0) ||
      (document.querySelector('.nMcdL') && document.querySelector('.nMcdL').parentElement) ||
      document.querySelector("div[jscontroller='TEjq6e']");
    if (!region) return '';
    const BADGE = '.NWpY1d, .xoMHSc, .zs7s8d';
    let rows = Array.from(region.querySelectorAll('.nMcdL'));
    if (!rows.length) rows = Array.from(region.children);
    if (!rows.length) rows = [region];
    const lines = [];
    for (const row of rows) {
      const badge = row.querySelector ? row.querySelector(BADGE) : null;
      const speaker = badge ? (badge.textContent||'').replace(/\\s+/g,' ').trim() : '';
      let text = '';
      try { const c = row.cloneNode(true); c.querySelectorAll(BADGE).forEach(e=>e.remove()); c.querySelectorAll('img,[data-iml]').forEach(e=>e.remove()); text=(c.textContent||'').replace(/\\s+/g,' ').trim(); } catch {}
      if (!text || text.length > 280) continue;
      lines.push(speaker ? (speaker + ': ' + text) : text);
    }
    return lines.join('\\n');
  } catch (e) { return ''; }
})()`;

// --- in-meeting check: a Meet URL + the "Leave call" control present ---
const IN_MEETING_JS = `(() => {
  try {
    if (!/meet\\.google\\.com\\/[a-z0-9]/i.test(location.href)) return false;
    return !!document.querySelector('button[aria-label*="Leave call" i],[aria-label*="Leave call" i],[aria-label*="Leave the call" i]');
  } catch (e) { return false; }
})()`;

// --- attendee scrape (best-effort participant names) ---
const ATTENDEES_JS = `(() => {
  try {
    const names = new Set();
    document.querySelectorAll('[data-participant-id] [data-self-name], [data-participant-id] div').forEach(e => {
      const t = (e.textContent||'').replace(/\\s+/g,' ').trim();
      if (t && t.length <= 48 && /[a-z]/i.test(t)) names.add(t);
    });
    return Array.from(names).slice(0, 50).join('\\n');
  } catch (e) { return ''; }
})()`;

// Click the first button matching any of the given aria-label / text fragments (case-insensitive).
function clickByLabelJS(fragments) {
  const arr = JSON.stringify(fragments.map(f => f.toLowerCase()));
  return `(() => {
    try {
      const frags = ${arr};
      const els = Array.from(document.querySelectorAll('button,[role="button"]'));
      for (const f of frags) {
        const el = els.find(e => {
          const al = (e.getAttribute('aria-label')||'').toLowerCase();
          const tx = (e.textContent||'').toLowerCase().trim();
          return al.includes(f) || tx === f || tx.includes(f);
        });
        if (el) { el.click(); return f; }
      }
      return '';
    } catch (e) { return ''; }
  })()`;
}

function createMeetDriver(getWC) {
  async function exec(js, userGesture = false) {
    const wc = getWC && getWC();
    if (!wc) return null;
    try { return await wc.executeJavaScript(js, userGesture); } catch (e) { return null; }
  }
  function input(ev) { const wc = getWC && getWC(); if (wc) { try { wc.sendInputEvent(ev); } catch {} } }
  function nudge() { input({ type: 'mouseMove', x: 480, y: 560 }); }   // reveal Meet's auto-hiding control bar
  function key(keyCode, modifiers = []) { input({ type: 'keyDown', keyCode, modifiers }); input({ type: 'keyUp', keyCode, modifiers }); }

  async function inMeeting() { return (await exec(IN_MEETING_JS)) === true; }

  async function navigate(url) { const wc = getWC && getWC(); if (!wc) return false; try { await wc.loadURL(url); return true; } catch { return false; } }

  // Dismiss the "let people hear/see you" device modal that covers the pre-join controls.
  async function preClear() { nudge(); for (let i = 0; i < 2; i++) { key('Escape'); await sleep(250); } await exec(clickByLabelJS(['close', 'dismiss']), true); }

  // Pre-join: mute mic + camera, then click Join now / Ask to join. Returns { ok, via }.
  async function joinNow() {
    nudge(); await sleep(200);
    await exec(clickByLabelJS(['turn off microphone', 'mute microphone']), true);
    await exec(clickByLabelJS(['turn off camera']), true);
    await sleep(150);
    const via = await exec(clickByLabelJS(['join now', 'ask to join', 'join meeting', 'join anyway']), true);
    return { ok: !!via, via: via || '' };
  }

  // Captions on: Shift+C (what the proven bots send), then a button fallback. Confirm via region.
  async function enableCaptions() {
    nudge();
    const isOn = async () => (await exec(`!!document.querySelector('[role="region"][aria-label*="aptions" i],button[aria-label*="Turn off captions" i]')`)) === true;
    if (await isOn()) return { ok: true, already: true };
    for (let i = 0; i < 4; i++) { key('c', ['shift']); await sleep(450); if (await isOn()) return { ok: true, via: 'shortcut' }; }
    await exec(clickByLabelJS(['turn on captions']), true);
    return { ok: await isOn(), via: 'button' };
  }

  async function scrapeCaptions() { return (await exec(CAPTIONS_JS)) || ''; }
  async function scrapeAttendees() { return (await exec(ATTENDEES_JS)) || ''; }

  // Post a message to the in-meeting chat: open the chat panel, set the input, dispatch Enter.
  // p177 catch ("intro post failed: chat input not found"): the probe knew only <textarea>, and
  // current Meet builds render the chat input as a rich contenteditable TEXTBOX — so the intro
  // died on a healthy panel. Both shapes are probed now, the panel gets a second render window,
  // and the reason names what actually missed.
  function _chatSetJS(message) {
    return `(() => {
      try {
        const msg = ${JSON.stringify(String(message || ''))};
        const ta = document.querySelector('textarea[aria-label*="send a message" i], textarea[placeholder*="message" i], textarea[aria-label*="message" i]');
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
          setter.call(ta, msg);
          ta.dispatchEvent(new Event('input',{bubbles:true}));
          ta.focus();
          return 'textarea';
        }
        const rt = document.querySelector('[role="textbox"][contenteditable="true"][aria-label*="message" i], [role="textbox"][contenteditable="true"][aria-label*="chat" i], div[contenteditable="true"][aria-label*="message" i]');
        if (rt) {
          rt.focus();
          const sel = window.getSelection(); sel.removeAllRanges();
          const range = document.createRange(); range.selectNodeContents(rt); sel.addRange(range);
          document.execCommand('insertText', false, msg);
          rt.dispatchEvent(new Event('input',{bubbles:true}));
          return 'textbox';
        }
        return '';
      } catch (e) { return ''; }
    })()`;
  }
  async function postChat(message) {
    nudge();
    const chatLabels = ['chat with everyone', 'open chat', 'show chat', 'chat'];
    let opened = await exec(clickByLabelJS(chatLabels), true);
    await sleep(500);
    let set = await exec(_chatSetJS(message), true);
    if (!set) {
      // The chat button TOGGLES — re-click ONLY when the first click found no button at all
      // (labels can render late); a landed click just gets a longer render window.
      if (!opened) opened = await exec(clickByLabelJS(chatLabels), true);
      await sleep(900);
      set = await exec(_chatSetJS(message), true);
    }
    if (!set) return { ok: false, reason: `chat input not found (textarea AND rich-textbox probes missed; chat button ${opened ? `clicked: "${opened}"` : 'NOT found'})` };
    await sleep(150);
    key('Return');
    // Belt: if the input still holds text (Return swallowed by the rich editor), click Send.
    try {
      const residue = await exec(`(() => { const el = document.querySelector('textarea[aria-label*="message" i], [role="textbox"][contenteditable="true"]'); return !!el && ((el.value || el.textContent || '').trim().length > 0); })()`, true);
      if (residue) await exec(clickByLabelJS(['send a message', 'send message', 'send']), true);
    } catch {}
    return { ok: true, via: set };
  }

  // Leave the call: click Leave; fallback navigate the pane away (about:blank).
  async function leave() {
    nudge();
    const via = await exec(clickByLabelJS(['leave call', 'leave the call']), true);
    await sleep(700);
    if ((await inMeeting())) { await navigate('about:blank'); return { ok: true, via: 'navigate-away' }; }
    return { ok: true, via: via || 'leave-button' };
  }

  return { inMeeting, navigate, preClear, joinNow, enableCaptions, scrapeCaptions, scrapeAttendees, postChat, leave };
}

// The live driver, registered by main once the Canvas window exists. canvasMeetDeps() reads it.
let _liveDriver = null;
function setLiveDriver(d) { _liveDriver = d; }
function getLiveDriver() { return _liveDriver; }

// Build the dependency set gmeet.runTick expects, but with its live-DOM hooks backed by the canvas
// driver instead of the Playwright browser — so gmeet's SAME stage machine runs through the canvas.
// The model is the DEDICATED meeting-cortex channel (config.meetingModel); the memory + web-search
// plumbing (storeMeeting / retrieve / webLookup) is reused UNCHANGED — just invoked from this channel.
function canvasMeetDeps() {
  const driver = _liveDriver;
  // gmeet's runTick calls a few things directly on d.web — shim just those (join recipe → joinNow,
  // post-chat recipe → postChat, read → heal no-op). Everything else goes through the hooks below.
  const web = {
    async runRecipe(name, args = {}) {
      if (!driver) return { ok: false, reason: 'no canvas meet driver' };
      if (name === 'gmeet_join') { const r = await driver.joinNow(); return { ok: !!r.ok, reason: r.ok ? '' : 'join control not found' }; }
      if (name === 'gmeet_post_chat') { return await driver.postChat(args.message); }
      return { ok: false, reason: `unsupported recipe ${name}` };
    },
    async read() { return { ok: false, text: '' }; },   // heal-signal path; canvas scrape is via hooks
    async ensure() { return null; },
  };
  return {
    web,
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').meetingModel(),   // dedicated cortex channel
    scrapeAttendees: () => driver ? driver.scrapeAttendees() : '',
    scrapeCaptions: () => driver ? driver.scrapeCaptions() : '',
    enableCaptions: () => driver ? driver.enableCaptions() : { ok: false },
    inMeeting: () => driver ? driver.inMeeting() : false,
    leaveMeeting: () => driver ? driver.leave() : { ok: false },
    preClear: () => driver ? driver.preClear() : undefined,
    postChat: (_web, message) => driver ? driver.postChat(message) : { ok: false, reason: 'no driver' },
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'meeting', content, source: opts.source || 'gmeet', importance: opts.importance == null ? 0.75 : opts.importance }); } catch { return null; } },
    retrieve: async (q) => { try { return await require('./memory').retrieve(q, { k: 3, preferLeaf: true }); } catch { return []; } },
    webLookup: async (q) => {
      try { const { results } = await require('./web_search').search(q); return (results || []).slice(0, 4).map(r => `- ${r.title}${r.snippet ? ': ' + r.snippet : ''}`).join('\n'); }
      catch { return ''; }
    },
  };
}

module.exports = { createMeetDriver, setLiveDriver, getLiveDriver, canvasMeetDeps, CAPTIONS_JS, IN_MEETING_JS, ATTENDEES_JS, clickByLabelJS };
