/**
 * Offline smoke for lib/editor_checks.js (B2 plumbing) — full orchestration via a MOCK callTool
 * (no live engine, no cloud creds). Proves open → delegate → poll-until-terminal → contract map →
 * registry record, plus the safe delegate:false path.
 * Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke_editor_checks.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `editor_checks_${Date.now()}.db`);
process.env.EDITOR_DB_PATH = TMP_DB;
const C = require('../lib/editor_checks');
const R = require('../lib/editor_registry');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

// Canonical findings (round-trip shape): partial+suggestion, verified, inaccessible.
const CITE_FINDINGS = { citations: [
  { id: 'f1', locator: '¶2', label: 'Flock claim', status: 'Partially Verified', match_score: 0.72,
    evidence: 'Company cites "thousands"; 5,000 not confirmed.',
    suggested_replacement: { before: 'deployed in 5,000 communities', after: 'deployed in thousands of communities', source: 'Flock 2024 transparency page' } },
  { id: 'f2', label: 'ALPR retention', status: 'verified', match_score: 0.94, evidence: '2 matching sources · cite-ready.' },
  { id: 'f3', label: 'blocked source', status: 'Inaccessible', match_score: 0 },
] };

// Build a mock callTool. status returns non-terminal once, then report_ready with findings.
function makeMock({ attachFindings = true } = {}) {
  const calls = [];
  let statusCalls = 0;
  return {
    calls,
    fn: async (name, args) => {
      calls.push(name);
      if (name === 'rainey_open_verification_session') return wrap({ session_id: 'sess-x', status: 'open', source_doc_path: args.source_doc_path });
      if (name === 'delegate_to_rainey_citation_verifier') return wrap({ run_id: 'cv-1' });
      if (name === 'delegate_to_rainey_fact_checker') return wrap({ run_id: 'fc-1' });
      if (name === 'verification_session_status') {
        statusCalls++;
        if (attachFindings && (statusCalls >= 2 || calls.filter(c => c === 'delegate_to_rainey_citation_verifier').length === 0)) {
          // terminal once delegated-and-polled-twice, OR immediately when not delegating
          return wrap({ status: 'report_ready', report_doc_path: 'Vault/report.md', cite_verify_findings: JSON.stringify(CITE_FINDINGS) });
        }
        return wrap({ status: 'citation_verifying' });
      }
      return wrap({ ok: true });
    },
  };
}

try {
  R.init({ path: TMP_DB });
  const doc = R.registerDocument({ title: 'Flock Op-Ed', author: 'Charles Walker', source: 'upload' });

  // --- full delegate path (polls twice) ---
  (async () => {
    const mock = makeMock({ attachFindings: true });
    const res = await C.runChecks({ callTool: mock.fn, docId: doc.id, sourceDocPath: 'C:/x/flock.docx',
      author: 'Charles Walker', model: 'frontier-x', tier: 'cloud', sleep: async () => {} });

    ok('opened session', res.sessionId === 'sess-x');
    ok('delegated cite-verify + fact-check', res.runIds.citeVerify === 'cv-1' && res.runIds.factCheck === 'fc-1');
    ok('polled until terminal (report_ready)', res.status === 'report_ready');
    ok('mapped 3 findings', res.mapped.summary.total === 3, `total=${res.mapped.summary.total}`);
    ok('1 suggestion (f1 has replacement)', res.mapped.suggestions.length === 1);
    ok('1 resolved (f2 verified auto-resolves)', res.mapped.summary.resolved === 1, `resolved=${res.mapped.summary.resolved}`);
    ok('byStatus partial+verified+inaccessible', res.mapped.summary.byStatus.partial === 1 && res.mapped.summary.byStatus.verified === 1 && res.mapped.summary.byStatus.inaccessible === 1);
    ok('status polled at least twice (non-terminal then terminal)', mock.calls.filter(c => c === 'verification_session_status').length >= 2);

    // registry check-run recorded + updated
    const cr = R.latestCheckRun(doc.id);
    ok('check_run tied to session + model/tier', cr.verification_session_id === 'sess-x' && cr.model === 'frontier-x' && cr.tier === 'cloud');
    ok('check_run updated: counts + finished + report_ref', cr.status === 'report_ready' && cr.findings_count === 3 && cr.resolved_count === 1 && cr.finished_at > 0 && cr.report_ref === 'Vault/report.md');

    // --- delegate:false path (safe pre-creds): no delegate calls, maps attached findings ---
    const mock2 = makeMock({ attachFindings: true });
    const res2 = await C.runChecks({ callTool: mock2.fn, docId: doc.id, sourceDocPath: 'C:/x/flock.docx', delegate: false, sleep: async () => {} });
    ok('delegate:false skips delegation', !mock2.calls.includes('delegate_to_rainey_citation_verifier'));
    ok('delegate:false still maps findings', res2.mapped.summary.total === 3);

    // --- guards / pure helpers ---
    let threw = false; try { await C.runChecks({}); } catch { threw = true; }
    ok('runChecks requires callTool', threw);

    const prompt = C.buildVerifierPrompt({ sessionId: 's1', sourceDocPath: 'd.docx', model: 'frontier-x' });
    ok('prompt carries pipeline + rubric + model', /citation_verify/.test(prompt) && /0\.90/.test(prompt) && /frontier-x/.test(prompt));

    ok('extractCitations parses string form', C.extractCitations({ cite_verify_findings: JSON.stringify(CITE_FINDINGS) }).length === 3);
    ok('extractCitations parses object + merges fact-check', C.extractCitations({ cite_verify_findings: CITE_FINDINGS, fact_check_findings: { citations: [{ id: 'g1', status: 'verified', match_score: 0.99 }] } }).length === 4);

    R.close();
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
} catch (e) {
  fail++; console.log('  FAIL (threw) —', e.message); console.error(e);
  R.close();
  console.log(`\nFAILURES — ${pass} passed, ${fail} failed`);
  process.exit(1);
}
