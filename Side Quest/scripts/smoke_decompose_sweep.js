/* smoke_decompose_sweep.js — documents that landed but were never read.
 *
 * decomposeLandedDoc (main.js:9029) is called from five specific INGEST paths, so decomposition is
 * coupled to how a document ARRIVED rather than to the document itself. scripts/research_org.js landed
 * raineycenter.org and raineyfreedom.org with correct origins and produced ZERO encounters — the
 * sentence naming the sister organisation sat in the corpus, unread.
 *
 * Runs against an in-memory database.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_decompose_sweep.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const sweep = require('../lib/decompose_sweep');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const land = (title, body, source) => db.insertDocument({ title, body, source, origin: `https://x.test/${encodeURIComponent(title)}` }).id;

// Three documents: one read, one never read, one that will be attempted and yield nothing.
const readDoc = land('Was read', 'Alcona County Board of Commissioners met.', 'browser_download');
const unread = land('Never read', 'The Rainey Center and its affiliates foster dialogue.', 'org_research');
const barren = land('Chrome only', 'Home About Contact Donate Menu', 'org_research');

enc.record({ object_type: 'gov', object_label: 'Alcona County Board', claim_class: 'existence',
  source_kind: 'document', source_ref: `doc:${readDoc}`, origin_host: 'x.test', content_hash: 'h1' });

// ── the selection ────────────────────────────────────────────────────────────────────────────────
{
  const found = sweep.findUndecomposed(db).map((r) => r.id);
  ok(!found.includes(readDoc), 'CRITICAL: a document that produced encounters is NOT re-read');
  ok(found.includes(unread) && found.includes(barren), 'documents that produced nothing ARE found');
}
{
  const rows = sweep.findUndecomposed(db);
  const r = rows.find((x) => x.id === unread);
  ok(r && r.source === 'org_research' && r.chars > 0 && r.origin_host === 'x.test',
    'each candidate carries what a caller needs to decide and to log');
}

// ── AN ATTEMPT IS RECORDED SEPARATELY FROM A RESULT ──────────────────────────────────────────────
// A page of navigation chrome can be read honestly and yield nothing. If absence of encounters were
// the only test it would be re-read on every sweep forever, burning a cloud extraction each time to
// produce the same nothing.
{
  sweep.markAttempted(db, [barren]);
  const found = sweep.findUndecomposed(db).map((r) => r.id);
  ok(!found.includes(barren),
    'CRITICAL: a document already ATTEMPTED is not retried, even though it still has no encounters');
  ok(found.includes(unread), '…and an untried one is still offered');
}
{
  ok(sweep.attemptedSet(db).has(barren), 'the attempted marker persists');
  sweep.markAttempted(db, [unread]);
  ok(sweep.findUndecomposed(db).length === 0, 'once everything is attempted the sweep is empty');
}

// ── bounds and filters ───────────────────────────────────────────────────────────────────────────
{
  const a = land('A', 'body a', 'org_research');
  const b = land('B', 'body b', 'news');
  ok(sweep.findUndecomposed(db, { sources: ['org_research'] }).map((r) => r.id).includes(a), 'sources filter selects a lane');
  ok(!sweep.findUndecomposed(db, { sources: ['org_research'] }).map((r) => r.id).includes(b), '…and excludes the others');
  ok(sweep.findUndecomposed(db, { limit: 1 }).length === 1, 'limit bounds the batch');
  ok(sweep.findUndecomposed(db, { sinceId: b }).every((r) => r.id > b), 'sinceId bounds the range');
}
{
  // An empty body is not a document to read.
  const empty = db.insertDocument({ title: 'Empty', body: '   ', source: 'org_research' });
  ok(empty === null || !sweep.findUndecomposed(db).map((r) => r.id).includes(empty && empty.id),
    'a blank document is never offered');
}
ok(Array.isArray(sweep.findUndecomposed(db, { limit: 0 })), 'garbage bounds → an array, never a throw');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
