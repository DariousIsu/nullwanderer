/**
 * Offline smoke for the verification harness STAGE 4 (studio/verify_match.js):
 * unit + resolved source → match_score + band, with the model NEVER touched. No cloud.
 *
 * Tier B is driven by a deterministic STUB embedder (bag of content words → cosine), so the
 * cascade is fully testable offline; cases are crafted to isolate each tier (lexical / numeric /
 * embeddings / Layer-0 guards). Production injects lib/memory.embed + memory.cosine.
 *
 * Run: node scripts/smoke_verify_match.js
 */
const VM = require('../studio/verify_match');
const { matchUnit, matchUnits, lexicalScore, numericMatch, parseStats, contentOverlap } = VM;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// Deterministic stub embedder: 64-dim bag of hashed content words, L2-normalized. Two texts that
// share content words score high cosine regardless of order — lets us exercise Tier B offline.
function stubEmbed(text) {
  const dim = 384, v = new Array(dim).fill(0);   // bge-small's real width — disjoint sets ≈ orthogonal
  for (const w of VM.contentWords(text)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dim] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
const OPTS = { embed: async (t) => stubEmbed(t) };          // cosine defaults to VM.cosineOf
const src = (text, url = 'https://a.example/x') => ({ resolved: true, source_url: url, source_text: text });

(async () => {
  // ---- atoms ---------------------------------------------------------------------------------
  ok('lexical exact substring → 1.0', lexicalScore('the deal is final', 'he said the deal is final today') === 1);
  ok('lexical disjoint → low', lexicalScore('alpha beta gamma', 'totally different words here now') < 0.2);
  ok('parseStats reads % / $ / magnitude', (() => {
    const s = parseStats('rose 15% to $3 billion, up 2 million units');
    return s.some(x => x.unit === '%' && x.val === 15) && s.some(x => x.unit === '$' && x.val === 3e9) && s.some(x => x.unit === 'n' && x.val === 2e6);
  })());
  ok('numericMatch equal → verified', numericMatch('rose 15% last year', 'the index rose 15% in 2021').verdict === 'verified');
  ok('numericMatch single differ → contradicted', numericMatch('rose 15%', 'the index rose 5% only').verdict === 'contradicted');
  ok('numericMatch no source number → inconclusive (null)', numericMatch('rose 15%', 'it increased a lot that year') === null);
  ok('contentOverlap ignores stopwords', contentOverlap('alpha beta gamma', 'the alpha and beta or gamma') === 1);

  // ---- Tier A: verbatim quote → Verified, no model -------------------------------------------
  {
    const u = { uid: 'q0', kind: 'quote', quote: 'limited to a single demonstration site', text: 'the effect was limited to a single demonstration site' };
    const r = await matchUnit(u, src('The 2021 review concluded the effect was limited to a single demonstration site, per GAO.'), OPTS);
    ok('verbatim quote → verified tier A score 1', r.band === 'verified' && r.tier === 'A' && r.match_score === 1 && r.needs_model === false);
  }

  // ---- Tier A: near-verbatim (one word changed) ≥0.90 → Verified -----------------------------
  {
    const u = { uid: 'q1', kind: 'quote', quote: 'the panel approved the revised budget for the coming year', text: 'the panel approved the revised budget for the coming year' };
    const r = await matchUnit(u, src('Records show the panel approved the revised budget for the coming decade and more.'), OPTS);
    ok('near-verbatim ≥0.90 → verified, no model', r.band === 'verified' && r.needs_model === false, `score=${r.match_score} tier=${r.tier}`);
  }

  // ---- numeric deterministic win + contradiction ---------------------------------------------
  {
    const u = { uid: 'n0', kind: 'numeric', text: 'snowpack rose 15% in treated basins', numbers: ['15%'] };
    const v = await matchUnit(u, src('Per the water office, snowpack rose 15% across the treated basins last winter.'), OPTS);
    ok('numeric equal → verified tier=numeric', v.band === 'verified' && v.tier === 'numeric' && v.needs_model === false);
    const c = await matchUnit(u, src('The water office reported snowpack rose 5% across the basins last winter, not more.'), OPTS);
    ok('numeric differ → contradicted, no model', c.band === 'contradicted' && c.tier === 'numeric' && c.needs_model === false);
  }

  // ---- numeric inconclusive falls through to lexical/embeddings ------------------------------
  {
    const u = { uid: 'n1', kind: 'numeric', text: 'snowpack rose 15% in treated basins', numbers: ['15%'] };
    const r = await matchUnit(u, src('The water office said snowpack increased substantially across the treated basins last winter.'), OPTS);
    ok('numeric w/ no source figure → not a numeric verdict', r.tier !== 'numeric' && r.band !== 'contradicted', `tier=${r.tier} band=${r.band}`);
  }

  // ---- Tier B: scattered words → lexical low, embeddings win → gray (escalate) ---------------
  {
    const u = { uid: 'b0', kind: 'claim', text: 'alpha beta gamma' };
    // needle words ≥3 apart (stopword-padded) so no width-3 window holds two → lexical stays low;
    // only 2 filler content words (foo, bar) → bag-of-words cosine ≈ 0.78 → gray (escalate).
    const source = src('alpha the of beta the of gamma the foo bar');
    const r = await matchUnit(u, source, OPTS);
    ok('Tier B wins over lexical (tier=B)', r.tier === 'B', `tier=${r.tier} score=${r.match_score} rubric=${JSON.stringify(r.rubric)}`);
    ok('Tier B mid-similarity → gray + needs_model', r.band === 'gray' && r.needs_model === true, `band=${r.band} score=${r.match_score}`);
    ok('Tier B exceeded the lexical score', r.rubric.embScore > r.rubric.lex);
    // Without an embedder, the SAME unit cannot reach Tier B → stays weak, no embedding score.
    const noEmb = await matchUnit(u, source, {});
    ok('no embedder → Tier B skipped (tier A, embScore 0)', noEmb.tier !== 'B' && noEmb.rubric.embScore === 0);
  }

  // ---- Layer-0 guards (never escalate) -------------------------------------------------------
  {
    const u = { uid: 'g0', kind: 'claim', text: 'wholly unrelated zeppelin marmalade tributary' };
    const r = await matchUnit(u, src('A report about quarterly municipal water board staffing schedules and meeting minutes.'), OPTS);
    ok('zero content overlap → unsupported, no model', r.band === 'unsupported' && r.needs_model === false && r.rubric.reason === 'zero-overlap', JSON.stringify(r.rubric));
  }
  ok('empty source → unsupported guard', (await matchUnit({ uid: 'g1', text: 'a real claim here' }, src(''), OPTS)).rubric.reason === 'empty-source');
  ok('boilerplate source → unsupported guard', (await matchUnit({ uid: 'g2', text: 'a real claim here' }, src('Page not found. 404 error. Please enable JavaScript to continue browsing.'), OPTS)).rubric.reason === 'boilerplate');
  ok('degenerate claim → unsupported guard', (await matchUnit({ uid: 'g3', text: 'Yes.' }, src('A long and perfectly readable source passage about many substantive things indeed.'), OPTS)).rubric.reason === 'degenerate-claim');
  ok('unresolved source → inaccessible passthrough', (await matchUnit({ uid: 'g4', text: 'a real claim here' }, { resolved: false }, OPTS)).band === 'inaccessible');

  // ---- cite_floor: independent-confirm counting + downgrade ----------------------------------
  {
    const u = { uid: 'cf0', kind: 'quote', quote: 'snowpack rose across treated basins', text: 'snowpack rose across treated basins' };
    const s1 = src('The report notes snowpack rose across treated basins last year.', 'https://wyo.gov/r');
    const s2 = src('Independent analysis confirms snowpack rose across treated basins last year.', 'https://noaa.gov/r');
    const met = await matchUnit(u, [s1, s2], Object.assign({ citeFloor: 2 }, OPTS));
    ok('cite_floor 2, two domains → met, verified', met.cite_floor.met === true && met.cite_floor.confirms === 2 && met.band === 'verified');
    const sameDomain = src('Also, snowpack rose across treated basins last year per the same office.', 'https://wyo.gov/r2');
    const unmet = await matchUnit(u, [s1, sameDomain], Object.assign({ citeFloor: 2 }, OPTS));
    ok('cite_floor 2, one domain → unmet → downgraded to gray', unmet.cite_floor.met === false && unmet.cite_floor.confirms === 1 && unmet.band === 'gray' && unmet.needs_model === true);
  }

  // ---- batch matchUnits preserves order + per-unit sources -----------------------------------
  {
    const units = [{ uid: 'm0', kind: 'quote', quote: 'deal is final', text: 'deal is final' }, { uid: 'm1', text: 'unrelated nonsense tokens here' }];
    const sources = [src('they confirmed the deal is final yesterday'), src('a passage about completely other municipal matters and budgets')];
    const rs = await matchUnits(units, (u, i) => sources[i], OPTS);
    ok('matchUnits order preserved', rs.map(r => r.uid).join(',') === 'm0,m1');
    ok('matchUnits per-unit verdicts differ', rs[0].band === 'verified' && rs[1].band === 'unsupported');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
