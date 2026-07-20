/**
 * Offline END-TO-END smoke for the deterministic verification harness:
 *   importText → verify_extract → verify_resolve → verify_match → verify_preflight →
 *   verify_classify (STUB) → checks_contract.mapCheckResult (STRICT)
 *
 * Proves the whole pipeline composes and runs with ZERO cloud: a mock callTool stands in for
 * Echo's web tools, a stub embedder for bge-small, a mock homework-check for the gate, and the
 * deterministic classify stub for the model leaf. This is the build-order milestone for step 5
 * ("full pipeline runs offline end-to-end before any cloud call").
 *
 * Run: node scripts/smoke_verify_pipeline.js
 */
const { importText } = require('../lib/editor_import');
const { extractUnits } = require('../studio/verify_extract');
const { resolveUnits } = require('../studio/verify_resolve');
const { matchUnits, contentWords } = require('../studio/verify_match');
const { buildCandidates, preflight } = require('../studio/verify_preflight');
const { classifyAll } = require('../studio/verify_classify');
const contract = require('../studio/checks_contract');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- offline fakes -----------------------------------------------------------------------------
// The "source of truth" corpus every resolution lands on (contains some claims verbatim, omits
// others, contradicts one number, and carries the scattered phrase that forces a gray residue).
const CORPUS = [
  'The 2021 review found the effect was limited to a single demonstration site.',
  'Per the water office, snowpack rose 15% across treated basins last winter.',
  'Budget records show the program cost $3 billion overall, not more.',
  'alpha the of beta the of gamma the foo bar end of note.',
].join(' ');

const callTool = async (name, args) => {
  switch (name) {
    case 'web_fetch':
      if (/void\.example/.test(args.url)) return { status: 404, body: '' };       // dead link
      return { status: 200, body: CORPUS, final_url: args.url };
    case 'web_search':
      if (/phlogiston/i.test(args.query || '')) return { results: [] };            // unresolvable
      return { results: [{ url: 'https://corpus.example/doc', title: 'corpus' }] };
    case 'wayback_history': return { snapshots: [] };
    case 'verify_url_history': return {};
    case 'web_resolve_oa': return {};
    case 'academic_search': case 'courtlistener_opinion_search':
    case 'edgar_full_text_search': case 'fr_search': return { results: [] };
    default: throw new Error('unexpected tool ' + name);
  }
};

function stubEmbed(text) {
  const dim = 384, v = new Array(dim).fill(0);
  for (const w of contentWords(text)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dim] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

const homeworkCheck = async (samples) => samples.map(s => ({ uid: s.uid, ok: true, reason: 'on-topic' }));

// band (decided) → contract status word
const BAND_STATUS = { verified: 'verified', unsupported: 'unverified', contradicted: 'contradicted', inaccessible: 'inaccessible', gray: 'unverified', weak: 'unverified' };

// Claims that should be JUDGED carry the source they cite. The citation lane reads the CITED source
// and nothing else — it never substitutes one found by search — so an uncited claim resolves to
// `inaccessible` by design rather than being checked against whatever a search engine returned.
const DOC = [
  '# Field Brief',
  '',
  'The 2021 review found the effect "limited to a single demonstration site" overall (https://corpus.example/doc).',
  'Snowpack rose 15% across treated basins according to officials (https://corpus.example/doc).',
  'The program cost $5 billion overall, the report says (https://corpus.example/doc).',
  'The water office described modest seasonal improvement in several treated areas (https://corpus.example/doc).',
  'See https://void.example/x for the phlogiston index figures.',
  'The phrase "alpha the of beta the of gamma" appears in the official record.',
].join('\n');

(async () => {
  // 1) intake + extract
  const wc = importText(DOC, { format: 'md' });
  const units = extractUnits(wc).units;
  ok('extract → 6 units (heading dropped)', units.length === 6, `${units.length}: ${units.map(u => u.kind).join(',')}`);

  // 2) resolve (mock callTool)
  const resolved = await resolveUnits(units, callTool);
  ok('resolve → one result per unit', resolved.length === units.length);
  ok('the void/phlogiston unit is inaccessible', resolved.some(r => r.tier === 'inaccessible'));
  ok('the rest resolved to a source', resolved.filter(r => r.resolved).length === 4);

  // 3) match (stub embedder)
  const matched = await matchUnits(units, (u, i) => resolved[i], { embed: async (t) => stubEmbed(t) });
  const bands = matched.map(m => m.band);
  ok('match: ≥2 verified (verbatim quote + numeric)', bands.filter(b => b === 'verified').length >= 2, bands.join(','));
  ok('match: exactly 1 contradicted ($5B vs $3B)', bands.filter(b => b === 'contradicted').length === 1, bands.join(','));
  // TWO now, and both are correct: the dead link, and the claim that cites no source at all. Neither
  // gets a substitute found by search — that is the citation lane's contract.
  ok('match: 2 inaccessible (dead link + uncited claim)', bands.filter(b => b === 'inaccessible').length === 2, bands.join(','));
  ok('match: ≥1 escalatable residue (gray|weak, needs_model)', matched.filter(m => m.needs_model).length >= 1, bands.join(','));

  // 4) preflight gate
  const candidates = buildCandidates(units, matched);
  const gate = await preflight(candidates, { homeworkCheck });
  ok('preflight proceeds (coherent residue)', gate.proceed === true, gate.reason);
  ok('preflight split decided vs residue', gate.decided.length === 5 && gate.residue.length === 1, `decided=${gate.decided.length} residue=${gate.residue.length}`);

  // 5) classify the released residue (STUB — no cloud)
  const classified = await classifyAll(gate.residue);
  ok('classify ran on residue → valid enum codes, tier stub', classified.length === 1 && classified.every(c => c.tier === 'stub' && /^(V|VC|VP|QO|QP|A|M|NK)$/.test(c.status_code)));

  // 6) assemble contract items (decided bands + classified residue) → render model (STRICT)
  const byUid = Object.fromEntries(candidates.map(c => [c.uid, c]));
  const items = [
    ...gate.decided.map(c => ({ id: c.uid, label: c.claim, status: BAND_STATUS[c.band], locator: c.uid, match_score: c.match_score, evidence: `band=${c.band}` })),
    ...classified.map(c => ({ id: c.uid, label: (byUid[c.uid] || {}).claim || c.uid, status_code: c.status_code, finding: c.note, locator: c.uid })),
  ];
  const rendered = contract.mapCheckResult({ claims: items }, { strict: true });

  ok('contract: every unit → exactly one finding (6)', rendered.findings.length === 6, `${rendered.findings.length}`);
  ok('contract STRICT: zero schema violations (all conform)', rendered.summary.invalid === 0, JSON.stringify(rendered.summary));
  ok('contract: byVerdict present + verified auto-resolves', rendered.summary.byVerdict && rendered.summary.resolved >= 2, JSON.stringify(rendered.summary.byVerdict));
  ok('contract: contradiction surfaced as bad', rendered.findings.some(f => f.verdict === 'bad'));
  ok('contract: inaccessible surfaced as info', rendered.findings.some(f => f.verdict === 'info'));

  // 7) determinism: the whole pipeline re-run yields identical bands + codes
  const units2 = extractUnits(importText(DOC, { format: 'md' })).units;
  const resolved2 = await resolveUnits(units2, callTool);
  const matched2 = await matchUnits(units2, (u, i) => resolved2[i], { embed: async (t) => stubEmbed(t) });
  ok('pipeline deterministic (bands identical on re-run)', JSON.stringify(matched2.map(m => m.band)) === JSON.stringify(bands));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
