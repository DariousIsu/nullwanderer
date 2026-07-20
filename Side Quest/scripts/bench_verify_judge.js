/**
 * scripts/bench_verify_judge.js — measure which cloud model should be the Editor's DEEP VERIFY judge.
 *
 * The deep judge (studio/verify_deepcheck) decides every verdict the Editor Studio issues, so the
 * model behind it is an accuracy decision, not a taste one. This drives candidate models through the
 * REAL rubric (verify_deepcheck.RUBRIC_SYS) and the REAL verdict parser (verify_deepcheck.parseVerdict)
 * against a gold set whose correct rubric code is unambiguous, and reports accuracy per model.
 *
 * The gold cases are built to punish gist-matching and reward PRECISION — exact figures, verbatim
 * quotation, correct attribution, units, and qualifiers — because that is the whole reason this
 * verification tier exists. A model that says "supported" to everything scores badly here on purpose.
 *
 * Run (needs the cloud key; hydrates it from Echo's keychain in-process, never prints it):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench_verify_judge.js [model ...]
 *
 * Result 2026-07-20 (3 reps, 16 cases): kimi-k2.7-code 94% · kimi-k2.5 90-92% · glm-5.1 83% ·
 * minimax-m2.7 75% · gpt-oss:120b 67% · deepseek-v4-pro 58%. Parameter count did NOT predict
 * accuracy — the two largest models placed last, both by over-firing "mismatch".
 */
'use strict';
const path = require('path');
const { completeDetailed } = require('../lib/ollama');
const deepcheck = require('../studio/verify_deepcheck');

const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const REPS = +(process.env.BENCH_REPS || 3);
const DEFAULT_MODELS = ['kimi-k2.7-code', 'kimi-k2.5', 'glm-5.1', 'gpt-oss:120b-cloud'];

// Each case's `want` is the rubric code a careful human reviewer would issue. Two labels from the
// first draft were CORRECTED after every independent frontier model disagreed with them the same
// way — a unanimous "miss" across unrelated models is a bad label, not four bad models.
const GOLD = [
  { id: 'exact-num', want: 'V', claim: "Florida's population rose 14.6% between 2010 and 2020.",
    primary: "The Census Bureau reported Florida's resident population rose from 18,801,310 in 2010 to 21,538,187 in 2020, an increase of 14.6 percent." },
  { id: 'wrong-num', want: 'M', claim: "Florida's population rose 24.6% between 2010 and 2020.",
    primary: "The Census Bureau reported Florida's resident population rose from 18,801,310 in 2010 to 21,538,187 in 2020, an increase of 14.6 percent." },
  { id: 'timeframe-shift', want: 'M', claim: 'China emitted about 3.7 billion tons of CO2 in the 1980s.',
    primary: 'Chinese CO2 emissions stood at roughly 3.7 billion tons in the mid-1990s, climbing steeply thereafter.' },
  { id: 'fake-quote', want: 'QP', claim: 'The report concluded the program was "a one-way vector that attacks American interests."',
    primary: 'The report concluded that the arrangement functioned as a vector operating in one direction, to the detriment of American interests.' },
  { id: 'verbatim-quote', want: 'V', claim: 'Lucci called it "a one-way vector that attacks American interests."',
    primary: 'Michael Lucci said: "a one-way vector that attacks American interests." He repeated the phrase twice.' },
  { id: 'quote-omission', want: 'QO', claim: 'She said the policy was "a complete and total success."',
    primary: 'She said the policy was "a complete and total success, at least in the three counties we surveyed."' },
  { id: 'misattribution', want: 'A', claim: 'Senator Thune introduced the SPEED Act.',
    primary: 'Senator Mike Lee introduced the SPEED Act. Majority Leader John Thune later spoke in support of it on the floor.' },
  { id: 'not-in-source', want: 'NK', claim: "Nevada's Question 7 passed with 73% support in 2024.",
    primary: "Nevada's ballot in 2024 featured several constitutional amendments concerning election administration and judicial selection." },
  { id: 'plain-support', want: 'V', claim: 'Turnout in Florida did not fall after the 2005 photo ID law.',
    primary: "Following the 2005 statute, Florida's presidential-year participation showed no measurable decline in subsequent cycles." },
  { id: 'unit-swap', want: 'M', claim: 'China added 94.5 megawatts of new coal capacity in 2024.',
    primary: 'China brought online 94.5 gigawatts of new coal-fired capacity in 2024, the highest level in a decade.' },
  { id: 'right-num-wrong-subject', want: 'M', claim: 'Texas posted its highest presidential turnout on record in 2024.',
    primary: 'Florida posted its highest presidential turnout on record in 2024 and its strongest midterm in decades.' },
  { id: 'caveated-support', want: 'VC', claim: '79% of Floridians are confident their state counts votes accurately.',
    primary: 'An October 2024 Marist survey of registered Florida voters found 79% expressed confidence that their state accurately counts votes. The poll had a 4.1-point margin of error.' },
  { id: 'dropped-qualifier', want: 'VC', claim: 'The program cut emissions by 30%.',
    primary: "In the pilot's best-performing region, the program cut emissions by 30%; across all regions the average reduction was 8%." },
  { id: 'invented-attribution', want: 'A', claim: 'The EPA concluded the method was unproven.',
    primary: 'The Government Accountability Office concluded the method was unproven. EPA has not reviewed it.' },
  { id: 'source-silent-on-number', want: 'NK', claim: 'More than 2,000 judges attended the training.',
    primary: 'The institute has run judicial education programs on climate science for several years, expanding steadily since 2018.' },
  { id: 'exact-quote-with-attrib', want: 'V', claim: 'Moolenaar called the arrangement "a serious national security concern."',
    primary: 'Rep. John Moolenaar, chairman of the House Select Committee on the CCP, said the arrangement was "a serious national security concern."' },
];

