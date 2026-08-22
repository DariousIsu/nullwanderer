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
  // P2 gate prep: the tokens search SEPARATELY and union (the proven sponsor-sweep pattern —
  // "china" + "surveillance" as one AND-ish string under-fetched both tracks). The dataset's
  // (project, entity) identity dedups the union; `query` stays as the joined label for logs/refs.
  const queries = [...new Set(toks)].slice(0, 2);
  return { states: states.slice(0, 8), query: queries.join(' '), queries };
}

/** One landed sheet body — every result row cited with its LegiScan URL. Pure. */
function sheetBody({ state, query, results, total, dateStr }) {
  const rows = (results || []).slice(0, 40).map((r) =>
    `- **${r.bill_number || '?'} — ${str(r.title).slice(0, 160)}** — ${str(r.last_action).slice(0, 120)}${r.last_action_date ? ` (${r.last_action_date})` : ''}. Source: ${r.url || ''} (LegiScan relevance ${r.relevance != null ? r.relevance : '?'})`);
  return `# LegiScan sweep — "${query}" bills: ${state}\n\n` +
    `Pulled live from the LegiScan API on ${dateStr} (key-authenticated; ${total != null ? total : rows.length} total match(es)).` +
    `${(results || []).length > 40 ? ' First 40 shown.' : ''}\n\n${rows.join('\n')}\n`;
}

/** P2 — search results as DATASET ROWS (pure): entity = "ST BILLNUM"; attrs carry what the
 *  search actually returned (state, title, last action + date, relevance, the query tag). */
function resultsToRows({ state, query, results = [] }) {
  return results.filter((r) => r && (r.bill_number || r.bill_id)).map((r) => ({
    entity: `${state} ${str(r.bill_number || r.bill_id)}`,
    attrs: {
      state,
      billId: r.bill_id != null ? Number(r.bill_id) : undefined,   // the enrichment key (legiscan_bill_get)
      title: str(r.title).slice(0, 200),
      lastAction: str(r.last_action).slice(0, 160),
      lastActionDate: str(r.last_action_date),
      relevance: r.relevance != null ? Number(r.relevance) : undefined,
      tags: [query],
    },
    sourceUrl: str(r.url),
    provenance: `legiscan_search ${state} "${query}"`,
  }));
}

