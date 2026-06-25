/**
 * Super Search — persistent ingest LEDGER (slice 7). A file-backed implementation of the ledger
 * interface the slice-5 ingestor expects: has(url) · get(url) · add(entry) · remove(id) · list().
 *
 * The ledger is the audit trail + dedup index for everything Super Search has archived into the
 * corpus: it survives restarts (so a URL ingested last week isn't re-archived) and makes ingests
 * reversible (the operator can list and undo them). Backed by a plain JSON file under data/ — no
 * DB migration, no schema churn. Writes are synchronous + atomic-ish (write whole file on mutate).
 */
'use strict';
const fs = require('fs');
const path = require('path');

function makeFileLedger(filePath) {
  const file = filePath || path.join(__dirname, '..', 'data', 'super_search_ledger.json');
  let rows = [];
  try {
    if (fs.existsSync(file)) { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(raw)) rows = raw; }
  } catch (e) { rows = []; /* corrupt/missing → start clean, never throw on boot */ }

  function flush() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(rows, null, 2)); }
    catch (e) { console.error('[super_search_ledger] write failed:', e.message); }
  }

  return {
    file,
    has: (url) => rows.some(r => r.url === url),
    get: (url) => rows.find(r => r.url === url) || null,
    add: (entry) => { rows = rows.filter(r => r.url !== entry.url); rows.push(entry); flush(); return entry; },
    remove: (id) => { const before = rows.length; rows = rows.filter(r => r.id !== id); const removed = rows.length < before; if (removed) flush(); return removed; },
    list: () => rows.slice(),
  };
}

module.exports = { makeFileLedger };
