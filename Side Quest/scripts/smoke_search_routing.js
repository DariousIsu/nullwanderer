/**
 * Backtest — autonomous-search routing + rumination brake.
 *  1) monologue.js loads clean (syntax/wiring) and webLib.open is the routing entry.
 *  2) isRepeatOfRecentSearch: a near-duplicate of a recent reading query is braked;
 *     a genuinely different topic passes (deepening must not be over-suppressed).
 * Uses a temp DB (SQ_DB_PATH) so it never touches the live one. Real bge-small
 * embeddings (CPU) — no network, no Playwright launch.
 *
 * Run: $env:SQ_DB_PATH=$env:TEMP+'\sq_route_test.db'; $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_search_routing.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = path.join(os.tmpdir(), `sq_route_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const mono = require('../lib/monologue');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  console.log('load + routing surface:');
  ok('monologue module loaded', typeof mono.startMonologueScheduler === 'function');
  ok('runSearch source uses webLib.open (browser-first)', /webLib\.open\(query\)/.test(fs.readFileSync(path.join(__dirname, '../lib/monologue.js'), 'utf8')));
  ok('legacy path retained as fallback', /runSearchLegacy/.test(fs.readFileSync(path.join(__dirname, '../lib/monologue.js'), 'utf8')));

  console.log('\nrumination brake (isRepeatOfRecentSearch):');
  // Seed recent reading queries — the typo-spiral theme she actually ran.
  D.insertMonologue({ content: 'r1', model: 'web-read', type: 'reading', query: 'Lucas endulge typo meaning' });
  D.insertMonologue({ content: 'r2', model: 'web-read', type: 'reading', query: 'his actual intention behind the indulge typo' });

  const nearDup = await mono.isRepeatOfRecentSearch('what Lucas meant by the endulge typo');
  ok('near-duplicate theme is BRAKED (true)', nearDup === true);

  const distinct = await mono.isRepeatOfRecentSearch('best practices for cold outreach emails 2026');
  ok('genuinely different topic PASSES (false)', distinct === false);

  const empty = await (async () => {
    // fresh-ish: a topic unrelated to seeds also passes
    return mono.isRepeatOfRecentSearch('history of the Hanseatic League trade routes');
  })();
  ok('second unrelated topic PASSES (false)', empty === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(tmp); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
