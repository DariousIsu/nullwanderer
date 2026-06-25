/**
 * Offline smoke for Super Search SLICE 5 (studio/super_search_ingest.js):
 * the auto-ingest-but-gated loop — dedup · provenance · reversible. Pure deterministic: the engine
 * save_source/archive tools are injected stubs, the ledger is in-memory, the clock is injected.
 *
 * Run: node scripts/smoke_super_search_ingest.js
 */
const { makeIngestor, makeMemoryLedger, ingestable } = require('../studio/super_search_ingest');
const { djb2 } = require('../studio/super_search_card');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ext = (over = {}) => ({ id: 'web:abc', plane: 'external', source: 'web', title: 'Cloud seeding', url: 'https://en.wikipedia.org/wiki/Cloud_seeding', snippet: 'a snippet', enrich: { body: 'Cloud seeding changes precipitation.' }, ...over });
const FIXED = '2026-06-24T12:00:00.000Z';

// ---- ingestable gate -------------------------------------------------------------------------
ok('gate: external+url+body is ingestable', ingestable(ext()).ok);
ok('gate: internal card rejected', ingestable({ ...ext(), plane: 'internal' }).reason === 'not_external');
ok('gate: external without url rejected', ingestable({ ...ext(), url: null }).reason === 'no_url');
ok('gate: external without any text rejected', ingestable({ ...ext(), snippet: '', enrich: {} }).reason === 'no_text');

(async () => {
  // ---- happy path: archives + writes a provenance ledger row ---------------------------------
  {
    const calls = [];
    const ing = makeIngestor({ callTool: async (t, a) => { calls.push({ t, a }); return { doc_id: 555 }; }, ledger: makeMemoryLedger(), now: () => FIXED });
    const r = await ing.ingestCard(ext(), { query: 'does cloud seeding work' });
    ok('ingest: returns ingested:true with an entry', r.ingested === true && !!r.entry);
    ok('ingest: called save_source with url + content + frontmatter', calls[0].t === 'save_source' && calls[0].a.original_url === ext().url && /changes precipitation/.test(calls[0].a.content_md));
    ok('ingest: provenance frontmatter (source/via/query/date)', calls[0].a.frontmatter.via === 'super_search' && calls[0].a.frontmatter.query === 'does cloud seeding work' && calls[0].a.frontmatter.collection_date === FIXED);
    ok('ingest: ledger row carries provenance + corpus ref', r.entry.ref === 555 && r.entry.query === 'does cloud seeding work' && r.entry.ingested_at === FIXED && r.entry.url === ext().url);
    ok('ingest: ledger id is deterministic (djb2 of url)', r.entry.id === djb2(ext().url));
    ok('ingest: ledger now has the url', ing.ledger.has(ext().url));
  }

  // ---- dedup: same url not archived twice ----------------------------------------------------
  {
    let n = 0;
    const ing = makeIngestor({ callTool: async () => { n++; return { doc_id: n }; }, ledger: makeMemoryLedger(), now: () => FIXED });
    await ing.ingestCard(ext(), { query: 'q1' });
    const dup = await ing.ingestCard(ext(), { query: 'q2' });
    ok('dedup: second ingest of same url skipped', dup.ingested === false && dup.reason === 'duplicate');
    ok('dedup: save_source called exactly once', n === 1);
  }

  // ---- fail-safe: engine error leaves the ledger untouched (retryable) -----------------------
  {
    const ing = makeIngestor({ callTool: async () => { throw new Error('vault offline'); }, ledger: makeMemoryLedger(), now: () => FIXED });
    const r = await ing.ingestCard(ext(), { query: 'q' });
    ok('fail-safe: ingested:false with the error reason', r.ingested === false && /vault offline/.test(r.reason));
    ok('fail-safe: ledger NOT written (url still retryable)', ing.ledger.has(ext().url) === false);
  }

  // ---- batch: mixed set splits into ingested / skipped ---------------------------------------
  {
    const ing = makeIngestor({ callTool: async () => ({ doc_id: 1 }), ledger: makeMemoryLedger(), now: () => FIXED });
    const cards = [
      ext({ id: 'web:1', url: 'https://a.com' }),
      { id: 'k:1', plane: 'internal', source: 'knowledge', title: 'x', snippet: 'y' },   // skipped: internal
      ext({ id: 'web:2', url: 'https://a.com' }),                                          // skipped: dup of a.com
      ext({ id: 'web:3', url: 'https://b.com' }),
    ];
    const res = await ing.ingestKept(cards, { query: 'topic' });
    ok('batch: two unique externals ingested', res.ingested.length === 2);
    ok('batch: internal + dup skipped with reasons', res.skipped.length === 2 && res.skipped.some(s => s.reason === 'not_external') && res.skipped.some(s => s.reason === 'duplicate'));
  }

  // ---- reversible: revert archives the doc + frees the url -----------------------------------
  {
    const calls = [];
    const ing = makeIngestor({ callTool: async (t, a) => { calls.push({ t, a }); return { doc_id: 777 }; }, ledger: makeMemoryLedger(), now: () => FIXED });
    const r = await ing.ingestCard(ext(), { query: 'q' });
    const rev = await ing.revert(r.entry.id);
    ok('revert: returns reverted:true', rev.reverted === true);
    ok('revert: archived the corpus doc by ref', calls.some(c => c.t === 'archive_document' && c.a.doc_id === 777));
    ok('revert: ledger row removed (url re-ingestable)', ing.ledger.has(ext().url) === false);
    const reAdd = await ing.ingestCard(ext(), { query: 'again' });
    ok('revert: same url can be ingested again after revert', reAdd.ingested === true);
    const missing = await ing.revert('nope');
    ok('revert: unknown id → reverted:false not_found', missing.reverted === false && missing.reason === 'not_found');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
