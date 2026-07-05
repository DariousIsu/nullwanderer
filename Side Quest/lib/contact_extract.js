/**
 * lib/contact_extract.js — pull CONTACT INFORMATION out of a document for the Puller.
 *
 * The curation substrate's doc-decompose (lib/doc_decompose) mints ENTITY objects + graph relations from a
 * dropped document. This is its sibling for the OTHER facet Lucas wants grown: contact data. It reads the
 * same document and extracts, per person/org, the stated contact fields — email / phone / title / mailing
 * address — as delimited tuples. Those land in the Puller (studio/puller_ingest.ingestRows), where they
 * become append-only observations + certainty-scored beliefs, cited to the document.
 *
 * DISCOVERY-not-invention: the prompt forbids guessing an email/phone; only values written in the text are
 * emitted (a stated roster line, an offer letter, a flyer footer). A tuple with only a name and no contact
 * field is dropped — a bare name mention is the entity-decompose's job, not contact intelligence.
 *
 * Pure + deps-free: buildContactPrompt/parseContactTuples are the two seams; the app pairs them with the
 * shared cloud extractor (decomp_lane.makeCloudExtractor) so the whole thing is offline-smoke-testable.
 */
'use strict';

const MAX_CHARS = 6000;   // same decomposition slice bound as doc_decompose (outer edge of one pass)
const NULLISH = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', 'tbd', '?']);
// doc-stated contact = a real value read from a source, but not mail-server / deliverability verified. 0.8
// lands in the Puller's 'pattern' tier ("format confirmed") — stronger than a 50% format-guess (we have the
// literal string), below 95% verified — and it credits the domain's email-pattern belief (a roster teaches it).
const DOC_CONFIDENCE = 0.8;

// The extraction prompt. Fixed pipe-delimited line format keeps parsing deterministic and lets a small
// extraction model stay on-rails. One line per contactable person/org; a hyphen for any absent field.
function buildContactPrompt(text, { title } = {}) {
  const body = String(text == null ? '' : text).slice(0, MAX_CHARS);
  const head = title ? `Document title: ${title}\n\n` : '';
  return [
    {
      role: 'system',
      content:
        'You extract CONTACTS — PEOPLE (and organizations you would contact directly, like a company or office) — from a document.\n' +
        'Output ONLY lines in this EXACT pipe-delimited format, nothing else:\n' +
        'CONTACT | name | title | affiliation | email | phone | address\n' +
        'Rules:\n' +
        '- Emit a line for each PERSON who is presented with a title/role OR with any contact detail (email/phone). A named person with a role but no email still counts — email/phone/address are optional.\n' +
        '- Do NOT emit a line for a VENUE, hotel, building, room, city, or for the EVENT itself. The location or address where an event is held is NOT a contact — attach an address only to a real person/org, never as its own entry.\n' +
        '- Skip people merely mentioned in passing who have neither a title/role nor any contact detail.\n' +
        '- Use a single hyphen - for any field that is not present in the text.\n' +
        '- NEVER invent, guess, or infer an email or phone. Only emit values explicitly written in the text.\n' +
        '- name = the person or org name; title = their role; affiliation = their employer/organization.\n' +
        '- No prose, no headers, no numbering, no commentary — only CONTACT lines.',
    },
    { role: 'user', content: `${head}${body}` },
  ];
}

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
// A VENUE / EVENT / street-address name is NOT a contact (the "AC Hotel Raleigh Downtown 9 Glenwood Ave"
// bug: a flyer's event location landed as a person). Deliberately narrow so real orgs survive — it does
// NOT match generic org words (center/institute/group/foundation/association/LLC/office).
const _VENUE_EVENT_RE = /\b(hotel|motel|inn|resort|ballroom|banquet|auditorium|arena|stadium|theat(?:er|re)|conference|convention|symposium|breakfast|luncheon|gala|reception|summit|downtown|uptown)\b/i;
const _STREET_RE = /\b\d{1,6}\s+\S+.*\b(st|street|ave|avenue|blvd|boulevard|road|rd|drive|dr|lane|ln|way|suite|ste|room|rm|floor|fl)\b/i;
function _looksLikeVenueOrEvent(name) { const n = String(name || ''); return _VENUE_EVENT_RE.test(n) || _STREET_RE.test(n); }

// Parse the model's pipe-delimited lines into Puller ingest rows ({name, company, title, email, phone,
// address, confidence}). Drops any tuple without a name or without at least one contact field. Pure.
function parseContactTuples(raw) {
  const out = [];
  for (const lineRaw of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || !line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    // tolerate a leading "CONTACT" tag (drop it) or its absence
    if (parts.length && /^contact$/i.test(parts[0])) parts.shift();
    if (parts.length < 2) continue;
    const [name, title, company, email, phone, address] = parts;
    const nm = _clean(name);
    if (!nm || nm.length < 2) continue;
    if (_looksLikeVenueOrEvent(nm)) continue;                 // a venue/event/street-address is not a contact
    const row = {
      name: nm,
      title: _clean(title),
      company: _clean(company),
      email: _email(email),
      phone: _phone(phone),
      address: _clean(address),
      confidence: DOC_CONFIDENCE,
    };
    // QUALIFY on a person-signal: a contact detail OR a title/role. An address ALONE does not qualify —
    // that's how a venue's event-address slipped in as a contact. (A titled person with no email still counts.)
    if (!row.email && !row.phone && !row.title) continue;
    out.push(row);
  }
  return out;
}

module.exports = { buildContactPrompt, parseContactTuples, MAX_CHARS, DOC_CONFIDENCE };
