/**
 * Backtest — self_model identity store. Near-duplicate self-statements consolidate
 * (UPDATE + bump mentions); genuinely distinct ones ADD. Temp DB, real bge-small.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_self_model.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_self_${Date.now()}.db`);

const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const self = require('../lib/self_model');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  // Deterministic merge-decider for the test: same trait iff both mention wording/words/overanalyze.
  const isWordingTrait = s => /overanalyz|wording|words/i.test(s);
  const decideFn = async (x, y) => isWordingTrait(x) && isWordingTrait(y);

  const a = await self.record('I tend to overanalyze small wording choices in conversation', { category: 'trait', decideFn });
  ok('first statement → add', a && a.action === 'add');

  const b = await self.record('I have a habit of reading too much into the exact words people pick', { category: 'trait', decideFn });
  ok('paraphrase (cosine 0.76, LLM says same) → update (no new row)', b && b.action === 'update');
  console.log(`      (prefilter sim=${b && b.sim ? b.sim.toFixed(3) : '?'})`);

  const c = await self.record('I value directness and plain communication over hedging', { category: 'value', decideFn });
  ok('distinct trait → add', c && c.action === 'add');

  ok('only 2 rows after a dedup (not 3)', D.countSelfModel() === 2);

  const reinforced = D.getAllSelfModel().find(r => /overanalyze|reading too much/i.test(r.content));
  ok('reinforced entry has mentions = 2', reinforced && reinforced.mentions === 2);

  const block = self.buildPromptBlock(10);
  ok('persona block renders both traits', block && /directness/.test(block) && /(overanalyze|reading too much)/.test(block));

  console.log('\nrevision — a changed favorite EVOLVES (not a 2nd contradictory entry):');
  await self.record('My favorite movie is Parasite.', { category: 'preference', decideFn: async () => 'different' });
  const cntA = D.countSelfModel();
  const r2 = await self.record('My favorite movie is now Portrait of a Lady on Fire.', { category: 'preference', decideFn: async () => 'update' });
  ok('changed favorite → revise (not add)', r2 && r2.action === 'revise');
  ok('no new row on revision', D.countSelfModel() === cntA);
  const all = D.getAllSelfModel();
  ok('entry now holds the NEW favorite, not the old', all.some(x => /Portrait of a Lady/i.test(x.content)) && !all.some(x => /Parasite/i.test(x.content)));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
