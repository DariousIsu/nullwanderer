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

// r.chars (fetchPage's CONTENT length) beats text.length when present — the firewall frame's
// header would otherwise let a near-empty shell pass as a read.
function _good(r) { const n = r && r.chars != null ? r.chars : (r && r.text ? String(r.text).trim().length : 0); return !!(r && r.ok && n >= MIN_TEXT); }

// preferDoor: the door that WORKED for this host last time (site_ledger.bestDoor) — studying the
// process means leading with what the map already learned, not re-deriving the ladder every visit.
// onAccess(door, ok): the caller's recorder — every attempt updates the host's access profile.
async function escalatedRead(url, { focus = '', fetchPage, seePage, maxChars = 4000, log, preferDoor = null, onAccess = null } = {}) {
  const u = String(url || '').trim();
  const tried = [];
  if (!u) return { ok: false, error: 'no url', tried };
  const acc = (door, ok) => { try { typeof onAccess === 'function' && onAccess(door, ok); } catch {} };

  const doors = {
    'plain fetch': async () => {
      if (typeof fetchPage !== 'function') return null;
      const r = await fetchPage(u, { maxChars }).catch(() => null);
      // links/finalUrl ride through for the site-sweep walker (2026-08-27) — only this door can
      // carry them (an archive copy's links point at web.archive.org rewrites, vision has none).
      return _good(r) ? { ok: true, text: r.text, via: 'plain fetch', note: null, links: r.links || null, finalUrl: r.finalUrl || null } : null;
    },
    'archive snapshot': async () => {
      if (typeof fetchPage !== 'function') return null;
      const r = await fetchPage(ARCHIVE_PREFIX + u, { maxChars }).catch(() => null);
      return _good(r) ? { ok: true, text: r.text, via: 'archive snapshot', note: 'Wayback Machine copy — may be stale; say so if currency matters' } : null;
    },
    'vision': async () => {
      if (typeof seePage !== 'function') return null;
      const r = await seePage(u, focus).catch(() => null);
      return _good(r) ? { ok: true, text: r.text, via: 'vision', note: 'read with her eyes off the rendered page' } : null;
    },
  };
  const order = ['plain fetch', 'archive snapshot', 'vision'];
  if (preferDoor && doors[preferDoor] && order.includes(preferDoor)) {
    order.splice(order.indexOf(preferDoor), 1);
    order.unshift(preferDoor);
  }

  for (const door of order) {
    if ((door === 'plain fetch' || door === 'archive snapshot') && typeof fetchPage !== 'function') continue;
    if (door === 'vision' && typeof seePage !== 'function') continue;
    tried.push(door);
    const r = await doors[door]();
    acc(door, !!(r && r.ok));
    if (r && r.ok) return { ...r, tried };
  }

  log && log(`[escalate] every door failed for ${u} (${tried.join(' → ')})`);
  return { ok: false, error: `blocked and every fallback failed (tried: ${tried.join(' → ')}) — this one genuinely needs a human`, tried };
}

module.exports = { escalatedRead, ARCHIVE_PREFIX, MIN_TEXT };
