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
const LIST_INTENT = /\b(list|give|show|pull|get|compile|export|send|grab|fetch|need|want|hand|make (?:me )?a list|who (?:do we have|are|'?s))\b/i;
// A phrasing that is clearly RESEARCH ("find NEW", "go discover", "research"), not a list-what-we-have.
const RESEARCH_INTENT = /\b(research|find (?:new|more)|discover|dig up|go get new|source new|build a (?:new )?list from scratch)\b/i;

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
// Detect a list-the-contacts-we-hold request. Returns { isQuery, sectors, company, limit }.
function detect(message) {
  const m = String(message == null ? '' : message);
  // a TYPE word ("elected officials", "corporate", "legislators") is itself a contact-list noun in this
  // domain — "give me grade B elected officials in LA" has no bare "contacts"/"people" noun but is clearly
  // a list ask. Still gated by LIST_INTENT below, so a non-list mention ("the government shut down") is out.
  const nounish = CONTACT_NOUN.test(m) || (WHO_HAVE.test(m) && /\bat\b/i.test(m)) || !!typeFrom(m);
  if (!nounish) return { isQuery: false };
  if (RESEARCH_INTENT.test(m) && !LIST_INTENT.test(m)) return { isQuery: false };   // an explicit "research NEW" → not a list
  if (!LIST_INTENT.test(m) && !WHO_HAVE.test(m)) return { isQuery: false };
  const g = gradeFrom(m);
  return { isQuery: true, sectors: sectorsFrom(m), company: companyFrom(m), limit: countFrom(m),
           grade: g ? g.grade : null, gradeDir: g ? g.dir : 'gte', type: typeFrom(m), state: stateFrom(m) };
}

// GRADE — the A–E confidence ladder (mirrors studio/puller_confidence CAP). "c rating or higher" is the
// most common list filter and it IS on every row (the `confidence` field), it just was never used as a
// FILTER (only for sorting). C = 0.80, so "C or higher" = confidence >= 0.80.
const GRADE_CAP = { A: 1.00, B: 0.95, C: 0.80, D: 0.50, E: 0.30 };
const _GRADE_RE = /\bgrade\s+([a-e])\b|\b([a-e])[\s-]?(?:rating|rated|graded?)\b/i;
const _DIR_LOWER = /\b(?:or\s+)?(?:lower|below|worse|under)\b/i;
function gradeFrom(message) {
  const m = String(message || '');
  const g = _GRADE_RE.exec(m);
  const grade = g ? (g[1] || g[2] || '').toUpperCase() : null;
  if (!grade || !GRADE_CAP[grade]) return null;
  // default a bare "grade X" / "X rating" to ">= X" (the "at least this quality" intent, e.g. "C and up");
  // an explicit "or lower/below" flips it.
  return { grade, dir: _DIR_LOWER.test(m) ? 'lte' : 'gte' };
}

// TYPE — corporate (private-sector) vs elected/government. The right signal is the COMPANY NAME, NOT the
// source: the Puller has DISCOVERED tens of thousands of GOVERNMENT contacts (DC Public Schools, Metro
// Police, State House, "Department of …") right alongside real corporations (Meta, OpenAI, Duke Energy,
// NVIDIA). And most corporate leads are grade-C/D with NO verified email yet (they aren't promoted to the
// CRM), so email/source can't be the key. So: corporate = has a company AND that company is not government.
const _TYPE_CORP = /\b(corporate|corporation|companies|company|commercial|for-?profit|private[\s-]?sector|firms?|industry|industries|business(?:es)?)\b/i;
const _TYPE_ELECTED = /\b(elected|officials?|legislators?|lawmakers?|congress(?:ional|m[ae]n|wom[ae]n|member)?|senators?|representatives?|governors?|mayors?|council\s?members?|commissioners?|office\s?holders?)\b/i;
const _TYPE_GOV = /\b(government|govt|agenc(?:y|ies)|federal agenc|municipal|public[\s-]?sector)\b/i;
function typeFrom(message) {
  const m = String(message || '');
  if (_TYPE_ELECTED.test(m)) return 'elected';   // "elected officials" before generic corp/gov words
  if (_TYPE_GOV.test(m)) return 'gov';
  if (_TYPE_CORP.test(m)) return 'corporate';
  return null;
}

// GOVERNMENT-company detector (the corporate/gov split). Matches the government patterns that dominate the
// held company names (verified against the Puller's 87k government contacts): departments, public schools,
// police/fire/EMS, bureaus/agencies/offices, state house/senate, city/county/parish/municipal, courts,
// universities, libraries, corrections, public works, etc. Deliberately NOT bare "general"/"national"/
// "federal" (those hit real companies — General Dynamics, National Grid, FedEx). Corporate = a company that
// this does NOT match.
const _GOV_COMPANY = /\b(departments?|dept\.?|public schools?|\bpolice\b|\bfire\b|emergency medical|\bems\b|bureaus?|agenc(?:y|ies)|\bagcy\b|office of|\bofc\.?\b|state (?:house|senate|department|of|police)|city of|count(?:y|ies)|\bparish(?:es)?\b|municipal|\blibrary\b|superintendent|attorney general|public works|human services|corrections|parks (?:and|&) rec|commissions?|authorit(?:y|ies)|board of|sheriff|\bcourts?\b|universit(?:y|ies)|\bschools?\b|division of|\bdiv\.?\b|administration|patrol|substitute teacher|comptroller|\btreasurer\b|assessor|clerk of|town of|village of|borough of|national guard|city council|county council|housing authority|transit authority|water district|school district|\bva\b|veterans affairs|\busda\b|\bepa\b|\bfbi\b|legislature|governor'?s office|mayor'?s office)\b/i;
function isGovernmentCompany(company) {
  const c = String(company || '').trim();
  return !!c && _GOV_COMPANY.test(c);
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
function select(rows, { sectors = [], company = null, limit = 200, grade = null, gradeDir = 'gte', type = null, state = null } = {}) {
  const comp = company ? _norm(company) : null;
  const minC = grade && GRADE_CAP[grade] != null ? GRADE_CAP[grade] : null;
  const st = state ? String(state).toUpperCase() : null;
  const filtered = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const name = String((r && r.name) || '').trim();
    if (name.length < 2 || isInitialsOnly(name)) continue;   // drop malformed initials-only junk
    const rc = String((r && r.company) || '');
    if (!matchesSectors(rc, sectors)) continue;
    if (comp && !_norm(rc).includes(comp)) continue;
    // GRADE — confidence threshold. "C or higher" (gte) → conf >= 0.80; "or lower" (lte) → conf <= cap.
    if (minC != null) {
      const c = typeof (r && r.confidence) === 'number' ? r.confidence : 0;
      if (gradeDir === 'lte' ? (c > minC + 1e-9) : (c < minC - 1e-9)) continue;
    }
    // TYPE — by COMPANY, not source (both Puller and CRM hold gov AND private orgs). corporate = a real
    // company that is NOT government; gov = a government company OR the electoral CRM; elected = a CRM row
    // carrying an elected marker. No email is required — most corporate leads are unenriched (grade filter,
    // if asked, is what narrows to send-ready ones).
    const src = r && r.src;
    const dk = domainKind((r && r.domain) || (r && r.email));   // target company domain preferred, else email domain
    const govCo = isGovernmentCompany(rc);
    if (type === 'corporate' && !(dk === 'corporate' && !govCo)) continue;   // a real COMPANY domain, name not gov
    if (type === 'gov' && !(dk === 'gov' || govCo || src === 'crm')) continue;
    if (type === 'elected' && (src !== 'crm' || (('elected' in (r || {})) && r.elected === false))) continue;
    // STATE — match the row's represented/mailing state (civic CRM rows carry it; Puller rows usually don't).
    if (st && String((r && r.state) || '').toUpperCase() !== st) continue;
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
  return { rows: shown, total, shown: shown.length, withEmail: deduped.filter(r => r.email).length, headers: ['Name', 'Email', 'Company', 'Title', 'Confidence'] };
}

// The canvas TABLE payload (headers + rows) for saga_canvas_add_block block_type='table'. Pure.
function toTable(sel) {
  const headers = sel.headers || ['Name', 'Email', 'Company', 'Title', 'Confidence'];
  const pct = (c) => (typeof c === 'number' && c > 0) ? `${Math.round(c * 100)}%` : '';
  const rows = (sel.rows || []).map(r => [r.name || '', r.email || '', r.company || '', r.title || '', pct(r.confidence)]);
  const caption = sel.total > sel.shown ? `${sel.shown} of ${sel.total} contacts (${sel.withEmail} with email)` : `${sel.total} contacts (${sel.withEmail} with email)`;
  return { headers, rows, caption };
}

// A short human title for the canvas tab + the chat line, from the request's sectors/company.
const TYPE_LABELS = { corporate: 'corporate', elected: 'elected-official', gov: 'government' };
function label({ sectors = [], company = null, grade = null, gradeDir = 'gte', type = null, state = null } = {}) {
  const parts = [];
  if (grade) parts.push(`grade ${grade}${gradeDir === 'lte' ? ' or lower' : '+'}`);
  if (type) parts.push(TYPE_LABELS[type] || type);
  if (sectors.length) parts.push(sectors.map((s) => SECTOR_LABELS[s] || s).join(' / '));
  if (company) parts.push(company);
  if (state) parts.push(`in ${state}`);
  const noun = 'contacts';
  return parts.length ? `${parts.join(' ')} ${noun}`.replace(/\s+/g, ' ').trim() : 'Contacts';
}

module.exports = { detect, select, toTable, label, unmetFilters, gradeFrom, typeFrom, stateFrom, isGovernmentCompany, domainKind, sectorsFrom, companyFrom, matchesSectors, GRADE_CAP, SECTORS };
