/**
 * lib/contacts_query.js — recognize a "give me the contacts we HAVE" request and turn our held contacts
 * (the Puller's discovered contacts + the CRM) into a list, instead of launching a research run.
 *
 * The bug this fixes: "cleanest energy industry contacts — names, emails, companies" tripped the
 * assignment/discover signal → the turn-router routed it to `task` → a research focus spun up. But we
 * already HOLD thousands of those contacts; the ask was to LIST them, not research them. This is the pure
 * brain of a new `contacts` route: detect the intent + the sector/company filter, and select/format the
 * rows the caller pulled from the store. No I/O (the Puller/CRM query + the canvas emit live in main.js).
 */
'use strict';

// "targets"/"names"/"orgs" are contact-list nouns too — the Puller calls its held contacts "targets",
// and "a list of 100 high-confidence targets" is a list-what-we-hold ask, not a research assignment.
const CONTACT_NOUN = /\b(contacts?|people|persons?|e-?mails?|roster|leads?|directory|rolodex|targets?|names|orgs?|organi[sz]ations?)\b/i;
// list-INTENT = a verb that asks for our held contacts OR a container noun (a sheet/spreadsheet/table/roster
// of contacts is a list request whatever the verb — "create a sheet", "draw up a roster", "export a csv").
const LIST_INTENT = /\b(list(?:ing)?|give|show|pull|get|compile|export|send|grab|fetch|need|want|hand|build|assemble|create|produce|generate|prepare|draw up|put together|whip up|throw together|write up|spreadsheet|sheet|table|roster|directory|rolodex|csv|who (?:do we have|are|'?s))\b/i;
// A phrasing that is clearly RESEARCH ("find NEW", "go discover", "research"), not a list-what-we-have.
const RESEARCH_INTENT = /\b(research|find (?:new|more)|discover|dig up|go get new|source new|build a (?:new )?list from scratch)\b/i;
// POSSESSION / COUNT — "how many … do we have", "do we have emails for …", "what contacts do we have".
//
// LIST_INTENT is a bank of ACTION VERBS (list/give/show/pull/export…), so it recognises "fetch me the
// contacts" and misses "do we have any". Those are the same question about the same data, and the
// miss is not silent: on 2026-07-20 Lucas asked "how many email contacts do we have for Louisiana
// Perish leadership?" four times and got
//
//   "I checked our records and searched, but I haven't been able to pin down the specific email
//    contacts for the Louisiana Parish leadership just yet."
//
// while holding 42 of them (doc_contacts, state='LA'). The contacts route never fired, so nothing
// ever looked — and the fallback claimed it had. A false negative wearing a verification claim is
// worse than no answer, because it closes the question.
//
// Same shape as the coverage-question gap: the detector covered being TOLD TO DO something and
// missed being ASKED WHAT SHE HAS.
const COUNT_INTENT = /\b(how many|how much|number of|count of|do we (?:have|hold|got)|have we got|d'?you have|do you have|what .{0,30}(?:do|have) we (?:have|hold|got)|any\s+(?:contacts?|e-?mails?|people|names))\b/i;

// COVERAGE / PROGRESS — "have you finished collecting X", "are we done gathering X", "status of the X
// collection", "did you get all the X". A question about HOW COMPLETE our held set is — the same data as a
// COUNT, answered with a number/coverage, not a research run. This phrasing was the live 2026-07-25 miss:
// "have you finished collecting the contact information for every Louisiana official?" matched neither
// LIST nor COUNT, so it fell to the ENTITY RESOLVER, which minted the plural "officials in Louisiana" as
// ONE phantom person, found no such individual, marked it a GAP, and the anti-confab rail made her report
// ZERO while holding 1,426 CRM + 603 Puller-with-email Louisiana contacts.
const COVERAGE_INTENT = /\b(?:(?:finish|done|complet|wrap|through)\w*\s+(?:with\s+)?(?:collect|gather|compil|pull|assembl|build)|(?:collect|gather|compil|assembl)(?:ed|ing)|status\b[^?.!]{0,30}\b(?:collect|contact|roster|list|officials?)|how (?:far along|much progress)|got\s+(?:all|every|the (?:full|complete))|have\s+(?:all|every|the (?:full|complete))\b|are we (?:done|finished)|is\b[^?.!]{0,30}\b(?:list|collection|roster) (?:done|finished|complete))/i;

// Sector filters — reuse the operator's prospecting sectors. Each maps a request keyword → a company-name
// matcher, so "energy contacts" filters to energy-industry companies we hold.
const SECTORS = {
  energy: /\b(energy|power|electric(?:al|ity)?|utilit|grid|nuclear|renewabl|solar|wind|hydro|geothermal|\bgas\b|turbine|transmission|pipeline|nextera|duke energy|exelon|constellation|vistra|dominion|southern co|\baep\b|\bfpl\b|exxon|chevron|conocophillips|\bbp\b|shell|halliburton|schlumberger)\b/i,
  // known AI/cloud/datacenter company NAMES too — the names don't carry the sector keyword.
  ai: /\b(a\.?i\.?|artificial intelligence|machine (?:learning|intelligence)|\bml\b|openai|anthropic|deepmind|cohere|mistral|hugging ?face|scale ai|databricks|\bmiri\b|inflection|stability ai|character\.?ai|xai\b)\b/i,
  datacenter: /\b(data ?cent(?:er|re)|cloud|hyperscal|equinix|digital realty|coreweave|crusoe|switch inc|vantage|\bqts\b|cyrusone|\baws\b|\bgcp\b|azure)\b/i,
  tech: /\b(tech(?:nolog(?:y|ies))?|software|hardware|semiconductor|\bchip(?:s|maker)?\b|\bgpu\b|electronics|computing|\bsaas\b|\bit\b services|meta\b|facebook|apple\b|microsoft|google|alphabet|oracle|salesforce|adobe|cisco|\bdell\b|\bhp\b|nvidia|intel\b|\bibm\b|red hat|\bsap\b|vmware|qualcomm|broadcom|\bamd\b|palantir|snowflake|workday|servicenow)\b/i,
  manufacturing: /\b(manufactur\w*|industrial|factory|machinery|automotive|steel|chemical|materials|foundry|fabricat\w*|dupont|\b3m\b|honeywell|caterpillar|deere|\bge\b|general electric|siemens|emerson|rockwell|parker hannifin|illinois tool)\b/i,
  defense: /\b(defense|defence|aerospace|lockheed|raytheon|\brtx\b|northrop|grumman|boeing|general dynamics|\bbae\b|l3\s?harris|leidos|palantir|anduril|military|munitions|missile|armament|sikorsky|\bsaic\b|booz allen|\bcaci\b)\b/i,
  infrastructure: /\b(infrastructure|construction|\bengineering\b|utilit(?:y|ies)|transport\w*|railway|railroad|highway|\bport\b|pipeline|logistics|bechtel|fluor|aecom|jacobs|kiewit|vinci|\bcsx\b|union pacific)\b/i,
  internet: /\b(internet service|broadband|\bisp\b|fiber optic|telecom\w*|verizon|comcast|at\s?&\s?t|at&t|t-?mobile|charter communications|spectrum|\blumen\b|cox communications|frontier communications|\bviasat\b|starlink|\bcenturylink\b)\b/i,
  transition: /\b(transition|decarbon|clean energy|net.?zero|emission|climate tech)\b/i,
  weather: /\b(weather|climate|meteorolog|forecast)\b/i,
  // think tanks / policy shops / private (non-government) orgs. One regex serves both roles: it matches
  // the request phrasing ("think tanks", "private organizations") AND the org NAMES we hold (Brookings,
  // R Street, "Center for …", foundations, institutes) so select() can filter held contacts by it.
  thinktank: /\b(think.?tanks?|policy (?:institute|shop|org|center)|non.?profit|private organi[sz]ations?|foundation|institute|council|center for|brookings|heritage|cato|niskanen|rainey|american enterprise|\baei\b|urban institute|r street|manhattan institute|hoover|carnegie|hudson institute|new america|third way)\b/i,
};
// Prettier display names for sectors whose key isn't the phrase we'd show the operator.
const SECTOR_LABELS = { thinktank: 'think tank', ai: 'AI' };

const _norm = (s) => String(s == null ? '' : s).toLowerCase();
// A malformed extraction where the name collapsed to bare initials ("P. C. V. C.", "A. G.") — every token
// a single letter. These pattern-fill to high confidence and would otherwise top a "highest confidence"
// list, so they're dropped as unusable contacts.
function isInitialsOnly(name) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every((t) => /^[A-Za-z]\.?$/.test(t));
}

// Which sectors did the request mention? [] = no sector filter (all held contacts).
function sectorsFrom(message) {
  const m = String(message || '');
  const out = [];
  for (const [name, re] of Object.entries(SECTORS)) if (re.test(m)) out.push(name);
  return out;
}
// US state names → 2-letter (abbrevs are skipped: IN/OR/OK/ME etc. false-positive on prose). Used by both
// stateFrom (the state filter) and companyFrom (so "in Louisiana" isn't mistaken for a company).
const _STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };

// "contacts at <Company>" / "from <Company>" / "for <Company>" → the company filter, else null. Skips a
// captured token that is actually a US STATE ("in Louisiana" is a state filter, not a company) — otherwise
// "grade B elected officials in Louisiana" would set company="Louisiana" AND state=LA (the double-match bug).
function companyFrom(message) {
  const re = /\b(?:at|from|for|with|in)\s+([A-Z][A-Za-z0-9&.\- ]{2,40})/g;
  let m;
  while ((m = re.exec(String(message || ''))) !== null) {
    let cand = m[1].replace(/\b(the|contacts?|people|list|our|their)\b/gi, '').replace(/\s+/g, ' ').trim();
    // the greedy capture can swallow a trailing "… in Texas" / "… from X" — cut at the next connective.
    cand = cand.replace(/\s+(?:in|at|from|for|with)\s+.*$/i, '').trim();
    // …and a trailing question filler ("in Louisiana YET", "for Texas NOW/PLEASE/ALREADY"), which otherwise
    // made "Louisiana yet" a bogus company filter that zeroed a valid state query (live 2026-07-26).
    cand = cand.replace(/\b(yet|now|today|please|already|still|too|also|then|there)\b\s*$/gi, '').trim();
    if (cand && !_STATES[cand.toLowerCase()]) return cand;
  }
  return null;
}

// "who do we have / who are our [people] at <X>" — a contact ask with no explicit noun.
const WHO_HAVE = /\bwho\s+(?:do we have|are (?:our|we|the)|'?s (?:our|on))\b/i;
// A requested count ("100 highest confidence contacts", "top 50", "the 25 best") → the limit, else null.
function countFrom(message) {
  const m = /\b(?:top|first|best|give me|list|our|the)?\s*(\d{1,4})\b/i.exec(String(message || ''));
  const n = m ? parseInt(m[1], 10) : null;
  return (n && n >= 1 && n <= 5000) ? n : null;
}
// FIELD-PRESENCE filters — "contacts WITH A PHONE NUMBER" / "with emails". The 08-08 census repro'd
// Lucas's graded fail: "How many contacts do we hold with a phone number in Louisiana?" answered with
// the total + email count because PHONE was representable nowhere in the ask shape — the door can only
// answer questions its schema can carry. CRM columns: Phone (34.8k filled) + MobilePhone.
function hasPhoneFrom(message) {
  return /\b(?:with|have|has|having|carry(?:ing)?|hold(?:ing)?|includ\w+)\s+(?:a\s+)?(?:phone|mobile|cell)(?:\s*(?:numbers?|#s?))?\b|\b(?:phone|mobile|cell)\s*numbers?\b/i.test(String(message || ''));
}
function hasEmailFrom(message) {
  return /\b(?:with|have|has|having|carry(?:ing)?|hold(?:ing)?|includ\w+)\s+(?:an?\s+)?e-?mails?(?:\s+address(?:es)?)?\b|\be-?mail address(?:es)?\b/i.test(String(message || ''));
}

// PARTY → the canonical code the CRM stores (Party_Canonical: 'R'/'D'). null = no party filter.
function partyFrom(message) {
  const m = String(message || '');
  if (/\b(republicans?|gop|conservatives?)\b/i.test(m)) return 'R';
  if (/\b(democrats?|democratic|dnc)\b/i.test(m)) return 'D';
  return null;
}
// GOVERNMENT LEVEL → 'state' | 'federal' | 'local' | null, mapped to Office_Role_Canonical families
// (grounded in the real vocabulary: state_*/governor; us_*/fed_*; county_commission/city_council).
function levelFrom(message) {
  const m = String(message || '');
  if (/\b(federal|congress(?:ional)?|u\.?s\.?\s+(?:rep(?:resentative)?|senator|house|senate|congress)|capitol hill)\b/i.test(m)) return 'federal';
  if (/\b(state[-\s]?level|state (?:official\w*|legislat\w*|rep\w*|senators?|house|senate|assembly)|in the (?:state )?legislature)\b/i.test(m)) return 'state';
  if (/\b(local|municipal|county|parish|city council|alderman|councilmember)\b/i.test(m)) return 'local';
  return null;
}
const _LEVEL_SQL = {
  state: "(c.Office_Role_Canonical LIKE 'state\\_%' ESCAPE '\\' OR c.Office_Role_Canonical IN ('governor','lt_governor'))",
  federal: "(c.Office_Role_Canonical LIKE 'us\\_%' ESCAPE '\\' OR c.Office_Role_Canonical LIKE 'fed\\_%' ESCAPE '\\')",
  // LOCAL: role-coding for local government is almost entirely absent (county_commission=3, city_council=2),
  // so parish/county bodies are reachable ONLY by ACCOUNT NAME — 788 contacts carry "Parish" in the account
  // with no role code (the Richland Parish miss). Match role codes OR the parish/county account.
  local: "(c.Office_Role_Canonical IN ('county_commission','city_council','dc_council','parish_local') OR LOWER(a.Name) LIKE '%parish%' OR LOWER(a.Name) LIKE '%county%')",
};
// Escape a value for a LIKE literal: backslash the LIKE metacharacters and double single-quotes (injection-safe).
function _likeSafe(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\\%_]/g, (x) => '\\' + x).replace(/'/g, "''").trim(); }

// THE ACCURATE COVERAGE COUNT. A DIRECT COUNT over electoral.contact (LEFT JOIN account) honoring the parsed
// filters, so "how many republican state officials in LA" returns the REAL number — not the emailed-gather
// subset (203 vs a true 1,410). Returns { applies, sql, filters }; applies=false for CORPORATE asks (those
// live in the Puller, not this civic CRM) so the caller falls back to the gather. Injection-safe: validated
// codes inlined; account-name matches escaped. A NAMED ORG / parish ("Richland Parish", company='parish') is
// reached by account name and is the GEOGRAPHIC ANCHOR — parish contacts are frequently stateless, so a
// strict state filter would drop them (why "we don't have anything for that Parish" was false).
function buildCoverageCountSql(ask = {}) {
  if (ask.type === 'corporate') return { applies: false };   // corporate contacts aren't in electoral.contact
  // HONESTY GUARD (2026-07-29): any parsed filter this COUNT cannot honor → applies:false, so the
  // caller stays on the gather path (which honors grade + sectors). Without this, "how many energy
  // contacts?" relayed the count of the ENTIRE CRM number-first. Slow-and-honest beats fast-and-wrong.
  if (ask.grade || (Array.isArray(ask.sectors) && ask.sectors.length)) return { applies: false };
  const w = ['c.deleted=0'];
  const filters = [];
  const comp = ask.company ? _likeSafe(ask.company) : '';
  const st = ask.state && /^[A-Za-z]{2}$/.test(String(ask.state)) ? String(ask.state).toUpperCase() : null;
  if (comp) {
    w.push(`LOWER(a.Name) LIKE '%${comp}%' ESCAPE '\\'`); filters.push(String(ask.company));
    // The named org/parish stays the GEOGRAPHIC ANCHOR (parish rows are frequently stateless), but a
    // state named ALONGSIDE it still gates: a row that CARRIES a state must match it; only stateless
    // rows ride the anchor. "Jefferson Parish in Louisiana" no longer counts other states' parishes.
    if (st) {
      w.push(`(UPPER(TRIM(COALESCE(c.State_Represented,'')))='${st}' OR UPPER(TRIM(COALESCE(c.MailingState,'')))='${st}' OR ((c.State_Represented IS NULL OR TRIM(c.State_Represented)='') AND (c.MailingState IS NULL OR TRIM(c.MailingState)='')))`);
      filters.push(st);
    }
  }
  else if (st) { w.push(`(UPPER(TRIM(c.State_Represented))='${st}' OR UPPER(TRIM(c.MailingState))='${st}')`); filters.push(st); }
  const party = (ask.party === 'R' || ask.party === 'D') ? ask.party : null;
  if (party) { w.push(`UPPER(TRIM(c.Party_Canonical))='${party}'`); filters.push(party === 'R' ? 'Republican' : 'Democrat'); }
  if (_LEVEL_SQL[ask.level]) { w.push(_LEVEL_SQL[ask.level]); filters.push(ask.level === 'local' ? 'local/parish' : `${ask.level}-level`); }
  if (ask.type === 'elected') { w.push("(c.Contact_Kind__c='elected' OR c.Active_Elected__c=1)"); filters.push('elected'); }
  const where = w.join(' AND ');
  const sql = `SELECT COUNT(*) AS total, `
    + `SUM(CASE WHEN c.Email IS NOT NULL AND TRIM(c.Email)<>'' THEN 1 ELSE 0 END) AS with_email, `
    + `SUM(CASE WHEN (c.Phone IS NOT NULL AND TRIM(c.Phone)<>'') OR (c.MobilePhone IS NOT NULL AND TRIM(c.MobilePhone)<>'') THEN 1 ELSE 0 END) AS with_phone, `
    + `SUM(CASE WHEN (c.State_Represented IS NULL OR TRIM(c.State_Represented)='') AND (c.MailingState IS NULL OR TRIM(c.MailingState)='') THEN 1 ELSE 0 END) AS no_location `
    + `FROM electoral.contact c LEFT JOIN electoral.account a ON a.id=c.AccountId WHERE ${where}`;
  return { applies: true, sql, filters };
}

// Detect a list-the-contacts-we-hold request. Returns { isQuery, sectors, company, limit }.
function detect(message) {
  const m = String(message == null ? '' : message);
  // a TYPE word ("elected officials", "corporate", "legislators") is itself a contact-list noun in this
  // domain — "give me grade B elected officials in LA" has no bare "contacts"/"people" noun but is clearly
  // a list ask. Still gated by LIST_INTENT below, so a non-list mention ("the government shut down") is out.
  const nounish = CONTACT_NOUN.test(m) || (WHO_HAVE.test(m) && /\bat\b/i.test(m)) || !!typeFrom(m);
  if (!nounish) return { isQuery: false };
  // RESEARCH vs LIST-WHAT-WE-HAVE: a research phrasing ("research / from scratch / find new") is a research
  // run UNLESS the turn also carries a HELD signal ("the contacts we have / already hold / in our records").
  // Keys on HELD, not on list-words, because "build a NEW list from scratch" contains the word "list" yet is
  // research — while "build a sheet with all the Contacts we HAVE generated" is a list of what we hold.
  const HELD = /\b(we (?:have|hold|already have|generated|got|pulled|already got)|we'?ve (?:got|generated|pulled)|(?:our|the) (?:existing|current|held)|on hand|in (?:our|the) (?:records|database|crm|files)|that we (?:have|hold))\b/i;
  if (RESEARCH_INTENT.test(m) && !HELD.test(m)) return { isQuery: false };   // research NEW (not about what we hold) → not a list
  const counting = COUNT_INTENT.test(m) || COVERAGE_INTENT.test(m);          // a coverage/progress ask counts as a count
  if (!LIST_INTENT.test(m) && !WHO_HAVE.test(m) && !counting) return { isQuery: false };
  const g = gradeFrom(m);
  // PARISH — Louisiana's county-equivalent. "parish"/"parishes" is an ORG filter: every LA parish
  // government account carries "Parish" in its name, and select() matches `company` as a substring of
  // the account name, so company='parish' narrows to parish-affiliated contacts. Without this,
  // "Louisiana parish contacts" set only state=LA and returned the ENTIRE Louisiana book (the
  // precision miss diagnosed 2026-07-27). A specifically-named company ("at Cameron Parish") still
  // wins — this only fills in when no explicit company was extracted.
  const parishFilter = /\bparish(?:es)?\b/i.test(m) ? 'parish' : null;
  return { isQuery: true, sectors: sectorsFrom(m), company: companyFrom(m) || parishFilter, limit: countFrom(m),
           grade: g ? g.grade : null, gradeDir: g ? g.dir : 'gte', type: typeFrom(m), state: stateFrom(m),
           party: partyFrom(m), level: levelFrom(m),
           hasPhone: hasPhoneFrom(m), hasEmail: hasEmailFrom(m),
           // "How many do we have?" wants a NUMBER, not 200 rows. Only when there is no retrieval verb
           // alongside it — "list how many we have" is still a list ask.
           countOnly: counting && !LIST_INTENT.test(m) };
}

// GRADE — the A–E confidence ladder (mirrors studio/puller_confidence CAP). "c rating or higher" is the
// most common list filter and it IS on every row (the `confidence` field), it just was never used as a
// FILTER (only for sorting). C = 0.80, so "C or higher" = confidence >= 0.80.
const GRADE_CAP = { A: 1.00, B: 0.95, C: 0.80, D: 0.50, E: 0.30 };
const _GRADE_ORDER = ['A', 'B', 'C', 'D', 'E'];   // best → worst
const _DIR_LOWER = /\b(?:or\s+)?(?:lower|below|worse|under)\b/i;
function gradeFrom(message) {
  const m = String(message || '');
  const letters = new Set();
  // single: "grade X", or "X rating/rated/graded/level/tier" ("C level", "B rated").
  let mm; const single = /\bgrade\s+([a-e])\b|\b([a-e])[\s-]?(?:rating|rated|graded?|level|tier)\b/gi;
  while ((mm = single.exec(m)) !== null) letters.add((mm[1] || mm[2]).toUpperCase());
  // RANGE/LIST of tiers ("A, B, and C level", "A/B/C", "A-C", "grades A and B") — only when a grade word is
  // present (so a stray "a and b" isn't read as grades). All listed letters count; the floor decides the
  // threshold: "A, B, and C" → C-and-up (gte C); "C or lower" → C-and-down (lte C).
  if (/\b(grade|graded|level|rating|rated|tier)\b/i.test(m)) {
    const listM = m.match(/\b[a-e](?:\s*(?:,|and|or|&|\/|-|through|thru|to)\s*[a-e]\b){1,4}/i);
    if (listM) for (const ch of (listM[0].match(/\b[a-e]\b/gi) || [])) letters.add(ch.toUpperCase());   // STANDALONE letters only (not the a/d inside "and")
  }
  const valid = [...letters].filter((g) => GRADE_CAP[g]).sort((a, b) => _GRADE_ORDER.indexOf(a) - _GRADE_ORDER.indexOf(b));
  if (!valid.length) return null;
  const dir = _DIR_LOWER.test(m) ? 'lte' : 'gte';
  // gte → the floor is the WORST tier listed (A,B,C → C, "at least C"); lte → the ceiling is the BEST listed.
  const grade = dir === 'lte' ? valid[0] : valid[valid.length - 1];
  return { grade, dir };
}

// TYPE — corporate (private-sector) vs elected/government. The right signal is the COMPANY NAME, NOT the
// source: the Puller has DISCOVERED tens of thousands of GOVERNMENT contacts (DC Public Schools, Metro
// Police, State House, "Department of …") right alongside real corporations (Meta, OpenAI, Duke Energy,
// NVIDIA). And most corporate leads are grade-C/D with NO verified email yet (they aren't promoted to the
// CRM), so email/source can't be the key. So: corporate = has a company AND that company is not government.
const _TYPE_CORP = /\b(corporate|corporation|companies|company|commercial|for-?profit|private(?:[\s-]?sector)?|firms?|industry|industries|business(?:es)?)\b/i;
const _TYPE_ELECTED = /\b(elected|officials?|legislators?|lawmakers?|congress(?:ional|m[ae]n|wom[ae]n|member)?|senators?|representatives?|governors?|mayors?|council\s?members?|commissioners?|office\s?holders?)\b/i;
const _TYPE_GOV = /\b(government|govt|agenc(?:y|ies)|federal agenc|municipal|public[\s-]?sector)\b/i;
function typeFrom(message) {
  const m = String(message || '');
  const hasCorp = _TYPE_CORP.test(m);
  const hasElected = _TYPE_ELECTED.test(m);
  const hasGov = _TYPE_GOV.test(m);
  // BOTH sides named ("government and private alike", "public and private", "elected + corporate", "all
  // types") → return null = NO type filter = include EVERYONE. A single side named narrows to it.
  if (/\bpublic and private\b|\bprivate and public\b|\ball (?:types|categories|kinds|sectors)\b/i.test(m)) return null;
  if (hasCorp && (hasElected || hasGov)) return null;
  if (hasElected) return 'elected';   // "elected officials" beats the generic gov/corp words
  if (hasGov) return 'gov';
  if (hasCorp) return 'corporate';
  return null;
}

// GOVERNMENT-company detector (the corporate/gov split). Matches the government patterns that dominate the
// held company names (verified against the Puller's 87k government contacts): departments, public schools,
// police/fire/EMS, bureaus/agencies/offices, state house/senate, city/county/parish/municipal, courts,
// universities, libraries, corrections, public works, etc. Deliberately NOT bare "general"/"national"/
// "federal" (those hit real companies — General Dynamics, National Grid, FedEx). Corporate = a company that
// this does NOT match.
// Plurals matter: the Puller's "Louisiana Assessors' Association" (tax assessors — elected officials)
// leaked into corporate because `assessor` singular didn't match "Assessors". Same for treasurers,
// comptrollers, superintendents, sheriffs. Also added "association of tax/gov" patterns since these are
// professional bodies of elected officials.
const _GOV_COMPANY = /\b(departments?|dept\.?|public schools?|\bpolice\b|\bfire\b|emergency medical|\bems\b|bureaus?|agenc(?:y|ies)|\bagcy\b|office of|\bofc\.?\b|state (?:house|senate|department|of|police|capitol)|state capitol|city of|count(?:y|ies)|\bparish(?:es)?\b|municipal|\blibrary\b|superintendents?|attorney general|public works|human services|corrections|parks (?:and|&) rec|commissions?|authorit(?:y|ies)|board of|sheriffs?|\bcourts?\b|universit(?:y|ies)|\bschools?\b|division of|\bdiv\.?\b|administration|patrol|substitute teacher|comptrollers?|\btreasurers?\b|assessors?|clerk of|town of|village of|borough of|national guard|city council|county council|housing authority|transit authority|water district|school district|\bva\b|veterans affairs|\busda\b|\bepa\b|\bfbi\b|legislature|governor'?s office|mayor'?s office|house of representatives?|senate of|association of (?:tax|counties|schools?|municipalit\w+|clerks?|assessors?|sheriffs?|superintendents?|police|fire chiefs?|prosecut\w+|district attorney|elected|towns?|cities|parishes)|(?:tax|assessor|police|fire|sheriff|clerk)s?['’]?\s+association|minist[eé]rio (?:p[uú]blico|da|do)|procurador\w+|advocacia[\s-]?geral|regi[aã]o|governo (?:federal|do estado|de)|c[aâ]mara (?:dos deputados|municipal)|senado federal|prefeitura|departamento (?:de|federal))\b/i;
function isGovernmentCompany(company) {
  const c = String(company || '').trim();
  return !!c && _GOV_COMPANY.test(c);
}

// NONPROFIT / ADVOCACY / THINK-TANK detector. Rainey Center (Lucas's org — 501c3 think tank), "Citizens
// for X" (political advocacy), community civic orgs, foundations — all showed up as "corporate" because
// they have a .org domain and no gov keyword. They're not for-profit companies; they belong in a separate
// "nonprofit/advocacy" bucket, not the corporate list. Deliberately avoids "coalition" alone (Data Center
// Coalition = valid tech industry lobby), and requires "for" after "citizens/coalition" only when
// political ("Citizens for a New Louisiana"). Foundation is allowed to survive when a real corp name
// precedes it (e.g. "Gates Foundation" — but for now, keep it strict: foundation = nonprofit).
const _NONPROFIT_COMPANY = /\b(citizens for|advocacy|\baction fund\b|action network|501\s?\(?\s?c\s?\)?\s?\(?\s?[0-9]\)?|community (?:action|services|development corp)|leadership \w+|\bthink[\s-]?tank|policy institute|policy center|policy shop|non[\s-]?profits?|charitab\w+|philanthrop\w+|humanitarian|goodwill|salvation army|\byMCA\b|\bYWCA\b|united way|habitat for humanity|red cross|catholic charities|jewish federation|rainey ?center|raineycenter\.org|american enterprise institute|\baei\b|heritage foundation|brookings|cato institute|urban institute|niskanen|r street institute|hoover institution|new america|third way|hudson institute|manhattan institute|foundation(?:s)?|law center|children'?s (?:law|advocacy|welfare|services|home|hospital|defense fund))\b/i;
function isNonprofitCompany(company) {
  const c = String(company || '').trim();
  return !!c && _NONPROFIT_COMPANY.test(c);
}

// DOMAIN classification — the CLEAN corporate/gov signal (verified against the real Puller). A discovered
// corporate contact carries a resolved company `domain` (openai.com / meta.com / duke-energy.com); the DC-
// government scrape that dominates the store (Substitute Teachers, "SHS" schools) has a NULL domain, and
// government orgs that do have one carry a gov TLD (dc.gov / *.gov / legislature.*.gov / .mil / .us). So:
// corporate = a real COMPANY domain; gov = a government domain. domainKind reads the target `domain` first,
// else falls back to the email domain. A null-domain contact is unclassifiable (→ not corporate) — which is
// exactly right, since the null-domain bulk is the government scrape.
const _PERSONAL_MX = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com']);
function _domainOf(emailOrDomain) {
  const s = String(emailOrDomain || '').toLowerCase().trim();
  if (!s) return null;
  const at = s.indexOf('@');
  return (at >= 0 ? s.slice(at + 1) : s).replace(/\s+$/, '') || null;
}
function domainKind(domain) {
  const d = _domainOf(domain);
  if (!d) return null;
  if (/(?:^|\.)gov(?:\.|$)|\.mil(?:\.|$)|gov[a-z]*\.|\.[a-z]{2}\.us$|\.us$/.test(d)) return 'gov';
  if (/\.edu(?:\.|$)/.test(d)) return 'edu';
  if (_PERSONAL_MX.has(d)) return 'personal';
  return 'corporate';
}

function stateFrom(message) {
  const m = String(message || '').toLowerCase();
  for (const [name, ab] of Object.entries(_STATES)) if (new RegExp(`\\b${name}\\b`).test(m)) return ab;
  return null;
}

// Reverse: 'LA' → 'louisiana'. Lets a state-aware contact gather infer a Puller row's state from its org
// name (Puller targets carry no state field), so a state query can reach the parish/municipal contacts.
const _ABBR_TO_NAME = Object.fromEntries(Object.entries(_STATES).map(([n, a]) => [a, n]));
function stateNameOf(abbr) { return _ABBR_TO_NAME[String(abbr || '').toUpperCase()] || null; }

// UNMET-FILTER honesty (now narrow): grade/type/state ARE applied. The one dimension the held data can't
// resolve is COUNTY — there is no county field on the contact rows (state yes, county no). If the request
// asks to narrow by county, the caller discloses it instead of silently ignoring it.
const _COUNTY_RE = /\b([A-Z][a-z]+)\s+count(?:y|ies)\b/;
function unmetFilters(message) {
  const m = String(message == null ? '' : message);
  const unmet = [];
  if (_COUNTY_RE.test(m)) unmet.push('county');
  return unmet;
}

// A company matches the requested sectors if ANY requested sector's matcher hits its name. No sectors → all.
function matchesSectors(company, sectors) {
  if (!sectors || !sectors.length) return true;
  const c = String(company || '');
  return sectors.some((s) => SECTORS[s] && SECTORS[s].test(c));
}

// Select + rank the held contacts for the request. `rows` = [{name, email, phone, company, title}] pulled
// from the Puller/CRM. Filter by sector + company; PREFER rows with an email; dedup by name+company; cap.
// Returns { rows, total, shown, headers }. Pure.
function select(rows, { sectors = [], company = null, limit = 200, grade = null, gradeDir = 'gte', type = null, state = null, hasPhone = false, hasEmail = false } = {}) {
  const comp = company ? _norm(company) : null;
  const minC = grade && GRADE_CAP[grade] != null ? GRADE_CAP[grade] : null;
  const st = state ? String(state).toUpperCase() : null;
  const filtered = [];
  let geoGap = 0;   // rows that match EVERY non-state filter but carry no location → can't be placed in `st`
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const name = String((r && r.name) || '').trim();
    if (name.length < 2 || isInitialsOnly(name)) continue;   // drop malformed initials-only junk
    // FIELD PRESENCE — "with a phone number" / "with emails" narrows to rows that CARRY the field.
    if (hasPhone && !String((r && r.phone) || '').trim()) continue;
    if (hasEmail && !String((r && r.email) || '').trim()) continue;
    const rc = String((r && r.company) || '');
    if (!matchesSectors(rc, sectors)) continue;
    if (comp && !_norm(rc).includes(comp)) continue;
    // GRADE — confidence threshold. "C or higher" (gte) → conf >= 0.80; "or lower" (lte) → conf <= cap.
    if (minC != null) {
      const c = typeof (r && r.confidence) === 'number' ? r.confidence : 0;
      if (gradeDir === 'lte' ? (c > minC + 1e-9) : (c < minC - 1e-9)) continue;
    }
    // TYPE — corporate is now STRICT (Lucas: the list had elected officials, municipal contacts, and all of
    // Rainey leaking in). To be corporate a row must: (1) have a company-shaped domain (dk==='corporate');
    // (2) have a company name that isn't government (assessors/dept/dept-of/schools/etc.); (3) NOT be a
    // nonprofit/advocacy/think-tank (Rainey/Citizens-for/foundation/policy institute); (4) NOT come from the
    // electoral CRM (src!=='crm' — those are inherently civic/political even when a staffer uses a firm .com
    // email). gov = a gov domain / gov company / the electoral CRM; elected = CRM + elected marker.
    const src = r && r.src;
    const dk = domainKind((r && r.domain) || (r && r.email));   // target company domain preferred, else email domain
    const govCo = isGovernmentCompany(rc);
    const nonprofit = isNonprofitCompany(rc);
    if (type === 'corporate' && !(dk === 'corporate' && !govCo && !nonprofit && src !== 'crm')) continue;
    if (type === 'gov' && !(dk === 'gov' || govCo || src === 'crm')) continue;
    if (type === 'elected' && (src !== 'crm' || (('elected' in (r || {})) && r.elected === false))) continue;
    // STATE — match the row's represented/mailing state (civic CRM rows carry it; Puller/corporate rows
    // usually don't). A row that passed EVERY other filter but has NO state is a GEO GAP: it can't be placed
    // in `st`, and that missing-data-point is exactly what should trigger a "want me to find their location?"
    // offer (the "if we're missing data, we find it" loop) rather than being silently dropped.
    if (st) {
      const rowState = String((r && r.state) || '').toUpperCase();
      if (!rowState) { geoGap++; continue; }   // matches everything except it has no location
      if (rowState !== st) continue;            // in a different state — correctly excluded
    }
    filtered.push({
      name,
      email: String((r && r.email) || '').trim() || null,
      phone: String((r && r.phone) || '').trim() || null,
      company: rc.trim() || null,
      title: String((r && r.title) || '').trim() || null,
      confidence: typeof (r && r.confidence) === 'number' ? r.confidence : 0,
    });
  }
  // HIGHEST CONFIDENCE first (the operator's ask), then MOST COMPLETE (most contact fields filled — "the
  // 200 most complete" is a common ask), then emailed contacts, then company.
  const completeness = (r) => (r.email ? 1 : 0) + (r.phone ? 1 : 0) + (r.company ? 1 : 0) + (r.title ? 1 : 0);
  filtered.sort((a, b) => (b.confidence - a.confidence) || (completeness(b) - completeness(a)) || ((b.email ? 1 : 0) - (a.email ? 1 : 0)) || _norm(a.company).localeCompare(_norm(b.company)));
  // DEDUP after sorting (so the BEST row per person wins): collapse same name+company AND same email — the
  // latter catches a person held in BOTH the Puller and the CRM under a different company string (the
  // crm_id-link dedup upstream only catches linked pairs). Different people who share a name survive (they
  // differ by email/company); only true same-person duplicates fold.
  const seenNC = new Set(), seenEmail = new Set(), deduped = [];
  for (const r of filtered) {
    const nc = _norm(r.name) + '|' + _norm(r.company);
    const em = r.email ? _norm(r.email) : null;
    if (seenNC.has(nc)) continue;
    if (em && seenEmail.has(em)) continue;
    seenNC.add(nc); if (em) seenEmail.add(em);
    deduped.push(r);
  }
  const total = deduped.length;
  const shown = deduped.slice(0, Math.max(1, limit || 200));
  // Headers must describe the SIX columns toTable() renders (name, email, company, title, puller
  // confidence, evidence). Returning five here left the final "Evidence" column headerless on the
  // canvas and mislabeled the puller-confidence column as the generic "Confidence".
  return { rows: shown, total, shown: shown.length, withEmail: deduped.filter(r => r.email).length, withPhone: deduped.filter(r => r.phone).length, geoGap, headers: ['Name', 'Email', 'Company', 'Title', 'Puller conf.', 'Evidence'] };
}

// ── EVIDENCE (R1) ────────────────────────────────────────────────────────────────────────────────
//
// Everything built so far made the substrate correct without changing a single answer. This is where
// the encounter log becomes visible: what does the evidence actually say about this contact?
//
// The rule that shapes the format: AN UNGRADED CLAIM MUST READ AS UNGRADED, NEVER AS FACT. A blank
// cell reads as "fine"; an absent row reads as "nothing to say". Both are wrong, and both are worse
// than the truth, which is usually "one document said so and we cannot even prove that document was
// independent". Every state gets words.
//
// `lookup(name)` is injected — the encounter log lives behind db and this module is pure. It returns
// { grade, sources, unproven } or null.
function evidenceCell(ev) {
  if (!ev) return 'not in evidence log';
  if (!ev.grade) return ev.stated ? 'said, not verified' : 'unverified';
  const n = Number(ev.sources) || 0;
  const src = `${n} source${n === 1 ? '' : 's'}`;
  return ev.unproven ? `${ev.grade} · ${src} (unproven)` : `${ev.grade} · ${src}`;
}

// ONE HONEST LINE ABOUT THE WHOLE LIST, for whoever writes the spoken answer.
//
// The evidence reached the canvas and stopped there. A live turn on 2026-07-20:
//
//   Lucas:  "print me a sheet with all the leadership contacts we have emails for in those Parishes"
//   Zoe:    "I've added the 28,721 leadership contacts that include email addresses to your canvas"
//
// The canvas table beneath that sentence said `C · 1 source` on every row and "0 rest on more than one
// independent source" in its caption. The table was honest and the sentence was not, because the voice
// line was written from `total` and `withEmail` — two counts that say how MUCH was found and nothing
// about whether any of it is supported.
//
// So this exists to be handed to the answer-writer, which lives in another context's lane
// (lib/package.js). Returns a string, not a verdict: what to do with it belongs to whoever composes the
// reply. Null when there is no evidence data attached at all, so a caller can tell "nothing to say"
// from "nothing supports this".
function evidenceSummary(sel) {
  const rows = (sel && Array.isArray(sel.rows)) ? sel.rows : [];
  if (!rows.length) return null;
  if (!rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'evidence'))) return null;

  let corroborated = 0, single = 0, unknown = 0;
  for (const r of rows) {
    const ev = r && r.evidence;
    if (!ev) { unknown += 1; continue; }
    if ((Number(ev.sources) || 0) > 1) corroborated += 1; else single += 1;
  }
  const parts = [`${corroborated} of ${rows.length} shown rest on more than one independent source`];
  if (single) parts.push(`${single} on a single source`);
  if (unknown) parts.push(`${unknown} not in the evidence log at all`);
  return parts.join('; ');
}

// Attach the log's verdict to each row. Pure — `lookup` does the I/O.
function withEvidence(rows, lookup) {
  const fn = typeof lookup === 'function' ? lookup : () => null;
  return (Array.isArray(rows) ? rows : []).map((r) => {
    let ev = null;
    try { ev = fn(r && r.name) || null; } catch { ev = null; }
    return { ...r, evidence: ev, evidenceLabel: evidenceCell(ev) };
  });
}

// The canvas TABLE payload (headers + rows) for saga_canvas_add_block block_type='table'. Pure.
function toTable(sel) {
  // Two different measurements sit side by side and must not be mistaken for each other: the Puller's
  // own per-attribute confidence, and what the encounter log can actually support. A contact can read
  // 80% and still be a single unproven document — that gap is the point, so both are named explicitly
  // rather than one being labelled the generic "Confidence".
  const headers = sel.headers || ['Name', 'Email', 'Company', 'Title', 'Puller conf.', 'Evidence'];
  const pct = (c) => (typeof c === 'number' && c > 0) ? `${Math.round(c * 100)}%` : '';
  const rows = (sel.rows || []).map(r => [
    r.name || '', r.email || '', r.company || '', r.title || '', pct(r.confidence),
    r.evidenceLabel || evidenceCell(r.evidence || null),
  ]);
  const shownRows = sel.rows || [];
  // WHICH NUMBER TO PUT IN THE CAPTION, and why not the obvious one.
  //
  // "carries graded evidence" was the first attempt and it reads as reassurance. Checked against the
  // live Louisiana list: every one of the twelve rows had a grade, so the caption said "12 of 12 carry
  // graded evidence" — while every single row was `C · 1 source`. Technically true, and it implies the
  // opposite of what the data says.
  //
  // The number that means something is CORROBORATION: how many rest on more than one independent
  // source. For most of this corpus the honest answer is zero, and the caption should say zero.
  const corroborated = shownRows.filter((r) => r.evidence && (Number(r.evidence.sources) || 0) > 1).length;
  const head = sel.total > sel.shown ? `${sel.shown} of ${sel.total} contacts` : `${sel.total} contacts`;
  const caption = `${head} (${sel.withEmail} with email) — ${corroborated} of ${shownRows.length} shown rest on more than one independent source`;
  return { headers, rows, caption };
}

// A short human title for the canvas tab + the chat line, from the request's sectors/company.
const TYPE_LABELS = { corporate: 'corporate', elected: 'elected-official', gov: 'government' };
function label({ sectors = [], company = null, grade = null, gradeDir = 'gte', type = null, state = null, hasPhone = false, hasEmail = false } = {}) {
  const parts = [];
  if (grade) parts.push(`grade ${grade}${gradeDir === 'lte' ? ' or lower' : '+'}`);
  if (type) parts.push(TYPE_LABELS[type] || type);
  if (sectors.length) parts.push(sectors.map((s) => SECTOR_LABELS[s] || s).join(' / '));
  if (company) parts.push(company);
  if (state) parts.push(`in ${state}`);
  const noun = 'contacts';
  let out = parts.length ? `${parts.join(' ')} ${noun}`.replace(/\s+/g, ' ').trim() : 'Contacts';
  if (hasPhone) out += ' with a phone number';
  if (hasEmail) out += ' with an email';
  return out;
}

module.exports = { detect, select, toTable, withEvidence, evidenceCell, evidenceSummary, label, unmetFilters, gradeFrom, typeFrom, stateFrom, stateNameOf, partyFrom, levelFrom, hasPhoneFrom, hasEmailFrom, buildCoverageCountSql, isGovernmentCompany, isNonprofitCompany, domainKind, sectorsFrom, companyFrom, matchesSectors, GRADE_CAP, SECTORS };
