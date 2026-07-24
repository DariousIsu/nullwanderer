/* smoke_doc_contacts.js — making her own research reachable by the contacts query.
 *
 * The gap: gatherHeldContacts read Puller + CRM and never the `documents` table, so asked to finish the
 * Louisiana parish rosters she offered to go research 390 documents she already held.
 *
 * The load-bearing tests here are the REFUSALS and the STATE attribution. A wrong state silently drops a
 * real contact out of a filtered answer, or files a Louisiana official under Texas.
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_doccontacts_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require(path.join(__dirname, '..', 'lib', 'db'));
const dc = require(path.join(__dirname, '..', 'lib', 'doc_contacts'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗ FAIL:', m); } };
db.init();

// ── state from PROSE: only when unambiguous ────────────────────────────────────────────────────
ok(dc.inferState('The Acadia Parish Police Jury of Louisiana meets monthly') === 'LA', 'one state named → that state');
ok(dc.inferState('a comparison of Louisiana and Texas parish government') === null,
  'CRITICAL: two states named → null, never a coin-flip between them');
ok(dc.inferState('no jurisdiction mentioned here at all') === null, 'no state → null');
ok(dc.inferState('') === null && dc.inferState(null) === null, 'empty/null → null, never throws');
ok(dc.inferState('mail it to 401 Main St, LA 70501 today') === 'LA', 'postal code in address position counts');
ok(dc.inferState('the results are in OR they are not, so we wait') === null,
  'CRITICAL: "OR" as an ordinary word is not Oregon');
ok(dc.inferState('put IN the request and see') === null, 'CRITICAL: "IN" as a preposition is not Indiana');
ok(dc.inferState('West Virginia county commissions') === 'WV',
  'CRITICAL: "West Virginia" is not read as Virginia');

// ── state from PROVENANCE: what the run was actually researching beats counting names ──────────
db.setMeta('focus.4242.beat', 'county-commissions-la');
ok(dc.stateForDoc({ ref: 'directed-4242', title: 'Research', body: 'mentions Louisiana and Mississippi and Texas' }) === 'LA',
  'THE FIX: research provenance wins where the text names several states and prose would give up');
ok(dc.stateForDoc({ ref: null, title: '', body: 'Acadia Parish, Louisiana' }) === 'LA',
  'no provenance → falls back to the text scan');
ok(dc.stateForDoc({ ref: 'directed-9999', title: '', body: 'no state here' }) === null,
  'unknown focus → no beat → null, never invents one');
ok(dc.stateForDoc({}) === null, 'empty input → null, never throws');

// ── upsert refuses what is not a contact ───────────────────────────────────────────────────────
ok(dc.upsert({ name: 'Bill Sims', phone: '318-548-6777', title: 'District 1 juror' }, { docId: 1, state: 'LA' }) === true,
  'a named person with a phone is stored');
ok(dc.upsert({ name: 'Jane Doe' }, { docId: 1 }) === false,
  'CRITICAL: a bare NAME with no email or phone is refused — an unreachable name is not a contact');
ok(dc.upsert({ email: 'x@y.gov' }, { docId: 1 }) === false, 'no name → refused');
ok(dc.upsert({ name: 'Bill Sims', phone: '318-548-6777' }, {}) === false,
  'CRITICAL: no doc id → refused; an uncited contact could never be checked');
ok(dc.upsert(null, { docId: 1 }) === false, 'null row → refused, never throws');

// ── one row per person per document; the query folds and counts corroboration ──────────────────
dc.upsert({ name: 'Gil Dowies', email: 'gil@rppj.com', title: 'District 9 Juror' }, { docId: 1, state: 'LA' });
dc.upsert({ name: 'Gil Dowies', email: 'gil@rppj.com', title: 'District 9 Juror' }, { docId: 2, state: 'LA' });
dc.upsert({ name: 'Gil Dowies', email: 'gil@rppj.com' }, { docId: 1, state: 'LA' });   // same doc again
{
  const rows = db.getDb().prepare("SELECT COUNT(*) c FROM doc_contacts WHERE name='Gil Dowies'").get().c;
  ok(rows === 2, `two documents → two stored rows, the re-scan of doc 1 updates rather than duplicates (got ${rows})`);
  const folded = dc.search({ limit: 50 }).filter((r) => r.name === 'Gil Dowies');
  ok(folded.length === 1, 'search folds him to ONE person');
  ok(folded[0].doc_count === 2, 'CRITICAL: corroboration is surfaced (2 documents), not averaged away');
}

// ── state filter ───────────────────────────────────────────────────────────────────────────────
dc.upsert({ name: 'Someone Else', email: 'a@b.gov' }, { docId: 3, state: 'TX' });
ok(dc.search({ state: 'LA' }).every((r) => r.state === 'LA'), 'state filter returns only that state');
ok(dc.search({ state: 'LA' }).length >= 2 && !dc.search({ state: 'LA' }).some((r) => r.name === 'Someone Else'),
  'a Texas contact does not appear under Louisiana');

// ── scan ledger: scanned-and-empty is not the same as never-scanned ────────────────────────────
{
  db.getDb().prepare("INSERT INTO documents (id,title,body,source,ref,created_ts,updated_ts) VALUES (900,'Doc A',?,'research','directed-4242',1,1)")
    .run('x'.repeat(500));
  ok(dc.pendingDocs({ limit: 10 }).some((d) => d.id === 900), 'a never-scanned document is pending');
  dc.recordScan(900, { docUpdatedTs: 1, found: 0 });
  ok(!dc.pendingDocs({ limit: 10 }).some((d) => d.id === 900),
    'CRITICAL: scanned-with-zero-found is NOT re-scanned — barren documents must not loop forever');
  db.getDb().prepare('UPDATE documents SET updated_ts = 2 WHERE id = 900').run();
  ok(dc.pendingDocs({ limit: 10 }).some((d) => d.id === 900), 'an EDITED document becomes pending again');
}

// ── match filter lets a specific backlog be worked first ───────────────────────────────────────
{
  db.getDb().prepare("INSERT INTO documents (id,title,body,source,ref,created_ts,updated_ts) VALUES (901,'Parish roster',?,'research','directed-4242',1,1)")
    .run('Police Jury members ' + 'y'.repeat(400));
  const m = dc.pendingDocs({ limit: 10, match: 'Police Jury' });
  ok(m.some((d) => d.id === 901) && !m.some((d) => d.id === 900), 'match filter selects only documents containing the phrase');
}

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
