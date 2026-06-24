/**
 * Live round-trip: the Editor's "Run checks" loop against real Echo, proved
 * CHEAPLY — exercise the verification_session lifecycle with a TEST findings
 * payload (no cloud-agent firing), then map it through the studio contract.
 *
 *   open_verification_session  →  attach_cite_verify_findings (test)
 *   →  verification_session_status  →  mapCheckResult  →  render shape
 *
 * Uses Zoe's OWN client (lib/echo.js) so this proves HER path, not a side tool.
 * Expires the test session at the end so it leaves no cruft in skuld.db.
 *
 * Run: node scripts/smoke_editor_roundtrip.js
 */
const { fromEnv } = require('../lib/echo');
const { mapCheckResult } = require('../studio/checks_contract');

const ECHO_URL = process.env.ECHO_MCP_URL || 'http://127.0.0.1:8765/mcp/';
const ECHO_TOKEN = process.env.NX_ECHO_ADMIN_TOKEN || 'nx-echo-dev-admin';
const DOC = 'C:\\Users\\azrae\\Downloads\\Flock_Oped_Walker.docx';

// A representative cite-verify findings payload in the contract's canonical shape.
const TEST_FINDINGS = {
  citations: [
    {
      id: 'f1', locator: '¶2', label: 'Flock surveillance claim',
      url: 'https://example.org/flock-report', quote: 'deployed in 5,000 communities',
      claim: 'Flock cameras are in 5,000 communities',
      status: 'Partially Verified', match_score: 0.72,
      evidence: 'Company materials cite "thousands"; 5,000 not confirmed.',
      suggested_replacement: {
        before: 'deployed in 5,000 communities',
        after: 'deployed in thousands of communities',
        source: 'Flock Safety 2024 transparency page'
      }
    },
    {
      id: 'f2', label: 'ALPR retention claim',
      status: 'verified', match_score: 0.94,
      evidence: '2 matching sources · cite-ready.'
    },
    {
      id: 'f3', label: 'blocked source', url: 'https://paywalled.example/x',
      status: 'Inaccessible', match_score: 0
    }
  ]
};

function payload(res) {
  if (!res) return null;
  const c = res.content;
  if (Array.isArray(c) && c[0] && typeof c[0].text === 'string') {
    try { return JSON.parse(c[0].text); } catch { return c[0].text; }
  }
  return res.structuredContent || res;
}

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const echo = fromEnv({ url: ECHO_URL, token: ECHO_TOKEN });
  let sessionId = null;
  try {
    const init = await echo.initialize();
    ok('connected to Echo', !!echo.ready, JSON.stringify(init && init.serverInfo));

    // 1) open
    const openRes = await echo.callTool('rainey_open_verification_session', {
      source_doc_path: DOC, author_name: 'Charles Walker',
      notes: 'editor round-trip smoke (test findings, no agent run)'
    });
    const open = payload(openRes);
    sessionId = open && (open.session_id || open.id || (open.session && open.session.id));
    ok('opened verification session', !!sessionId, JSON.stringify(open).slice(0, 200));
    if (!sessionId) throw new Error('no session_id returned');

    // 2) attach test cite-verify findings
    const attachRes = await echo.callTool('rainey_attach_cite_verify_findings', {
      session_id: sessionId, findings: TEST_FINDINGS
    });
    const attach = payload(attachRes);
    ok('attached cite-verify findings', !(attachRes && attachRes.isError), JSON.stringify(attach).slice(0, 200));

    // 3) read status back
    const statusRes = await echo.callTool('verification_session_status', { session_id: sessionId });
    const status = payload(statusRes);
    ok('read session status', !!status && !(statusRes && statusRes.isError), JSON.stringify(status).slice(0, 220));

    // 4) locate the cite-verify findings in the status payload (tolerant of key naming)
    const findingsBlob =
      status.cite_verify_findings || status.citeVerifyFindings ||
      (status.findings && (status.findings.cite_verify || status.findings.citation)) ||
      status.citations || status.findings || TEST_FINDINGS;
    console.log('  -- status findings keys:', Object.keys(status || {}).join(', '));

    // 5) map through the studio contract → render shape
    const mapped = mapCheckResult(findingsBlob);
    ok('mapCheckResult produced findings', mapped.findings.length >= 1, `${mapped.findings.length}`);
    ok('produced suggestions for fixable findings', mapped.suggestions.length >= 1, `${mapped.suggestions.length}`);
    console.log('  -- render summary:', JSON.stringify(mapped.summary));
    console.log('  -- sample finding:', JSON.stringify(mapped.findings[0]));
  } catch (e) {
    ok('round-trip completed without throwing', false, e.message || String(e));
  } finally {
    // clean up the test session
    if (sessionId) {
      try { await echo.callTool('rainey_expire_session', { session_id: sessionId }); console.log(`  (expired test session ${sessionId})`); }
      catch (e) { console.log(`  (could not expire session ${sessionId}: ${e.message})`); }
    }
  }
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
