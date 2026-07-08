/**
 * Offline smoke for the harness ORCHESTRATOR (studio/verify_harness.js) — the one pathway.
 * Same offline fakes as smoke_verify_pipeline, but driving runHarness() directly. No cloud.
 *
 * Run: node scripts/smoke_verify_harness.js
 */
const { importText } = require('../lib/editor_import');
const { runHarness } = require('../studio/verify_harness');
const { contentWords } = require('../studio/verify_match');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const CORPUS = [
  'The 2021 review found the effect was limited to a single demonstration site.',
  'Per the water office, snowpack rose 15% across treated basins last winter.',
  'Budget records show the program cost $3 billion overall, not more.',
  'alpha the of beta the of gamma the foo bar end of note.',
].join(' ');

const callTool = async (name, args) => {
  switch (name) {
    case 'web_fetch': return /void\.example/.test(args.url) ? { status: 404, body: '' } : { status: 200, body: CORPUS, final_url: args.url };
    case 'web_search': return /phlogiston/i.test(args.query || '') ? { results: [] } : { results: [{ url: 'https://corpus.example/doc' }] };
    case 'wayback_history': return { snapshots: [] };
    case 'verify_url_history': case 'web_resolve_oa': return {};
    default: return { results: [] };
  }
};
function stubEmbed(text) {
  const dim = 384, v = new Array(dim).fill(0);
  for (const w of contentWords(text)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dim] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
const DOC = [
  '# Field Brief', '',
  'The 2021 review found the effect "limited to a single demonstration site" overall.',
  'Snowpack rose 15% across treated basins according to officials.',
  'The program cost $5 billion overall, the report says.',
  'See https://void.example/x for the phlogiston index figures.',
  'The signal phrase "alpha beta gamma" appears in the official record.',
].join('\n');

(async () => {
  const wc = importText(DOC, { format: 'md' });

  // --- happy path: gate passes, classify via the built-in stub (no model injected) ---
  {
    const stages = [];
    const r = await runHarness(wc, {
      callTool, embed: async (t) => stubEmbed(t),
      homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: true })),
      onStage: (n) => stages.push(n),
    });
    ok('runHarness returns the standardized contract shape', r.findings && r.suggestions && r.summary && r.gate && r.stages);
    ok('every unit → one finding (5)', r.findings.length === 5, `${r.findings.length}`);
    ok('stages fired in fixed order', stages.join('>') === 'extract>resolve>match>preflight>classify', stages.join('>'));
    ok('gate proceeded', r.gate.proceed === true);
    ok('contract strict: zero schema violations', r.summary.invalid === 0, JSON.stringify(r.summary));
    ok('verified auto-resolves (≥2) + a contradiction surfaced bad', r.summary.resolved >= 2 && r.findings.some(f => f.verdict === 'bad'));
    ok('inaccessible surfaced info', r.findings.some(f => f.verdict === 'info'));
    ok('residue classified by stub (valid enum)', r.stages.classified.every(c => /^(V|VC|VP|QO|QP|A|M|NK)$/.test(c.status_code)));
  }

  // --- gate ABORTS: held residue surfaced (NK/info), never dropped, none classified ---
  {
    const r = await runHarness(wc, {
      callTool, embed: async (t) => stubEmbed(t),
      homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: false, reason: 'login page' })),  // all garbage
    });
    ok('gate aborted', r.gate.proceed === false && /login page/.test(r.gate.reason));
    ok('nothing classified when gate aborts', r.stages.classified.length === 0);
    ok('held residue still surfaced as findings (5 total, none lost)', r.findings.length === 5);
    ok('held items flagged not-checked', r.findings.some(f => /preflight held/.test(f.ev)));
  }

  // --- injected classifyModel is used over the stub ---
  {
    let used = 0;
    const classifyModel = async () => { used++; return { status_code: 'VP', note: 'model said so', confidence: 0.9 }; };
    const r = await runHarness(wc, {
      callTool, embed: async (t) => stubEmbed(t),
      homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: true })),
      classifyModel,
    });
    ok('injected classifyModel is called for residue', used >= 1 && r.stages.classified.some(c => c.tier === 'local' && c.status_code === 'VP'));
  }

  // --- injected deepVerify replaces the classify leaf; caveat + sources_consulted flow into findings ---
  {
    let used = 0;
    const deepVerify = async (residue) => { used++; return residue.map(c => ({ uid: c.uid, status_code: 'VC', caveat: 'timeframe imprecise', evidence_quote: 'the source says 1999', sources_consulted: [{ url: 'https://indep.example/a', title: 'Independent' }] })); };
    const r = await runHarness(wc, {
      callTool, embed: async (t) => stubEmbed(t),
      homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: true })),
      deepVerify,
    });
    ok('injected deepVerify replaces the classify leaf (called once with residue)', used === 1 && r.stages.classified.length >= 1);
    ok('deep verdict flows through contract (VC · caveat)', r.findings.some(f => f.vlabel === 'Verified · caveat' && f.caveat === 'timeframe imprecise'));
    ok('sources_consulted carried onto findings', r.findings.some(f => Array.isArray(f.sources_consulted) && f.sources_consulted.some(s => /indep\.example/.test(s.url))));
  }

  // --- guard: callTool required ---
  ok('missing callTool throws', await (async () => { try { await runHarness(wc, {}); return false; } catch { return true; } })());

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
