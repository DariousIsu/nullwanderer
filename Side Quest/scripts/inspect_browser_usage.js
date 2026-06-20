/**
 * READ-ONLY: did she actually drive her dedicated browser, or just narrate / use
 * the legacy headless search? The `model` column on reading rows is the tell:
 *   web-open / web-read   → her dedicated Playwright browser (the new capability)
 *   browser-read/open     → shared attach to Lucas's Chrome
 *   duckduckgo            → legacy boredom/headless search (no visible browser)
 *   <the 24B model name>  → the model NARRATING a reading (no real fetch)
 * Safe to run live (WAL read).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\inspect_browser_usage.js
 */
const D = require('../lib/db');
D.init();
const db = D.getDb();
const short = (s, n = 64) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

console.log('=== READINGS BY MODEL (all time) ===');
for (const r of db.prepare(`SELECT model, COUNT(*) n, MAX(ts) last FROM monologue WHERE type='reading' GROUP BY model ORDER BY n DESC`).all()) {
  console.log(`  ${String(r.n).padStart(4)}  ${(r.model || '?').padEnd(22)} last: ${new Date(r.last).toLocaleString()}`);
}

console.log('\n=== READINGS BY MODEL (last 24h) ===');
const since = Date.now() - 24 * 3600 * 1000;
const recent = db.prepare(`SELECT model, COUNT(*) n FROM monologue WHERE type='reading' AND ts>=? GROUP BY model ORDER BY n DESC`).all(since);
if (!recent.length) console.log('  (no readings in last 24h)');
for (const r of recent) console.log(`  ${String(r.n).padStart(4)}  ${r.model || '?'}`);

console.log('\n=== LAST 12 READINGS (model · query/content) ===');
for (const r of db.prepare(`SELECT model, query, content, ts FROM monologue WHERE type='reading' ORDER BY ts DESC LIMIT 12`).all()) {
  console.log(`  [${(r.model || '?').padEnd(14)}] ${short(r.query || r.content)}`);
}

console.log('\n=== WEB-TAG EVIDENCE (did <web-*> ever dispatch?) ===');
const webRows = db.prepare(`SELECT COUNT(*) n FROM monologue WHERE model IN ('web-open','web-read')`).get();
const ddgRows = db.prepare(`SELECT COUNT(*) n FROM monologue WHERE model='duckduckgo'`).get();
const narrated = db.prepare(`SELECT COUNT(*) n FROM monologue WHERE type='reading' AND model NOT IN ('web-open','web-read','browser-read','browser-open','duckduckgo','screen-observe','file-read')`).get();
console.log(`  dedicated browser (web-open/web-read): ${webRows.n}`);
console.log(`  legacy headless search (duckduckgo):   ${ddgRows.n}`);
console.log(`  narrated/other reading rows:           ${narrated.n}`);

console.log('\n=== web_profile dir (launched at all?) ===');
const fs = require('fs'), path = require('path');
const prof = path.join(path.dirname(D.DB_PATH), 'web_profile');
try {
  if (fs.existsSync(prof)) {
    const st = fs.statSync(prof);
    const entries = fs.readdirSync(prof).length;
    console.log(`  ${prof}\n  exists · ${entries} entries · mtime ${st.mtime.toLocaleString()}`);
  } else console.log(`  ${prof}\n  DOES NOT EXIST — browser never launched`);
} catch (e) { console.log('  ' + e.message); }

db.close();
