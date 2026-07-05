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
        'You extract CONTACT INFORMATION for people and organizations from a document.\n' +
        'Output ONLY lines in this EXACT pipe-delimited format, nothing else:\n' +
        'CONTACT | name | title | affiliation | email | phone | address\n' +
        'Rules:\n' +
        '- One line per person or organization that has AT LEAST a stated email, phone, or mailing address.\n' +
        '- Use a single hyphen - for any field that is not present in the text.\n' +
        '- NEVER invent, guess, or infer an email or phone. Only emit values explicitly written in the text.\n' +
        '- name = the person or org name; title = their role; affiliation = their employer/organization.\n' +
        '- Do NOT emit a line for a name that has no email, phone, or address.\n' +
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
    const row = {
      name: nm,
      title: _clean(title),
      company: _clean(company),
      email: _email(email),
      phone: _phone(phone),
      address: _clean(address),
      confidence: DOC_CONFIDENCE,
    };
    if (!row.email && !row.phone && !row.address) continue;   // a bare name is not contact intelligence
    out.push(row);
  }
  return out;
}

module.exports = { buildContactPrompt, parseContactTuples, MAX_CHARS, DOC_CONFIDENCE };