// ── P2 slice 2 — BILL-DETAIL ENRICHMENT ────────────────────────────────────────────────────────
// The search rows carry no STATUS and no SPONSORS — the cross-tab's missing dimension and the
// roster's missing half. legiscan_bill_get (Echo READ tool — never tier-blocked, never quota-
// deferred inside a user-ordered turn) returns the canonical Bill object; billToAttrs distills
// exactly the render-relevant fields. Bounded by COUNT and TIME, highest-relevance rows first,
// so the top bills are always detailed even when the budget cuts; the rest enrich on later runs.
const STATUS_MAP = { 1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Passed', 5: 'Vetoed', 6: 'Failed' };

/** Distill one canonical Bill object to render attrs — pure. Primary sponsors lead the list. */
function billToAttrs(bill) {
  const out = {};
  const st = STATUS_MAP[Number(bill && bill.status)] || undefined;
  if (st) out.status = st;
  const sp = Array.isArray(bill && bill.sponsors) ? bill.sponsors : [];
  if (sp.length) {
    const nm = (s) => {
      const n = str(s.name) || `${str(s.first_name)} ${str(s.last_name)}`.trim();
      const tag = [str(s.party), str(s.district)].filter(Boolean).join('-');
      return tag ? `${n} (${tag})` : n;
    };
    const prim = sp.filter((s) => Number(s.sponsor_type_id) === 1).map(nm);
    const cos = sp.filter((s) => Number(s.sponsor_type_id) !== 1).map(nm);
    out.sponsors = [...prim, ...cos].slice(0, 40);
    out.primarySponsors = prim.length;
  }
  const hist = Array.isArray(bill && bill.history) ? bill.history : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  if (last && last.action) { out.lastAction = str(last.action).slice(0, 160); if (last.date) out.lastActionDate = str(last.date); }
  return out;
}

/**
 * enrich({rows, dispatch, upsert, cap, budgetMs, now, log}) → {done, failed, remaining}.
 * rows = the project's dataset rows; only those with a billId and missing status/sponsors are
 * fetched. upsert() receives MERGED attrs (fresh detail over the search row). Fail-soft per bill.
 */
async function enrich({ rows = [], dispatch, upsert, cap = 120, budgetMs = 150000, now = () => Date.now(), log = () => {} } = {}) {
  const out = { done: 0, failed: 0, remaining: 0 };
  if (typeof dispatch !== 'function' || typeof upsert !== 'function') return out;
  const todo = rows
    .filter((r) => r && r.attrs && r.attrs.billId && (!r.attrs.status || !r.attrs.sponsors))
    .sort((a, b) => (b.attrs.relevance || 0) - (a.attrs.relevance || 0));
  const t0 = now();
  for (const r of todo) {
    if (out.done + out.failed >= cap || now() - t0 > budgetMs) break;
    try {
      const res = await dispatch({ kind: 'do', name: 'legiscan_bill_get', args: { bill_id: r.attrs.billId } });
      if (!res || !res.ok || !res.text) { out.failed++; continue; }
      let j = null; try { j = JSON.parse(res.text); } catch { out.failed++; continue; }
      const bill = (j && j.bill) || (j && j.result && j.result.bill) || null;
      if (!bill) { out.failed++; continue; }
      upsert([{ entity: r.entity, attrs: { ...r.attrs, ...billToAttrs(bill) }, sourceUrl: r.sourceUrl || str(bill.url), provenance: r.provenance }]);
      out.done++;
    } catch (e) { out.failed++; log(`[legis-enrich] ${r.entity} failed (${e && e.message}) — moving on`); }
  }
  out.remaining = todo.length - out.done - out.failed;
  return out;
}

/**
 * acquire({states, query, dispatch, insertDocument, findExisting, landRows, hasRowsFor, now, log})
 * → { landed, skipped, rows }.
 * dispatch = the suit's Echo dispatch (legiscan_search is a READ tool — never tier-blocked, never
 * quota-deferred: this runs inside a user-ordered turn). Fail-soft: any per-state failure moves on.
 * P2: `landRows(rowArray)` lands the SAME results as dataset rows under the project; when the
 * day's sheet already exists but the project holds no rows for the state (the first post-P2 run),
 * the search still runs for ROWS ONLY — a skipped sheet must never mean a starved dataset.
 */
async function acquire({ states = [], query = '', queries = null, dispatch, insertDocument, findExisting = () => false, landRows = null, hasRowsFor = () => true, now = Date.now(), log = () => {} } = {}) {
  const out = { landed: 0, skipped: 0, rows: 0 };
  const qList = (Array.isArray(queries) && queries.length ? queries : (query ? [query] : [])).slice(0, 3);
  if (!states.length || !qList.length || typeof dispatch !== 'function' || typeof insertDocument !== 'function') return out;
  const dateStr = new Date(now).toISOString().slice(0, 10);
  for (const state of states) {
    for (const q of qList) {
      const ref = `legiscan-search:${state.toLowerCase()}:${q.replace(/\s+/g, '-')}:${dateStr}`;
      try {
        const sheetHeld = findExisting(ref);
        if (sheetHeld && (!landRows || hasRowsFor(state, q))) { out.skipped++; continue; }   // sheet AND rows already held
        const r = await dispatch({ kind: 'do', name: 'legiscan_search', args: { state, query: q } });
        if (!r || !r.ok || !r.text) continue;
        let j = null; try { j = JSON.parse(r.text); } catch { continue; }
        const results = Array.isArray(j.results) ? j.results : [];
        if (!results.length) continue;                              // an honest empty is not a sheet
        if (typeof landRows === 'function') {
          try { const rows = resultsToRows({ state, query: q, results }); landRows(rows); out.rows += rows.length; } catch (e) { log(`[legis-acquire] ${state} row landing failed (${e && e.message}) — sheet path continues`); }
        }
        if (sheetHeld) { out.skipped++; continue; }                  // rows refreshed; today's sheet stands
        const id = insertDocument({
          title: `LegiScan sweep — ${q} bills: ${state} (${dateStr})`,
          body: sheetBody({ state, query: q, results, total: j.total_results, dateStr }),
          source: 'legislation', ref,
          understanding: `Live LegiScan search results for "${q}" legislation in ${state} — bill numbers, statuses, dates, source URLs.`,
          origin: `https://legiscan.com/${state}`,
        });
        if (id != null) { out.landed++; log(`[legis-acquire] ${state} "${q}": ${results.length} bill(s) → sheet landed`); }
      } catch (e) { log(`[legis-acquire] ${state} "${q}" failed (${e && e.message}) — moving on`); }
    }
  }
  return out;
}

module.exports = { detect, acquire, sheetBody, resultsToRows, billToAttrs, enrich, STATUS_MAP, STATE_CODES };
