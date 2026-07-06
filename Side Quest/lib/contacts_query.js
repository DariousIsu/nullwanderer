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
  energy: /\b(energy|power|electric(?:al|ity)?|utilit|grid|nuclear|renewabl|solar|wind|hydro|geothermal|gas|turbine|transmission|pipeline)\b/i,
  // include known AI/cloud/datacenter company names — their names don't carry the sector keyword.
  ai: /\b(a\.?i\.?|artificial intelligence|machine learning|\bml\b|openai|anthropic|deepmind|cohere|mistral|hugging ?face)\b/i,
  datacenter: /\b(data ?cent(?:er|re)|cloud|hyperscal|semiconductor|chip|gpu|compute|equinix|digital realty|coreweave|crusoe|nvidia|google|amazon|aws|microsoft|azure|meta|apple|oracle|ibm|intel)\b/i,
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
// "contacts at <Company>" / "from <Company>" / "for <Company>" → the company filter, else null.
function companyFrom(message) {
  const m = /\b(?:at|from|for|with|in)\s+([A-Z][A-Za-z0-9&.\- ]{2,40})/.exec(String(message || ''));
  return m ? m[1].replace(/\b(the|contacts?|people|list|our|their)\b/gi, '').replace(/\s+/g, ' ').trim() || null : null;
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
  const nounish = CONTACT_NOUN.test(m) || (WHO_HAVE.test(m) && /\bat\b/i.test(m));
  if (!nounish) return { isQuery: false };
  if (RESEARCH_INTENT.test(m) && !LIST_INTENT.test(m)) return { isQuery: false };   // an explicit "research NEW" → not a list
  if (!LIST_INTENT.test(m) && !WHO_HAVE.test(m)) return { isQuery: false };
  return { isQuery: true, sectors: sectorsFrom(m), company: companyFrom(m), limit: countFrom(m) };
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
function select(rows, { sectors = [], company = null, limit = 200 } = {}) {
  const comp = company ? _norm(company) : null;
  const seen = new Set();
  const filtered = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const name = String((r && r.name) || '').trim();
    if (name.length < 2 || isInitialsOnly(name)) continue;   // drop malformed initials-only junk
    const rc = String((r && r.company) || '');
    if (!matchesSectors(rc, sectors)) continue;
    if (comp && !_norm(rc).includes(comp)) continue;
    const key = _norm(name) + '|' + _norm(rc);
    if (seen.has(key)) continue; seen.add(key);
    filtered.push({
      name,
      email: String((r && r.email) || '').trim() || null,
      phone: String((r && r.phone) || '').trim() || null,
      company: rc.trim() || null,
      title: String((r && r.title) || '').trim() || null,
      confidence: typeof (r && r.confidence) === 'number' ? r.confidence : 0,
    });
  }
  // HIGHEST CONFIDENCE first (the operator's ask), then emailed contacts, then company.
  filtered.sort((a, b) => (b.confidence - a.confidence) || ((b.email ? 1 : 0) - (a.email ? 1 : 0)) || _norm(a.company).localeCompare(_norm(b.company)));
  const total = filtered.length;
  const shown = filtered.slice(0, Math.max(1, limit || 200));
  return { rows: shown, total, shown: shown.length, withEmail: filtered.filter(r => r.email).length, headers: ['Name', 'Email', 'Company', 'Title', 'Confidence'] };
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
function label({ sectors = [], company = null } = {}) {
  if (company) return `${company} contacts`;
  if (sectors.length) return `${sectors.map((s) => SECTOR_LABELS[s] || s).join(' / ')} contacts`;
  return 'Contacts';
}

module.exports = { detect, select, toTable, label, sectorsFrom, companyFrom, matchesSectors, SECTORS };
