/**
 * Offline smoke for the harness ORCHESTRATOR (studio/verify_harness.js) — the one pathway.
 * Same offline fakes as smoke_verify_pipeline, but driving runHarness() directly. No cloud.
 *
 * Run: node scripts/smoke_verify_harness.js
 */
const { importText } = require('../lib/editor_import');
const { runHarness } = require('../studio/verify_harness');
const { contentWords } = require('../studio/verify_match');
const cert = require('../studio/cert_template');           // gradeFor — a held batch must not "clear"

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
    ok('residue classified by stub (valid enum)', r.stages.classified.every(c => /^(V|VC|VP|QO|QP|A|M|NS|NK|ERR)$/.test(c.status_code)));

    // DOCUMENT ORDER (live defect, 2026-07-23). Findings are assembled in three stage-ordered
    // batches — settled-at-match, judged, then held — and both the rail and the report print
    // "Claims listed in document order" above them. On the Arizona ESA op-ed that printed the
    // document's opening sentence fifth of six. Stage of processing is not the author's reading order.
    const rank = (loc) => { const m = /^a(\d+)\.s(\d+)$/.exec(loc || ''); return m ? +m[1] * 1e4 + +m[2] : Infinity; };
    const order = r.findings.map(f => f.locator);
    ok('findings really are in document order, not stage order',
      order.every((loc, i) => i === 0 || rank(order[i - 1]) <= rank(loc)), order.join(' → '));
    // The batches must genuinely be interleaved, or the assertion above proves nothing.
    const judged = new Set(r.stages.classified.map(c => c.uid));
    const firstJudged = order.findIndex(l => judged.has(l));
    ok('a judged claim really does sort among the settled ones (order is not batch order)',
      firstJudged > 0 && firstJudged < order.length - 1, `judged at ${firstJudged} of ${order.length}: ${order.join(',')}`);

    // Every finding a source was read for must be able to name it — not just the deep-judged ones.
    ok('findings carry the source that was actually read',
      r.findings.filter(f => (f.sources_consulted || []).length).length >= 2,
      JSON.stringify(r.findings.map(f => (f.sources_consulted || []).length)));

    // REGRESSION (live defect, 2026-07-23): candidates must carry the FULL cited source, not just
    // the matcher's single best sentence. editor_checks feeds this to the deep judge as sourceText;
    // when it was only the snippet, the "reads the primary source deeply" verifier ruled on one
    // sentence chosen by the cheap pass it exists to second-guess, and called a good citation
    // unsupported because the sentence it was handed genuinely did not support the claim.
    const withSource = r.stages.candidates.filter(c => c.source_text);
    ok('candidates carry the FULL cited source for the judge', withSource.length >= 2,
      JSON.stringify(r.stages.candidates.map(c => ({ uid: c.uid, full: (c.source_text || '').length, snip: (c.passage || '').length }))));
    ok('the full source really is longer than the match snippet',
      withSource.some(c => (c.source_text || '').length > (c.passage || '').length));
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
    // A batch nothing ever read cannot be a clean bill of health.
    ok('an aborted gate withholds clearance (held ≠ benign info)',
      cert.gradeFor(r.summary).key !== 'clear', JSON.stringify(r.summary.byVerdict));
  }

  // --- gate aborts by THROWING / returning junk: the two paths that lost claims outright ---------
  // Found in a live run, not by reading code: only the tidy "verdicts say no" path set heldResidue.
  // The throw path and the no-usable-verdicts path left it undefined while leaving `residue`
  // populated, so `gate.heldResidue || []` surfaced nothing and those claims DISAPPEARED — the run
  // extracted 6 units, rendered 4 findings, and issued a ruling over them as though the document had
  // 4 claims. Silent loss on the failure path is the worst place for it: nothing else says the batch
  // went unchecked.
  for (const [label, homeworkCheck] of [
    ['throws', async () => { throw new Error('model not found'); }],
    ['returns junk', async () => [{ nope: true }]],
  ]) {
    const r = await runHarness(wc, { callTool, embed: async (t) => stubEmbed(t), homeworkCheck });
    ok(`gate ${label} → still aborts`, r.gate.proceed === false, r.gate.reason);
    ok(`gate ${label} → EVERY claim still reported (6, none lost)`, r.findings.length === 6, `${r.findings.length}`);
    ok(`gate ${label} → the unchecked claims say so`, r.findings.some(f => /not checked/.test(f.ev)));
    ok(`gate ${label} → does not read as cleared`, cert.gradeFor(r.summary).key !== 'clear', cert.gradeFor(r.summary).ruling);
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
