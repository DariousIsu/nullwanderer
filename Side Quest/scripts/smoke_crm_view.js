/**
 * Offline smoke for the CRM view model (studio/crm_view.js): pure mappers over the REAL contact
 * tool shapes captured live (2026-06-25).
 *
 * Run: node scripts/smoke_crm_view.js
 */
const CV = require('../studio/crm_view');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const FACETS = {
  state: [{ value: 'US', count: 13989 }, { value: 'WI', count: 4011 }, { value: '', count: 1 }],
  party: [{ value: 'R', count: 22860 }, { value: 'D', count: 19932 }, { value: 'WHIG', count: 562 }, { value: 'I', count: 329 }],
  chamber: [{ value: 'State_House', count: 26624 }, { value: 'US_House', count: 25267 }, { value: 'US_Senate', count: 5087 }],
  tier: [{ value: 'Tier 3', count: 294 }, { value: 'Tier 1', count: 96 }],
  engagement: [{ value: 'Cold', count: 90405 }],
};
const COMPACT = {
  total: 110319,
  sample_columns: ['id', 'FirstName', 'LastName', 'MailingState', 'Chamber__c', 'District__c', 'Party__c'],
  sample: [
    [73457, 'Elizabeth', '"Beth" McCann', 'CO', 'State_House', null, 'D'],
    [6159, 'John', '"Big John" Illg , Jr.', 'LA', 'State_House', 'LA-78', 'R'],
    [5087, 'Jane', 'Doe', 'US', 'US_Senate', null, 'I'],
  ],
  cursor: 'CURSOR123',
};
const SEARCH = { result: [
  { id: 26338, FirstName: 'Roby', LastName: 'Smith', Title: 'Treasurer', Party__c: 'R', MailingState: 'IA', Chamber__c: 'State_Treasurer', District__c: 'IA', name_snippet: 'Roby <mark>Smith</mark>', notes_snippet: '' },
] };
const PAGE = { csv: 'id,FirstName,LastName,MailingState,Chamber__c,District__c,Party__c\n6180,Michael,"Fesi, Jr.",LA,State_Senate,LA-20,R\n71504,Thurman,Bartie,,Mayor,,', next_cursor: 'CURSOR456' };
const CONTACT = {
  id: 26338, FirstName: 'Roby', LastName: 'Smith', Title: 'Treasurer', Party__c: 'R', MailingState: 'IA',
  Chamber__c: 'State_Treasurer', Jurisdiction__c: 'IA', District__c: 'IA', Contact_Kind__c: 'elected',
  Email: 'roby.smith@legis.iowa.gov', Phone: '563-386-0179', Active_Elected__c: 1,
  Bioguide_Id__c: null, OCD_Person_Id__c: 'ocd-person/a6a6bf4e', Account: null,
  RelatedLists: { committee_memberships: [{}, {}], vote_records: [{}], donations_received: [], known_associates_a: [{}], known_associates_b: [{}], statements: [] },
};

// --- facets ---
{
  const g = CV.facetGroups(FACETS);
  ok('facets: groups for party/chamber/state/tier', g.map(x => x.key).join(',') === 'party,chamber,state,tier');
  ok('facets: party labels resolved', g[0].options[0].label === 'Republican' && g[0].options.find(o => o.value === 'WHIG').label === 'Whig');
  ok('facets: chamber humanized', g[1].options[0].label === 'State House');
  ok('facets: empty state value dropped', !g[2].options.some(o => o.value === ''));
  ok('facets: counts carried', g[0].options[0].count === 22860);
}

// --- browse list ---
{
  const b = CV.browseList(COMPACT);
  ok('browse: total', b.total === 110319);
  ok('browse: items mapped from sample', b.items.length === 3 && b.items[0].id === 73457);
  ok('browse: name assembled (keeps quoted nickname)', b.items[0].name === 'Elizabeth "Beth" McCann');
  ok('browse: party + chamber labels', b.items[2].partyLabel === 'Independent' && b.items[2].chamberLabel === 'US Senate');
  ok('browse: cursor carried', b.cursor === 'CURSOR123');
}

// --- search list ---
{
  const s = CV.searchList(SEARCH);
  ok('search: item mapped', s.items.length === 1 && s.items[0].id === 26338);
  ok('search: name + title', s.items[0].name === 'Roby Smith' && s.items[0].title === 'Treasurer');
  ok('search: party label', s.items[0].partyLabel === 'Republican');
}

// --- CSV pagination (quote-aware) ---
{
  ok('csvSplit: respects quotes around commas', JSON.stringify(CV.csvSplit('1,John,"Smith, Jr.",LA')) === JSON.stringify(['1', 'John', 'Smith, Jr.', 'LA']));
  ok('csvSplit: RFC doubled-quote escape', JSON.stringify(CV.csvSplit('"a""b",c')) === JSON.stringify(['a"b', 'c']));
  const pg = CV.pageRows(PAGE);
  ok('page: rows parsed past header', pg.items.length === 2 && pg.items[0].id === '6180');
  ok('page: comma-in-quoted-field preserved', pg.items[0].name === 'Michael Fesi, Jr.');
  ok('page: empty cells tolerated', pg.items[1].state === '' && pg.items[1].chamberLabel === 'Mayor');
  ok('page: next cursor carried', pg.cursor === 'CURSOR456');
}

// --- contact card ---
{
  const c = CV.contactCard(CONTACT);
  ok('card: scalars', c.name === 'Roby Smith' && c.title === 'Treasurer' && c.partyLabel === 'Republican' && c.chamberLabel === 'State Treasurer');
  ok('card: contact channels', c.email === 'roby.smith@legis.iowa.gov' && c.phone === '563-386-0179');
  ok('card: activeElected flag', c.activeElected === true);
  ok('card: related lists = only non-empty, with counts', c.related.some(r => r.label === 'Committees' && r.count === 2) && c.related.some(r => r.label === 'Votes' && r.count === 1));
  ok('card: empty related dropped', !c.related.some(r => r.label === 'Donations received' || r.label === 'Statements'));
  ok('card: known_associates buckets merged', c.related.find(r => r.label === 'Associates').count === 2);
  ok('card: null contact → null', CV.contactCard(null) === null);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
