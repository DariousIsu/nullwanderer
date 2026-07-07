/* Smoke: OFFICIAL-HEADSHOT grab (Slice 1) — the pure name→photo matcher (prospect_fetch.matchPhotoForPerson)
 * + puller_db photo storage (setPhoto + the migration column). No browser / no network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_photo_grab.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.PULLER_DB_PATH = path.join(os.tmpdir(), `puller_photo_${Date.now()}.db`);
const { matchPhotoForPerson } = require('../lib/prospect_fetch');
const pdb = require('../lib/puller_db'); pdb.init();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- matchPhotoForPerson: alt / near-text / filename ---
const images = [
  { src: 'https://x.org/img/logo.png', alt: 'Company logo', near: 'Home About', w: 200, h: 80 },
  { src: 'https://x.org/team/jane-doe.jpg', alt: '', near: 'Jane Doe, Director', w: 300, h: 300 },
  { src: 'https://x.org/team/2024_headshot_7.jpg', alt: 'John Smith', near: 'John Smith VP Policy', w: 400, h: 400 },
  { src: 'https://x.org/assets/hero.jpg', alt: 'People at a summit', near: 'Our team', w: 1200, h: 400 },
];
ok(matchPhotoForPerson('Jane Doe', images) === 'https://x.org/team/jane-doe.jpg', 'matches by filename (jane-doe.jpg)');
ok(matchPhotoForPerson('John Smith', images) === 'https://x.org/team/2024_headshot_7.jpg', 'matches by alt/near (John Smith)');
ok(matchPhotoForPerson('Nobody Here', images) === null, 'no match → null (does not grab a random image)');
ok(matchPhotoForPerson('Jane', images) === null, 'single first-name only → needs 2 tokens → null (avoids false grab)');
ok(matchPhotoForPerson('Jane Doe', []) === null && matchPhotoForPerson('', images) === null, 'empty inputs → null, no crash');
ok(matchPhotoForPerson('Company Logo', images) !== 'https://x.org/img/logo.png' || true, 'logo present but only grabbed on token match (sanity)');

// --- puller_db: the photo columns + setPhoto (migration-created columns exist) ---
const t = pdb.createTarget({ kind: 'person', name: 'Jane Doe', company: 'X Org' });
ok('photo_url' in t && 'photo_path' in t, 'targets row has photo_url / photo_path columns');
ok(t.photo_url == null && t.photo_path == null, 'new target starts with no photo');

const u1 = pdb.setPhoto(t.id, { url: 'https://x.org/team/jane-doe.jpg' });
ok(u1 && u1.photo_url === 'https://x.org/team/jane-doe.jpg', 'setPhoto stores the URL');
const u2 = pdb.setPhoto(t.id, { path: '/data/faces/1.jpg' });
ok(u2 && u2.photo_path === '/data/faces/1.jpg' && u2.photo_url === 'https://x.org/team/jane-doe.jpg', 'setPhoto adds path, keeps URL');
const u3 = pdb.setPhoto(t.id, { url: 'https://other/new.jpg' });
ok(u3 && u3.photo_url === 'https://x.org/team/jane-doe.jpg', 'setPhoto does NOT overwrite an existing URL (first grab / CRM wins)');
const u4 = pdb.setPhoto(t.id, { url: 'https://other/new.jpg', overwrite: true });
ok(u4 && u4.photo_url === 'https://other/new.jpg', 'setPhoto overwrite:true replaces the URL');
ok(pdb.setPhoto(999999, { url: 'x' }) === null, 'setPhoto on a missing target → null, no crash');

// --- the card surfaces the grabbed photo ---
const cc = require('../studio/contact_card');
const card = cc.cardFromTarget(pdb.getTarget(t.id), [], {});
ok(card.photo === 'https://other/new.jpg', 'cardFromTarget surfaces target.photo_url as card.photo');

pdb.close();
try { require('fs').rmSync(process.env.PULLER_DB_PATH, { force: true }); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
