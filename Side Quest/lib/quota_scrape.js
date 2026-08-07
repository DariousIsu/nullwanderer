/*
 * lib/quota_scrape.js — the PURE half of the quota self-true-up: turn the ollama.com usage
 * dashboard's page text into the mark the quota gate consumes (quota.mark_pct / reset_at).
 *
 * Ollama exposes no usage API or headers (see config.usageConfig), so the provider's counter is
 * only readable the way Lucas reads it: the dashboard. Tonight's operator workflow — screenshot,
 * read the WEEKLY meter, write the meta keys by hand — is what this automates; main.js loads the
 * page in a hidden window and hands the innerText here.
 *
 * The dashboard shows relative meters ("36.1% … Resets in 1 hour" session, "67.1% … Resets in
 * 2 days" weekly). The quota gate models ONE pool — the WEEKLY one — so selection is the whole
 * job: prefer the meter labelled weekly; with no labels, the longest reset horizon is the pool
 * (a session window is minutes-to-hours, the weekly pool days). A single unlabelled meter is
 * accepted only when its reset is >24h out — a multi-day reset can only be the weekly pool, but
 * a lone short-reset meter is the session bar and writing it as the weekly mark would poison the
 * gate. Refusing to parse is always safe: the caller leaves the mark untouched.
 */
'use strict';

const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 7 * 86400000 };

// "2 days", "1 hour", "1 day 3 hours", "45 minutes" → total ms (0 when nothing parses).
function parseDuration(s) {
  let total = 0;
  for (const m of String(s || '').matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/gi)) {
    const w = m[2].toLowerCase();
    const unit = w.startsWith('sec') ? 'second' : w.startsWith('min') ? 'minute' : (w.startsWith('hour') || w.startsWith('hr')) ? 'hour' : w.startsWith('day') ? 'day' : 'week';
    total += Number(m[1]) * UNIT_MS[unit];
  }
  return total;
}

// All "<pct>% … resets in <duration>" tuples in the page text, each with the label word (if any)
// that precedes it. The 80-char windows keep a meter's pieces bound to each other, so two meters
// on one page never cross-wire.
function extractMeters(text) {
  const txt = String(text || '');
  const out = [];
  for (const m of txt.matchAll(/(\d+(?:\.\d+)?)\s*%[\s\S]{0,80}?resets?\s+(?:in\s+)?([^\n]{1,60})/gi)) {
    const pct = Number(m[1]) / 100;
    const resetMs = parseDuration(m[2]);
    if (!(pct >= 0 && pct <= 1.005) || resetMs <= 0) continue;   // a >100% or reset-less match is noise, not a meter
    const before = txt.slice(Math.max(0, m.index - 60), m.index);
    const label = /weekly/i.test(before) ? 'weekly' : /session/i.test(before) ? 'session' : /daily/i.test(before) ? 'daily' : '';
    // Round to 4 decimals: 67.1/100 is 0.67099999… in floats, and the mark should read back as
    // exactly what the dashboard displayed.
    out.push({ pct: Math.min(1, Math.round(pct * 1e4) / 1e4), resetMs, label });
  }
  return out;
}

/**
 * Parse the usage page text. Returns:
 *   { ok: true, pct, resetAt, label, session: {pct, resetAt}|null }   — write the mark
 *   { ok: false, signedOut: true }                                    — page needs a sign-in
 *   { ok: false, signedOut: false, reason }                           — leave the mark untouched
 */
function parseUsage(text, now = Date.now()) {
  const meters = extractMeters(text);
  if (!meters.length) {
    const signedOut = /\b(sign|log)\s*in\b/i.test(String(text || ''));
    return { ok: false, signedOut, reason: signedOut ? 'signed out' : 'no usage meters in the page text' };
  }
  let weekly = meters.find((m) => m.label === 'weekly');
  if (!weekly) {
    if (meters.length > 1) {
      weekly = meters.reduce((a, b) => (b.resetMs > a.resetMs ? b : a));
    } else if (meters[0].resetMs > UNIT_MS.day) {
      weekly = meters[0];   // a multi-day reset can only be the weekly pool
    } else {
      return { ok: false, signedOut: false, reason: 'only a short-reset meter visible — refusing to write it as the weekly mark' };
    }
  }
  const session = meters.find((m) => m !== weekly && (m.label === 'session' || m.resetMs < weekly.resetMs)) || null;
  return {
    ok: true,
    pct: weekly.pct,
    resetAt: now + weekly.resetMs,
    label: weekly.label || 'longest-horizon',
    session: session ? { pct: session.pct, resetAt: now + session.resetMs } : null,
  };
}

module.exports = { parseUsage, parseDuration, extractMeters };
