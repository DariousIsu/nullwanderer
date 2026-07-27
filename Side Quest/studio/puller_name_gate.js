/* studio/puller_name_gate.js — REJECT junk "person" names before they become Puller targets (#43).
 *
 * The waste this stops (memory #43): a doc roster or a web-discovery pass names "Finance Director",
 * "Board of Trustees", "The Smith Family Trust", "General Inquiries" — these land as PERSON targets, and
 * every one then burns a web pull when the autonomous Puller tries to research a person who does not exist.
 * A person target must name a PERSON, not a role, an org, or a mailbox.
 *
 * DELIBERATELY CONSERVATIVE — a false POSITIVE drops a real contact, so the bar to call a name junk is high:
 * reject only high-confidence junk (an org-suffix or role-word TAIL, or an all-meta name). A real full name
 * ("John Smith", even "Trust Nkosi" — a person named Trust) passes: its surname is not a role/org word.
 *
 * Pure. Tokenizes on alpha words; never throws.
 */
'use strict';

// Legal-entity / organization tails. A person's SURNAME is almost never one of these in a contact roster,
// so a name ENDING in one is an org, not a person ("Acme Foundation", "Smith Family Trust", "Rainey PAC").
const ORG_TAIL = new Set([
  'trust', 'llc', 'llp', 'lp', 'inc', 'incorporated', 'ltd', 'co', 'corp', 'corporation', 'company',
  'foundation', 'committee', 'subcommittee', 'pac', 'fund', 'association', 'assn', 'coalition', 'society',
  'institute', 'institution', 'center', 'centre', 'alliance', 'network', 'agency', 'bureau', 'division',
  'department', 'dept', 'office', 'board', 'council', 'commission', 'authority', 'group', 'partners',
  'holdings', 'bank', 'ministries', 'ministry', 'university', 'college', 'academy', 'church', 'coalition',
  'caucus', 'chapter', 'union', 'federation', 'league', 'chamber', 'services', 'systems', 'solutions',
]);

// Role / title words — a name that ENDS in one is a role, not a person ("Finance Director", "Board Member").
const ROLE_TAIL = new Set([
  'director', 'manager', 'chair', 'chairman', 'chairwoman', 'chairperson', 'president', 'treasurer',
  'secretary', 'officer', 'ceo', 'cfo', 'coo', 'cto', 'evp', 'svp', 'vp', 'member', 'coordinator',
  'analyst', 'assistant', 'representative', 'rep', 'counsel', 'administrator', 'admin', 'staff',
  'volunteer', 'intern', 'trustee', 'trustees', 'principal', 'associate', 'fellow', 'advisor', 'adviser',
  'consultant', 'clerk', 'deputy', 'chief', 'head', 'lead', 'founder', 'editor', 'reporter', 'liaison',
  'specialist', 'supervisor', 'superintendent', 'commissioner', 'delegate', 'aide', 'spokesperson',
]);

// Generic non-names / mailboxes. A name made only of these is not a person.
const GENERIC = new Set([
  'unknown', 'unnamed', 'na', 'none', 'null', 'tbd', 'test', 'anonymous', 'various', 'multiple', 'team',
  'support', 'sales', 'marketing', 'hr', 'it', 'billing', 'accounts', 'accounting', 'info', 'information',
  'contact', 'contacts', 'general', 'inquiries', 'inquiry', 'enquiries', 'admin', 'office', 'main', 'desk',
  'help', 'helpdesk', 'webmaster', 'noreply', 'no', 'reply', 'mail', 'email', 'staff', 'public', 'media',
  'press', 'communications', 'comms',
]);

// Structural / grammar tokens that carry no name signal.
const STOP = new Set(['the', 'of', 'and', 'for', 'a', 'an', '&', 'at', 'in', 'on', 'to', 'by', 'or', 'de', 'la', 'el']);

function _tokens(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9&\s'’.-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.'’-]+|[.'’-]+$/g, ''))
    .filter(Boolean);
}

// Is this purported PERSON name actually junk (a role / org / mailbox), not a person?
function isJunkPersonName(name) {
  const toks = _tokens(name);
  if (!toks.length) return true;                                   // empty / punctuation-only → junk
  const content = toks.filter((t) => !STOP.has(t));
  if (!content.length) return true;                                // only stopwords ("the", "of") → junk

  // Every content token is a ROLE or ORG word → not a person ("Executive Director", "Board of Trustees").
  // NOTE: deliberately NOT including GENERIC here — a multi-word mailbox persona ("Press Team") is handled
  // by the ingest tier system (30%-generic), not this gate. #43 is scoped to ROLE / ORG-ENTITY junk.
  if (content.every((t) => ROLE_TAIL.has(t) || ORG_TAIL.has(t))) return true;

  // A single content token that is a role/generic word → junk ("Director", "Contact", "Various"). A lone
  // real given name (rare in a roster) is left alone unless it is a known meta word.
  if (content.length === 1 && (ROLE_TAIL.has(content[0]) || GENERIC.has(content[0]))) return true;

  // The name ENDS in an org tail or a role word → an org or a role, not a person ("Smith Family Trust",
  // "Finance Director", "Advisory Board"). The tail is where the entity/role type lives.
  const last = content[content.length - 1];
  if (ORG_TAIL.has(last) || ROLE_TAIL.has(last)) return true;

  // Contains any digit-heavy token that is not a name (a mailbox local-part slipped in, "info2020").
  if (content.some((t) => /\d/.test(t) && /[a-z]/.test(t))) return true;

  return false;                                                    // looks like a real person name → keep
}

module.exports = { isJunkPersonName, ORG_TAIL, ROLE_TAIL, GENERIC };
