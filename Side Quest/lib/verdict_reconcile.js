'use strict';
/**
 * lib/verdict_reconcile.js — W5-S0.5: ONE VERDICT STORE (run-2 F4, 2026-08-20).
 *
 * The live disease: a subconscious synthesis pass minted the verdict that "Larry Selders died
 * July 7, 2026" is a "temporally impossible future date" — reasoning from the MODEL'S TRAINED
 * CLOCK (which believes 2026 is the future) instead of the wall clock (it was August 2026). The
 * TRUE fact was branded a temporal error while the reply layer kept correctly asserting it — two
 * organs holding opposite verdicts with no reconciliation, exactly the W5 "asserted, not measured"
 * seam in the epistemic layer.
 *
 * The cure at the door: before a refutation VERDICT sticks in known_incorrect (the trust authority
 * — a refuted value can never win a claim), a temporal-flavored charge must survive the WALL
 * CLOCK. A date the charge calls "future" that is actually ≤ now refutes the CHARGE, not the
 * claim. Deterministic, sync, zero model involvement — the trained clock cannot outvote Date.now().
 *
 * Polarity: the gate only BLOCKS a verdict it can positively disprove. Anything it cannot judge
 * (no dates found, a genuinely future date, a non-temporal reason, an internal error) passes
 * through unchanged — bounce refutations, resolver audits, and every existing writer are
 * untouched. Pure + injectable now-clock, smoked offline.
 */

// A reason that charges the claim with a time crime.
const _TEMPORAL_REASON_RE = /\btemporal(?:ly)?\b|\bfuture date\b|\bin the future\b|\bhasn'?t happened\b|\bhas not happened\b|\bimpossible date\b|\bnot (?:yet )?occurred\b|\bdate .{0,20}\bimpossible\b/i;

const _MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

/** Extract asserted calendar dates from a claim. Returns [{ts, text}] — best-effort, conservative:
 *  "July 7, 2026" / "7 July 2026" → that day; a bare year "2026" → Jan 1 of that year (the EARLIEST
 *  moment the year could refer to, so a bare current-year mention is never judged future). */
function datesIn(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  // Month D, YYYY  |  D Month YYYY
  const re1 = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/gi;
  const re2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+((?:19|20)\d{2})\b/gi;
  let m;
  while ((m = re1.exec(s)) !== null) { const ts = Date.UTC(+m[3], _MONTHS[m[1].toLowerCase()], +m[2]); if (!seen.has(ts)) { seen.add(ts); out.push({ ts, text: m[0] }); } }
  while ((m = re2.exec(s)) !== null) { const ts = Date.UTC(+m[3], _MONTHS[m[2].toLowerCase()], +m[1]); if (!seen.has(ts)) { seen.add(ts); out.push({ ts, text: m[0] }); } }
  // ISO YYYY-MM-DD
  const re3 = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = re3.exec(s)) !== null) { const ts = Date.UTC(+m[1], +m[2] - 1, +m[3]); if (!seen.has(ts)) { seen.add(ts); out.push({ ts, text: m[0] }); } }
  // bare years — only when no full date already carries that year
  const yearsCovered = new Set(out.map((d) => new Date(d.ts).getUTCFullYear()));
  const re4 = /\b((?:19|20)\d{2})\b/g;
  while ((m = re4.exec(s)) !== null) { const y = +m[1]; if (!yearsCovered.has(y)) { const ts = Date.UTC(y, 0, 1); if (!seen.has(ts)) { seen.add(ts); yearsCovered.add(y); out.push({ ts, text: m[0], bareYear: true }); } } }
  return out;
}

const GRACE_MS = 26 * 3600e3;   // a date "today" anywhere on Earth is never future — a day+tz of slack

/**
 * gate({ claimValue, reason, now }) → { stick, why }
 * stick=false ONLY when the reason is a temporal charge AND every date the claim asserts is
 * already past by the WALL clock — i.e. the charge itself is disproven. Everything else sticks.
 */
function gate({ claimValue, reason, now = Date.now() } = {}) {
  try {
    if (!_TEMPORAL_REASON_RE.test(String(reason || ''))) return { stick: true, why: 'not-temporal' };
    const dates = datesIn(claimValue);
    if (!dates.length) return { stick: true, why: 'no-dates-to-judge' };
    const future = dates.filter((d) => d.ts > now + GRACE_MS);
    if (future.length) return { stick: true, why: `genuinely-future:${future[0].text}` };
    // Every asserted date is PAST — the "future date" charge is false by the wall clock.
    return { stick: false, why: `clock-refuted: every asserted date (${dates.map((d) => d.text).join(', ')}) is already past — the charge came from a stale trained clock, not from time` };
  } catch { return { stick: true, why: 'gate-error-fail-open' }; }
}

/** The real-date line for reflective/synthesis prompts — the trained clock's antidote at the
 *  MINTING seam. Rendered from the wall clock (Eastern, like every displayed time). */
function clockLine(now = Date.now()) {
  try {
    const tz = require('./tz');
    const d = new Date(now);
    return `TODAY IS ${tz.date(d)} (${tz.timeWithZone(d)}). Your trained sense of "the current year" is STALE — judge past vs future ONLY against this date. Any date on or before it has ALREADY HAPPENED and is never a "temporally impossible future date".`;
  } catch {
    return `TODAY IS ${new Date(now).toDateString()}. Judge past vs future ONLY against this date — any date on or before it has already happened.`;
  }
}

module.exports = { gate, datesIn, clockLine, GRACE_MS, _TEMPORAL_REASON_RE };
