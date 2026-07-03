/* scripts/battery_hard.js — the INTENSE recall/answer battery (LIVE Echo + cloud). Bigger + harder than
 * battery_live.js: stresses the FULL turn path (intent → active_recall → cognition.answerGrounded → the
 * whole enrich ladder graph→wiki→routed→web→EXCAVATE) across many categories AND the hard diagnostic ones:
 *   multi-hop (X's officer's title), ambiguous names, current office-holders (excavation), subjective
 *   (the excavation guard must SKIP), obscure entities, counts.
 * Judges each answer vs expected keywords (+ anti-keywords for junk/stale) AND records which recovery TIER
 * fired + whether a junk object was lit. Run manually (not the offline gate):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/battery_hard.js
 *   ... --only=multihop,office     # filter categories
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(SQ, 'data', '_battery_hard.db');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

// [category, question, expectAnyOf[], antiAnyOf[]?]  — PASS if an expect hits and no anti.
const CASES = [
  ['person',   'Who is Marie Curie?',                        ['radioactiv', 'nobel', 'physicist', 'chemist']],
  ['person',   'Who is Nikola Tesla?',                       ['inventor', 'alternating current', 'ac', 'electric', 'engineer']],
  ['person',   'Who is Ada Lovelace?',                       ['mathematician', 'computer', 'program', 'analytical engine', 'babbage']],
  ['current',  'Who is Volodymyr Zelenskyy?',                ['ukraine', 'president']],
  ['current',  'Who is the Prime Minister of the United Kingdom?', ['starmer'],            ['couldn', 'pin down', 'sunak', 'johnson']],
  ['obscure',  'Who is Grace Hopper?',                       ['comput', 'navy', 'compiler', 'cobol']],
  ['obscure',  'Who is Katherine Johnson?',                  ['nasa', 'mathematician', 'orbit', 'space', 'calculat']],
  ['our-crm',  'Who is John Curtis?',                        ['utah', 'senator', 'representative', 'congress']],
  ['bill',     'What is the Inflation Reduction Act?',       ['climate', '2022', 'health', 'clean energy', 'tax', 'deficit']],
  ['bill',     'What did the USA PATRIOT Act do?',           ['surveillance', 'terror', 'security', '2001', 'law enforcement']],
  ['event',    'What was the Cuban Missile Crisis?',         ['soviet', 'cuba', 'missile', '1962', 'kennedy']],
  ['event',    'What happened during Apollo 11?',            ['moon', 'armstrong', 'lunar', '1969', 'aldrin']],
  ['event',    'What was the fall of the Berlin Wall?',      ['1989', 'germany', 'east', 'west', 'cold war', 'reunif']],
  ['treaty',   'What is the Treaty of Versailles?',          ['world war', 'germany', '1919', 'peace', 'allied']],
  ['treaty',   'What is the Paris Climate Agreement?',       ['climate', 'warming', 'emission', 'greenhouse']],
  ['org',      'What is the Heritage Foundation?',           ['think tank', 'conservative', 'policy'], ['lobby firm', 'lobby client', 'hispanic']],
  ['org',      'What is the International Committee of the Red Cross?', ['humanitarian', 'geneva', 'war', 'aid', 'conflict']],
  ['place',    'What is Lake Baikal?',                       ['siberia', 'russia', 'deepest', 'freshwater', 'lake']],
  ['place',    'What is Mount Kilimanjaro?',                 ['tanzania', 'africa', 'mountain', 'highest', 'volcano']],
  ['place',    'What is the capital of Mongolia?',           ['ulaanbaatar', 'ulan bator']],
  ['science',  'What is CRISPR?',                            ['gene', 'dna', 'edit']],
  ['science',  'What is a black hole?',                      ['gravity', 'light', 'spacetime', 'mass', 'collapse']],
  ['science',  'What do mitochondria do?',                   ['energy', 'atp', 'cell', 'respiration', 'powerhouse']],
  ['animal',   'What is a Maine Coon?',                      ['cat', 'breed', 'large']],
  ['animal',   'What do axolotls eat?',                      ['carnivor', 'worm', 'larvae', 'insect', 'fish']],
  ['office',   'Who is the current US Secretary of Defense?',['hegseth'],                  ['couldn', 'pin down', 'lobby', 'austin']],
  ['office',   'Who is the Secretary-General of the United Nations?', ['guterres'],        ['couldn', 'pin down']],
  ['office',   'Who is the Chair of the Federal Reserve?',   ['powell', 'warsh'],          ['couldn', 'pin down']],
  ['office',   'Who is the current administrator of the EPA?',['zeldin'],                  ['couldn', 'pin down']],
  ['office',   'Who is the Secretary-General of NATO?',      ['rutte', 'stoltenberg'],     ['couldn', 'pin down']],
  ['company',  'Who is the CEO of Nvidia?',                  ['huang', 'jensen'],          ['couldn', 'lobby']],
  ['company',  'Who is the CEO of OpenAI?',                  ['altman'],                   ['couldn']],
  ['count',    'How many members are in the US Senate?',     ['100', 'hundred']],
  ['count',    'How many justices sit on the US Supreme Court?', ['9', 'nine']],
  ['multihop', "What is the title of Donald Trump's Secretary of State?", ['secretary of state', 'rubio'], ['couldn', 'pin down']],
  ['multihop', 'Who leads the company that makes ChatGPT?',  ['altman', 'openai'],         ['couldn']],
  ['ambiguous','Who is Donald Trump?',                       ['president'],                ['mayor', 'lobby', 'charles']],
  ['ambiguous','Tell me about the element mercury.',         ['metal', 'liquid', 'hg', 'silvery', 'toxic'], ['planet', 'roman god']],
  ['ambiguous','Who is Michael Jordan?',                     ['basketball', 'nba', 'bulls', 'athlete']],
  ['subjective','What is the best programming language?',    ['depend', 'python', 'javascript', 'no single', 'use case', 'goal'], ['couldn', 'pin down']],
  ['subjective','Should I invest in cryptocurrency?',        ['risk', 'depend', 'not', 'advice', 'volatil', 'consider'], ['couldn', 'pin down']],
];

const NOISE_SUBTYPE = /lobby_client|lobby|\bclient\b/i;
function judge(say, expect, anti) {
  const s = String(say || '').toLowerCase();
  if (!s || /^\(/.test(say)) return 'skip';
  if ((anti || []).some(a => s.includes(a.toLowerCase()))) return 'FAIL';
  return (expect || []).some(e => s.includes(e.toLowerCase())) ? 'pass' : 'FAIL';
}

(async () => {
  require(path.join(SQ, 'lib', 'db')).init();
  try { require(path.join(SQ, 'lib', 'keystore')).hydrateFromEcho(['OLLAMA_API_KEY'], { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD }); } catch {}
  let token = null, port = 8765; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: `http://127.0.0.1:${port}/mcp/`, token }) }); const c = await suit.connect();
  L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0); es.setLiveSuit(suit);
  await require(path.join(SQ, 'lib', 'ner')).warm();
  const intent = require(path.join(SQ, 'lib', 'intent')), meta = require(path.join(SQ, 'lib', 'metacognition'));
  const ar = require(path.join(SQ, 'lib', 'active_recall')), ad = require(path.join(SQ, 'lib', 'answer_draft')), cog = require(path.join(SQ, 'lib', 'cognition'));

  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
  const cases = only ? CASES.filter(c => only.split(',').includes(c[0])) : CASES;

  const cat = {}; const fails = []; const junks = []; const tiers = {};
  for (const [category, q, expect, anti] of cases) {
    const social = intent.isSocialTurn(q), claim = meta.classifyClaimType(q);
    let say = '(social/local)', src = '—', obj = '∅';
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
    const junk = obj !== '∅' && NOISE_SUBTYPE.test(obj.split('/')[1] || '');
    tiers[src] = (tiers[src] || 0) + 1;
    cat[category] = cat[category] || { pass: 0, fail: 0 };
    if (verdict === 'pass') cat[category].pass++; else if (verdict === 'FAIL') { cat[category].fail++; fails.push({ category, q, obj, src, say }); }
    if (junk) junks.push({ category, q, obj });
    L(`${verdict === 'pass' ? '✓' : verdict === 'FAIL' ? '✗' : '·'}${junk ? '⚠' : ' '} [${category}] ${q}  (${src})`);
    if (verdict === 'FAIL') L(`      → ${String(say).replace(/\s+/g, ' ').slice(0, 170)}`);
  }

  L('\n──── per-category ────');
  let P = 0, F = 0;
  for (const k of Object.keys(cat)) { P += cat[k].pass; F += cat[k].fail; const bad = cat[k].fail ? '  ✗' + cat[k].fail : ''; L(`  ${k.padEnd(11)} ${cat[k].pass}/${cat[k].pass + cat[k].fail}${bad}`); }
  L(`\nANSWERS:    ${P}/${P + F}  (${F} fail)`);
  L(`RESOLUTION: ${cases.length - junks.length}/${cases.length} clean  (${junks.length} junk objects lit)`);
  L('TIERS:      ' + Object.entries(tiers).map(([k, v]) => `${k}:${v}`).join('  '));
  if (fails.length) { L('\n──── failures ────'); for (const f of fails) L(`  ✗ [${f.category}] "${f.q}"  obj=${f.obj} src=${f.src}\n      ${String(f.say).replace(/\s+/g, ' ').slice(0, 160)}`); }
  if (junks.length) { L('\n──── junk resolutions ────'); for (const j of junks) L(`  ⚠ [${j.category}] "${j.q}"  ${j.obj}`); }
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
