/**
 * Offline smoke for cert ISSUANCE (lib/editor_cert.js + registry cert helpers, B4).
 * Isolated editor.db (EDITOR_DB_PATH) + a temp certsDir. No cloud.
 *
 * Run (Electron ABI — better-sqlite3):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_editor_cert.js
 */
const os = require('os'), fs = require('fs'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cert-'));
process.env.EDITOR_DB_PATH = path.join(tmp, 'editor.db');
const certsDir = path.join(tmp, 'certs');

const registry = require('../lib/editor_registry');
const { issueCertificate } = require('../lib/editor_cert');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

registry.init();

// seed a document + a check-run
const docId = registry.registerDocument({ title: 'Test Brief', author: 'R. Walker', echoDocPath: null, format: 'md' }).id;
const crId = registry.recordCheckRun(docId, { tier: 'harness', model: 'mistral-small3.2:24b', status: 'checked', version: 1 });

const mapped = {
  findings: [
    { id: 'f1', label: 'Claim A', verdict: 'ok', vlabel: 'Verified', status: 'verified', ev: 'ok', locator: 'a0.s0' },
    { id: 'f2', label: 'Claim B', verdict: 'bad', vlabel: 'Contradicted', status: 'contradicted', ev: 'source differs', locator: 'a1.s0' },
    { id: 'f3', label: 'Claim C', verdict: 'warn', vlabel: 'Verified · paraphrase', status: 'VP', ev: 'paraphrase', locator: 'a2.s0' },
  ],
  suggestions: [{ id: 's1', finding: 'f2', loc: 'a1.s0', beforeX: 'X', afterO: 'Y', src: 'src' }],
  summary: { total: 3, resolved: 1, invalid: 0, byVerdict: { ok: 1, bad: 1, warn: 1 } },
};

// fixed clock for deterministic cert numbers
let clock = Date.UTC(2026, 5, 24, 9, 0, 0);
const now = () => clock;

const r1 = issueCertificate({ docId, mapped, checkRunId: crId, certsDir, now });
ok('cert number scheme CFC-YYYY-MM-DD-NN', r1.certNumber === 'CFC-2026-06-24-01', r1.certNumber);
ok('grade derived from a bad verdict → hold', r1.grade === 'hold');
ok('scoreline computed on the SUPPORT axis', /verified/.test(r1.scoreline) && /not supported/.test(r1.scoreline), r1.scoreline);
ok('cert HTML written to disk', fs.existsSync(r1.certDocRef) && fs.readFileSync(r1.certDocRef, 'utf8').includes(r1.certNumber));
ok('certDocRef is <certsDir>/<num>.html', r1.certDocRef === path.join(certsDir, 'CFC-2026-06-24-01.html'));

// registry side effects
const doc = registry.getDocument(docId);
ok('doc status → certified', doc.status === 'certified');
ok('doc.cert_number set', doc.cert_number === 'CFC-2026-06-24-01');
const certs = registry.listCertificates(docId);
ok('certificate row logged', certs.length === 1 && certs[0].cert_number === 'CFC-2026-06-24-01' && certs[0].grade === 'hold' && certs[0].check_run_id === crId && certs[0].cert_doc_ref === r1.certDocRef);

// second issuance same day → seq increments
const r2 = issueCertificate({ docId, mapped, certsDir, now, parentCertId: r1.certId, reaudit: true });
ok('same-day seq increments → -02', r2.certNumber === 'CFC-2026-06-24-02', r2.certNumber);
ok('re-audit chains to parent cert', registry.listCertificates(docId).find(c => c.cert_number === r2.certNumber).parent_cert_id === r1.certId);
ok('re-audit cert HTML labels Re-audit', fs.readFileSync(r2.certDocRef, 'utf8').includes('Re-audit'));

// next day → seq resets to -01
clock = Date.UTC(2026, 5, 25, 9, 0, 0);
const r3 = issueCertificate({ docId, mapped, certsDir, now });
ok('new day resets sequence → -01', r3.certNumber === 'CFC-2026-06-25-01', r3.certNumber);

// clean grade when no bad/warn
const cleanMapped = { findings: [{ id: 'f1', label: 'A', verdict: 'ok', vlabel: 'Verified' }], suggestions: [], summary: { total: 1, byVerdict: { ok: 1 } } };
const docId2 = registry.registerDocument({ title: 'Clean', author: 'x', format: 'md' }).id;
const r4 = issueCertificate({ docId: docId2, mapped: cleanMapped, certsDir, now });
ok('all-ok → grade clear', r4.grade === 'clear');

// guards
ok('missing docId throws', (() => { try { issueCertificate({ mapped }); return false; } catch { return true; } })());
ok('missing mapped throws', (() => { try { issueCertificate({ docId }); return false; } catch { return true; } })());

// ---- findings REPORT (cert_template.renderReport) — the author handoff, NOT a certification ----
const CT = require('../studio/cert_template');
const report = CT.renderReport({ doc: registry.getDocument(docId), findings: mapped.findings, suggestions: mapped.suggestions, summary: mapped.summary, generatedAt: clock });
ok('report lists each finding claim', /Claim A/.test(report) && /Claim B/.test(report) && /Claim C/.test(report));
ok('report shows verdict pills', /pill (pass|fail|warn)/.test(report));
ok('report includes the recommended corrections', /X/.test(report) && /Y/.test(report));
ok('report is explicitly NOT a certification', /not a certification/i.test(report));
ok('report carries NO CFC cert id', !/CFC-\d{4}-\d{2}-\d{2}/.test(report));
ok('report carries NO certification seal', !/Certification Seal/.test(report));
ok('report titled "Verification Findings"', /Verification Findings/.test(report));

// deep-verify output: caveat + sources-consulted render in the report
const reportDeep = CT.renderReport({ doc: registry.getDocument(docId), findings: [
  { id: 'f1', label: 'China emitted 13B tons in 2024', verdict: 'warn', vlabel: 'Verified · caveat', status: 'VC', ev: 'source confirms ~13.1B', caveat: 'the "1990s" framing matches 1999-2000, not the whole decade', sources_consulted: [{ url: 'https://worldometers.info/china', title: 'Worldometer/EDGAR' }, { url: 'https://scienceinsights.example/a', title: 'ScienceInsights' }] },
], suggestions: [], summary: { total: 1, byVerdict: { warn: 1 } }, generatedAt: clock });
ok('report renders the deep-verify caveat', /1990s.*framing/.test(reportDeep));
ok('report renders a "Sources consulted" section', /Sources consulted/.test(reportDeep) && /worldometers\.info\/china/.test(reportDeep) && /scienceinsights/.test(reportDeep));

// ---- LANE 2: the fact-check section renders LAST and cannot touch the ruling -----------------
{
  const T = require('../studio/cert_template');
  const doc2 = { title: 'Two Lane Doc', author: 'A. Author', current_version: 1 };
  // A perfectly clean citation audit, plus independent sources that COUNTER two claims. The ruling
  // must stay "clear": a counter-source is material for the author to weigh, not a sourcing defect.
  const clean = {
    findings: [{ label: 'A correctly cited claim', verdict: 'ok', vlabel: 'Verified', status: 'verified', ev: 'the cited source supports it', locator: 'a1.s0' }],
    suggestions: [],
    summary: { total: 1, resolved: 1, invalid: 0, byVerdict: { ok: 1 } },
  };
  const factcheck = {
    summary: { ran: true, checked: 3, corroborated: 1, contested: 1, mixed: 1, none: 0, countering: 2 },
    items: [
      { uid: 'a4.s0', claim: 'A corroborated claim.', stance: 'corroborated', supporting: [{ url: 'https://sup2.example/e', title: 'Confirmer', stance: 'supports', quote: 'confirmed' }], countering: [], consulted: [], searched: true, note: '' },
      { uid: 'a2.s0', claim: 'The increase was 14.6 percent.', stance: 'mixed', supporting: [{ url: 'https://sup.example/a', title: 'Supporter', stance: 'supports', quote: 'was 14.6 percent' }], countering: [{ url: 'https://opp.example/c', title: 'Opponent', stance: 'counters', quote: 'closer to 9 percent' }], consulted: [], searched: true, note: '' },
      { uid: 'a3.s0', claim: 'A contested claim.', stance: 'contested', supporting: [], countering: [{ url: 'https://opp2.example/d', title: 'Rebuttal', stance: 'counters', quote: 'the opposite happened' }], consulted: [], searched: true, note: '' },
    ],
  };

  ok('grade is a pure function of the CITATION lane (counters do not move it)', T.gradeFor(clean.summary).key === 'clear');

  // ---- REGRESSION (live defect, 2026-07-23): "the cited source does not support this claim" must
  // HOLD the document. It used to be code NK, which the contract graded `info`, which gradeFor
  // ignores — so the Arizona ESA op-ed, whose judge correctly found that a cited NAEP page did not
  // state the rate attributed to it AND that a cited case study never mentioned the story it backed,
  // came back "Cleared for publication — no outstanding issues".
  {
    const C = require('../studio/checks_contract');
    const live = C.mapCheckResult({ claims: [
      { id: 'a5.s1', label: 'Cap ESAs at families making under $150,000 a year.[3]', status: 'verified', match_score: 1, locator: 'a5.s1' },
      { id: 'a1.s1', label: 'Only 25 percent of eighth graders do.', status: 'inaccessible', match_score: 0, locator: 'a1.s1' },
      { id: 'a1.s0', label: 'Arizona fourth graders have below-average reading proficiency.', status_code: 'NS', locator: 'a1.s0',
        finding: 'The cited passage discusses 2022-2024 score trends, not the proficiency rate.' },
      { id: 'a13.s2', label: 'Nobody serious defends ESA dollars going to diamond rings.[4]', status_code: 'NS', locator: 'a13.s2',
        finding: 'The cited passage never mentions diamond rings.' },
    ] }, { strict: true });
    const g = T.gradeFor(live.summary);
    ok('NS (cited source does not support) grades BAD, not info', live.summary.byVerdict.bad === 2, JSON.stringify(live.summary.byVerdict));
    ok('a document with unsupported claims is HELD, never cleared', g.key === 'hold', g.ruling);
    ok('the ruling names the unsupported claims', /2 material issues/.test(g.ruling), g.ruling);
    ok('the ruling also admits what it could NOT check', /could not be checked/.test(g.ruling), g.ruling);

    // An unparseable/truncated judge reply is a HOLE in the audit, not a pass.
    const broken = C.mapCheckResult({ claims: [
      { id: 'a1.s0', label: 'some claim', status_code: 'ERR', locator: 'a1.s0', finding: 'no usable verdict from the judge' },
    ] }, { strict: true });
    ok('ERR (judge produced no verdict) withholds clearance', T.gradeFor(broken.summary).key === 'conditional',
      JSON.stringify(broken.summary.byVerdict));
    ok('ERR is never labelled as a clean result', broken.findings[0].vlabel === 'Not checked — judge error');

    // The legacy Rainey code keeps its original, correct meaning: no LOCAL record says nothing
    // about the claim, so it stays advisory.
    const kdb = C.mapCheckResult({ claims: [{ id: 'x', label: 'y', status_code: 'NK', locator: 'x' }] }, { strict: true });
    ok('NK still means "no internal record" and stays info', kdb.summary.byVerdict.info === 1 && kdb.findings[0].vlabel === 'No internal record');
  }

  for (const [name, html] of [
    ['cert', T.renderCertificate(Object.assign({ doc: doc2, factcheck, certNumber: 'CFC-TEST-01', issuedAt: Date.now() }, clean))],
    ['report', T.renderReport(Object.assign({ doc: doc2, factcheck, generatedAt: Date.now() }, clean))],
  ]) {
    ok(`${name}: renders the fact-check section`, /Fact check — independent sources/.test(html));
    ok(`${name}: fact check comes LAST (after citation findings)`, html.indexOf('Per-claim findings') < html.indexOf('Fact check'));
    ok(`${name}: says plainly it is not a sourcing defect`, /Nothing here is a defect/.test(html));
    ok(`${name}: countering source + its quote are shown`, /opp\.example\/c/.test(html) && /closer to 9 percent/.test(html));
    ok(`${name}: supporting source shown too`, /sup\.example\/a/.test(html));
    // Split/against first — that is what an author needs to see before publishing.
    ok(`${name}: contested and mixed sort above corroborated`,
      html.indexOf('A contested claim') < html.indexOf('A corroborated claim') &&
      html.indexOf('The increase was 14.6 percent') < html.indexOf('A corroborated claim'));
    // Neither artifact may be pushed to "hold" by counter-evidence — that verdict belongs to the
    // citation lane alone. (Only the certificate states a ruling; a findings report carries none.)
    ok(`${name}: 2 countering sources do NOT trigger a hold`, !/Hold — corrections required/.test(html) && !/must be corrected before publication/.test(html));
  }
  ok('certificate still reads CLEARED with counters present',
    /Cleared for publication/.test(T.renderCertificate(Object.assign({ doc: doc2, factcheck, certNumber: 'CFC-TEST-02', issuedAt: Date.now() }, clean))));

  // The lane is honest about not having run — silence must never read as "nothing found".
  const noLane = T.renderReport(Object.assign({ doc: doc2, generatedAt: Date.now() }, clean));
  ok('no fact-check section when the lane did not run', !/Fact check/.test(noLane));
  const ranEmpty = T.renderReport(Object.assign({ doc: doc2, generatedAt: Date.now(), factcheck: { summary: { ran: true, checked: 0, corroborated: 0, contested: 0, mixed: 0, none: 0 }, items: [] } }, clean));
  ok('lane ran but checked nothing → section says so', /Fact check/.test(ranEmpty) && /No claims were fact-checked/.test(ranEmpty));
}

registry.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
