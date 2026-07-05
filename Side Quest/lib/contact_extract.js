/**
 * lib/contact_extract.js — pull PEOPLE, PLACES, and EVENTS out of a document as CARDS.
 *
 * The curation substrate's doc-decompose (lib/doc_decompose) mints ENTITY objects + graph relations from a
 * dropped document. This is its surfacing sibling: one extraction pass that reads the same document and
 * pulls the three card kinds Lucas wants populating the canvas rail —
 *   PERSON | name | title | affiliation | email | phone | address   → Puller contact + person card
 *   PLACE  | name | address | note                                   → place card (venue/office/city)
 *   EVENT  | name | date | location | note                          → event card (meeting/breakfast/summit)
 *
 * PEOPLE flow into the Puller (studio/puller_ingest) as cited, certainty-scored beliefs; PLACES and EVENTS
 * become cards (persisted in the recent-cards store). The venue/event that used to pollute PERSON contacts
 * (the "AC Hotel" bug) now lands correctly as its own PLACE / EVENT card.
 *
 * DISCOVERY-not-invention: the prompt forbids guessing an email/phone; only values written in the text are
 * emitted. Pure + deps-free (build/parse are the seams) so it's offline-smoke-testable.
 */
'use strict';

const MAX_CHARS = 6000;   // same decomposition slice bound as doc_decompose (outer edge of one pass)
const NULLISH = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', 'tbd', '?']);
// doc-stated contact = a real value read from a source, but not mail-server / deliverability verified. 0.8
// lands in the Puller's 'pattern' tier ("format confirmed") — stronger than a 50% format-guess (we have the
// literal string), below 95% verified — and it credits the domain's email-pattern belief (a roster teaches it).
const DOC_CONFIDENCE = 0.8;

// The extraction prompt. Fixed pipe-delimited line formats keep parsing deterministic and let a small
// extraction model stay on-rails. One line per object; a hyphen for any absent field.
function buildCardsPrompt(text, { title } = {}) {
  const body = String(text == null ? '' : text).slice(0, MAX_CHARS);
  const head = title ? `Document title: ${title}\n\n` : '';
  return [
    {
      role: 'system',
      content:
        'You extract three kinds of objects from a document, as cards: PEOPLE, PLACES, and EVENTS.\n' +
        'Output ONLY lines in these EXACT pipe-delimited formats, one object per line, nothing else:\n' +
        'PERSON | name | title | affiliation | email | phone | address\n' +
        'PLACE | name | address | note\n' +
        'EVENT | name | date | location | note\n' +
        'Rules:\n' +
        '- PERSON: each person presented with a title/role OR any contact detail (email/phone). A named person with a role but no email still counts.\n' +
        '- PLACE: a venue, hotel, building, office, or city — especially the location where something is held (with its street address if the text states one).\n' +
        '- EVENT: a meeting, breakfast, luncheon, summit, gala, hearing, or similar happening (with its date and location if stated).\n' +
        '- A venue/hotel/building is a PLACE and the happening itself is an EVENT — NEVER emit either as a PERSON.\n' +
        '- Use a single hyphen - for any field not present in the text.\n' +
        '- NEVER invent, guess, or infer an email or phone. Only emit values explicitly written in the text.\n' +
        '- No prose, no headers, no numbering, no commentary — only PERSON / PLACE / EVENT lines.',
    },
    { role: 'user', content: `${head}${body}` },
  ];
}
// Back-compat alias (older callers imported buildContactPrompt).
const buildContactPrompt = buildCardsPrompt;

function _clean(s) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return NULLISH.has(v.toLowerCase()) ? null : v;
}
// A stated email must actually look like one (local@domain) — guards against the model dropping a stray
// token in the email column. Loose on purpose; the Puller's verify/negatives loop does the real vetting.
function _email(s) {
  const v = _clean(s);
  if (!v) return null;
  const m = /[^\s|,;<>()]+@[^\s|,;<>()]+\.[a-z]{2,}/i.exec(v);
  return m ? m[0].toLowerCase() : null;
}
function _phone(s) {
  const v = _clean(s);
  if (!v) return null;
  const digits = v.replace(/[^\d]/g, '');
  return digits.length >= 7 ? v : null;   // needs enough digits to be a real number
}
// A VENUE / EVENT / street-address name must never be a PERSON (the "AC Hotel Raleigh Downtown 9 Glenwood
// Ave" bug). Deliberately narrow so real orgs survive — does NOT match generic org words (center/institute/
// group/foundation/association/LLC/office). Used as a backstop on PERSON rows.
const _VENUE_EVENT_RE = /\b(hotel|motel|inn|resort|ballroom|banquet|auditorium|arena|stadium|theat(?:er|re)|conference|convention|symposium|breakfast|luncheon|gala|reception|summit|downtown|uptown)\b/i;
const _STREET_RE = /\b\d{1,6}\s+\S+.*\b(st|street|ave|avenue|blvd|boulevard|road|rd|drive|dr|lane|ln|way|suite|ste|room|rm|floor|fl)\b/i;
function _looksLikeVenueOrEvent(name) { const n = String(name || ''); return _VENUE_EVENT_RE.test(n) || _STREET_RE.test(n); }

// PERSON parts ([name,title,company,email,phone,address]) → a Puller ingest row, or null.
function _personRow(parts) {
  const [name, title, company, email, phone, address] = parts;
  const nm = _clean(name);
  if (!nm || nm.length < 2) return null;
  if (_looksLikeVenueOrEvent(nm)) return null;                 // a venue/event never a person
  const row = {
    name: nm, title: _clean(title), company: _clean(company),
    email: _email(email), phone: _phone(phone), address: _clean(address),
    confidence: DOC_CONFIDENCE,
  };
  // QUALIFY on a person-signal: a contact detail OR a title/role. An address ALONE does not qualify.
  if (!row.email && !row.phone && !row.title) return null;
  return row;
}
// PLACE parts ([name,address,note]) → {name, address, note}, or null (name required).
function _placeRow(parts) {
  const nm = _clean(parts[0]);
  if (!nm || nm.length < 2) return null;
  return { name: nm, address: _clean(parts[1]), note: _clean(parts[2]) };
}
// EVENT parts ([name,date,location,note]) → {name, date, location, note}, or null (name required).
function _eventRow(parts) {
  const nm = _clean(parts[0]);
  if (!nm || nm.length < 2) return null;
  return { name: nm, date: _clean(parts[1]), location: _clean(parts[2]), note: _clean(parts[3]) };
}

// Parse the model's typed lines into { people, places, events }, routed by the leading tag. A legacy
// "CONTACT"/untagged line is treated as a PERSON. Pure.
function parseDocCards(raw) {
  const people = [], places = [], events = [];
  for (const lineRaw of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || !line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    const tag = (parts[0] || '').toUpperCase();
    if (tag === 'PLACE') { const r = _placeRow(parts.slice(1)); if (r) places.push(r); continue; }
    if (tag === 'EVENT') { const r = _eventRow(parts.slice(1)); if (r) events.push(r); continue; }
    const rest = (tag === 'PERSON' || tag === 'CONTACT') ? parts.slice(1) : parts;   // tolerate legacy/untagged
    const r = _personRow(rest); if (r) people.push(r);
  }
  return { people, places, events };
}
// Back-compat: the people-only view (older callers used parseContactTuples).
function parseContactTuples(raw) { return parseDocCards(raw).people; }

module.exports = {
  buildCardsPrompt, buildContactPrompt, parseDocCards, parseContactTuples,
  MAX_CHARS, DOC_CONFIDENCE,
};
