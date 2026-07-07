/* Smoke: PUBLIC-profile confirmation (face-match Slice 2b) — pure candidate extraction + the injected-deps
 * orchestration (mocked search/image/face) + puller_db face_embedding storage. No browser / no model.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_profile_confirm.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.PULLER_DB_PATH = path.join(os.tmpdir(), `puller_profile_${Date.now()}.db`);
const pc = require('../lib/profile_confirm');
const pdb = require('../lib/puller_db'); pdb.init();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- platformOf / pickProfileCandidates ---
ok(pc.platformOf('https://www.linkedin.com/in/jane-doe') === 'LinkedIn', 'linkedin.com/in/ → LinkedIn');
ok(pc.platformOf('https://x.com/janedoe') === 'X', 'x.com/handle → X');
ok(pc.platformOf('https://github.com/janedoe') === 'GitHub', 'github.com/user → GitHub');
ok(pc.platformOf('https://www.cnn.com/2026/politics') === null, 'a news URL → not a profile');
ok(pc.platformOf('https://x.com/search?q=x') === null, 'x.com/search → not a profile');

const results = [
  { url: 'https://www.linkedin.com/in/jane-doe', title: 'Jane Doe | LinkedIn' },
  { url: 'https://x.com/janedoe', title: 'Jane Doe (@janedoe)' },
  { url: 'https://www.cnn.com/story', title: 'unrelated news' },
  { url: 'https://github.com/janedoe', title: 'janedoe · GitHub' },
  { url: 'https://www.linkedin.com/in/jane-doe/', title: 'dup' },   // trailing-slash dup
];
const cands = pc.pickProfileCandidates(results, { max: 6 });
ok(cands.length === 3, `3 public-profile candidates (news dropped, dup collapsed) — got ${cands.length}`);
ok(cands.every((c) => c.platform), 'every candidate is tagged with a platform');
ok(!cands.some((c) => /cnn/.test(c.url)), 'the news URL is not a candidate');
ok(pc.buildProfileQuery('Jane Doe', 'Acme').includes('Jane Doe') && pc.buildProfileQuery('Jane Doe', 'Acme').includes('Acme'), 'query includes name + org');

// --- confirmProfiles orchestration (mocked deps) ---
(async () => {
  const search = async () => results;
  const fetchProfileImage = async (url) => `img:${url}`;                       // every candidate has a photo
  const confirmFace = async (_ref, imgUrl) => ({ same: /linkedin/.test(imgUrl), similarity: /linkedin/.test(imgUrl) ? 0.71 : 0.10 });
  const refEmbedding = Array.from({ length: 8 }, () => 0.3);

  const res = await pc.confirmProfiles({ name: 'Jane Doe', org: 'Acme', refEmbedding, search, fetchProfileImage, confirmFace });
  ok(res.ok && res.matches.length === 1 && res.matches[0].platform === 'LinkedIn', `only the face-matched profile is kept — got ${res.matches.length}`);
  ok(res.checked === 3, `checked all 3 candidates that had a photo — got ${res.checked}`);

  const noRef = await pc.confirmProfiles({ name: 'x', refEmbedding: [], search, fetchProfileImage, confirmFace });
  ok(noRef.ok === false && noRef.reason === 'no-reference-embedding', 'no reference embedding → refuses (safe)');

  const noDeps = await pc.confirmProfiles({ name: 'x', refEmbedding: [0.1] });
  ok(noDeps.ok === false && noDeps.matches.length === 0, 'missing deps → fail-soft, no matches');

  // --- puller_db face_embedding storage (migration column) ---
  const t = pdb.createTarget({ kind: 'person', name: 'Jane Doe' });
  ok(pdb.getFaceEmbedding(t.id) === null, 'new target has no cached embedding');
  pdb.setFaceEmbedding(t.id, refEmbedding);
  const got = pdb.getFaceEmbedding(t.id);
  ok(Array.isArray(got) && got.length === 8 && Math.abs(got[0] - 0.3) < 1e-9, 'setFaceEmbedding / getFaceEmbedding round-trips the vector');

  pdb.close();
  try { require('fs').rmSync(process.env.PULLER_DB_PATH, { force: true }); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
