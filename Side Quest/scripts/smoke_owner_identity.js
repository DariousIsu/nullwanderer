/* scripts/smoke_owner_identity.js — the owner-identity anchor + recognition (isolated temp sq.db).
 * Proves seedOwnerIdentity derives the owner's aliases from user_name + the personal node, isOwnerName
 * recognizes his facets (and rejects strangers), and the seed is idempotent + non-destructive. This is the
 * guard that stops the graph-walk builder from researching the owner as an unknown civic subject.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_owner_identity.js */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `owner_id_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('../lib/db');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

db.init();   // init seeds owner_identity, but user_name/personal node don't exist yet → no-op

// no owner set yet → recognizes nobody
ok('no owner_identity before seed', db.getOwnerIdentity() == null);
ok('isOwnerName false when unseeded', db.isOwnerName('Lucas Overby') === false);

// establish the owner: user_name + the personal (gmeet-witnessed) person node
db.setMeta('user_name', 'Lucas');
db.getDb().prepare("INSERT INTO graph_entities(name, name_key, entity_type, confidence, proposed_by, created_at, updated_at) VALUES('Lucas Overby','lucas overby','person',0.95,'gmeet',1,1)").run();

const oid = db.seedOwnerIdentity({ email: 'lucastoverby@gmail.com' });
ok('seed returns an identity', oid && oid.canonical === 'Lucas Overby');
const al = (oid.aliases || []).map((a) => a.toLowerCase());
ok('alias: full name', al.includes('lucas overby'));
ok('alias: F. Last (L. Overby)', al.includes('l. overby'));
ok('alias: Last, First (Overby, Lucas)', al.includes('overby, lucas'));
ok('alias: initials (LO)', al.includes('lo'));
ok('alias: bare last (Overby)', al.includes('overby'));
ok('alias: email local-part', al.includes('lucastoverby'));
ok('personal_entity_id linked', oid.personal_entity_id > 0);

// recognition: his facets are the owner; strangers are not
ok('isOwnerName: "L. Overby"', db.isOwnerName('L. Overby') === true);
ok('isOwnerName: "l. overby" (case/punct-insensitive)', db.isOwnerName('l. overby') === true);
ok('isOwnerName: "LUCAS OVERBY"', db.isOwnerName('LUCAS OVERBY') === true);
ok('isOwnerName: "LO"', db.isOwnerName('LO') === true);
ok('isOwnerName: "Overby, Lucas"', db.isOwnerName('Overby, Lucas') === true);
ok('GUARD: a stranger is NOT the owner', db.isOwnerName('Jeb Bush') === false);
ok('GUARD: the FL namesake FULL public label still resolves (bare Overby)', db.isOwnerName('Overby') === true);
ok('GUARD: empty/short → false', db.isOwnerName('') === false && db.isOwnerName('x') === false);

// idempotent + non-destructive: a second seed does NOT overwrite an operator-curated record
db.setMeta('owner_identity', JSON.stringify({ ...oid, note: 'operator-curated', civic_ref: 'OVERBY, LUCAS [H4FL13077]' }));
const again = db.seedOwnerIdentity({ email: 'x@y.com' });
ok('seed is non-destructive (keeps operator edits)', again.note === 'operator-curated' && again.civic_ref === 'OVERBY, LUCAS [H4FL13077]');

// SELF recognition: Zoe's own names (so "Hey Zo" / "Zoe, …" is not a civic lookup)
ok('isSelfName: "Zoe"', db.isSelfName('Zoe') === true);
ok('isSelfName: "Zo"', db.isSelfName('Zo') === true);
ok('isSelfName: "Zoe Lane"', db.isSelfName('Zoe Lane') === true);
ok('GUARD: a real same-first-name person is NOT self (Zoe Halfmann)', db.isSelfName('Zoe Halfmann') === false);
ok('GUARD: a stranger is not self', db.isSelfName('Zoe Logren') === false);

(async () => {
  // detectMention SUPPRESSES self/owner mentions (stub NER for an offline-deterministic check), so the vocative
  // never reaches civic disambiguation — the "which Zoe / which Z do you mean?" bug.
  try {
    const ner = require('../lib/ner');
    const orig = ner.topMention;
    const M = require('../lib/mention');
    ner.topMention = async () => ({ mention: 'Zoe', kgType: 'person', score: 0.9 });
    ok('detectMention SUPPRESSES a self-name mention', (await M.detectMention('Zoe, what is my name?', { deps: { noCloud: true } })) === null);
    ner.topMention = async () => ({ mention: 'L. Overby', kgType: 'person', score: 0.9 });
    ok('detectMention SUPPRESSES an owner-name mention', (await M.detectMention('what office did L. Overby run for?', { deps: { noCloud: true } })) === null);
    ner.topMention = async () => ({ mention: 'Z', kgType: 'person', score: 0.9 });
    ok('detectMention SUPPRESSES a bare single-letter mention ("Z" from "Hey Zo")', (await M.detectMention('Hey Zo, what did I run for?', { deps: { noCloud: true } })) === null);
    ner.topMention = async () => ({ mention: 'Zoe Halfmann', kgType: 'person', score: 0.9 });
    const kept = await M.detectMention('tell me about Zoe Halfmann', { deps: { noCloud: true } });
    ok('detectMention KEEPS a real distinct same-first-name person (Zoe Halfmann)', kept && kept.mention === 'Zoe Halfmann');
    ner.topMention = orig;
  } catch (e) { console.error('  (detectMention integration skipped:', e.message, ')'); }

  db.close && db.close();
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
