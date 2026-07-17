/* Smoke: the SOFT leash on the idle graph-walk's global-frontier tier (lib/monologue.js). Even when NO
 * directed focus is active, the leash's fallback tokens (from db.recentThreadGoals, via
 * focus.domainLeashTokens) should filter the frontier to on-domain candidates. Historical Wikipedia bios
 * (Frank Guarini, Society of the Cincinnati, Miroslav Tyrš) share zero tokens with real project work
 * (Louisiana parishes, county commissioners) → dropped. On-domain candidates match → kept.
 *
 * Fully offline: builds the same token set + filter predicate the runtime uses. Isolated temp DB via
 * SQ_DB_PATH so it doesn't touch the live sq.db. Run: ELECTRON_RUN_AS_NODE=1 electron scripts/smoke_soft_leash.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_softleash_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const focus = require('C:/Users/azrae/Desktop/Side Quest/lib/focus');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// same predicate the runtime uses (lib/monologue.js _tokenHit)
function tokenHit(text, toks) {
  const h = String(text || '').toLowerCase();
  for (const t of toks) if (h.includes(t)) return true;
  return false;
}

try {
  db.init();
  const s = db.startSession();

  // seed recent civic threads via USER turns (recentThreadGoals reads from open_threads)
  const insertUserThread = (goal) => {
    const uTurn = db.insertTurn({ sessionId: s, speaker: 'user', content: goal });
    return db.insertOpenThread({ content: goal, sourceTurnId: uTurn.id });
  };
  insertUserThread('research parish level government contacts in Louisiana for Lucas');
  insertUserThread('compile contact information for county commissioners for Lucas');
  insertUserThread('elected officials in Louisiana — gather: spreadsheet of all elected officials');
  insertUserThread('find county commissioners contact information for all US states');

  const toks = focus.domainLeashTokens();
  ok(toks && toks.size >= 4, `domainLeashTokens picks up the recent thread words (got ${toks ? toks.size : 0} tokens)`);
  ok(toks.has('louisiana') && toks.has('parish') && toks.has('commissioners'), 'tokens include louisiana / parish / commissioners');
  // Plural stemming: a thread that says "Parishes" or "commissioners" should ALSO produce the singular so
  // a doc mentioning "parish" or "commissioner" matches at word-boundary. This is what unblocked the
  // Lafayette Parish (singular) doc when the focus was "Louisiana Parishes" (plural).
  ok(toks.has('commissioners') && toks.has('commissioner'), 'plural stem: "commissioners" (in thread) ALSO produces "commissioner" (singular)');
  insertUserThread('deepen Louisiana Parishes coverage and county elections');
  const t2 = focus.domainLeashTokens();
  ok(t2.has('parishes') && t2.has('parish') && t2.has('elections') && t2.has('election'), 'plural stem: "Parishes"→"parish" and "elections"→"election" both produced');

  // the REAL 37 drift names captured from the live 2026-07-13 audit — every one MUST drop
  const DRIFT = ['Frank Guarini', 'Ellis Berry', 'Allen Treadway', 'Matthew Quay', 'Alonzo Ransier', 'Charles Hodges', 'Peter Newhard', 'Jared Williams', 'Kenneth Pitzer', 'American Record Corporation', 'Society of the Cincinnati', 'Beverly Byron', 'Josh Shapiro', 'Gilman Marston', 'Hugh Haralson', 'George Upham', 'Peggy Lehner', 'Phil Gingrey', 'Dante Fascell', 'Marlow Cook', 'Foster Stearns', 'Burton Sweet', 'Joseph Millard', 'Eben Stone', 'Aaron Harlan', 'Anderson Mitchell', 'William Plumer', 'James Watson', 'Miroslav Tyrš', 'Western Oregon University', 'Albert Bustamante', 'Earl Ruth', 'Augustine Kelley', 'Strait of Hormuz', 'Richmond Pearson', 'John Patman', 'Jared Polis'];
  const drifted = DRIFT.filter((n) => tokenHit(n, toks));
  ok(drifted.length === 0, `all 37 real drift names DROP (leaked: ${drifted.length ? drifted.join(', ') : 'none'})`);

  // on-domain sanity: names related to project work MUST be kept
  const ONDOM = ['Louisiana House of Representatives', 'Ouachita Parish Council', 'East Baton Rouge Parish Government', 'Jefferson County Commissioner', 'Contact for Louisiana Elected Officials'];
  const dropped = ONDOM.filter((n) => !tokenHit(n, toks));
  ok(dropped.length === 0, `all on-domain sanity names KEPT (false-drops: ${dropped.length ? dropped.join(', ') : 'none'})`);

  // WORD-BOUNDARY match (2026-07-13 audit): "direct" (a distinctive project word if it appears) must not
  // match "directory" via substring. The same 4+ char tokenizer used to build the leash set is used at match
  // time, so intersect at word level. This is the recipe both grabPdfs and the dl-ingest quarantine use.
  const wordMatch = (hay, ts) => {
    const w = new Set((String(hay || '').toLowerCase().match(/[a-z]{4,}/g) || []));
    for (const t of ts) if (w.has(t)) return true;
    return false;
  };
  // Drift docs seeded the 2026-07-13 flood → EVERY one must block. The earlier substring-match leash let
  // 3 of 4 slip through because "direct" matched "directory", "organization" and "social" were in bodies.
  const DRIFT_DOCS = [
    { t: 'COVID19_Emergency_Dental_Providers.csv', b: 'Dental Provider Name City State ZIP Emergency Contact' },
    { t: 'ca-dppo-south-b-dental-directory.pdf', b: 'California Delta Dental Preferred Provider Organization dentist network' },
    { t: 'internetbasedsociallending.pdf', b: 'peer-to-peer lending crowdfunding social lending investors' },
    { t: 'faculty-directory-070325.pdf', b: 'Faculty directory university professors department heads' },
  ];
  const docLeaks = DRIFT_DOCS.filter((d) => wordMatch(`${d.t} ${d.b}`, toks));
  ok(docLeaks.length === 0, `off-domain doc quarantine: all 4 drift docs BLOCK (leaked: ${docLeaks.length ? docLeaks.map((d) => d.t).join(', ') : 'none'})`);
  const ON_DOCS = [
    { t: 'louisiana-parish-council-directory.pdf', b: 'parish council members roster' },
    { t: 'jefferson-county-police-jury.pdf', b: 'police jury members Jefferson' },
  ];
  const onFalseDrops = ON_DOCS.filter((d) => !wordMatch(`${d.t} ${d.b}`, toks));
  ok(onFalseDrops.length === 0, `on-domain docs PASS (false-drops: ${onFalseDrops.length ? onFalseDrops.map((d) => d.t).join(', ') : 'none'})`);

  // AUTHORITATIVE CIVIC-SOURCE bypass (2026-07-17): a gov origin ALWAYS passes the grab leash even with ZERO
  // domain-token overlap (fixes "local officials dropped"), while a .com page with the same off-token words
  // stays blocked (no medical/dental flood). Exercises the REAL exported _pdfMatchesLeash + curation_gate.
  const { isAuthoritativeSource } = require('C:/Users/azrae/Desktop/Side Quest/lib/curation_gate');
  const web = require('C:/Users/azrae/Desktop/Side Quest/lib/web');
  ok(isAuthoritativeSource('https://cdc.gov/x/report12345.pdf') && !isAuthoritativeSource('https://smilesdental.com/x/report12345.pdf'),
    'isAuthoritativeSource: .gov true, .com false');
  // an off-token gov PDF: its words do NOT hit the leash, yet it PASSES via the gov bypass
  const govPdf = { href: 'https://cdc.gov/roster/report12345.pdf', text: '', pageTitle: '', pageUrl: 'https://cdc.gov' };
  ok(!wordMatch(`${govPdf.href} ${govPdf.text}`, toks), 'sanity: the gov PDF shares NO token with the leash (so only the bypass can pass it)');
  ok(web._pdfMatchesLeash(govPdf, toks) === true, 'gov-source PDF PASSES the grab leash even off-token (local-officials fix)');
  // an off-token .com PDF with the SAME non-civic words stays BLOCKED
  const comPdf = { href: 'https://smilesdental.com/roster/report12345.pdf', text: 'dentist network provider', pageTitle: '', pageUrl: 'https://smilesdental.com' };
  ok(web._pdfMatchesLeash(comPdf, toks) === false, 'off-token .com PDF stays BLOCKED (no flood re-open)');
  // a gov PDF reached via a gov PAGE (href on a CDN) also passes via pageUrl
  ok(web._pdfMatchesLeash({ href: 'https://cdn.example.com/f.pdf', pageUrl: 'https://legislature.mi.gov/docs' }, toks) === true, 'gov PAGE origin (pageUrl) also bypasses');

  // FALLBACK: no threads → tokens null → leash inert → frontier UNCHANGED (walker doesn't starve on fresh install)
  db.markOpenThreadStatus(1, 'resolved');
  db.markOpenThreadStatus(2, 'resolved');
  db.markOpenThreadStatus(3, 'resolved');
  db.markOpenThreadStatus(4, 'resolved');
  db.markOpenThreadStatus(5, 'resolved');   // the plural-stem test thread
  ok(focus.domainLeashTokens() === null, 'no active/pending threads → domainLeashTokens null → leash inert (fresh-install safety)');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
