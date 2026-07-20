/* scripts/extract_doc_contacts.js — run contact extraction over the short-term document corpus.
 *
 * Makes her own research reachable: lib/contact_extract pulls PERSON cards out of each document,
 * lib/doc_contacts stores them WITH the document they came from, and gatherHeldContacts reads them as a
 * third source alongside Puller and CRM. See lib/doc_contacts.js for why this exists.
 *
 * DRY-RUN BY DEFAULT — prints what it would extract from a small sample without calling the model or
 * writing anything. --apply runs extraction for real.
 *
 *   --apply          write results (otherwise sample + report only)
 *   --limit N        documents to process this run (default 25; the corpus is thousands)
 *   --min-length N   skip documents shorter than N chars (default 200)
 *   --match TEXT     only documents whose title/body contains TEXT (work a specific backlog first)
 *
 * Bounded per run ON PURPOSE: extraction is a model call per ~6k chunk, so this is a lane you run
 * repeatedly (or from the app's idle loop), not a single batch that ties up the machine.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/extract_doc_contacts.js [--apply] [--limit N]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const dc = require('../lib/doc_contacts');
const ce = require('../lib/contact_extract');

db.init();
const argv = process.argv;
const APPLY = argv.includes('--apply');
const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt; };
const LIMIT = arg('--limit', 25);
const MIN_LEN = arg('--min-length', 200);
const MATCH = (() => { const i = argv.indexOf('--match'); return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : null; })();

(async () => {
  const before = dc.stats();
  console.log(`\nDOC-CONTACT EXTRACTION — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(72)}`);
  console.log(`corpus: ${before.docsScanned} scanned, ${before.docsPending} pending | stored: ${before.contacts} rows / ${before.people} people${MATCH ? ` | filter: "${MATCH}"` : ''}`);

  const docs = dc.pendingDocs({ limit: LIMIT, minLength: MIN_LEN, match: MATCH });
  if (!docs.length) { console.log('\nNothing pending — every document has been scanned at its current version.'); process.exit(0); }
  console.log(`\nprocessing ${docs.length} document(s)…\n`);

  if (!APPLY) {
    // No model calls in a dry run — show WHAT would be processed and the state each would be filed under,
    // which is the part most likely to be wrong and cheapest to eyeball before spending tokens.
    for (const d of docs.slice(0, 10)) {
      const row = db.getDb().prepare('SELECT body FROM documents WHERE id = ?').get(d.id);
      const st = dc.inferState(`${d.title || ''}\n${(row && row.body) || ''}`);
      const chunks = ce.chunkForExtraction((row && row.body) || '').chunks.length;
      console.log(`  [${d.id}] ${String(d.title || '(untitled)').slice(0, 54).padEnd(54)} ${String(d.len).padStart(7)}ch  ${String(chunks).padStart(3)} chunk(s)  state=${st || '—'}`);
    }
    if (docs.length > 10) console.log(`  … and ${docs.length - 10} more`);
    console.log(`\nDry run — no model calls, nothing written. Re-run with --apply.`);
    process.exit(0);
  }

  const { complete } = require('../lib/ollama');
  const model = require('../lib/config').extractionModel();
  let totalFound = 0, totalChunks = 0, failures = 0;

  for (const d of docs) {
    const row = db.getDb().prepare('SELECT body FROM documents WHERE id = ?').get(d.id);
    const body = (row && row.body) || '';
    const state = dc.inferState(`${d.title || ''}\n${body}`);
    const { chunks } = ce.chunkForExtraction(body);
    let found = 0;
    for (const chunk of chunks) {
      let raw = '';
      try {
        raw = await complete({ model, messages: ce.buildCardsPrompt(chunk, { title: d.title }), options: { temperature: 0.1, num_ctx: 8192, num_predict: 800 } });
      } catch (e) { failures++; console.error(`  [${d.id}] chunk failed: ${e.message}`); continue; }
      const { people } = ce.parseDocCards(raw);
      for (const p of people) if (dc.upsert(p, { docId: d.id, docTitle: d.title, state })) found++;
    }
    totalChunks += chunks.length; totalFound += found;
    // Ledger the scan even when nothing was found — "scanned, empty" and "never scanned" are different
    // states, and conflating them would re-scan barren documents forever.
    dc.recordScan(d.id, { docUpdatedTs: d.updated_ts, found, chunks: chunks.length });
    console.log(`  [${d.id}] ${String(d.title || '').slice(0, 46).padEnd(46)} ${String(chunks.length).padStart(3)} chunk(s) → ${String(found).padStart(3)} contact(s)  state=${state || '—'}`);
  }

  const after = dc.stats();
  console.log(`\n${'='.repeat(72)}`);
  console.log(`processed ${docs.length} doc(s), ${totalChunks} chunk(s)${failures ? `, ${failures} chunk failure(s)` : ''} → +${totalFound} contact rows`);
  console.log(`stored now: ${after.contacts} rows / ${after.people} distinct people | ${after.docsPending} document(s) still pending`);
  process.exit(0);
})();
