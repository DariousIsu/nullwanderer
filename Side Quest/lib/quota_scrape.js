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
// A WEEKLY pool's reset is always days out; anything sooner is a shorter-cycle meter mislabeled.
// Refusing on a sub-day horizon is the SAFE failure — it keeps the last trusted mark.
const MIN_WEEKLY_RESET_MS = 24 * 3600000;

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

const _round4 = (pct) => Math.min(1, Math.round(pct * 1e4) / 1e4);   // 67.1/100 = 0.67099… in floats

// All "<pct>% … resets in <duration>" tuples in the page text, each with the label word (if any)
// bound to it. Two passes, structured first:
//
// PRIMARY — the REAL /settings layout (seen live 2026-08-07): a meter is
//   "<label> usage <pct>% used. Resets in <duration>."
// The label is the word DIRECTLY before "usage" (not a loose lookback), and each meter's duration
// is captured up to the sentence PERIOD — both were the first-parse bugs: a 60-char lookback caught
// the word "weekly" from the preamble ("…contribute to session and weekly limits.") sitting before
// the SESSION percentage, and an unbounded duration let the 2.9% meter swallow "…3 hours. Weekly
// usage 68%…". Binding the label to "usage" and stopping the duration at the period fixes both.
//
// FALLBACK — the older loose "<pct>% … resets in <dur>" shape (a differently-worded page), used
// only when the structured pass finds nothing, so the preamble-label bug can't reach it here.
const _STRUCTURED_RE = /(session|weekly|daily|monthly)\s+usage\s+(\d+(?:\.\d+)?)\s*%[^.\n]*?resets?\s+(?:in\s+)?([^.\n]{1,40})/gi;
const _LOOSE_RE = /(\d+(?:\.\d+)?)\s*%[\s\S]{0,80}?resets?\s+(?:in\s+)?([^.\n]{1,60})/gi;

function extractMeters(text) {
  const txt = String(text || '');
  const out = [];
  for (const m of txt.matchAll(_STRUCTURED_RE)) {
    const pct = Number(m[2]) / 100;
    const resetMs = parseDuration(m[3]);
    if (!(pct >= 0 && pct <= 1.005) || resetMs <= 0) continue;
    out.push({ pct: _round4(pct), resetMs, label: m[1].toLowerCase() });
  }
  if (out.length) return out;   // structured labels are authoritative — never fall through to the loose scan
  for (const m of txt.matchAll(_LOOSE_RE)) {
    const pct = Number(m[1]) / 100;
    const resetMs = parseDuration(m[2]);
    if (!(pct >= 0 && pct <= 1.005) || resetMs <= 0) continue;   // a >100% or reset-less match is noise, not a meter
    const before = txt.slice(Math.max(0, m.index - 60), m.index);
    const label = /weekly/i.test(before) ? 'weekly' : /session/i.test(before) ? 'session' : /daily/i.test(before) ? 'daily' : '';
    out.push({ pct: _round4(pct), resetMs, label });
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
  // ⚠ RESET-HORIZON SANITY (2026-08-07, caught live on the FIRST clean parse): the scrape wrote
  // "2.6% weekly, resets in 3h", overwriting the trued-up 67.1% mark — impossible for a WEEKLY
  // pool (it cannot reset in hours, and usage cannot fall mid-cycle). The parser had matched the
  // short-cycle SESSION meter and mislabeled it weekly (the real /settings layout differs from the
  // /settings/usage page this was designed against — never seen until now). A weekly mark whose
  // reset is < 24h out is definitionally a misparse: REFUSE it. Refusing is the safe direction —
  // it keeps the last trusted mark rather than opening the spend gate on a phantom-empty pool.
  if (weekly.resetMs < MIN_WEEKLY_RESET_MS) {
    return { ok: false, signedOut: false,
      reason: `selected "${weekly.label || 'longest-horizon'}" meter resets in ${(weekly.resetMs / 3600000).toFixed(1)}h — too soon to be the weekly pool (likely the session meter mislabeled); refusing` };
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

module.exports = { parseUsage, parseDuration, extractMeters, MIN_WEEKLY_RESET_MS };
