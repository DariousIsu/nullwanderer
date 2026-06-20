/**
 * Backtest — recipe card (procedural memory). The atlas "recipes must execute"
 * gate, applied to SQ: every recipe's canonical `emit` example is run through the
 * REAL parser for its tool, so the card can never advertise a tag the dispatcher
 * won't accept. Also checks email/discord gating and a footprint bound.
 *
 * Run under electron-as-node.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_recipes_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const recipes = require('../lib/recipes');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

function run() {
  db.init();
  console.log('Backtest — recipe card (procedural memory)\n');

  // --- every recipe example is recognized by its real parser ---
  console.log('recipe examples validate against live parsers:');
  const all = recipes.allRecipes();
  for (const r of all) {
    let okFlag = false;
    try { okFlag = !!r.check(r.emit); } catch (e) { okFlag = false; }
    ok(`[${r.tier}] ${r.need}  →  ${r.emit.slice(0, 48)}`, okFlag);
  }

  // --- gating ---
  console.log('\ngating + card:');
  const active = recipes.activeRecipes();
  ok('core recipes always present', active.some(r => r.tier === 'core'));
  ok('email recipes present iff email configured', recipes.emailReady() ? active.some(r => r.tier === 'email') : !active.some(r => r.tier === 'email'));
  ok('discord recipes present iff discord configured', recipes.discordReady() ? active.some(r => r.tier === 'discord') : !active.some(r => r.tier === 'discord'));

  const text = recipes.card();
  ok('card has the literal-tag discipline header', /emit the LITERAL tag/i.test(text));
  ok('card lists at least the core recipes', active.filter(r => r.tier === 'core').every(r => text.includes(r.emit)));

  // --- footprint bound (rough: chars/4 ≈ tokens; keep well under a turn budget) ---
  // Ceiling is 800 (≈10% of the 8192 turn budget; the Echo atlas precedent was ~1270).
  const approxTokens = Math.round(text.length / 4);
  ok(`footprint bounded (~${approxTokens} tok < 800)`, approxTokens < 800);
  console.log(`    (card ≈ ${approxTokens} tokens, ${active.length} active recipes)`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
