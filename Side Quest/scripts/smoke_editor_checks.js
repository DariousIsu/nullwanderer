/**
 * Offline smoke for lib/editor_checks.js (slice 2) — full orchestration via a MOCK callTool
 * (no live engine, no cloud). Proves open → fire verifier+fact-checker (event prompt) →
 * poll-until-findings-attached → contract map (Rainey {claims} shape) → registry record.
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

// Rainey AGENT findings shapes (what rainey_attach_*_findings persists onto the session).
const CITE = { claims: [
  { claim_text: 'Flock cameras in 5,000 communities', status_code: 'M', finding: 'Company cites "thousands"; 5,000 not confirmed.' },
  { claim_text: 'ALPR retention 30 days', status_code: 'V', finding: '2 independent sources confirm.' },
], summary: { total_cites: 2 } };
const FACT = { claims: [
  { text: 'downwind effects peer-reviewed', status_code: 'VC', finding: 'True with a caveat on basin scope.' },
] };

// status returns no findings until both agents have been delegated + one poll passes.
function makeMock({ preAttached = false } = {}) {
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
        const ready = preAttached || statusCalls >= 2;
        return wrap(ready
          ? { status: 'citation_verifying', cite_verify_findings: JSON.stringify(CITE), fact_check_findings: JSON.stringify(FACT) }
          : { status: 'citation_verifying' });
      }
      return wrap({ ok: true });
    },
  };
}

try {
  R.init({ path: TMP_DB });
  const doc = R.registerDocument({ title: 'Flock Op-Ed', author: 'Charles Walker', source: 'upload' });

  (async () => {
    // --- full delegate path (event prompt + poll until both findings attached) ---
    const mock = makeMock({});
    const res = await C.runChecks({ callTool: mock.fn, docId: doc.id, sourceDocPath: 'Vault/_Inbox/flock.md',
      author: 'Charles Walker', model: 'gemma4:31b-cloud', tier: 'cloud', sleep: async () => {} });

    ok('opened session', res.sessionId === 'sess-x');
    ok('fired cite-verify + fact-checker', res.runIds.citeVerify === 'cv-1' && res.runIds.factCheck === 'fc-1');
    ok('mapped 3 findings (2 cite + 1 fact)', res.mapped.summary.total === 3, `total=${res.mapped.summary.total}`);
    ok('M → bad, V → ok+auto, VC → warn', (() => {
      const v = res.mapped.summary.byVerdict; return v.bad === 1 && v.ok === 1 && v.warn === 1;
    })());
    ok('1 resolved (V auto-resolves)', res.mapped.summary.resolved === 1, `resolved=${res.mapped.summary.resolved}`);
    ok('polled until findings attached (>=2 status reads)', mock.calls.filter(c => c === 'verification_session_status').length >= 2);

    const cr = R.latestCheckRun(doc.id);
    ok('check_run tied to session + model/tier', cr.verification_session_id === 'sess-x' && cr.model === 'gemma4:31b-cloud' && cr.tier === 'cloud');
    ok('check_run updated: counts', cr.findings_count === 3 && cr.resolved_count === 1);

    // --- delegate:false (pre-attached findings) maps without delegating ---
    const mock2 = makeMock({ preAttached: true });
    const res2 = await C.runChecks({ callTool: mock2.fn, docId: doc.id, sourceDocPath: 'Vault/x.md', delegate: false, sleep: async () => {} });
    ok('delegate:false skips delegation', !mock2.calls.includes('delegate_to_rainey_citation_verifier'));
    ok('delegate:false still maps attached findings', res2.mapped.summary.total === 3);

    // --- guards / helpers ---
    let threw = false; try { await C.runChecks({}); } catch { threw = true; }
    ok('runChecks requires callTool', threw);

    const evt = C.buildEventPrompt('verification:session_open', { session_id: 's1', source_doc_path: 'd.md' });
    ok('event prompt carries topic + session_id payload', /Event: verification:session_open/.test(evt) && /"session_id": "s1"/.test(evt) && /Respond to this event/.test(evt));

    ok('parseFindings parses string form', C.parseFindings({ cite_verify_findings: JSON.stringify(CITE) }, 'cite_verify_findings').claims.length === 2);
    ok('parseFindings parses object form', C.parseFindings({ fact_check_findings: FACT }, 'fact_check_findings').claims.length === 1);
    ok('parseFindings missing → null', C.parseFindings({}, 'cite_verify_findings') === null);

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
