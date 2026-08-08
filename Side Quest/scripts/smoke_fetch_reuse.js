'use strict';
/* smoke_fetch_reuse.js — never-same-page-twice on the FETCH lane (web_search.fetchPage reuse +
 * the shared ingest export). Hermetic: temp sq.db, NO network — reuse hits must short-circuit
 * before fetch, and the .invalid TLD guarantees any accidental live fetch errors instead of
 * silently passing. Run: node scripts/smoke_fetch_reuse.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchreuse-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const web = require(path.join(__dirname, '..', 'lib', 'web'));
const sl = require(path.join(__dirname, '..', 'lib', 'site_ledger'));
const ws = require(path.join(__dirname, '..', 'lib', 'web_search'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

(async () => {
  const URL = 'https://smoke-reuse.invalid/council/members';
  const BODY = 'Council members: ' + 'Jane Roe (President); John Doe (Member); '.repeat(10);

  // ── the shared ingest export: one living doc per URL, pointer on the visit row ───────────────
  web.ingestReading(URL, 'Council Members', BODY);
  const row1 = sl.seen(sl.normalizeUrl(URL));
  ok('ingest lands a doc + the visit row carries the pointer', row1 && row1.doc_id > 0);
  const doc1 = db.getDb().prepare('SELECT title, body FROM documents WHERE id = ?').get(row1.doc_id);
  ok('the doc holds the FULL text', doc1 && /Jane Roe/.test(doc1.body) && doc1.title === 'Council Members');
  web.ingestReading(URL, 'Council Members', BODY + ' UPDATED ROW');
  const row2 = sl.seen(sl.normalizeUrl(URL));
  ok('a re-read UPDATES the same doc, never a duplicate', row2.doc_id === row1.doc_id
    && /UPDATED ROW/.test(db.getDb().prepare('SELECT body FROM documents WHERE id = ?').get(row1.doc_id).body)
    && db.getDb().prepare("SELECT COUNT(*) n FROM documents WHERE source = 'web_page'").get().n === 1);
  web.ingestReading('https://smoke-reuse.invalid/thin', 'Thin', 'nav nav nav');
  const thin = sl.seen(sl.normalizeUrl('https://smoke-reuse.invalid/thin'));
  ok('a <200ch shell records the visit but lands NO doc', thin && !thin.doc_id);
  // the junk floor measures the PAGE, not the wrapper (live-driven 08-08: an empty JS shell's
  // ~300ch frame landed as a "document")
  const fw = require(path.join(__dirname, '..', 'lib', 'content_firewall'));
  const framedEmpty = fw.frame('', { url: 'https://smoke-reuse.invalid/shell' }).text;
  web.ingestReading('https://smoke-reuse.invalid/shell', 'Shell', framedEmpty);
  const shell = sl.seen(sl.normalizeUrl('https://smoke-reuse.invalid/shell'));
  ok('a framed EMPTY shell lands NO doc — the frame header cannot defeat the floor', shell && !shell.doc_id);
  const framedReal = fw.frame(BODY, { url: 'https://smoke-reuse.invalid/real' }).text;
  web.ingestReading('https://smoke-reuse.invalid/real', 'Real', framedReal);
  const realRow = sl.seen(sl.normalizeUrl('https://smoke-reuse.invalid/real'));
  ok('framed REAL content still lands (floor measures the inner body)', realRow && realRow.doc_id > 0);

  // ── fetchPage reuse: a held copy within TTL answers with ZERO network ────────────────────────
  const hit = await ws.fetchPage(URL, { reuse: true, maxChars: 4000 });
  ok('reuse:true serves the held doc (dedup, no fetch attempted)', hit.ok && hit.dedup === true && /Jane Roe/.test(hit.text) && hit.title === 'Council Members');
  const hitCap = await ws.fetchPage(URL, { reuse: true, maxChars: 50 });
  ok('reuse respects maxChars + truncated flag', hitCap.ok && hitCap.truncated === true && hitCap.text.length <= 51);

  // ── defaults + fall-throughs stay LIVE fetches (which error on .invalid — proving the wire) ──
  const live = await ws.fetchPage(URL, {});
  ok('reuse defaults OFF — the same URL goes to the network', !live.ok && !live.dedup);
  const noDoc = await ws.fetchPage('https://smoke-reuse.invalid/thin', { reuse: true });
  ok('a pointerless row falls through to a live fetch (heals on success)', !noDoc.ok && !noDoc.dedup);
  const never = await ws.fetchPage('https://smoke-reuse.invalid/never-seen', { reuse: true });
  ok('an unseen URL falls through to a live fetch', !never.ok && !never.dedup);

  console.log(`smoke_fetch_reuse: ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e.message); process.exit(1); });
