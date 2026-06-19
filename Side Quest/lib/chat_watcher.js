/**
 * ChatWatcher — async event bridge for chat-bot conversations.
 *
 * Architecture per research synthesis 2026-06-18:
 *   - Per-watched-tab watcher in Electron main process
 *   - Detection: button-enabled poll (primary), waitForResponse race (secondary),
 *     MutationObserver fallback (tertiary), 45s timeout floor
 *   - Delta extraction via last_seen_message_index pointer
 *   - On reply: insertInbound() into DB, fire IPC, gemma's tick or chat:send
 *     consumes it as <incoming> system context next turn
 *
 * Honest 8B ceiling: 5-8 coherent exchanges before drift. Beyond that requires
 * rolling-summary work that's out of scope for v1.
 */

const db = require('./db');

const REPLY_TIMEOUT_MS = 45_000;
const SETTLE_DELAY_MS = 1500;   // wait after detection before extracting — lets stream finish painting
const POLL_INTERVAL_MS = 500;

// Common send-button selectors across chat sites. Tried in order.
const SEND_BUTTON_SELECTORS = [
  'button[aria-label="Send" i]',
  'button[aria-label="Send message" i]',
  'button[data-testid="send-button"]',
  'button[type="submit"]:not([disabled])',
  'button:has-text("Send")',
  '[role="button"]:has-text("Send")',
  // CrushOn-style: look for any enabled-after-streaming button near the input
  'button[aria-label*="send" i]:not([disabled])'
];

// Common message-container selectors — bot replies appear as new children here
const MESSAGE_CONTAINER_HINTS = [
  '[data-message-role="assistant"]',
  '[role="article"]',
  '.message',
  '[class*="message"]',
  '[class*="Message"]',
  '[data-author="bot"]',
  '[data-from="bot"]'
];

// Per-tab state: { speaker, lastSeenIndex, messages: [{ index, speaker, text }] }
const watchers = new Map();  // key: url, value: state object

let listeners = { onReplyArrived: () => {}, onReplyTimeout: () => {} };
function setListeners(l) { listeners = { ...listeners, ...l }; }

function _key(url) {
  // Normalize URL — strip query/hash so a navigated tab stays watched
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Begin watching a tab. Records the current message count as baseline.
 * Returns { ok, url, baselineCount, speaker }.
 */
async function watch(page, { speaker } = {}) {
  if (!page) return { ok: false, reason: 'no page' };
  const url = page.url();
  const key = _key(url);
  const baselineCount = await countMessages(page);
  watchers.set(key, {
    url, speaker: speaker || 'bot',
    lastSeenIndex: baselineCount,
    pendingSend: false
  });
  return { ok: true, url, baselineCount, speaker: speaker || 'bot' };
}

function unwatch(urlOrPage) {
  const url = typeof urlOrPage === 'string' ? urlOrPage : urlOrPage?.url?.();
  if (!url) return { ok: false };
  const key = _key(url);
  watchers.delete(key);
  return { ok: true, url };
}

function isWatched(url) {
  return watchers.has(_key(url));
}

function getWatcherState(url) {
  return watchers.get(_key(url)) || null;
}

/**
 * Approximate the number of messages on a chat page. Tries several selector
 * heuristics and returns the largest count found. Used as the baseline pointer
 * and to detect new messages.
 */
async function countMessages(page) {
  let best = 0;
  for (const sel of MESSAGE_CONTAINER_HINTS) {
    try {
      const n = await page.locator(sel).count();
      if (n > best) best = n;
    } catch {}
  }
  return best;
}

/**
 * Extract the last N visible messages from the page in render order. Used after
 * detecting a new reply to capture just the delta. Best-effort — falls back to
 * a generic chat-container scrape if specific selectors don't match.
 */
async function extractMessages(page, sinceIndex) {
  // Find the selector that gives the most messages (most likely the right one)
  let bestSel = null;
  let bestCount = 0;
  for (const sel of MESSAGE_CONTAINER_HINTS) {
    try {
      const n = await page.locator(sel).count();
      if (n > bestCount) { bestCount = n; bestSel = sel; }
    } catch {}
  }
  if (!bestSel || bestCount <= sinceIndex) return [];

  const messages = [];
  // Pull the new ones (after sinceIndex)
  for (let i = sinceIndex; i < bestCount && messages.length < 6; i++) {
    try {
      const loc = page.locator(bestSel).nth(i);
      const txt = (await loc.textContent({ timeout: 1500 }))?.trim().replace(/\s+/g, ' ');
      if (txt && txt.length > 0) {
        messages.push({ index: i, text: txt.slice(0, 4000) });
      }
    } catch {}
  }
  return messages;
}

/**
 * Find the send button on the page using the cascade of selectors.
 * Returns the first locator that yields an enabled element.
 */
async function findEnabledSendButton(page) {
  for (const sel of SEND_BUTTON_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      const enabled = await loc.isEnabled({ timeout: 500 }).catch(() => false);
      if (enabled) return loc;
    } catch {}
  }
  return null;
}

/**
 * The main work: send a message into a watched tab and wait for the bot's reply.
 *
 * Strategy:
 *   1. Type into the message input
 *   2. Click send (or press Enter)
 *   3. Note the message count immediately after send → "post-send-count"
 *   4. Race: wait for (a) message-count > post-send-count + 1, OR
 *            (b) send button enabled again after being disabled, OR
 *            (c) 45s timeout
 *   5. After the winner fires, settle delay 1.5s, extract delta
 *   6. Store as inbound, fire IPC
 */
