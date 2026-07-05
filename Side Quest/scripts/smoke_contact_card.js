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

// --- buildPlaceCard / buildEventCard ---
const place = CC.buildPlaceCard({ name: 'AC Hotel Raleigh Downtown', address: '9 Glenwood Ave, Raleigh, NC 27603', note: 'event venue' }, { ts: 5 });
ok(place.type === 'place' && place.name === 'AC Hotel Raleigh Downtown' && /Glenwood/.test(place.address), 'buildPlaceCard: type + name + address');
ok(place.initials === '📍' && place.key === 'ac hotel raleigh downtown' && place.ts === 5, 'buildPlaceCard: pin avatar + dedup key + ts');
const event = CC.buildEventCard({ name: 'Faith in Elections Prayer Breakfast', date: 'Jun 30, 2026', location: 'AC Hotel Raleigh', note: '8:30am' }, { ts: 9 });
ok(event.type === 'event' && event.date === 'Jun 30, 2026' && event.location === 'AC Hotel Raleigh', 'buildEventCard: type + date + location');
ok(event.initials === '📅' && event.key === 'faith in elections prayer breakfast', 'buildEventCard: calendar avatar + dedup key');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
