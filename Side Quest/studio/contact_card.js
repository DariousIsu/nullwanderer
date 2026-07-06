/**
 * studio/contact_card.js — assemble a CONTACT CARD payload for the People rail from a discovered contact.
 *
 * The doc-ingestion contact pass (main.bankDocContacts) discovers people/orgs and lands them in the Puller
 * as certainty-scored beliefs. This turns a Puller target + its beliefs into the data for a card in the
 * left "People" rail (renderer/canvas.js) — the VISIBLE proof: photo (or initials), name, role, the
 * discovered contact rows, a bio, a confidence grade, click-through to the full Puller briefing. Pure: the
 * CRM photo/bio (consume-only) is looked up upstream and passed in, so this is offline-smoke-testable.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

// Coarse card grade from the belief confidence — mirrors the Puller send-safety ladder bands (A official /
// B verified / C pattern / D best-guess / E generic). Just the letter for the card's confidence dot.
function gradeFor(confidence) {
  if (confidence == null || confidence === '') return null;   // Number(null)===0 would misgrade as 'E'
  const c = Number(confidence);
  if (!Number.isFinite(c)) return null;
  if (c >= 0.95) return 'A';
  if (c >= 0.80) return 'B';
  if (c >= 0.50) return 'C';
  if (c >= 0.30) return 'D';
  return 'E';
}

// Photo fallback: up to two initials from a person/org name.
function initialsOf(name) {
  const parts = str(name).split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The consume-only CRM record surfaced on the card: the full entry the click-through opens, plus the
// key/value rows the inline expand shows. Only built when the contact is actually in the CRM (crmId).
// Pure — every value comes from the injected `crm` lookup (main.lookupCrmContacts).
function crmBlock(crm = {}) {
  if (crm.crmId == null) return null;
  const fields = [
    ['Title', crm.title], ['Party', crm.party], ['Chamber', crm.chamber],
    ['State', crm.state], ['District', crm.district], ['Tier', crm.tier],
    ['Engagement', crm.engagement], ['Email', crm.email], ['Phone', crm.phone],
    ['Address', crm.address],
  ].filter(([, v]) => str(v)).map(([k, v]) => ({ k, v: str(v) }));
  return {
    crmId: crm.crmId,
    fields,
    notes: str(crm.notesPublic) || null,
    wikipedia: str(crm.wikipedia) || null,
  };
}

// Build a card payload. `contact` = { name, title, company, email, phone, address, confidence, targetId,
// kind }. `crm` (optional, injected consume-only lookup) = the full CRM record (see lookupCrmContacts).
// A discovered contact detail (Puller belief) WINS over the CRM value; the CRM fills any gap. Pure.
function buildCardData(contact = {}, crm = {}) {
  const name = str(contact.name);
  const title = str(contact.title) || str(crm.title);
  const org = str(contact.company);
  const role = [title, org].filter(Boolean).join(' · ');
  return {
    type: 'person',
    name,
    title: title || null,
    org: org || null,
    role: role || null,
    photo: str(crm.photo) || null,
    initials: initialsOf(name),
    email: str(contact.email) || str(crm.email) || null,   // Puller belief wins; CRM fills the gap
    phone: str(contact.phone) || str(crm.phone) || null,
    address: str(contact.address) || str(crm.address) || null,
    bio: str(crm.bio) || null,
    grade: gradeFor(contact.confidence),
    confidence: (typeof contact.confidence === 'number') ? contact.confidence : null,
    targetId: (contact.targetId != null) ? contact.targetId : null,
    crmId: (crm.crmId != null) ? crm.crmId : null,
    crm: crmBlock(crm),                                     // the full entry for inline expand + click-through
    social: socialList(contact.social),                     // discovered handles (maigret) — UNVERIFIED, grade-E
    kind: contact.kind === 'org' ? 'org' : 'person',
    ts: (typeof contact.ts === 'number') ? contact.ts : null,   // recency for the waterfall
  };
}

// Normalize discovered social handles for the card: [{site,url}], deduped by url, capped. These are
// grade-E OBSERVATIONS (corroborated but UNVERIFIED) — the renderer labels them as such. Pure.
function socialList(social) {
  const out = []; const seen = new Set();
  for (const s of (Array.isArray(social) ? social : [])) {
    const url = str(s && s.url); if (!url || seen.has(url)) continue; seen.add(url);
    out.push({ site: str(s && s.site) || null, url });
    if (out.length >= 8) break;
  }
  return out;
}

// An ORG card — for a "place" that RESOLVED to an organization in Echo (the Rainey Center bug: an org
// was landing as a blank place). `entity` = a search_entities hit { id, name, entity_type, summary }.
// Rendered like a contact card (org-styled), with the Echo summary as its bio. Pure.
function buildOrgCard(entity = {}, { ts = null } = {}) {
  const name = str(entity.name);
  const summary = str(entity.summary);
  return {
    type: 'org', name, initials: initialsOf(name),
    role: 'Organization',
    bio: summary ? summary.slice(0, 400) : null,
    entityId: (entity.id != null) ? entity.id : null,
    subtype: str(entity.entity_subtype) || null,
    key: name.toLowerCase(), ts: (typeof ts === 'number') ? ts : null,
  };
}

// A PLACE card (venue/office/city). `p` = { name, address, note }. Pure.
function buildPlaceCard(p = {}, { ts = null } = {}) {
  const name = str(p.name);
  return { type: 'place', name, initials: '📍', address: str(p.address) || null, note: str(p.note) || null,
    key: name.toLowerCase(), ts: (typeof ts === 'number') ? ts : null };
}
// An EVENT card (meeting/breakfast/summit). `e` = { name, date, location, note }. Pure.
function buildEventCard(e = {}, { ts = null } = {}) {
  const name = str(e.name);
  return { type: 'event', name, initials: '📅', date: str(e.date) || null, location: str(e.location) || null,
    note: str(e.note) || null, key: name.toLowerCase(), ts: (typeof ts === 'number') ? ts : null };
}

// Bridge: a Puller target row + its beliefs (lib/puller_db.listBeliefs shape) → a card. The belief value is
// the current best answer per attr; confidence rides the email belief (else phone). Pure.
function cardFromTarget(target = {}, beliefs = [], crm = {}, { social = [] } = {}) {
  const list = Array.isArray(beliefs) ? beliefs : [];
  const bv = (t) => { const b = list.find((x) => x.type === t); return b ? b.value : null; };
  const bc = (t) => { const b = list.find((x) => x.type === t); return (b && typeof b.confidence === 'number') ? b.confidence : null; };
  return buildCardData({
    name: target.name, company: target.company, title: bv('role'),
    email: bv('email'), phone: bv('phone'), address: bv('address'),
    confidence: bc('email') != null ? bc('email') : bc('phone'),
    targetId: target.id, kind: target.kind, social,
    ts: target.last_accessed_at || target.created_at || null,
  }, crm);
}

// Parse the Puller's social OBSERVATIONS (attr='social', value='Site|url') into [{site,url}] for a card.
// Pure — the caller passes lib/puller_db.listObservations(id,{attr:'social'}) rows.
function socialFromObservations(observations) {
  return (Array.isArray(observations) ? observations : []).map((o) => {
    const v = String((o && o.value) || '');
    const i = v.indexOf('|');
    return i > 0 ? { site: v.slice(0, i), url: v.slice(i + 1) } : { site: null, url: v };
  }).filter((s) => s.url);
}

module.exports = { buildCardData, cardFromTarget, socialFromObservations, buildPlaceCard, buildEventCard, buildOrgCard, crmBlock, gradeFor, initialsOf };
