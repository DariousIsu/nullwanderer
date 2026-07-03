/**
 * lib/candidate_party.js — resolve a CANDIDATE NAME → party (A=Dem / B=Rep) via FEC. This is the piece that
 * turns VoteHub race polls from unusable into a SIGNED margin: VoteHub gives bare names ("Ruben Gallego")
 * with no party, so the forecasting model can't tell which side is which. FEC is the authoritative source —
 * `candidates/search?q=<name>` returns `{ name:"GALLEGO, RUBEN", party:"DEM", office:"S", state:"AZ" }`.
 *
 * Same async-pre-resolve → sync-lookup shape as forecast_assess: `resolveMany` runs the FEC lookups (budgeted
 * concurrency, cached — party is static per person) and returns a SYNC `partyOf(choice, race)` the loop's
 * signMargin calls on its hot path. PURE cores (normName / matchRecord / partyCode) → offline-testable with an
 * injected `search`; the live `search` is `api_stream.pull('fec', …)` (NEVER api_client directly). Fail-safe:
 * no match / third-party / FEC down → null → the race falls back to a prior (never a mis-signed margin).
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();

// FEC party code → the reactor's A(=Dem) / B(=Rep) convention. Third parties / independents → null (prior).
const A_PARTIES = new Set(['DEM', 'DFL']);       // Democratic, MN Dem-Farmer-Labor
const B_PARTIES = new Set(['REP']);              // Republican
function partyCode(p) { const s = String(p == null ? '' : p).toUpperCase().trim(); return A_PARTIES.has(s) ? 'A' : (B_PARTIES.has(s) ? 'B' : null); }

// poll_type / chamber → FEC office code
function officeCode(x) {
  const s = String(x == null ? '' : x).toLowerCase();
  if (s === 'senate' || s === 'us-senator') return 'S';
  if (s === 'house' || s === 'us-representative') return 'H';
  if (s === 'president') return 'P';
  return null;
}

// last name from a "First Last" (VoteHub) or "LAST, FIRST" (FEC) string → normalized token
function lastNameOf(name) {
  const raw = String(name == null ? '' : name).trim();
  if (raw.includes(',')) return norm(raw.split(',')[0]);          // FEC "GALLEGO, RUBEN" → "gallego"
  const toks = norm(raw).split(' ').filter(Boolean);
  // drop a trailing suffix (jr/sr/ii/iii/iv) so "Nick Begich III" → "begich"
  const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  while (toks.length > 1 && SUFFIX.has(toks[toks.length - 1])) toks.pop();
  return toks[toks.length - 1] || '';
}

// pick the FEC record best matching `name` (+ office/state hint). Prefers a shared last name, then office,
// then state, then a major-party record. null when nothing plausible.
function matchRecord(name, results, hint = {}) {
  const rs = Array.isArray(results) ? results : [];
  if (!rs.length) return null;
  const wantLast = lastNameOf(name);
  let pool = wantLast ? rs.filter((r) => lastNameOf(r.name) === wantLast) : rs;
  if (!pool.length) return null;                                   // no surname match → don't guess
  if (hint.office) { const o = pool.filter((r) => r.office === hint.office); if (o.length) pool = o; }
  if (hint.state) { const s = pool.filter((r) => r.state === hint.state); if (s.length) pool = s; }
  const major = pool.filter((r) => partyCode(r.party));            // prefer a D/R record over a stray third-party dup
  return major[0] || pool[0] || null;
}

// PURE — one name + its FEC results → 'A'|'B'|null
function partyFromResults(name, results, hint = {}) {
  const rec = matchRecord(name, results, hint);
  return rec ? partyCode(rec.party) : null;
}

/**
 * LIVE — pre-resolve a set of candidate entries → a SYNC partyOf(choice, race).
 * entries: [{ name, office?, state? }]  (office/state only sharpen the FEC search; identity key is the name).
 * search(name, {office, state}) → FEC results array (injected; real = api_stream.pull('fec','candidates/search',…)).
 * cache: a Map name→party ('A'|'B'|null) reused across cycles (party is static). Fail-safe per entry.
 */
async function resolveMany(entries, { search, cache = new Map(), concurrency = 4 } = {}) {
  const uniq = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) { const k = norm(e && e.name); if (k && !uniq.has(k) && !cache.has(k)) uniq.set(k, e); }
  const q = [...uniq.values()];
  async function worker() {
    let e;
    while ((e = q.shift())) {
      let party = null;
      try { party = partyFromResults(e.name, await search(e.name, { office: e.office, state: e.state }), e); }
      catch { party = null; }
      cache.set(norm(e.name), party);
    }
  }
  if (typeof search === 'function') await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, q.length)) }, worker));
  const partyOf = (choice) => { const v = cache.get(norm(choice)); return v == null ? null : v; };
  return { partyOf, cache, resolved: [...cache.values()].filter(Boolean).length, total: cache.size };
}

module.exports = { norm, partyCode, officeCode, lastNameOf, matchRecord, partyFromResults, resolveMany };
