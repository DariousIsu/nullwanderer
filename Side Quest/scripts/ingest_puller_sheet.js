/* scripts/ingest_puller_sheet.js — one-off loader: stock data/puller.db from a dumped rows JSON.
 * The xlsx → JSON step is done separately (openpyxl for this stock; SheetJS for the in-app drop later).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/ingest_puller_sheet.js [rows.json] */
'use strict';
const fs = require('fs');
const path = require('path');
const DB = require('../lib/puller_db');
const B = require('../studio/puller_beliefs');
const I = require('../studio/puller_ingest');

const jsonPath = process.argv[2] || path.join(__dirname, '..', 'data', '_ingest_contacts.json');
const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

DB.init();   // default → data/puller.db
const t0 = Date.now();
const stats = I.ingestRows(DB, rows, { source: 'EA2030 handoff sheet' });
console.log(`\ningest (${Date.now() - t0}ms):`, JSON.stringify(stats));

// verification summary: per-domain belief for the headline domains
const targets = DB.listTargets({ limit: 1e7 });
console.log(`\ntotal targets in store: ${targets.length}`);
const headline = ['google.com', 'amazon.com', 'meta.com', 'aes.com', 'microsoft.com', 'openai.com', 'entergy.com'];
console.log('per-domain email-pattern belief (best @ confidence, hits):');
for (const d of headline) {
  const st = DB.getPatternState(d);
  if (!st || !Object.keys(st.patterns).length) { console.log(`  ${d}: (none)`); continue; }
  const best = B.bestPattern(st);
  const e = st.patterns[best];
  console.log(`  ${d}: ${best} @ ${(B.currentBelief(st, best) * 100).toFixed(1)}%  (${e.hits}✓)`);
}
DB.close();
