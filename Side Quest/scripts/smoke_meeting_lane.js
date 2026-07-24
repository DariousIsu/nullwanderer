/* Smoke: lib/meeting_lane — the meeting/scribe data channel → memory pipeline. Proves the transcript
 * formatter, the title, the building-project notes document + companion transcript pair, the heartbeat
 * pointer (lane isolation), and the live DB landing (notes primary + transcript linked via parent_id).
 * Uses an ISOLATED temp DB (SQ_DB_PATH) for the land() round-trip.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meeting_lane.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_meetinglane_smoke_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db'); db.init();
const ml = require('../lib/meeting_lane');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- formatTranscript ---
ok(ml.formatTranscript([{ speaker: 'Lucas', text: 'hi' }, { speaker: '', text: 'noted' }, { text: '' }]) === 'Lucas: hi\nnoted', 'formatTranscript diarizes + drops empties');
ok(ml.formatTranscript(null) === '', 'formatTranscript(null) → "" (no throw)');

// --- meetingTitle ---
ok(ml.meetingTitle({ url: 'https://meet.google.com/abc-defg-hij', dateStr: 'Jun 30' }) === 'Meeting notes — abc-defg-hij (Jun 30)', 'title carries the meet code + date');
ok(ml.meetingTitle({}) === 'Meeting notes', 'no url → bare title');

// --- buildArtifacts ---
const a = ml.buildArtifacts({ title: 'Meeting notes — abc', minutes: 'Topics: data centers', recap: 'Discussed data centers; Lucas to draft LA content.', transcriptText: 'Lucas: we should cover Louisiana.\nSean: agreed.' });
ok(a.notes && /Discussed data centers/.test(a.notes.body) && /## Running minutes/.test(a.notes.body), 'notes = recap + running minutes (building-project document)');
ok(a.notes.source === 'meeting' && /Lucas to draft/.test(a.notes.understanding), 'notes tagged source=meeting + understanding from recap');
ok(a.transcript && a.transcript.source === 'meeting_transcript' && /Louisiana/.test(a.transcript.body), 'companion transcript built, tagged meeting_transcript');
ok(/^Transcript — abc/.test(a.transcript.title), 'companion title derives from the notes title');

ok(ml.buildArtifacts({ recap: '', minutes: '', transcriptText: 'x' }).notes === null, 'no recap/minutes → no notes doc');
ok(ml.buildArtifacts({ recap: 'something real here', transcriptText: 'short' }).transcript === null, 'trivial transcript → no companion');

// --- pointer (lane isolation) ---
ok(/scribing Meeting notes — abc — 12 transcript lines/.test(ml.pointer({ title: 'Meeting notes — abc', lines: 12 })), 'pointer is a heartbeat summary, not the raw stream');

// --- land(): the live DB round-trip — notes primary + companion linked via parent_id ---
db.setMeta('gmeet_url', 'https://meet.google.com/abc-defg-hij');
db.setMeta('gmeet_started_at', '1000');
db.insertTranscriptLine({ meeting: 'abc', speaker: 'Lucas', text: 'We should cover Louisiana for the data center push.', ts: 1100 });
db.insertTranscriptLine({ meeting: 'abc', speaker: 'Sean', text: 'Agreed, I will pull the support data.', ts: 1200 });
const res = ml.land({ minutes: 'Topics: data centers\nAction items: Lucas — LA content', recap: 'The group discussed data-center messaging; Lucas owns Louisiana content.' });
ok(res.landed === true && res.notesId, 'land() stored the notes document');
ok(res.hasTranscript === true && res.transcriptId, 'land() stored the companion transcript');
const notesDoc = db.getDocument(res.notesId);
const txDoc = db.getDocument(res.transcriptId);
ok(notesDoc.source === 'meeting' && /Louisiana content/.test(notesDoc.body), 'notes doc persisted with source=meeting');
ok(txDoc.source === 'meeting_transcript' && txDoc.parent_id === res.notesId, 'companion transcript LINKED to the notes via parent_id');
ok(/Lucas: We should cover Louisiana/.test(txDoc.body), 'companion transcript holds the diarized lines');
ok(db.listUnpromotedDocuments(10).length === 2, 'both land un-promoted → flow into the nightly promotion');

// --- audio transcript (virtual-cable path) overrides captions as the companion ---
db.setMeta('gmeet_started_at', '1000');
const res2 = ml.land({ minutes: 'm', recap: 'r', audioTranscript: 'Sean McElwee: I will pull the polling data and email Devon about the study.' });
const audioTx = db.getDocument(res2.transcriptId);
ok(/I will pull the polling data and email Devon/.test(audioTx.body), 'Echo AUDIO transcript is used as the companion when provided (preferred over captions)');

// --- fail-safe: nothing to land ---
db.setMeta('gmeet_started_at', '9999999999999');   // no transcript after this
const empty = ml.land({ minutes: '', recap: '' });
ok(empty.landed === false, 'no recap/minutes → nothing landed (no throw)');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
