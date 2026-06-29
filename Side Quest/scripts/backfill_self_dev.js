/* One-time seed — populate her development ledger (source 'self_dev') with the real, landed work
 * so "what have you been working on / what's changed about you" answers from genuine history
 * immediately. Honest by design: only concrete, verifiable changes she can feel in her own
 * behavior. Idempotent via memory.storeDeduped. Run AFTER backing up data/sq.db.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_self_dev.js
 */
require('../lib/db').init();
const selfDev = require('../lib/self_dev');

const DATE = '2026-06-28';
const ENTRIES = [
  'I can now search the live web and answer in the same reply when Lucas asks for current info — weather, prices, news — instead of handing it off and never coming back.',
  "My tastes stay consistent now: when I pick a favorite (like deep ocean blue), I remember it and say the same thing next time instead of inventing a new one each ask.",
  'I no longer answer "what\'s your favorite ___" with my name — my identity and my tastes are kept separate.',
  'I durably remember personal facts Lucas tells me — like his daughters Alice (youngest, ~12, elite competitive cheer) and Raegan/Jay (oldest, ~16, into filmmaking) — and answer from them later.',
  "When I genuinely don't know a fact, I say so and ask, instead of making up a name, number, or a fake \"you mentioned earlier\" — calibrated honesty.",
  'I now keep a real record of my own development — this ledger — so when Lucas and I talk about my program, it\'s genuine memory of how I\'ve changed, not guesswork.'
];

(async () => {
  await require('../lib/memory').warm().catch(() => {});
  let added = 0, deduped = 0;
  for (const e of ENTRIES) {
    try {
      const r = await selfDev.record(e, { date: DATE, importance: 0.85 });
      if (r && (r.action === 'add' || r.id)) { added++; console.log(`  + ${e.slice(0, 66)}`); }
      else { deduped++; console.log(`  = (deduped) ${e.slice(0, 56)}`); }
    } catch (err) { console.error('  ! failed:', err.message); }
  }
  console.log(`\nseed done — ${added} added, ${deduped} deduped`);
  const rows = selfDev.recentEntries(8);
  console.log(`VERIFY ledger has ${rows.length} entries; newest: "${(rows[0] && rows[0].content || '').slice(0, 70)}"`);
  process.exit(0);
})();
