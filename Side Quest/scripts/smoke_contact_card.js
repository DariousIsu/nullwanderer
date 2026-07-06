/* Smoke: studio/contact_card — assemble People-rail card payloads. Fully offline (pure module).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contact_card.js
 */
const CC = require('../studio/contact_card');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- gradeFor: ladder bands ---
ok(CC.gradeFor(1) === 'A' && CC.gradeFor(0.95) === 'A', 'gradeFor: >=0.95 → A');
ok(CC.gradeFor(0.8) === 'B' && CC.gradeFor(0.5) === 'C' && CC.gradeFor(0.3) === 'D' && CC.gradeFor(0.1) === 'E', 'gradeFor: B/C/D/E bands');
ok(CC.gradeFor(null) === null, 'gradeFor: no confidence → null');

// --- initialsOf ---
ok(CC.initialsOf('Brad Overcash') === 'BO', 'initialsOf: two-token → first+last initial');
ok(CC.initialsOf('Rainey') === 'RA', 'initialsOf: single token → first two letters');
ok(CC.initialsOf('') === '?', 'initialsOf: empty → ?');

// --- buildCardData: fields, grade, photo fallback ---
const card = CC.buildCardData(
  { name: 'Brad Overcash', title: 'State Senator', company: 'NC Senate', email: 'brad.overcash@ncleg.gov', phone: '919-733-5745', address: 'Raleigh, NC', confidence: 0.8, targetId: 7, ts: 111 },
  {}
);
ok(card.name === 'Brad Overcash' && card.role === 'State Senator · NC Senate', 'buildCardData: name + composed role');
ok(card.email === 'brad.overcash@ncleg.gov' && card.phone === '919-733-5745' && card.address === 'Raleigh, NC', 'buildCardData: contact rows carried');
ok(card.grade === 'B' && card.confidence === 0.8, 'buildCardData: grade from confidence');
ok(card.photo === null && card.initials === 'BO', 'buildCardData: no CRM photo → initials fallback');
ok(card.targetId === 7 && card.kind === 'person' && card.ts === 111, 'buildCardData: targetId + kind + recency ts');

// --- buildCardData: CRM enrichment injected (consume-only) ---
const enriched = CC.buildCardData({ name: 'Sarah Vance', confidence: 0.95, targetId: 3 }, { photo: 'http://akleg.gov/vance.jpg', bio: 'AK State Rep', crmId: 1 });
ok(enriched.photo === 'http://akleg.gov/vance.jpg' && enriched.bio === 'AK State Rep' && enriched.crmId === 1, 'buildCardData: CRM photo/bio/crmId passed through');
ok(enriched.grade === 'A', 'buildCardData: 0.95 → grade A');

// --- buildCardData: FULL CRM record → the crm block (inline expand) + gap-fill ---
const crmFull = {
  crmId: 42, photo: 'http://x/p.jpg', bio: 'Senator',
  title: 'State Senator', email: 'ted@ncleg.gov', phone: '919-000-0000', address: '16 W Jones St, Raleigh, NC',
  party: 'Republican', chamber: 'State Senate', state: 'NC', district: 'NC-44', tier: '1', engagement: 'Warm',
  wikipedia: 'https://en.wikipedia.org/wiki/Ted', notesPublic: 'LAMP Tier 1 Active Elected.',
};
// no Puller contact detail → CRM fills the gap
const crmCard = CC.buildCardData({ name: 'Ted Alexander', confidence: 0.8, targetId: 9 }, crmFull);
ok(crmCard.email === 'ted@ncleg.gov' && crmCard.phone === '919-000-0000' && crmCard.address === '16 W Jones St, Raleigh, NC', 'buildCardData: CRM fills missing email/phone/address');
ok(crmCard.title === 'State Senator' && crmCard.role === 'State Senator', 'buildCardData: CRM title fills the role line');
ok(crmCard.crm && crmCard.crm.crmId === 42 && Array.isArray(crmCard.crm.fields), 'buildCardData: crm block attached with fields[]');
ok(crmCard.crm.fields.some(f => f.k === 'Party' && f.v === 'Republican') && crmCard.crm.fields.some(f => f.k === 'Tier' && f.v === '1'), 'buildCardData: crm fields carry party + tier');
ok(crmCard.crm.notes === 'LAMP Tier 1 Active Elected.' && /wikipedia/.test(crmCard.crm.wikipedia), 'buildCardData: crm block carries notes + wikipedia');
// Puller belief WINS over CRM for the same attr
const bothCard = CC.buildCardData({ name: 'Ted Alexander', email: 'discovered@ncleg.gov', confidence: 0.8 }, crmFull);
ok(bothCard.email === 'discovered@ncleg.gov', 'buildCardData: a discovered (Puller) email wins over the CRM value');
// no CRM → no crm block
ok(CC.buildCardData({ name: 'Nobody', confidence: 0.5 }, {}).crm === null, 'buildCardData: no crmId → crm block is null');
ok(CC.crmBlock({}) === null && CC.crmBlock({ crmId: 1, party: 'R' }).fields.length === 1, 'crmBlock: null without crmId; drops empty fields');

