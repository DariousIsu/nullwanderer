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
// Every claim that should actually be JUDGED now carries the source it cites. That is the citation
// lane's whole contract: it reads the cited source and nothing else, so an uncited claim has nothing
// to check against and a dead link resolves to `inaccessible` — never to a substitute found by search.
const DOC = [
  '# Field Brief', '',
  'The 2021 review found the effect "limited to a single demonstration site" overall (https://corpus.example/doc).',
  'Snowpack rose 15% across treated basins according to officials (https://corpus.example/doc).',
  'The program cost $5 billion overall, the report says (https://corpus.example/doc).',
  // partial overlap with the corpus → lands in the GRAY band, i.e. the residue the judge exists for
  'The water office described modest seasonal improvement in several treated areas (https://corpus.example/doc).',
  'See https://void.example/x for the phlogiston index figures.',
  'The phrase "alpha the of beta the of gamma" appears in the official record.',
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
    ok('every unit → one finding (6)', r.findings.length === 6, `${r.findings.length}`);
    ok('stages fired in fixed order, citation first then fact check', stages.join('>') === 'extract>resolve>match>preflight>classify>factcheck', stages.join('>'));
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
    ok('held residue still surfaced as findings (6 total, none lost)', r.findings.length === 6);
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

  // --- THE TWO LANES: citation decides the verdict, fact check only informs -------------------
  {
    let fcCalls = 0, fcSeen = [];
    const factCheck = async (claims) => {
      fcCalls++; fcSeen = claims;
      return claims.map((c, i) => ({
        uid: c.uid, claim: c.claim,
        stance: i === 0 ? 'contested' : (i === 1 ? 'corroborated' : 'no-independent-source'),
        supporting: i === 1 ? [{ url: 'https://indep.example/s', title: 'Supporting', stance: 'supports', quote: 'affirms it' }] : [],
        countering: i === 0 ? [{ url: 'https://indep.example/c', title: 'Countering', stance: 'counters', quote: 'disputes it' }] : [],
        consulted: [], searched: true, note: 'n',
      }));
    };
    const base = { callTool, embed: async (t) => stubEmbed(t), homeworkCheck: async (s) => s.map(x => ({ uid: x.uid, ok: true })) };
    const withFc = await runHarness(wc, Object.assign({}, base, { factCheck }));
    const noFc = await runHarness(wc, base);

    ok('fact check runs once, over every candidate claim', fcCalls === 1 && fcSeen.length === withFc.stages.candidates.length);
    ok('fact check items ride alongside the citation findings', withFc.factcheck.items.length === fcSeen.length && withFc.factcheck.summary.ran === true);
    ok('fact-check summary tallies stances', withFc.factcheck.summary.contested === 1 && withFc.factcheck.summary.corroborated === 1 && withFc.factcheck.summary.countering === 1,
      JSON.stringify(withFc.factcheck.summary));
    ok('citation lane is exposed separately', withFc.citation && withFc.citation.findings.length === withFc.findings.length);
    // The load-bearing guarantee: a COUNTERING source is information for the author, never a defect.
    // Citation findings and the grade inputs must be byte-identical with and without the lane.
    ok('fact check does NOT change any citation finding',
      JSON.stringify(withFc.findings) === JSON.stringify(noFc.findings));
    ok('fact check does NOT change the citation summary (the grade input)',
      JSON.stringify(withFc.summary) === JSON.stringify(noFc.summary));
    ok('no countering source leaked into citation findings',
      !JSON.stringify(withFc.findings).includes('indep.example/c'));
    ok('lane absent → empty, ran:false (never silently "clean")',
      noFc.factcheck.items.length === 0 && noFc.factcheck.summary.ran === false);
  }

  // --- guard: callTool required ---
  ok('missing callTool throws', await (async () => { try { await runHarness(wc, {}); return false; } catch { return true; } })());

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
