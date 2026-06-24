/**
 * Offline smoke for lib/editor_registry.js (B1) — runs against a throwaway DB.
 * Run: node scripts/smoke_editor_registry.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), `editor_smoke_${Date.now()}.db`);
process.env.EDITOR_DB_PATH = TMP;
const R = require('../lib/editor_registry');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

try {
  R.init({ path: TMP });

  // --- pure helpers ---
  ok('formatCertNumber pads daily seq', R.formatCertNumber('2026-06-24', 3) === 'CFC-2026-06-24-03', R.formatCertNumber('2026-06-24', 3));
  ok('dateStamp formats YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(R.dateStamp(Date.now())));

  // --- register + iteration v1 + immutable author ---
  const doc = R.registerDocument({ echoDocId: 42, echoDocPath: 'Vault/x.md', title: 'U.S.–Israel Brief',
    author: 'Lucas Overby', project: 'Rainey', docType: 'briefing', topics: ['us-israel', 'tech'], source: 'upload' });
  ok('register → in-process', doc.status === 'in-process', doc.status);
  ok('register → version 1', doc.current_version === 1);
  ok('register → author set', doc.author === 'Lucas Overby');
  ok('register → topics parsed to array', Array.isArray(doc.topics) && doc.topics[0] === 'us-israel');
  ok('iteration v1 created', R.listIterations(doc.id).length === 1);
  ok('getByEchoDocId finds it', R.getByEchoDocId(42)?.id === doc.id);

  // --- second doc + listing/recency/sort/filter ---
  const doc2 = R.registerDocument({ echoDocId: 43, title: 'Polling Memo', author: 'Jane Auditor', project: 'Rainey', topics: ['polling'] });
  // touch doc1 so it's most-recent
  R.touchAccessed(doc.id);
  const recent = R.listDocuments({});
  ok('listDocuments default = recency desc (touched doc first)', recent[0].id === doc.id, `first=${recent[0].id}`);
  ok('listDocuments filter by author', R.listDocuments({ author: 'Jane Auditor' }).length === 1);
  ok('listDocuments filter by status', R.listDocuments({ status: 'in-process' }).length === 2);
  ok('listDocuments titleLike', R.listDocuments({ titleLike: 'Polling' }).length === 1);
  ok('listDocuments topic facet', R.listDocuments({ topic: 'polling' }).length === 1);
  ok('listDocuments sort by title asc', R.listDocuments({ sort: 'title', dir: 'asc' })[0].title === 'Polling Memo');

  // --- iteration bump + author immutability ---
  const it = R.addIteration(doc.id, { changeAuthor: 'Lucas Overby', source: 'edit', changeSummary: 'fixed FN7 + a typo' });
  ok('addIteration bumps to v2', it.version === 2 && R.getDocument(doc.id).current_version === 2);
  ok('addIteration with different change_author leaves doc author immutable',
     R.addIteration(doc.id, { changeAuthor: 'Jane Auditor', source: 'edit' }) && R.getDocument(doc.id).author === 'Lucas Overby');
  ok('iteration log has 3 entries', R.listIterations(doc.id).length === 3);

  // --- check-run pointer ---
  const crId = R.recordCheckRun(doc.id, { verificationSessionId: 'sess-abc', tier: 'cloud', model: 'frontier-x', status: 'open', findingsCount: 3, resolvedCount: 0 });
  R.updateCheckRun(crId, { status: 'report_ready', resolvedCount: 2, finished: true });
  const cr = R.latestCheckRun(doc.id);
  ok('check-run recorded + tied to current version', cr.verification_session_id === 'sess-abc' && cr.version === 3, `v=${cr.version}`);
  ok('check-run updated (status/resolved/finished)', cr.status === 'report_ready' && cr.resolved_count === 2 && cr.finished_at > 0);

  // --- certificate → certified + cert_number on doc ---
  const certNum = R.formatCertNumber(R.dateStamp(Date.now()), 1);
  const certId = R.attachCertificate(doc.id, { certNumber: certNum, verificationSessionId: 'sess-abc', checkRunId: crId, grade: 'Verified', scoreline: '0.91' });
  const afterCert = R.getDocument(doc.id);
  ok('attachCertificate → status certified', afterCert.status === 'certified', afterCert.status);
  ok('attachCertificate → cert_number on doc', afterCert.cert_number === certNum);
  ok('listCertificates returns it', R.listCertificates(doc.id).length === 1);

  // re-audit cert references parent
  const reauditNum = R.formatCertNumber(R.dateStamp(Date.now()), 2);
  R.attachCertificate(doc.id, { certNumber: reauditNum, parentCertId: certId, grade: 'Verified' });
  ok('re-audit cert chains to parent', R.listCertificates(doc.id).some(c => c.parent_cert_id === certId));

  // --- close-out / publish ---
  const pub = R.closeOut(doc.id, { publicCopyRef: 'https://example.org/published' });
  ok('closeOut → published + public copy + published_at', pub.status === 'published' && pub.public_copy_ref === 'https://example.org/published' && pub.published_at > 0);

  // --- lifecycle guard: no regression ---
  let regressed = false;
  try { R.setStatus(doc.id, 'in-process'); } catch { regressed = true; }
  ok('setStatus rejects regression published→in-process', regressed);
  ok('setStatus idempotent same-state ok', R.setStatus(doc.id, 'published').status === 'published');

} catch (e) {
  fail++; console.log('  FAIL (threw) —', e.message); console.error(e);
} finally {
  R.close();
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch {} }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
