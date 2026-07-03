/**
 * lib/poll_538legacy.js — FiveThirtyEight legacy-data adapter (Suite-A / model-input source).
 *
 * The 538 forecast is dead, but its public data repo (github.com/fivethirtyeight/data) is still up under
 * CC-BY 4.0 (verified 2026-07-03). This adapter loads the two files the MODELS need — not the live poll
 * feed (that's poll_wikipedia + poll_votehub), but the weighting + backtest substrate:
 *   • pollster-ratings/pollster-ratings-combined.csv → POLLSTER RATINGS (quality grade + measured partisan
 *     BIAS = a house-effect prior for the aggregation model).
 *   • pollster-ratings/raw_polls.csv → HISTORICAL polls with the ACTUAL result (margin_poll vs
 *     margin_actual) = the calibration/backtest signal for both models.
 *
 * These are distinct shapes from the live-poll adapter shape (they're ratings + result-labeled history),
 * on purpose — they feed Suite B's model layer, not the poll trend feed. PURE + injected I/O (fetchText),
 * offline-testable; `defaultFetchText` (global fetch) is the real one. Fail-soft throughout.
 * No csv dependency in the project → a small RFC4180-ish parser lives here.
 */
'use strict';

const RAW = 'https://raw.githubusercontent.com/fivethirtyeight/data/master/pollster-ratings';
const RATINGS_URL = `${RAW}/pollster-ratings-combined.csv`;
const RAW_POLLS_URL = `${RAW}/raw_polls.csv`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v) => String(v).trim().toUpperCase() === 'TRUE';
const str = (v) => (v == null ? '' : String(v)).trim();

// --- CSV (quoted fields, "" escapes, CRLF) → rows of arrays ---
function parseCsv(text) {
  const s = String(text == null ? '' : text);
  const rows = []; let field = ''; let row = []; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
// → array of header-keyed objects (drops blank trailing lines)
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const hdr = rows[0];
  return rows.slice(1)
    .filter((r) => r.length && !(r.length === 1 && r[0] === ''))
    .map((r) => { const o = {}; hdr.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

// --- pollster ratings (quality + house-effect prior) ---
function normalizeRating(row) {
  const pollster = str(row.pollster);
  if (!pollster) return null;
  return {
    source: '538_legacy', tier: 'free',
    pollster,
    rating_id: num(row.pollster_rating_id),
    grade: num(row.numeric_grade),        // higher = better quality
    rank: num(row.rank),
    pollscore: num(row.POLLSCORE),        // lower = better
    transparency: num(row.wtd_avg_transparency),
    error_ppm: num(row.error_ppm),        // avg absolute error
    bias_ppm: num(row.bias_ppm),          // SIGNED partisan bias → house-effect PRIOR
    n_polls: num(row.number_polls_pollster_total),
    inactive: bool(row.inactive),
  };
}
function parseRatings(csv) { return parseCsvObjects(csv).map(normalizeRating).filter(Boolean); }

// --- historical polls WITH actual result (backtest signal) ---
function normalizeRawPoll(row) {
  const pollster = str(row.pollster);
  if (!pollster && row.margin_poll == null) return null;
  return {
    source: '538_legacy', tier: 'free', kind: 'result',
    poll_id: num(row.poll_id), cycle: num(row.cycle),
    location: str(row.location), race: str(row.race), type: str(row.type_simple),
    pollster, rating_id: num(row.pollster_rating_id), partisan: str(row.partisan) || null,
    methodology: str(row.methodology) || null,
    poll_date: str(row.polldate) || null, election_date: str(row.electiondate) || null,
    sample_size: num(row.samplesize),
    cand1: { name: str(row.cand1_name), party: str(row.cand1_party), pct: num(row.cand1_pct), actual: num(row.cand1_actual) },
    cand2: { name: str(row.cand2_name), party: str(row.cand2_party), pct: num(row.cand2_pct), actual: num(row.cand2_actual) },
    margin_poll: num(row.margin_poll),      // poll's predicted margin
    margin_actual: num(row.margin_actual),  // the real result → error = poll − actual
  };
}
function parseRawPolls(csv) { return parseCsvObjects(csv).map(normalizeRawPoll).filter(Boolean); }

// --- fetch (injected fetchText → CSV string). Fail-soft → {ok:false,…}. ---
async function fetchRatings({ fetchText } = {}) {
  if (typeof fetchText !== 'function') return { ok: false, ratings: [], error: 'missing fetchText' };
  try { return { ok: true, ratings: parseRatings(await fetchText(RATINGS_URL)) }; }
  catch (e) { return { ok: false, ratings: [], error: e.message }; }
}
async function fetchRawPolls({ fetchText } = {}) {
  if (typeof fetchText !== 'function') return { ok: false, polls: [], error: 'missing fetchText' };
  try { return { ok: true, polls: parseRawPolls(await fetchText(RAW_POLLS_URL)) }; }
  catch (e) { return { ok: false, polls: [], error: e.message }; }
}

async function defaultFetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'SideQuest-forecast/0.1' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

module.exports = {
  RATINGS_URL, RAW_POLLS_URL, parseCsv, parseCsvObjects,
  normalizeRating, parseRatings, normalizeRawPoll, parseRawPolls,
  fetchRatings, fetchRawPolls, defaultFetchText,
};
