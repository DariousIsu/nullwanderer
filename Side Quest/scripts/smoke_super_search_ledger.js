/**
 * Offline smoke for the persistent ingest ledger (lib/super_search_ledger.js): write → reload →
 * dedup → remove, against a throwaway temp file. Proves the slice-5 ingestor's "reversible +
 * dedup-across-restarts" promise holds with the real file-backed ledger.
 *
 * Run: node scripts/smoke_super_search_ledger.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeFileLedger } = require('../lib/super_search_ledger');
const { makeIngestor } = require('../studio/super_search_ingest');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const tmp = path.join(os.tmpdir(), `ss_ledger_${process.pid}.json`);
try { fs.unlinkSync(tmp); } catch (e) {}

(async () => {
  // boot on a missing file → empty, no throw
  const led1 = makeFileLedger(tmp);
  ok('boot on missing file → empty', led1.list().length === 0);

  // ingest one external card through the real ingestor + file ledger
  const ing = makeIngestor({ callTool: async () => ({ doc_id: 9 }), ledger: led1, now: () => '2026-06-24T00:00:00Z' });
  const card = { id: 'web:x', plane: 'external', source: 'web', title: 'T', url: 'https://example.com/a', snippet: 'body text here' };
  const r = await ing.ingestCard(card, { query: 'q' });
  ok('ingest writes a ledger row', r.ingested === true && led1.list().length === 1);
  ok('ledger file persisted to disk', fs.existsSync(tmp));

  // a FRESH ledger reading the same file sees the row → dedup survives "restart"
  const led2 = makeFileLedger(tmp);
  ok('reload sees the persisted row', led2.has('https://example.com/a'));
  const ing2 = makeIngestor({ callTool: async () => { throw new Error('should not archive a dup'); }, ledger: led2, now: () => 'x' });
  const dup = await ing2.ingestCard(card, { query: 'q2' });
  ok('dedup across restart (no re-archive)', dup.ingested === false && dup.reason === 'duplicate');

  // revert frees the url, persisted
  const rev = await ing2.revert(r.entry.id);
  ok('revert removes the row', rev.reverted === true && led2.list().length === 0);
  const led3 = makeFileLedger(tmp);
  ok('removal persisted (fresh read is empty)', led3.list().length === 0);

  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