async function sendAndWait(page, text, { speaker } = {}) {
  if (!page) return { ok: false, reason: 'no page' };
  if (!text || text.trim().length === 0) return { ok: false, reason: 'empty text' };

  const url = page.url();
  let state = getWatcherState(url);
  if (!state) {
    // Auto-watch if she's sending into an unwatched tab
    const w = await watch(page, { speaker });
    if (!w.ok) return { ok: false, reason: 'could not watch tab' };
    state = getWatcherState(url);
  }

  // Find the message input (textarea preferred for chat sites)
  let input = null;
  const inputSelectors = [
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="type" i]',
    'textarea[aria-label*="message" i]',
    'textarea:not([readonly])',
    'input[type="text"][placeholder*="message" i]',
    '[contenteditable="true"]',
    'input[type="search"]'
  ];
  for (const sel of inputSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
        input = loc;
        break;
      }
    } catch {}
  }
  if (!input) return { ok: false, reason: 'no message input found on page' };

  try {
    await input.click({ timeout: 2000 });
    await input.fill(text, { timeout: 3000 });
  } catch (err) {
    return { ok: false, reason: `could not type: ${err.message}` };
  }

  const preCount = await countMessages(page);

  // Click send button OR press Enter as fallback
  const sendBtn = await findEnabledSendButton(page);
  if (sendBtn) {
    try { await sendBtn.click({ timeout: 2000 }); }
    catch (err) {
      try { await input.press('Enter'); }
      catch (err2) { return { ok: false, reason: `send click failed: ${err.message}; Enter failed: ${err2.message}` }; }
    }
  } else {
    try { await input.press('Enter'); }
    catch (err) { return { ok: false, reason: `Enter press failed: ${err.message}` }; }
  }

  // Race the three signals
  const result = await raceDetection(page, preCount);

  if (result.timedOut) {
    try { listeners.onReplyTimeout({ url, sentText: text }); } catch {}
    return { ok: false, reason: 'reply timeout', timedOut: true };
  }

  // Settle delay — let any final stream chunks land
  await new Promise(r => setTimeout(r, SETTLE_DELAY_MS));

  // Extract the delta — messages added since pre-send count
  // The user's own send becomes one new message; the bot's reply is the next.
  // We want everything after preCount and skip the user's own send when possible.
  const newMessages = await extractMessages(page, preCount);
  // The first new message is usually her own send (we just typed it). The bot's
  // reply is usually the second. Filter to messages that AREN'T her own text.
  const botReplies = newMessages.filter(m => !m.text.toLowerCase().includes(text.toLowerCase().slice(0, Math.min(60, text.length))) || m.index > preCount + 0);
  const reply = botReplies.length > 0 ? botReplies[botReplies.length - 1] : (newMessages[newMessages.length - 1] || null);

  if (!reply) {
    try { listeners.onReplyTimeout({ url, sentText: text, reason: 'no new messages extracted' }); } catch {}
    return { ok: false, reason: 'reply detected but no extractable text' };
  }

  // Update pointer
  state.lastSeenIndex = reply.index + 1;

  // Queue in DB
  const inboundRow = db.insertInbound({
    tabUrl: url,
    speaker: state.speaker,
    text: reply.text,
    messageIndex: reply.index,
    source: 'chat-watcher'
  });

  const event = {
    inboundId: inboundRow.id,
    url, speaker: state.speaker,
    text: reply.text,
    messageIndex: reply.index,
    detectedBy: result.detectedBy
  };
  try { listeners.onReplyArrived(event); } catch {}

  return { ok: true, ...event };
}

/**
 * Race the three detection signals. Returns whichever fires first
 * (or {timedOut:true} on 45s floor).
 */
async function raceDetection(page, preCount) {
  const start = Date.now();

  const messageCountSignal = (async () => {
    while (Date.now() - start < REPLY_TIMEOUT_MS) {
      try {
        const cur = await countMessages(page);
        // Wait for at least 2 new messages (the user's send + bot's reply)
        // OR 1 new message if no user-message echo (some sites don't echo user msg into the same container)
        if (cur >= preCount + 2) return { detectedBy: 'message-count-+2' };
      } catch {}
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    return null;
  })();

  const sendEnabledSignal = (async () => {
    // First wait for the send button to become DISABLED (sending in progress)
    // then wait for it to become ENABLED again (reply complete)
    const disabledStart = Date.now();
    let wasDisabled = false;
    while (Date.now() - start < REPLY_TIMEOUT_MS) {
      try {
        const btn = page.locator(SEND_BUTTON_SELECTORS.join(', ')).first();
        const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
        if (!visible) { await new Promise(r => setTimeout(r, POLL_INTERVAL_MS)); continue; }
        const enabled = await btn.isEnabled({ timeout: 500 }).catch(() => true);
        if (!enabled) { wasDisabled = true; }
        else if (wasDisabled && (Date.now() - disabledStart > 1500)) {
          // Send was disabled then re-enabled → reply complete
          return { detectedBy: 'send-button-re-enabled' };
        }
      } catch {}
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    return null;
  })();

  const timeoutSignal = (async () => {
    await new Promise(r => setTimeout(r, REPLY_TIMEOUT_MS));
    return { timedOut: true };
  })();

  const winner = await Promise.race([messageCountSignal, sendEnabledSignal, timeoutSignal]);
  return winner || { timedOut: true };
}

function statusSnapshot() {
  return {
    watched: Array.from(watchers.values()).map(w => ({
      url: w.url,
      speaker: w.speaker,
      lastSeenIndex: w.lastSeenIndex
    }))
  };
}

module.exports = {
  watch,
  unwatch,
  isWatched,
  getWatcherState,
  sendAndWait,
  setListeners,
  statusSnapshot
};