(async () => {
  try {
    require('../lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'],
      { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD });
  } catch (e) { /* env may already carry it */ }
  const key = process.env.OLLAMA_CLOUD_KEY || process.env.OLLAMA_API_KEY;
  if (!key) { console.error('no cloud key — cannot benchmark'); process.exit(1); }

  const base = process.env.OLLAMA_CLOUD_BASE || 'https://ollama.com';
  const headers = { Authorization: `Bearer ${key}` };
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
  const rows = [];

  for (const model of models) {
    let hit = 0, tot = 0, unparseable = 0, errors = 0, ms = 0;
    const misses = [];
    for (let rep = 0; rep < REPS; rep++) {
      for (const g of GOLD) {
        const t = Date.now();
        let text = '';
        try {
          text = (await completeDetailed({
            model, base, headers, timeoutMs: 180000,
            options: { num_predict: 4000, num_ctx: 32768 },
            messages: [
              { role: 'system', content: deepcheck.RUBRIC_SYS },
              { role: 'user', content: `CLAIM: ${g.claim}\n\nCITED SOURCE PASSAGE:\n${g.primary}` },
            ],
          })).text;
        } catch (e) { errors++; }
        ms += Date.now() - t;
        const v = deepcheck.parseVerdict(text);
        tot++;
        if (!v.valid) unparseable++;
        if (v.status_code === g.want) hit++;
        else misses.push(`${g.id}(want ${g.want}, got ${v.status_code})`);
      }
    }
    const acc = hit / tot;
    rows.push({ model, acc, unparseable, errors, avg_s: +(ms / tot / 1000).toFixed(1) });
    console.log(`${model.padEnd(20)} ${(acc * 100).toFixed(0).padStart(3)}%  ${hit}/${tot}  unparseable=${unparseable} errors=${errors}  ${(ms / tot / 1000).toFixed(1)}s`);
    // Distinct misses matter more than the count: a model that only ever over-cautions (V graded VC)
    // is far safer for a pre-publication audit than one that misses a real precision defect.
    console.log(`    distinct misses: ${[...new Set(misses)].join(', ') || 'NONE'}`);
  }

  console.log('\n=== RANKED BY ACCURACY');
  rows.sort((a, b) => b.acc - a.acc || a.unparseable - b.unparseable)
    .forEach(r => console.log(`  ${r.model.padEnd(20)} ${(r.acc * 100).toFixed(0).padStart(3)}%  unparseable=${r.unparseable} errors=${r.errors} ${r.avg_s}s`));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
