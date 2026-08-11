/**
 * Phase C backtest — importance scoring + storage.
 *
 * Deterministic, no model: covers the no-model fast path (quickScore), the
 * reply parser (parseScore), and the monologue.importance column round-trip.
 * The LLM scoring path itself is exercised live in the running app.
 *
 * Run under electron-as-node (see run cmd).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_imp_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const importance = require('../lib/importance');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

function run() {
  db.init();
  console.log('Phase C backtest — importance scoring\n');

  console.log('quickScore (no-model fast path):');
  ok('empty → 1', importance.quickScore('') === 1);
  ok('SKIP → 1', importance.quickScore('SKIP') === 1);
  ok('short fragment → 2', importance.quickScore('hmm, not sure') === 2);
  ok('bare opener → low', importance.quickScore('Okay.') <= 2);
  ok('silence-essay filler → 2', importance.quickScore('The silence in the room felt heavy and deliberate again tonight') === 2);
  ok('substantive thought → null (defer to model)',
    importance.quickScore('I realized the cold pitch should lead with the recipient\'s problem, not our product') === null);

  console.log('\nparseScore (model reply → int 1-10):');
  ok("'7' → 7", importance.parseScore('7') === 7);
  ok("'10' → 10", importance.parseScore('10') === 10);
  ok("'I would rate this an 8.' → 8", importance.parseScore('I would rate this an 8.') === 8);
  ok("'3/10' → 3", importance.parseScore('3/10') === 3);
  ok("'' → null", importance.parseScore('') === null);
  ok("'none' → null", importance.parseScore('none') === null);
  ok("'0' (invalid) → null", importance.parseScore('0') === null);

  console.log('\nmonologue.importance column round-trip:');
  const body = 'A substantive thought worth scoring and storing for later retrieval.';
  const r = db.insertMonologue({ content: body, model: 'test', type: 'thought', importance: 7 });
  const got = db.getRecentMonologueByType('thought', 1)[0];
  ok('importance persisted on insert', got && got.id === r.id && got.importance === 7);
  const r2 = db.insertMonologue({ content: 'no score given', type: 'thought' });
  const got2 = db.getRecentMonologueByType('thought', 1)[0];
  ok('importance nullable when omitted', got2 && got2.id === r2.id && got2.importance === null);

  ok('DEFAULT_SCORE exported and sane', importance.DEFAULT_SCORE >= 1 && importance.DEFAULT_SCORE <= 10);

  console.log('\nscoreDocument (C1 — deterministic document poignancy, no model call):');
  ok('browser_download flood → low (≤3)', importance.scoreDocument({ source: 'browser_download', body: 'x'.repeat(1000) }) <= 3);
  ok('news → low (≤3)', importance.scoreDocument({ source: 'news', body: 'x'.repeat(1000) }) <= 3);
  ok('deliverable → high (≥8)', importance.scoreDocument({ source: 'deliverable', body: 'x'.repeat(3000) }) >= 8);
  ok('meeting → high (≥7)', importance.scoreDocument({ source: 'meeting', body: 'x'.repeat(3000) }) >= 7);
  ok('unknown source → mid (5)', importance.scoreDocument({ source: 'whatever', body: 'x'.repeat(1000) }) === 5);
  ok('thin stub scores below its full-length base', importance.scoreDocument({ source: 'notes', body: 'tiny' }) < importance.scoreDocument({ source: 'notes', body: 'x'.repeat(1000) }));
  ok('synthesized research (no origin) beats a fetched page (with origin)', importance.scoreDocument({ source: 'research', body: 'x'.repeat(9000), origin: null }) > importance.scoreDocument({ source: 'browser_download', body: 'x'.repeat(9000), origin: 'https://x.com' }));
  ok('always clamped 1..10', (() => { const s = importance.scoreDocument({ source: 'deliverable', body: 'x'.repeat(50000) }); return s >= 1 && s <= 10; })());
  ok('bulk stays below deliverable (the triage signal C2/C3 use)', importance.scoreDocument({ source: 'browser_download', body: 'x'.repeat(3000) }) < importance.scoreDocument({ source: 'deliverable', body: 'x'.repeat(3000) }));

  console.log('\ndocuments.importance stamped at landing (doc_store.land → column round-trip):');
  const docStore = require('../lib/doc_store');
  const land1 = docStore.land({ title: 'A real deliverable', body: 'A substantial worked deliverable. '.repeat(200), source: 'deliverable', ref: 'imp-test-deliverable' });
  const drow = db.getDocumentByRef('imp-test-deliverable');
  ok('deliverable landed with a high importance stamp', land1.landed && drow && drow.importance >= 8);
  const land2 = docStore.land({ title: 'scraped page', body: 'some scraped web content here. '.repeat(200), source: 'browser_download', ref: 'imp-test-bulk', origin: 'https://example.com/page' });
  const brow = db.getDocumentByRef('imp-test-bulk');
  ok('browser_download landed with a low importance stamp', land2.landed && brow && brow.importance <= 3);
  ok('landing stamps bulk below deliverable (triage-ready)', brow && drow && brow.importance < drow.importance);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
