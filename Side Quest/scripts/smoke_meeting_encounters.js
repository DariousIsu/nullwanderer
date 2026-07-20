/* smoke_meeting_encounters.js — meetings become encounters (W4).
 *
 * The distinction this whole slice rests on: that someone WAS in a meeting is something Zoe observed;
 * what they SAID is not evidence that it is true. If those two collapse into each other, every claim
 * made out loud in a meeting acquires the authority of a record.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meeting_encounters.js
 */
'use strict';
const me = require('../lib/meeting_encounters');
const de = require('../lib/decomp_encounters');
const og = require('../lib/origin');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const T = Date.UTC(2026, 6, 15, 14, 0, 0);
const line = (o) => ({ meeting: 'mav-myni-mkw', ts: T, ...o });

// ── speaker labels ───────────────────────────────────────────────────────────────────────────────
ok(me.speakerLabel('  Bill   Dunne ') === 'Bill Dunne', 'whitespace normalised');
ok(me.speakerLabel(null) === null && me.speakerLabel('') === null, 'no speaker → null');
for (const p of ['Unknown', 'speaker', 'Guest', 'participant', 'You']) {
  ok(me.speakerLabel(p) === null, `CRITICAL: Meet's placeholder "${p}" is not a person`);
}

// ── attendance is EVIDENCE ───────────────────────────────────────────────────────────────────────
{
  const encs = me.attendanceEncounters([
    line({ speaker: 'Bill Dunne', text: 'All right.' }),
    line({ speaker: 'Bill Dunne', text: 'See you later.', ts: T + 60000 }),
    line({ speaker: 'Lucas Overby', text: 'I will see you later.', ts: T + 30000 }),
  ]);
  ok(encs.length === 4, 'two people × (existence + participated_in) = 4 encounters');
  const bill = encs.filter((e) => e.object_label === 'Bill Dunne');
  ok(bill.length === 2 && bill.some((e) => e.claim_class === 'existence')
    && bill.some((e) => e.claim_class === 'structural' && e.claim_key === 'participated_in'),
    'a person exists AND participated in the meeting');
  ok(bill[0].authority === 'ordinary',
    'attendance is ORDINARY evidence — a first-hand observation, but not an official record');
  ok(bill[0].observed_at === T, 'observed_at is the meeting time — native and exact, not parsed from prose');
  ok(bill.every((e) => e.claim_class !== 'biographical'),
    'attending a meeting is something someone DID, not a fact about who they are');
}
{
  // Lines with no speaker are ignored, never guessed. 2,484 of 4,178 live lines are media captions
  // with no attribution by construction; inventing one puts words in a real person's mouth.
  const encs = me.attendanceEncounters([
    line({ speaker: null, text: 'unattributed caption' }),
    line({ speaker: 'Unknown', text: 'also unattributed' }),
  ]);
  ok(encs.length === 0, 'CRITICAL: an unattributed line produces no attendance claim');
  const s = me.attendanceStats([line({ speaker: 'Bill Dunne' }), line({ speaker: null }), line({ speaker: null })]);
  ok(s.named === 1 && s.unnamed === 2 && s.people === 1,
    'the stats REPORT what was dropped — coverage must not look complete when most lines have no speaker');
}

// ── A MEETING IS ITS OWN ORIGIN ──────────────────────────────────────────────────────────────────
// Meetings have no URL. Left null, every meeting would collapse into one unattributable source, and
// three separate meetings attended by the same person would count as ONE.
{
  const a = me.attendanceEncounters([line({ meeting: 'meet-a', speaker: 'Bill Dunne' })]);
  const b = me.attendanceEncounters([line({ meeting: 'meet-b', speaker: 'Bill Dunne' })]);
  const c = me.attendanceEncounters([line({ meeting: 'meet-c', speaker: 'Bill Dunne' })]);
  const exists = [a, b, c].map((x) => x.find((e) => e.claim_class === 'existence'));
  ok(og.independence(exists).count === 3,
    `CRITICAL: three meetings are three independent observations (got ${og.independence(exists).count})`);
  // …and the same meeting seen twice is not two.
  const twice = [a[0], me.attendanceEncounters([line({ meeting: 'meet-a', speaker: 'Bill Dunne' })])[0]];
  ok(og.independence(twice).count === 1, 'CRITICAL: one meeting counted twice is still one source');
}

// ── SPEECH IS NON-VALIDATING ─────────────────────────────────────────────────────────────────────
//
// The rule this slice exists for. A meeting document decomposes down the SAME path as a .gov roster;
// without this its claims land graded B and promoted — hearsay wearing a document's authority.
{
  ok(de.isSpeech('meeting') && de.isSpeech('transcript') && de.isSpeech('conversation') && de.isSpeech('MEETING'),
    'speech lanes are recognised, case-insensitively');
  ok(!de.isSpeech('browser_download') && !de.isSpeech('research') && !de.isSpeech(null), 'document lanes are not speech');

  const obs = { sourceEntity: 'Jane Roe', relation: 'WORKS_FOR', target: 'Apache County', type: 'person', status: 'promoted' };
  const fromMeeting = de.toEncounter(obs, { id: 'meeting:9', source: 'meeting', origin_host: 'apachecountyaz.gov' });
  ok(fromMeeting.authority === 'stated',
    'CRITICAL: a claim made OUT LOUD is stated — zero evidentiary weight, a pointer to go verify');
  ok(fromMeeting.authority !== 'official',
    'CRITICAL: even in a .gov-hosted meeting record, saying it does not make it official');

  const fromDoc = de.toEncounter(obs, { id: 7, source: 'browser_download', origin_host: 'apachecountyaz.gov' });
  ok(fromDoc.authority === 'official', '…while the same claim in an actual .gov document IS official');

  // The payoff, through the real grader: repetition in meetings never becomes corroboration.
  const enc = require('../lib/encounters');
  const said = [fromMeeting, { ...fromMeeting, content_hash: 'h2' }, { ...fromMeeting, content_hash: 'h3' }];
  const g = enc.gradeValue('structural', said);
  ok(g.grade === null && g.unverified === true,
    'CRITICAL: three people saying it in meetings still grades NOTHING — it is work to do, not evidence');
}

ok(me.attendanceEncounters(null).length === 0 && me.attendanceEncounters([{}]).length === 0, 'garbage in → [], never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
