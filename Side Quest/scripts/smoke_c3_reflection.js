'use strict';
/* smoke_c3_reflection.js — Spine 4 / C3 foundation (docs/SPINE4_C3_GROUNDED_REFLECTION.md).
 * The two safe, testable C3 pieces: (1) reflection.isGrounded — a takeaway is a real FACT only if anchored to
 * external material (a reading, a url, or a landed document's origin via extraUrls), else SPECULATION (the
 * drift firewall); (2) db.getReflectionWorthyDocuments — the high-importance, un-reflected LANDED material the
 * significance reflection should synthesize over. Pure + one DB round-trip; no model. Electron-as-node. */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_c3_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
// The full-loop test (below) drives maybeSignificanceReflect, which calls ollama.streamChat. Override it
// with a canned EMPTY response BEFORE reflection is required (reflection destructures streamChat at load)
// so the live loop runs deterministically with NO model — exercising the empty-`recent` guard + the
// doc-cursor advance path without a network call. The routeReflection acceptance below does not use it.
const ollama = require('../lib/ollama');
// The full-loop test drives maybeSignificanceReflect, which calls ollama.streamChat. Override it BEFORE
// reflection is required (reflection destructures streamChat at load) to emit a canned GROUNDED takeaway,
// so the live loop runs deterministically with no model.
const CANNED_TAKEAWAY = "[KNOWLEDGE] Acadia Parish's police jury meets on the second Tuesday of each month.";
ollama.streamChat = async ({ onToken } = {}) => { if (onToken) onToken(CANNED_TAKEAWAY); };
const reflection = require('../lib/reflection');
const docStore = require('../lib/doc_store');
const memory = require('../lib/memory');
// The grounded fact WRITE goes through memory.storeDeduped → the WASM embed worker, which is unavailable in
// this hermetic smoke shell (it blocks smoke_reflection_delaunder here identically — an environment issue,
// not a C3 one). Stub the two memory calls so the test isolates the C3 ROUTING contract (grounded→fact vs
// ungrounded→speculation) from the embedder. reflection.js holds this same `memory` object → stub is seen.
let _storeCalls = 0;
memory.embed = async () => null;
memory.storeDeduped = async () => { _storeCalls++; return { action: 'add', id: _storeCalls }; };
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

  // C3 firewall (the two-sided acceptance, §33) at the routing layer, model-free: a takeaway with NO
  // external anchor (own thoughts, no readings, no doc origins) must route to SPECULATION, never a fact.
  // The speculation branch does not touch the embedder (delaunder proves the same offline).
  console.log('\nC3 firewall — own-thought-only takeaway → SPECULATION, not a fact:');
  const propsBefore = D.graphListPendingEntityProposals().length;
  const rUngrounded = await reflection.routeReflection(CANNED_TAKEAWAY, [{ id: 9, type: 'thought', content: 'idly thinking about acadia parish' }], { decideFn: () => 'distinct' });
  ok('ungrounded → NOT a fact (nKnow === 0)', rUngrounded.nKnow === 0);
  ok('ungrounded → speculation (nSpec === 1)', rUngrounded.nSpec === 1);
  ok('a gated proposal was queued, not a canonical fact', D.graphListPendingEntityProposals().length === propsBefore + 1);

  // C3 full loop — the delicate live step end-to-end: significance trips, `recent` (fresh thoughts) is
  // EMPTY but landed DOCS supply the material; the loop must fold the docs into the prompt, ground the
  // takeaway via the docs' ORIGINS (extraUrls → a real fact, NOT speculation), advance the DOC cursor, and
  // leave the monologue cursor alone (the recent[len-1] guard) — all without throwing.
  console.log('\nC3 full loop — empty thought stream + grounded landed docs → grounded fact + guarded cursors:');
  for (let i = 0; i < 5; i++) docStore.land({ title: `worked deliverable ${i}`, body: `Deliverable ${i}: distinct worked content on parish body number ${i}, item ${i}${i}${i}. `.repeat(150), source: 'deliverable', ref: `c3-loop-${i}`, origin: `https://acadiaparishpolicejury.org/doc${i}` });
  D.setMeta('reflection_importance_accum', '200');            // trip the significance threshold (150)
  D.setMeta('last_significance_doc_id', '0');
  D.setMeta('last_significance_monologue_id', '0');
  const reflBefore = D.getRecentReflections(50).length;
  const storeBefore = _storeCalls;
  let threw = false, did = null;
  try { did = await reflection.maybeSignificanceReflect(); } catch (e) { threw = true; console.log('    (threw:', e && e.message, ')'); }
  ok('did NOT throw on empty `recent` + docs present (the guard)', threw === false);
  ok('the loop fired (returned true)', did === true);
  ok('the takeaway routed to a grounded FACT (storeDeduped called once)', _storeCalls === storeBefore + 1);
  ok('a reflection note was written', D.getRecentReflections(50).length === reflBefore + 1);
  ok('doc cursor ADVANCED past 0', parseInt(D.getMeta('last_significance_doc_id') || '0', 10) > 0);
  ok('monologue cursor untouched (no fresh thoughts to mark)', (D.getMeta('last_significance_monologue_id') || '0') === '0');
  ok('accumulator reset to 0', (D.getMeta('reflection_importance_accum') || '') === '0');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.SQ_DB_PATH + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
})();
