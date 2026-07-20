/* lib/observed_at.js — WHEN DID THE SOURCE SAY THIS? (docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2)
 *
 * An encounter carries two clocks: `ingested_at` (when we read it) and `observed_at` (the SOURCE'S own
 * date). The design calls the distinction load-bearing, and it is: ingesting a 2021 PDF today must not
 * let it outrank genuinely current data. Without observed_at the entire recency half of §5 — contact
 * decay, volatility classes, "newer supersedes" — has nothing to run on. It is currently NULL on all
 * 4,726 encounters, so none of it runs.
 *
 * ── UNKNOWN STAYS UNKNOWN ───────────────────────────────────────────────────────────────────────
 *
 * The one rule that matters more than coverage: never guess. Defaulting to now() would silently stamp
 * every legacy document as current, which is worse than having no date at all — a wrong date is
 * indistinguishable from a right one downstream, and it would make the oldest material outrank the
 * newest. This returns null far more often than it returns a date, deliberately.
 *
 * ── A DOCUMENT'S DATE IS NOT ALWAYS ITS PUBLICATION DATE ────────────────────────────────────────
 *
 * Measured on the live corpus. Alameda County agendas read:
 *
 *   "ALAMEDA COUNTY BOARD OF SUPERVISORS' ... Thursday, July 23, 2026 10:00 a.m."
 *
 * That is the date of the MEETING BEING SCHEDULED — three days in the future when the file was
 * ingested. Taking it as observed_at would hand a document a date it has not reached yet, and under
 * recency weighting a future-dated source outranks everything real, permanently, and gets *stronger*
 * as other material ages. So FUTURE DATES ARE REFUSED, not clamped: a date we cannot interpret is
 * exactly the case where null is the honest answer.
 *
 * Pure. No db, no IO.
 */
'use strict';

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).join('|');

// Scan the head only: over a whole body, a roster listing terms of office yields a date per official.
//
// KNOWN LIMITATION, MEASURED AND LEFT IN. This cannot reliably tell a dateline from a date that happens
// to be *content*. A swim-meet schedule gives 4/17/2021 from a table row (idx 120); a vote-by-mail form
// gives 04/17/2024 from a field (idx 212); an Iberia Parish transcription gives its genuine January 20,
// 2026 dateline at idx 909. Position was the obvious discriminator and it is exactly backwards on these
// — tightening the window to 400 chars dropped the CORRECT one and kept both wrong ones.
//
// Left generous deliberately. The two failure modes are not equal:
//   - a content date is usually contemporaneous with its document (a 2021 form really is from 2021),
//     so it degrades precision rather than ordering;
//   - a FUTURE date reorders everything permanently and gets stronger as real material ages.
// Only the second is catastrophic, and it is refused outright below. Do not "fix" this by narrowing the
// window without re-measuring those three documents.
const HEAD_CHARS = 2500;
const MIN_YEAR = 1900;

// A date is only a date if it is a real one. `new Date(2026, 1, 31)` silently rolls into March, which
// would turn a typo into a confident wrong answer.
function utcTs(y, m, d) {
  if (!(y >= MIN_YEAR) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, m - 1, d);
  const back = new Date(ts);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ts;
}

// Two-digit years: 26 → 2026, 99 → 1999. Anything more than a few years ahead is far likelier to be a
// mis-parse than a real future date.
function fullYear(y) {
  const n = Number(y);
  if (n >= 100) return n;
  return n <= 40 ? 2000 + n : 1900 + n;
}

// Every date-shaped thing in a string, with where it was found. Position matters: the earliest date in
// the head is the dateline; later ones are body content.
function candidates(s) {
  const out = [];
  const push = (idx, ts, precision, matched) => { if (ts != null) out.push({ idx, ts, precision, matched }); };
  let m;

  // ISO: 2026-07-23
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = iso.exec(s))) push(m.index, utcTs(+m[1], +m[2], +m[3]), 'day', m[0]);

  // Month name first: July 23, 2026 / Jul 23 2026
  const mdy = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  while ((m = mdy.exec(s))) push(m.index, utcTs(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), 'day', m[0]);

  // Day first: 23 July 2026
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi');
  while ((m = dmy.exec(s))) push(m.index, utcTs(+m[3], MONTHS[m[2].toLowerCase()], +m[1]), 'day', m[0]);

  // Numeric US: 7/23/2026, 07-23-26. US order assumed — this corpus is US local government. Ambiguous
  // pairs like 3/4/26 are therefore a known, accepted risk within a month, not a silent one.
  const num = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
  while ((m = num.exec(s))) push(m.index, utcTs(fullYear(m[3]), +m[1], +m[2]), 'day', m[0]);

  // Month + year only: July 2026. Real, but the day is unknown — recorded as month precision so a
  // caller can tell "the 1st" from "sometime that month".
  const my = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{4})\\b`, 'gi');
  while ((m = my.exec(s))) push(m.index, utcTs(+m[2], MONTHS[m[1].toLowerCase()], 1), 'month', m[0]);

  return out;
}

// Filenames do not punctuate like prose, and the live corpus shows both shapes at once:
//   PAL_Ag_7_20_26I.pdf                        underscores, and a letter glued to the year
//   June-3-2025-Apache-County-Press-Release    hyphens where prose would have a space
// One normalisation cannot serve both — turning `-` into a space breaks `7-20-26`, and leaving it
// breaks `June-3-2025`. So the name is scanned BOTH ways and the results unioned.
function nameCandidates(name) {
  const s = String(name || '');
  if (!s) return [];
  const separated = s.replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
  const numeric = separated.replace(/_/g, '-');       // 7_20_26 → 7-20-26
  const worded = separated.replace(/[-_]+/g, ' ');    // June-3-2025 → June 3 2025
  return candidates(numeric).concat(candidates(worded));
}

// THE SOURCE'S OWN DATE, or null.
//
// `now` is injectable so this is testable without freezing a clock. Returns
// { ts, iso, precision, matched, from } — `from` says whether the date came from the text or the
// filename, because a filename date is weaker evidence and a caller may want to know.
function extractObservedAt({ text = '', title = '', filename = '', now = Date.now() } = {}) {
  const head = String(text || '').slice(0, HEAD_CHARS);
  // Tomorrow, not today: a document published today in another timezone is not from the future.
  const ceiling = now + 36 * 3600 * 1000;

  const pick = (list) => {
    const ok = list
      .filter((c) => c.ts <= ceiling)          // FUTURE DATES ARE REFUSED — see the header note
      .filter((c) => c.ts >= Date.UTC(MIN_YEAR, 0, 1))
      .sort((a, b) => a.idx - b.idx || (a.precision === 'day' ? -1 : 1));
    return ok.length ? ok[0] : null;
  };

  // Title and filename first when they carry a date: a filename like `PAL_Ag_7_20_26.pdf` is the
  // publisher's own label for the document, while the body's first date may be about its contents.
  const named = pick(nameCandidates(`${title} ${filename}`));
  if (named) return { ts: named.ts, iso: new Date(named.ts).toISOString().slice(0, 10), precision: named.precision, matched: named.matched, from: 'filename' };

  const inText = pick(candidates(head));
  if (inText) return { ts: inText.ts, iso: new Date(inText.ts).toISOString().slice(0, 10), precision: inText.precision, matched: inText.matched, from: 'text' };

  return null;
}

module.exports = { extractObservedAt, candidates, nameCandidates, utcTs, fullYear, MONTHS, HEAD_CHARS };
