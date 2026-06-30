/**
 * lib/record_completeness.js — measure how COMPLETE a research record actually is, by reading it.
 *
 * The miss this answers (Lucas 2026-06-30): "which do we have the most COMPLETE record on" was first
 * answered by ranking on raw text length — but length isn't completeness (a long record full of
 * "not found" is empty). The program should LOOK at each record and determine its completeness: how
 * many real data points it holds vs how many fields came back "not found". That measured score is what
 * "most complete" ranks on, what "where are the gaps" reads off, and the same completeness Pillar 0's
 * contract uses to decide a Track is done.
 *
 * PURE: operates on a section's markdown body. No I/O, no model. Fail-safe (never throws).
 */
'use strict';

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "empty" markers a record uses when a field couldn't be filled.
const NOT_FOUND_RE = /\bnot found\b|\bn\/?a\b|\bunknown\b|\bnone found\b|\bnot (?:available|listed|provided|public(?:ly available)?)\b|\bTBD\b|\bunavailable\b/gi;
// concrete data points = real, checkable content.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s)\]]+/g;
const PHONE_RE = /(?:\+?\d[\d\-.\s()]{7,}\d)/g;
// a named person with a role: "Firstname Lastname – Vice President …" (en/em dash or hyphen + a Title-cased role)
const PERSON_RE = /[A-Z][a-z]+(?:\s+[A-Z][a-z.]+){1,3}\s*[–—-]\s*[A-Z][a-z]/g;
// a labelled field line: "- **Key people:** value" / "- **Contact:** value"
const FIELD_LINE_RE = /^[ \t]*[-*][ \t]*\*\*([^*]+?)\*\*\s*:?\s*(.*)$/gim;

// Read ONE record's body and score its completeness.
// Returns { heading, dataPoints, notFound, filledFields, totalFields, ratio, size }.
//   dataPoints = real emails/urls/phones/named-people found
//   ratio      = filled signals ÷ (filled + not-found) → 0..1 (how much of what was sought is actually there)
function scoreSection(section) {
  const heading = String((section && section.heading) || '').trim();
  const body = String((section && section.body) || '');
  const count = (re) => { const m = body.match(re); return m ? m.length : 0; };

  const notFound = count(NOT_FOUND_RE);
  const emails = count(EMAIL_RE);
  const urls = count(URL_RE);
  const phones = count(PHONE_RE);
  const people = count(PERSON_RE);
  const dataPoints = emails + urls + phones + people;

  // labelled fields: filled vs empty/"not found"
  let filledFields = 0, totalFields = 0;
  let m; FIELD_LINE_RE.lastIndex = 0;
  while ((m = FIELD_LINE_RE.exec(body)) !== null) {
    totalFields++;
    const val = String(m[2] || '').trim();
    const filled = val.length > 0 && !/^(?:not found|n\/?a|unknown|none|tbd|—|-)\b/i.test(val);
    if (filled) filledFields++;
  }

  const filled = dataPoints + filledFields;
  const denom = filled + notFound;
  const ratio = denom > 0 ? filled / denom : (body.replace(/\s+/g, '').length > 40 ? 0.5 : 0);
  const size = body.replace(/\s+/g, ' ').trim().length;
  return { heading, dataPoints, notFound, filledFields, totalFields, ratio: round(ratio), size };
}

// Rank records by how COMPLETE they are: most real data points first, then best filled-ratio, then size
// as a final tiebreak. Returns the scored sections, richest first.
function rankByCompleteness(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(scoreSection)
    .filter(s => s.heading)
    .sort((a, b) => (b.dataPoints - a.dataPoints) || (b.ratio - a.ratio) || (b.size - a.size));
}

// One-line completeness phrase for a scored record (for grounded answers / status).
function describe(score) {
  if (!score) return '';
  const bits = [`${score.dataPoints} data point${score.dataPoints === 1 ? '' : 's'}`];
  if (score.notFound) bits.push(`${score.notFound} still "not found"`);
  return bits.join(', ');
}

// Coverage summary across a whole record set — totals + the THIN records (where the gaps are). Feeds
// "where are we light" answers and the Pillar-0 completeness contract.
function coverageSummary(sections, { thinThreshold = 2 } = {}) {
  const scored = rankByCompleteness(sections);
  const totalData = scored.reduce((n, s) => n + s.dataPoints, 0);
  const totalNotFound = scored.reduce((n, s) => n + s.notFound, 0);
  const thin = scored.filter(s => s.dataPoints <= thinThreshold).map(s => s.heading);
  return { count: scored.length, totalData, totalNotFound, thin, scored };
}

module.exports = { scoreSection, rankByCompleteness, describe, coverageSummary, NOT_FOUND_RE, EMAIL_RE, PERSON_RE };
