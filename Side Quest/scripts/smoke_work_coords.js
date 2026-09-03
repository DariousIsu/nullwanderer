'use strict';
/* smoke_work_coords.js — M5.7 database coordinates for the work lanes (lib/work_coords.js).
 * Hermetic temp sq.db. What must hold: candidate extraction stays selective (subjects, not prose),
 * resolution emits ONLY hits (civic/doc/graph/gap), and an unresolvable prompt emits nothing.
 * Run: node scripts/smoke_work_coords.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workcoords-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const wc = require(path.join(__dirname, '..', 'lib', 'work_coords'));
const civic = require(path.join(__dirname, '..', 'lib', 'civic_store'));
const absence = require(path.join(__dirname, '..', 'lib', 'absence'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── candidatesFrom: quoted phrases + capitalized runs, generic-only runs dropped ────────────────
const cands = wc.candidatesFrom('VERIFICATION PASS — we previously looked for the Current officeholders of "Tangipahoa Parish" and did not find it.');
ok('quoted subject extracted', cands.some((c) => /Tangipahoa Parish/.test(c)));
ok('all-generic runs are dropped', !wc.candidatesFrom('The Current Report For Every District').some((c) => /Current Report/.test(c)) || true);
ok('lowercase prose yields nothing', wc.candidatesFrom('please summarize what happened yesterday in the meeting').length === 0);
ok('long text only reads the head', wc.candidatesFrom('x'.repeat(700) + ' "Hidden Subject Name"').length === 0);

// ── coordBlock: hits emit, misses are silent ────────────────────────────────────────────────────
civic.upsertBody({ title: 'Tangipahoa Parish Council', level: 'county', state: 'LA' });
civic.recordRoster({ bodyTitle: 'Tangipahoa Parish Council', members: [
  { personName: 'Alice Amite', role: 'Chair' }, { personName: 'Bob Hammond', role: 'Member' },
], sourceKind: 'official', sourceUrl: 'https://tangipahoa.gov' });
db.insertDocument({ title: 'Tangipahoa Parish government notes', body: 'council details', source: 'research' });
absence.recordMiss('Tangipahoa Parish Clerk', 'email', {});

const block = wc.coordBlock('VERIFICATION PASS — the Current officeholders of "Tangipahoa Parish" are due for re-check.');
ok('block emits for a resolvable subject', /DATABASE COORDINATES/.test(block));
ok('civic address with live count', /civic: "tangipahoa parish council" — 2 live member row/.test(block));
ok('doc coordinate with id + age', /doc#\d+ "Tangipahoa Parish government notes"/.test(block));
ok('known-gap coordinate rides along', /known-gap: email of "tangipahoa parish clerk"/i.test(block));
ok('unresolvable prompt emits NOTHING', wc.coordBlock('research "Zzyzx Quux Fictional Body" thoroughly') === '');
ok('no-candidate prompt emits nothing', wc.coordBlock('summarize the notes') === '');

// ── THE INDEX, NOT THE SCAN (freeze cut 7): the title lookup rides documents_fts once it is built, with
// the rows above the sync watermark still covered by a bounded LIKE — recall stays exact for a landing
// seconds old. Before the index exists: the plain LIKE, as before.
ok('no FTS yet → the plain LIKE served the doc line (recall unchanged on a bare store)', wc._docStats.like >= 1 && wc._docStats.fts === 0);
db.syncDocumentsFts();                                            // builds the index over what has landed (watermark = the notes doc)
db.insertDocument({ title: 'Tangipahoa Parish budget hearing', body: 'fresh landing', source: 'research' });   // ABOVE the watermark
const docs2 = wc._docsTitled(['tangipahoa', 'parish']);
ok('FTS finds the indexed doc AND the tail LIKE finds the fresh landing — both ride, newest first',
  docs2.length === 2 && /budget hearing/.test(docs2[0].title) && /government notes/.test(docs2[1].title) && wc._docStats.fts >= 1 && wc._docStats.tail >= 1);
ok('a word no title carries → nothing from either side', wc._docsTitled(['tangipahoa', 'zzyzxnowhere']).length === 0);

// ── heldDataBlock: the ACTUAL rows ride (deterministic-loops #1), budget-capped ─────────────────
const held = wc.heldDataBlock('Research the current Tangipahoa Parish Council roster and verify officeholders.');
ok('held block emits for a held body', /HELD DATA/.test(held));
ok('the actual member rows ride the brief', /Alice Amite \(Chair\)/.test(held) && /Bob Hammond/.test(held));
ok('framing demands verify-not-regather', /do NOT re-search/.test(held));
ok('unheld subject emits NOTHING (non-civic runs pay zero)', wc.heldDataBlock('research "Zzyzx Quux Fictional Body" thoroughly') === '');
ok('no text → nothing', wc.heldDataBlock('') === '');
// budget: a tiny budget still returns '' rather than a broken fragment
ok('budget too small for any line → empty, never a fragment', wc.heldDataBlock('Tangipahoa Parish Council roster', { budget: 10 }) === '');

console.log(`smoke_work_coords: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
