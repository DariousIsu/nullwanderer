/*
 * lib/legis_acquire.js — DIRECTED LEGISLATIVE ACQUISITION (2026-08-21).
 *
 * Lucas, on watching the anti-China report starve while the corpus drain dripped at 300 bills/4h:
 * "I asked for an output. I would like the output delivered as quickly as possible. Why would a
 * direct user request get queued as a multi-day job, esp when it's just database review."
 *
 * The background bulk drain (lib/api_bulk) is a CORPUS builder — sequential, capped, quota-paced —
 * and it must never be the fulfillment path for a direct order. This module is the missing limb:
 * when a user-ordered report names STATES and LEGISLATION, the exact fuel is a handful of targeted
 * LegiScan searches (the same keyed API the drain uses), fetched NOW through the suit's read tools
 * and landed as citable search sheets BEFORE the composer gathers. Bounded (≤8 states/order, one
 * search each), idempotent per day (a ref-matched sheet is not re-landed), fail-soft in every
 * direction (no Echo / no results / a throw → the gather proceeds on held material unchanged).
 *
 * Pure detection + injected I/O (dispatch / insertDocument / findExisting) → offline-testable.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// Full state names → USPS codes (the topic names states in prose; LegiScan wants codes).
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const _LEGIS_RE = /\b(?:bills?|legislation|legislative|statutes?|acts?|laws?)\b/i;
// Tokens that steer the report but not the SEARCH — states, deliverable words, connective filler.
const _QUERY_STOP = new Set(['legislation', 'legislative', 'bill', 'bills', 'statute', 'statutes', 'act', 'acts',
  'law', 'laws', 'state', 'states', 'report', 'reports', 'status', 'statuses', 'breakdown', 'breakdowns', 'session', 'sessions', 'trend', 'trends',
  'graph', 'table', 'anti', 'pro', 'the', 'and', 'per', 'via', 'already', 'landed', 'legiscan', 'with', 'for']);

/** detect(topic) → { states: ['UT',…], query } — pure. Empty states = no acquisition. */
function detect(topic) {
  const t = str(topic).toLowerCase();
  if (!_LEGIS_RE.test(t)) return { states: [], query: '' };
  const states = [];
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(t) && !states.includes(code)) states.push(code);
  }
  if (!states.length) return { states: [], query: '' };
  // The query = the topic's salient non-state, non-filler tokens (e.g. "anti-China legislation
  // state by state: Utah, …" → "china"). No viable token → no acquisition (a bare state list is
  // not a searchable subject).
  const stateWords = new Set(Object.keys(STATE_CODES).flatMap((n) => n.split(' ')));
  const toks = (t.match(/[a-z][a-z0-9'-]{2,}/g) || [])
    .map((w) => w.replace(/^anti-/, ''))
    .filter((w) => !_QUERY_STOP.has(w) && !stateWords.has(w))
    // a hyphenated token made entirely of filler ("per-state") is filler too
    .filter((w) => !w.split('-').every((p) => _QUERY_STOP.has(p) || stateWords.has(p) || p.length < 3));
  const query = [...new Set(toks)].slice(0, 2).join(' ');
  return { states: states.slice(0, 8), query };
}

/** One landed sheet body — every result row cited with its LegiScan URL. Pure. */
function sheetBody({ state, query, results, total, dateStr }) {
  const rows = (results || []).slice(0, 40).map((r) =>
    `- **${r.bill_number || '?'} — ${str(r.title).slice(0, 160)}** — ${str(r.last_action).slice(0, 120)}${r.last_action_date ? ` (${r.last_action_date})` : ''}. Source: ${r.url || ''} (LegiScan relevance ${r.relevance != null ? r.relevance : '?'})`);
  return `# LegiScan sweep — "${query}" bills: ${state}\n\n` +
    `Pulled live from the LegiScan API on ${dateStr} (key-authenticated; ${total != null ? total : rows.length} total match(es)).` +
    `${(results || []).length > 40 ? ' First 40 shown.' : ''}\n\n${rows.join('\n')}\n`;
}

/**
 * acquire({states, query, dispatch, insertDocument, findExisting, now, log}) → { landed, skipped }.
 * dispatch = the suit's Echo dispatch (legiscan_search is a READ tool — never tier-blocked, never
 * quota-deferred: this runs inside a user-ordered turn). Fail-soft: any per-state failure moves on.
 */
async function acquire({ states = [], query = '', dispatch, insertDocument, findExisting = () => false, now = Date.now(), log = () => {} } = {}) {
  const out = { landed: 0, skipped: 0 };
  if (!states.length || !query || typeof dispatch !== 'function' || typeof insertDocument !== 'function') return out;
  const dateStr = new Date(now).toISOString().slice(0, 10);
  for (const state of states) {
    const ref = `legiscan-search:${state.toLowerCase()}:${query.replace(/\s+/g, '-')}:${dateStr}`;
    try {
      if (findExisting(ref)) { out.skipped++; continue; }         // today's sheet already held
      const r = await dispatch({ kind: 'do', name: 'legiscan_search', args: { state, query } });
      if (!r || !r.ok || !r.text) continue;
      let j = null; try { j = JSON.parse(r.text); } catch { continue; }
      const results = Array.isArray(j.results) ? j.results : [];
      if (!results.length) continue;                              // an honest empty is not a sheet
      const id = insertDocument({
        title: `LegiScan sweep — ${query} bills: ${state} (${dateStr})`,
        body: sheetBody({ state, query, results, total: j.total_results, dateStr }),
        source: 'legislation', ref,
        understanding: `Live LegiScan search results for "${query}" legislation in ${state} — bill numbers, statuses, dates, source URLs.`,
        origin: `https://legiscan.com/${state}`,
      });
      if (id != null) { out.landed++; log(`[legis-acquire] ${state}: ${results.length} bill(s) → sheet landed`); }
    } catch (e) { log(`[legis-acquire] ${state} failed (${e && e.message}) — moving on`); }
  }
  return out;
}

module.exports = { detect, acquire, sheetBody, STATE_CODES };
