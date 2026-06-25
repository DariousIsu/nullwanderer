/**
 * Offline smoke for the Legislation view model (studio/leg_view.js): pure mappers over the REAL
 * bill tool shapes captured live (2026-06-25).
 *
 * Run: node scripts/smoke_leg_view.js
 */
const LV = require('../studio/leg_view');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const FACETS = {
  state: [{ value: 'IL', count: 184163 }, { value: 'NY', count: 120217 }],
  session: [{ value: '2017-2018', count: 61722 }, { value: '194th', count: 17445 }],
  bill_type: [{ value: 'HB', count: 449457 }, { value: 'SB', count: 306777 }, { value: 'A', count: 85924 }],
  chamber_origin: [{ value: 'house', count: 576082 }, { value: 'senate', count: 384948 }, { value: 'joint', count: 30957 }],
  year: [{ value: 2025, count: 127836 }, { value: 2023, count: 127382 }],
};
const LIST = { rows: [
  { bill_id: 1047622, name: 'A 100 (NY, 2025-2026)', state: 'NY', session: '2025-2026', bill_type: 'A', bill_number: '100', chamber_origin: null, introduced_year: 2025, sponsor_count: 1, yea_count: 0, nay_count: 0, related_count: 4, summary_snippet: 'Requires electronic cigarette packaging to include a warning that the product may pose an explosion hazard — Requires electronic cigarette packaging to include a warning…' },
  { bill_id: 1051421, name: 'A 1000 (NY, 2025-2026)', state: 'NY', session: '2025-2026', bill_type: 'A', bill_number: '1000', chamber_origin: null, introduced_year: 2025, sponsor_count: 5, yea_count: 0, nay_count: 0, related_count: 10, summary_snippet: 'Relates to split shifts and minimum wage — Authorizes minimum wage…' },
], total: 120217, has_more: true };
const SEARCH = { result: [
  { bill_id: 947836, name: 'S 8666 (NY, 2017-2018)', state: 'NY', session: '2017-2018', bill_type: 'S', bill_number: '8666', introduced_year: 2017, sponsor_count: 0, yea_count: 0, nay_count: 0, related_count: 0, summary_match: 'Establishes licensing requirements for <mark>energy</mark> aggregators — Establishes licensing requirements…', rank: -8.16 },
] };
const BILL = {
  bill_id: 947836, name: 'S 8666 (NY, 2017-2018)', state: 'NY', session: '2017-2018', bill_type: 'S', bill_number: '8666',
  chamber_origin: null, ocd_bill_id: 'ocd-bill/42dd', introduced_year: 2017, sponsor_count: 0, yea_count: 0, nay_count: 0, related_count: 0,
  summary_full: 'Establishes licensing requirements for energy aggregators, energy brokers and energy consultants — Establishes licensing requirements … without a license.',
  RelatedLists: { sponsors: [{ person_entity_id: 1031485, sponsor_name: 'Joseph A. Griffo (NY)', confidence: 0.85, contact_id: null, Party__c: null, Chamber__c: null }], votes_yea: [], votes_nay: [], related_bills: [] },
};

// --- facets ---
{
  const g = LV.facetGroups(FACETS);
  ok('facets: groups state/session/type/chamber/year', g.map(x => x.key).join(',') === 'state,session,bill_type,chamber_origin,year');
  ok('facets: type label maps HB', g[2].options[0].label === 'House Bill' && g[2].options[0].value === 'HB');
  ok('facets: chamber humanized', g[3].options[0].label === 'House');
  ok('facets: raw session value kept', g[1].options[1].value === '194th');
  ok('facets: counts carried', g[0].options[0].count === 184163);
}

// --- list ---
{
  const l = LV.billList(LIST);
  ok('list: total + hasMore', l.total === 120217 && l.hasMore === true);
  ok('list: offset advances by page size', l.offset === 2);
  ok('list: row mapped', l.items[0].id === 1047622 && l.items[0].name === 'A 100 (NY, 2025-2026)');
  ok('list: lead summary (drops the " — " tail)', l.items[0].summary === 'Requires electronic cigarette packaging to include a warning that the product may pose an explosion hazard');
  ok('list: counts mapped', l.items[1].sponsors === 5 && l.items[1].related === 10);
  ok('list: type label', l.items[0].typeLabel === 'Assembly');
}

// --- search ---
{
  const s = LV.searchList(SEARCH);
  ok('search: item mapped', s.items.length === 1 && s.items[0].id === 947836);
  ok('search: summary de-marked + lead', s.items[0].summary === 'Establishes licensing requirements for energy aggregators');
}

// --- bill card ---
{
  const c = LV.billCard(BILL);
  ok('card: scalars', c.id === 947836 && c.state === 'NY' && c.session === '2017-2018' && c.type === 'S');
  ok('card: full summary kept', /without a license/.test(c.summary));
  ok('card: sponsor mapped', c.sponsors.length === 1 && c.sponsors[0].name === 'Joseph A. Griffo (NY)');
  ok('card: sponsor not linked when contact_id null', c.sponsors[0].linked === false && c.sponsors[0].confidence === 0.85);
  ok('card: empty votes/related → empty arrays', c.votesYea.length === 0 && c.related.length === 0);
  ok('card: counts block', c.counts.sponsors === 1 && c.counts.yea === 0);
  ok('card: null bill → null', LV.billCard(null) === null);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
