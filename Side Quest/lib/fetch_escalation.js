/**
 * lib/fetch_escalation.js — THE BLOCKER ESCALATION LADDER (2026-07-23).
 *
 * Lucas: "she has an entire stack of web tools at her fingertips — wayback, going around firewalls
 * and paywalls… it just seems like they are all going to waste. There are very few websites she
 * shouldn't be able to fully access as long as the tools and iteration time are present."
 *
 * The operator's open_page was hardcoded to give up on any blocked page ("needs a human — skip it,
 * don't retry"). This ladder tries the doors IN ORDER before conceding:
 *   1. PLAIN FETCH — no JS, different fingerprint; simple bot-walls and JS-dead pages often serve
 *      static HTML fine.
 *   2. ARCHIVE SNAPSHOT — the Wayback Machine's nearest capture (web.archive.org/web/2/<url>);
 *      paywalls and logins rarely reach the archive. The answer is LABELED as an archive copy —
 *      possibly stale, honestly so.
 *   3. VISION — her own eyes on the rendered page (seePage) for JS-heavy UIs the text tiers miss.
 *   4. HONEST CONCESSION — name every door tried; only now does it "need a human".
 *
 * Pure with injectable deps ({ fetchPage, seePage }) → offline-smokeable. Never throws.
 */
'use strict';

const ARCHIVE_PREFIX = 'https://web.archive.org/web/2/';
const MIN_TEXT = 180;   // below this a "success" is a shell/error page, not a read

function _good(r) { return !!(r && r.ok && r.text && String(r.text).trim().length >= MIN_TEXT); }

async function escalatedRead(url, { focus = '', fetchPage, seePage, maxChars = 4000, log } = {}) {
  const u = String(url || '').trim();
  const tried = [];
  if (!u) return { ok: false, error: 'no url', tried };

  if (typeof fetchPage === 'function') {
    tried.push('plain fetch');
    try {
      const r = await fetchPage(u, { maxChars });
      if (_good(r)) return { ok: true, text: r.text, via: 'plain fetch', note: null, tried };
    } catch {}

    tried.push('archive snapshot');
    try {
      const r = await fetchPage(ARCHIVE_PREFIX + u, { maxChars });
      if (_good(r)) return { ok: true, text: r.text, via: 'archive snapshot', note: 'Wayback Machine copy — may be stale; say so if currency matters', tried };
    } catch {}
  }

  if (typeof seePage === 'function') {
    tried.push('vision');
    try {
      const r = await seePage(u, focus);
      if (_good(r)) return { ok: true, text: r.text, via: 'vision', note: 'read with her eyes off the rendered page', tried };
    } catch {}
  }

  log && log(`[escalate] every door failed for ${u} (${tried.join(' → ')})`);
  return { ok: false, error: `blocked and every fallback failed (tried: ${tried.join(' → ')}) — this one genuinely needs a human`, tried };
}

module.exports = { escalatedRead, ARCHIVE_PREFIX, MIN_TEXT };
