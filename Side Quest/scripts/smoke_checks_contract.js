/**
 * Offline smoke for the Editor findings contract (studio/checks_contract.js):
 * Echo verification_session findings → studio render model (rail + drawer).
 *
 * Run: node scripts/smoke_checks_contract.js
 */
const { mapCheckResult, statusFromScore, STATUS } = require('../studio/checks_contract');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// A representative Echo-shaped check result (mirrors the harness's weather-mod doc).
const ECHO = {
  citations: [
    {
      id: 'f1', locator: '¶2', label: '15% snowpack',
      url: 'https://wwdo.wyo.gov/report2023', quote: '15% snowpack increase',
      claim: 'Wyoming snowpack rose 15% in treated basins',
      status: 'Contradicted', match_score: 0.15,
      evidence: 'Source reports 5–10% in treated basins, not 15%.',
      suggested_replacement: {
        before_pre: '…reports a ', before: '15% snowpack increase', before_post: ' across treated basins.',
        after_pre: '…reports a ', after: '5–10% snowpack increase', after_post: ' across treated basins.',
        source: 'Wyoming Water Dev. Office 2023, Table 4'
      }
    },
    {
      id: 'f2', locator: '¶3', label: '2021 GAO memo',
      quote: 'remains limited to a single 2021 GAO memo',
      status: 'Partially Verified', match_score: 0.74,
      evidence: 'Memo exists; "limited to" slightly overstates.',
      suggested_replacement: {
        before: 'remains limited to a single 2021 GAO memo',
        after: 'has produced only a 2021 GAO memo and a 2022 follow-up',
        source: 'GAO-22-104, summary'
      }
    },
    {
      id: 'f3', locator: '¶4', label: 'peer-reviewed downwind',
      status: 'verified', match_score: 0.92,
      evidence: '3 matching sources · cite-ready.'
    },
    {
      id: 'f4', locator: '¶5', label: 'blocked source',
      url: 'https://paywalled.example/x', status: 'Inaccessible', match_score: 0
    }
  ]
};

const r = mapCheckResult(ECHO);

// --- shape ---
ok('produces 4 findings', r.findings.length === 4, `${r.findings.length}`);
ok('suggestions only where a replacement exists (2)', r.suggestions.length === 2, `${r.suggestions.length}`);

// --- verdict mapping ---
const byId = Object.fromEntries(r.findings.map(f => [f.id, f]));
ok('contradicted → bad', byId.f1.verdict === 'bad' && byId.f1.vlabel === 'Contradicted');
ok('partial → warn', byId.f2.verdict === 'warn' && byId.f2.vlabel === 'Partial');
ok('verified → ok + auto/resolved', byId.f3.verdict === 'ok' && byId.f3.auto === true && byId.f3.resolved === true);
ok('inaccessible → info', byId.f4.verdict === 'info' && byId.f4.vlabel === 'Inaccessible');

// --- resolution defaults ---
ok('only verified auto-resolves', r.summary.resolved === 1, `resolved=${r.summary.resolved}`);
ok('contradicted starts unresolved', byId.f1.resolved === false && byId.f1.auto === false);

// --- hasFix flags drive the drawer ---
ok('f1 hasFix', byId.f1.hasFix === true);
ok('f3 (verified, no replacement) hasFix=false', byId.f3.hasFix === false);

// --- suggestion segments ---
const s1 = r.suggestions.find(s => s.finding === 'f1');
ok('suggestion linked to its finding', !!s1);
ok('diff segments split (before/after text present)', s1.beforeX === '15% snowpack increase' && s1.afterO === '5–10% snowpack increase');
ok('suggestion carries source', s1.src === 'Wyoming Water Dev. Office 2023, Table 4');
ok('suggestions default to pending', r.suggestions.every(s => s.state === 'pending'));

// --- tolerant inputs ---
ok('accepts bare array', mapCheckResult(ECHO.citations).findings.length === 4);
ok('accepts {results:[]}', mapCheckResult({ results: ECHO.citations }).findings.length === 4);
ok('empty/garbage → empty', mapCheckResult(null).findings.length === 0 && mapCheckResult({}).findings.length === 0);

// --- score → status fallback ---
ok('score 0.95 → verified', statusFromScore(0.95) === 'verified');
ok('score 0.70 → partial', statusFromScore(0.70) === 'partial');
ok('score 0.30 → unverified', statusFromScore(0.30) === 'unverified');
ok('NaN score → inaccessible', statusFromScore('x') === 'inaccessible');

// --- a finding with only a score (no explicit status) still maps ---
const scored = mapCheckResult({ citations: [{ id: 'x', match_score: 0.93, label: 'q' }] });
ok('score-only finding → verified', scored.findings[0].verdict === 'ok');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
