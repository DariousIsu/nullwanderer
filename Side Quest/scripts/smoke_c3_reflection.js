'use strict';
/* smoke_c3_reflection.js — Spine 4 / C3 foundation (docs/SPINE4_C3_GROUNDED_REFLECTION.md).
 * The two safe, testable C3 pieces: (1) reflection.isGrounded — a takeaway is a real FACT only if anchored to
 * external material (a reading, a url, or a landed document's origin via extraUrls), else SPECULATION (the
 * drift firewall); (2) db.getReflectionWorthyDocuments — the high-importance, un-reflected LANDED material the
 * significance reflection should synthesize over. Pure + one DB round-trip; no model. Electron-as-node. */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_c3_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const reflection = require('../lib/reflection');
const docStore = require('../lib/doc_store');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('isGrounded (C3 — external anchor gates fact-vs-speculation, the drift firewall):');
  ok('a reading source → grounded', reflection.isGrounded([{ id: 1, type: 'reading' }], []) === true);
  ok('a sourceRow carrying urls → grounded', reflection.isGrounded([{ id: 1, urls: JSON.stringify(['https://x.com']) }], []) === true);
  ok('a landed doc origin (extraUrls) → grounded', reflection.isGrounded([], ['https://acadiaparish.gov/']) === true);
  ok('own-thoughts only (no reading/url/doc) → NOT grounded (→ speculation)', reflection.isGrounded([{ id: 1, type: 'thought' }], []) === false);
  ok('empty window → not grounded', reflection.isGrounded([], []) === false);
  ok('malformed urls JSON → not grounded, no throw', reflection.isGrounded([{ id: 1, urls: '{not json' }], []) === false);

  console.log('\ngetReflectionWorthyDocuments (C3 — the synthesis input):');
  docStore.land({ title: 'LA parish dossier', body: 'A worked deliverable dossier body here. '.repeat(150), source: 'deliverable', ref: 'c3-deliv' });
  docStore.land({ title: 'meeting notes', body: 'Live meeting notes captured here. '.repeat(150), source: 'meeting', ref: 'c3-meet' });
  docStore.land({ title: 'scraped page', body: 'scraped bulk web content here. '.repeat(150), source: 'browser_download', ref: 'c3-bulk', origin: 'https://ex.com/p' });
  const worthy = D.getReflectionWorthyDocuments({ sinceId: 0, minImportance: 6, limit: 10 });
  ok('includes the deliverable (importance ≥ 6)', worthy.some((d) => d.title === 'LA parish dossier'));
  ok('includes the meeting notes (importance ≥ 6)', worthy.some((d) => d.title === 'meeting notes'));
  ok('EXCLUDES the browser_download bulk (importance < 6)', !worthy.some((d) => d.title === 'scraped page'));
  ok('rows carry origin (the grounding / extraUrls source)', worthy.every((d) => 'origin' in d));
  const maxId = worthy.reduce((m, d) => Math.max(m, d.id), 0);
  ok('cursor (sinceId) excludes already-reflected docs', D.getReflectionWorthyDocuments({ sinceId: maxId, minImportance: 6, limit: 10 }).length === 0);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.SQ_DB_PATH + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
})();
