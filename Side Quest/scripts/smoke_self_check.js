/**
 * Backtest — self_check.js (Tier-1 capability self-test), OFFLINE (temp DB, no model).
 * Proves the model-free pathway sweep: real pathways/recipes/modules come back green,
 * the ledger + throttle behave, the awareness line grounds capability-confidence, and a
 * forced breakage goes RED → surfaces a reading + a deduped gap.
 */
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_selfcheck_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const sc = require('../lib/self_check');
const recipesLib = require('../lib/recipes');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Backtest — self_check.js (offline)\n');

  console.log('green sweep (real pathways/recipes/modules are intact):');
  const pathways = sc.checkActionPathways();
  ok('action pathways all parse (green)', pathways.length > 0 && pathways.every(r => r.status === 'green'));
  const files = sc.checkRecipeFiles();
  ok('recipe files runner-shaped (green)', files.status === 'green');
  const mods = sc.checkCoreModules();
  ok('core modules present (recorder/flow_runner/recipe_store/own browser)', mods.length === 4 && mods.every(m => m.status === 'green'));

  console.log('\nrun() ledger + throttle:');
  ok('due at boot (no prior ts)', sc.due() === true);
  const ledger = sc.run();
  ok('run returns an all-green ledger', ledger.allGreen === true && ledger.red.length === 0 && ledger.green === ledger.total);
  ok('ledger persisted to meta', (() => { const l = sc.lastLedger(); return l && l.total === ledger.total && l.allGreen; })());
  ok('not due again immediately after a run', sc.due() === false);

  console.log('\nawarenessLine (grounds capability-confidence):');
  const line = sc.awarenessLine();
  ok('green line states all pathways verified', /all \d+ of your action pathways verified/i.test(line) && /doubt you can do something/i.test(line));

  console.log('\nRED path (force a drifted pathway → surfaces reading + deduped gap):');
  const realActive = recipesLib.activeRecipes;
  recipesLib.activeRecipes = () => [
    { need: 'a healthy pathway', emit: '<ok/>', check: () => true },
    { need: 'a drifted pathway', emit: '<gone/>', check: () => false }   // parser no longer matches
  ];
  const before = db.getOpenCapabilityGaps(20).length;
  const redLedger = sc.run();
  ok('ledger goes RED with the drifted pathway', redLedger.allGreen === false && redLedger.red.some(r => /drifted/.test(r.name)));
  const readings = db.getRecentMonologueByType('reading', 5);
  ok('a reading was surfaced about the breakage', readings.some(r => /broken pathway/i.test(r.content)));
  const afterOne = db.getOpenCapabilityGaps(20).length;
  ok('a capability gap was recorded', afterOne === before + 1);
  // second identical RED run must NOT double-log the gap (signature dedup)
  sc.run();
  const afterTwo = db.getOpenCapabilityGaps(20).length;
  ok('repeat RED run does not duplicate the gap', afterTwo === afterOne);
  ok('RED awareness line flags attention', /need attention/i.test(sc.awarenessLine()));
  recipesLib.activeRecipes = realActive;   // restore

  console.log('\nthrottle window:');
  db.setMeta(sc.LAST_TS_KEY, String(Date.now() - (sc.CHECK_INTERVAL_MS + 1000)));
  ok('due again after the interval elapses', sc.due() === true);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
