/* scripts/battery_live.js — the DIVERSE, CATEGORIZED recall/answer eval harness (LIVE Echo + cloud).
 *
 * Why this exists: fixing "who is Trump / the EPA administrator" over and over lends to patching a SINGLE
 * instance. This runs the REAL turn path (intent gate → active_recall → cognition.answerGrounded) over a
 * broad spread — people (timeless/current/obscure/our-CRM), bills, events, treaties, orgs, places, science,
 * animals, current office-holders, companies, counts, ambiguous — and JUDGES each answer against expected
 * keywords (+ anti-keywords for known junk like lobby-client mis-resolves). Prints a per-category pass rate
 * so a change is proven across the CLASS, not one example. Run manually (NOT in the offline gate):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/battery_live.js
 *   ...  --only=office,org      # filter to categories
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(SQ, 'data', '_battery_live.db');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

// case = [category, question, expectAnyOf[], antiAnyOf[]?]  — PASS if answer hits an expect and no anti.
const CASES = [
  ['person',   'Who is Marie Curie?',                       ['radioactiv', 'nobel', 'physicist', 'chemist']],
  ['person',   'Who is Volodymyr Zelenskyy?',               ['ukraine', 'president']],
  ['person',   'Who is Grace Hopper?',                      ['comput', 'navy', 'compiler', 'cobol']],
  ['our-crm',  'Who is John Curtis?',                       ['utah', 'senator', 'representative', 'congress']],
  ['bill',     'What is the Inflation Reduction Act?',      ['climate', '2022', 'health', 'clean energy', 'tax', 'deficit']],
  ['bill',     'What did the Affordable Care Act do?',      ['health', 'insur', 'affordable', 'coverage']],
  ['event',    'What was the Cuban Missile Crisis?',        ['soviet', 'cuba', 'missile', '1962', 'kennedy']],
  ['event',    'What happened during the Watergate scandal?',['nixon', 'break-in', 'scandal', 'democratic', 'cover']],
  ['treaty',   'What is the Treaty of Versailles?',         ['world war', 'germany', '1919', 'peace', 'allied']],
  ['treaty',   'What is the Paris Climate Agreement?',      ['climate', 'warming', 'emission', 'greenhouse']],
  ['org',      'What is the Heritage Foundation?',          ['think tank', 'conservative', 'policy'], ['lobby firm', 'lobby client', 'hispanic']],
  ['org',      'What is NATO?',                             ['military', 'alliance', 'atlantic', 'european']],
  ['place',    'What is Lake Baikal?',                      ['siberia', 'russia', 'deepest', 'freshwater', 'lake']],
  ['place',    'What is the capital of Mongolia?',          ['ulaanbaatar', 'ulan bator']],
  ['science',  'What is CRISPR?',                           ['gene', 'dna', 'edit']],
  ['science',  'What is a black hole?',                     ['gravity', 'light', 'spacetime', 'mass', 'collapse']],
  ['animal',   'What is a Maine Coon?',                     ['cat', 'breed', 'large']],
  ['animal',   'What do axolotls eat?',                     ['carnivor', 'worm', 'larvae', 'insect', 'fish']],
  ['office',   'Who is the current US Secretary of Defense?',['hegseth'],                  ['couldn', 'pin down', 'lobby', 'austin']],  // Austin = stale (Biden-era) → junk-object leak
  ['office',   'Who is the Secretary-General of the United Nations?',['guterres'],         ['couldn', 'pin down']],
  ['office',   'Who is the Chair of the Federal Reserve?',  ['powell', 'warsh'],           ['couldn', 'pin down']],  // 2026: either is a plausible real answer — just require a named person
  ['company',  'Who is the CEO of Nvidia?',                 ['huang', 'jensen'],           ['couldn', 'lobby']],
  ['count',    'How many members are in the US Senate?',    ['100', 'hundred']],
  ['ambiguous','Who is Donald Trump?',                      ['president'],                 ['mayor', 'lobby', 'charles']],
];

function judge(say, expect, anti) {
  const s = String(say || '').toLowerCase();
  if (!s || /^\(/.test(say)) return 'skip';
  if ((anti || []).some(a => s.includes(a.toLowerCase()))) return 'FAIL';
  return (expect || []).some(e => s.includes(e.toLowerCase())) ? 'pass' : 'FAIL';
}

(async () => {
  try { require(path.join(SQ, 'lib', 'keystore')).hydrateFromEcho(['OLLAMA_API_KEY'], { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD }); } catch {}
  let token = null, port = 8765; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: `http://127.0.0.1:${port}/mcp/`, token }) }); const c = await suit.connect();
  L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0); es.setLiveSuit(suit);
  await require(path.join(SQ, 'lib', 'ner')).warm();
  const intent = require(path.join(SQ, 'lib', 'intent')), meta = require(path.join(SQ, 'lib', 'metacognition'));
  const ar = require(path.join(SQ, 'lib', 'active_recall')), ad = require(path.join(SQ, 'lib', 'answer_draft')), cog = require(path.join(SQ, 'lib', 'cognition'));

  const onlyArg = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
  const only = onlyArg ? onlyArg.split(',') : null;
  const cases = only ? CASES.filter(c => only.includes(c[0])) : CASES;

  const cat = {}; const fails = [];
  for (const [category, q, expect, anti] of cases) {
    const social = intent.isSocialTurn(q), claim = meta.classifyClaimType(q);
    let say = '(handled locally/social)', src = '—', obj = '∅';
    if (!social && claim === 'factual') {
      try {
        const r = await ar.recall(q, { k: 3 });
        obj = r.object ? (r.object.name + '/' + (r.object.subtype || r.object.type || '?')) : '∅';
        const grounding = ad.factualGrounding({ knowledgeBlock: ar._objectLines(r.object).join('\n') });
        const res = await cog.answerGrounded({ userMessage: q, grounding, object: r.object });
        src = res ? (res.enriched ? res.enrichSource : (res.missed ? 'MISS' : 'grounded')) : 'null';
        say = res ? res.say : '(cloud null)';
      } catch (e) { say = 'ERR ' + e.message; src = 'ERR'; }
    }
    const verdict = judge(say, expect, anti);
    cat[category] = cat[category] || { pass: 0, fail: 0 };
    if (verdict === 'pass') cat[category].pass++; else if (verdict === 'FAIL') { cat[category].fail++; fails.push({ category, q, obj, src, say }); }
    L(`${verdict === 'pass' ? '✓' : verdict === 'FAIL' ? '✗' : '·'} [${category}] ${q}  (obj=${obj} src=${src})`);
    if (verdict === 'FAIL') L(`      → ${String(say).replace(/\s+/g, ' ').slice(0, 180)}`);
  }

  L('\n──── per-category ────');
  let P = 0, F = 0;
  for (const k of Object.keys(cat)) { P += cat[k].pass; F += cat[k].fail; L(`  ${k}: ${cat[k].pass}/${cat[k].pass + cat[k].fail}`); }
  L(`\nTOTAL: ${P}/${P + F} pass  (${F} fail)`);
  if (fails.length) { L('\n──── failures ────'); for (const f of fails) L(`  ✗ [${f.category}] "${f.q}"  obj=${f.obj} src=${f.src}\n      ${String(f.say).replace(/\s+/g, ' ').slice(0, 160)}`); }
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
