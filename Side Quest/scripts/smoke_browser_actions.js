/**
 * Browser-action breadcrumb — the navigation-time record (2026-08-13, the phantom "Cabinet of the
 * United States" window). The site ledger records at CAPTURE time, so an open that died before its
 * read (reboot killed the headful Chrome) left zero trace and the search window on Lucas's screen
 * was un-attributable. db.recordBrowserAction writes (source, target, url) BEFORE the goto.
 *
 * Also pins the forensic fingerprint that attributed the window: web.toUrl turns a bare query into
 * a google SERP via encodeURIComponent (%20 spaces) — a human-typed Chrome search uses '+'.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_browser_actions.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_bract_${Date.now()}.db`);

const db = require('../lib/db');
db.init();

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// --- the migration created the table ---
const tbl = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_actions'").get();
ok('browser_actions table exists after init', !!tbl);

// --- record + read back ---
const id = db.recordBrowserAction({ source: 'excavate-search', target: 'Cabinet of the United States', url: 'https://www.google.com/search?q=Cabinet%20of%20the%20United%20States' });
ok('recordBrowserAction returns an id', Number.isInteger(id) && id > 0);
const row = db.getDb().prepare('SELECT * FROM browser_actions WHERE id = ?').get(id);
ok('row carries source + target + url + ts', row && row.source === 'excavate-search' && /Cabinet of the United States/.test(row.target) && /google\.com\/search/.test(row.url) && row.ts > 0);

// --- fail-soft on garbage ---
ok('null-ish input records without throw', db.recordBrowserAction({}) !== undefined);

// --- prune keeps the table bounded (newest 2000) ---
const ins = db.getDb().prepare('INSERT INTO browser_actions (ts, source, target, url) VALUES (?, ?, ?, ?)');
const many = db.getDb().transaction(() => { for (let i = 0; i < 2100; i++) ins.run(Date.now(), 'bulk', `t${i}`, 'u'); });
many();
db.recordBrowserAction({ source: 'trim-trigger', target: 'x', url: 'y' });
const n = db.getDb().prepare('SELECT COUNT(*) n FROM browser_actions').get().n;
ok(`prune bounds the table (${n} rows ≤ 2000)`, n <= 2000);
ok('newest row survives the prune', !!db.getDb().prepare("SELECT 1 FROM browser_actions WHERE source='trim-trigger'").get());

// --- the SERP fingerprint (requires no browser launch — toUrl is pure) ---
const web = require('../lib/web');
ok('bare query → google SERP with %20 encoding (the programmatic fingerprint)',
  web.toUrl('Cabinet of the United States') === 'https://www.google.com/search?q=Cabinet%20of%20the%20United%20States');
ok('a real URL passes through untouched', web.toUrl('https://example.com/a b') === 'https://example.com/a b');
ok('a bare domain gets https', web.toUrl('example.com/path') === 'https://example.com/path');
ok('search-verb dressing is stripped before the SERP', web.toUrl('search for Acme Corp leadership') === 'https://www.google.com/search?q=Acme%20Corp%20leadership');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { db.getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
