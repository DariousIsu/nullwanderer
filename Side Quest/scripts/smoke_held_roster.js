/* Smoke: lib/held_roster — chat-path homecoming. A "list/roster of X" request is answered from a
 * roster she HOLDS (doc match + body-verified officials table), not the empty contacts store. THE
 * PROOF: the parish-contacts request that made her confabulate "the list is empty" now returns the
 * extracted 3+-parish answer, cited, with an explicit "do NOT say empty". Temp SQ_DB_PATH.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_held_roster.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = path.join(os.tmpdir(), `zoe-held-roster-${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
process.env.SQ_DB_PATH = path.join(TMP, 'sq.db');
fs.mkdirSync(TMP, { recursive: true });
const db = require('../lib/db'); db.init();
const HR = require('../lib/held_roster');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// A real roster: header + party-committee noise + 3 parishes' offices.
const roster = ['| Office Title | Parish | Candidate Name |', '| --- | --- | --- |',
  '| DSCC Member | | Party Person |', '| Sheriff | Acadia | Al Adams |', '| Police Juror | Acadia | Bo Best |',
  '| Sheriff | Allen | Cy Cole |', '| Parish President | Ascension | Di Doe |', '| Sheriff | Ascension | Ed Eng |'].join('\n');
const rdoc = db.insertDocument({ title: 'LA-parish-officials-2026.xls', body: roster, source: 'browser_download' });
// A non-roster table (meetings) — must NOT be mistaken for a roster.
const meetings = ['| Date | Topic | Room |', '| --- | --- | --- |', '| 2026-02-01 | Budget | A |', '| 2026-02-08 | Zoning | B |'].join('\n');
db.insertDocument({ title: 'my-meetings-2026.md', body: meetings, source: 'note' });

// --- topic tokens ---
ok(HR._topicTokens('how is the list of LA parish contacts coming?').includes('parish'), '_topicTokens: pulls the distinctive noun ("parish") from a list request');
ok(!HR._topicTokens('how is the list of LA parish contacts coming?').includes('contacts'), '_topicTokens: drops filler ("contacts", "list", "coming")');

// --- the measured failure, fixed ---
const hit = HR.recognize('How is the list of LA parish contacts coming?', { deps: { db } });
ok(hit && hit.docId === rdoc.id, 'recognize: a parish-contacts request finds the held roster doc (not the empty contacts store)');
ok(hit && /Al Adams/.test(hit.block) && /Di Doe/.test(hit.block) && !/Party Person/.test(hit.block), 'recognize: the block carries the real names, party-committee row excluded');
ok(hit && /do NOT say the list is empty/i.test(hit.block) && new RegExp(`cite doc #${rdoc.id}`).test(hit.block), 'recognize: steers to present + cite + never "empty"');
ok(hit && hit.groups === 3, 'recognize: all 3 parishes grouped');

// --- P2 (PLAN_MAP §2): recognize exposes the CLEAN extracted roster TEXT for the canvas product ---
ok(hit && hit.text && /Al Adams/.test(hit.text) && /Di Doe/.test(hit.text), 'recognize: .text carries the organized roster names (for the canvas doc)');
ok(hit && hit.text && !/do NOT say the list is empty/i.test(hit.text) && !/YOU ALREADY HOLD/i.test(hit.text), 'recognize: .text is CLEAN — no chat-only framing, ready to seed a canvas doc');
// a bare delivery-promise TOPIC resolves the same held roster (the P3 net → P2 product hand-off)
const viaTopic = HR.recognize('Louisiana parish contacts', { deps: { db } });
ok(viaTopic && viaTopic.docId === rdoc.id && !!viaTopic.text, 'recognize: a bare promise topic ("Louisiana parish contacts") resolves the held roster + exposes its text');

// --- guards: no false positives ---
ok(HR.recognize('what is the weather in Baton Rouge today?', { deps: { db } }) === null, 'recognize: a plain question (not a list request) → null');
ok(HR.recognize('list my meetings for February', { deps: { db } }) === null, 'recognize: a list request whose only match is a NON-roster table → null (body verification gates it)');
ok(HR.recognize('give me the roster of Ohio county sheriffs', { deps: { db } }) === null, 'recognize: a list request with no held doc on that topic → null');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
try { db.getDb().close(); } catch {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