// --- buildOrgCard: a "place" that resolved to an ORG (the Rainey Center bug) → an org card, not a blank place ---
const org = CC.buildOrgCard({ id: 1550486, name: 'Joseph Rainey Center for Public Policy', entity_type: 'organization', entity_subtype: 'poll_sponsor', summary: 'Polling-domain organization.' }, { ts: 77 });
ok(org.type === 'org' && org.name === 'Joseph Rainey Center for Public Policy', 'buildOrgCard: type=org + name');
ok(org.role === 'Organization' && org.bio === 'Polling-domain organization.' && org.entityId === 1550486, 'buildOrgCard: role + Echo summary as bio + entityId');
ok(org.initials === 'JP' && org.key === 'joseph rainey center for public policy' && org.ts === 77, 'buildOrgCard: initials (first+last token) + dedup key + ts');

// --- cardFromTarget: Puller target + beliefs → card ---
const target = { id: 12, name: 'Ted Alexander', company: 'NC Senate', kind: 'person', last_accessed_at: 999 };
const beliefs = [
  { type: 'email', value: 'ted.alexander@ncleg.gov', confidence: 0.8 },
  { type: 'phone', value: '919-715-3038', confidence: 0.8 },
  { type: 'role', value: 'State Senator', confidence: 0.8 },
];
const fromT = CC.cardFromTarget(target, beliefs, {});
ok(fromT.name === 'Ted Alexander' && fromT.email === 'ted.alexander@ncleg.gov', 'cardFromTarget: name + email belief');
ok(fromT.phone === '919-715-3038' && fromT.role === 'State Senator · NC Senate', 'cardFromTarget: phone + role belief → role line');
ok(fromT.grade === 'B' && fromT.targetId === 12 && fromT.ts === 999, 'cardFromTarget: confidence from email belief, targetId, recency');
const noEmail = CC.cardFromTarget({ id: 5, name: 'No Email Org', kind: 'org' }, [{ type: 'phone', value: '555', confidence: 0.5 }], {});
ok(noEmail.confidence === 0.5 && noEmail.kind === 'org', 'cardFromTarget: falls back to phone confidence; org kind');

ok(card.type === 'person', 'buildCardData: type=person');

// --- social handles (maigret grade-E observations) on the card ---
const socialObs = [{ value: 'LinkedIn|https://linkedin.com/in/x' }, { value: 'Instagram|https://instagram.com/x' }, { value: 'nolink' }];
const parsed = CC.socialFromObservations(socialObs);
ok(parsed.length === 3 && parsed[0].site === 'LinkedIn' && parsed[0].url === 'https://linkedin.com/in/x' && parsed[2].site === null, 'socialFromObservations: parses Site|url, tolerates bare value');
const withSocial = CC.cardFromTarget(target, beliefs, {}, { social: parsed });
ok(Array.isArray(withSocial.social) && withSocial.social.length === 3 && withSocial.social[0].url === 'https://linkedin.com/in/x', 'cardFromTarget: threads social handles onto the card');
ok(CC.cardFromTarget(target, beliefs, {}).social.length === 0, 'cardFromTarget: no social param → empty social array');

// --- buildPlaceCard / buildEventCard ---
const place = CC.buildPlaceCard({ name: 'AC Hotel Raleigh Downtown', address: '9 Glenwood Ave, Raleigh, NC 27603', note: 'event venue' }, { ts: 5 });
ok(place.type === 'place' && place.name === 'AC Hotel Raleigh Downtown' && /Glenwood/.test(place.address), 'buildPlaceCard: type + name + address');
ok(place.initials === '📍' && place.key === 'ac hotel raleigh downtown' && place.ts === 5, 'buildPlaceCard: pin avatar + dedup key + ts');
const event = CC.buildEventCard({ name: 'Faith in Elections Prayer Breakfast', date: 'Jun 30, 2026', location: 'AC Hotel Raleigh', note: '8:30am' }, { ts: 9 });
ok(event.type === 'event' && event.date === 'Jun 30, 2026' && event.location === 'AC Hotel Raleigh', 'buildEventCard: type + date + location');
ok(event.initials === '📅' && event.key === 'faith in elections prayer breakfast', 'buildEventCard: calendar avatar + dedup key');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
