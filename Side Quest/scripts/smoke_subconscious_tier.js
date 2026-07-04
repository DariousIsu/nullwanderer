/* Smoke: tiered subconscious brain (lib/subconscious.js) — triage + budget + source grounding +
 * synthesis. Pure/deterministic: in-memory meta + injected search. No model/network/db.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_subconscious_tier.js
 */
'use strict';
const S = require('../lib/subconscious');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- MERIT ---
  ok(S.meritScore({ activeFocus: { id: 1 } }).score >= 3, 'focus alone clears the bar');
  ok(S.meritScore({ wonder: true }).score >= 3, 'a <wonder> clears the bar');
  ok(S.meritScore({ mode: 'free', novelty: 0.1, importance: 0.1 }).score === 0, 'mundane free-association scores 0');
  ok(S.meritScore({ novelty: 0.7, importance: 0.8 }).score >= 4, 'novel + important stacks');
  ok(S.meritScore({ wonder: true }).reasons.includes('wonder'), 'reasons explain the score');

  // --- TIER DECISION ---
  ok(S.decideTier({ wonder: true }, { mode: 'hybrid', budgetOk: true }).tier === 'cloud', 'hybrid: merit → cloud');
  ok(S.decideTier({ mode: 'free' }, { mode: 'hybrid', budgetOk: true }).tier === 'local', 'hybrid: mundane → local');
  ok(S.decideTier({ wonder: true }, { mode: 'hybrid', budgetOk: false }).tier === 'local', 'budget exhausted → local even with merit');
  ok(S.decideTier({ wonder: true }, { mode: 'local' }).tier === 'local', 'mode=local never goes cloud');
  ok(S.decideTier({ mode: 'free' }, { mode: 'all', budgetOk: true }).tier === 'cloud', 'mode=all → cloud regardless of merit');
  ok(S.decideTier({ mode: 'free' }, { mode: 'all', budgetOk: false }).tier === 'local', 'mode=all still respects budget');
  ok(S.decideTier({ novelty: 0.4 }, { mode: 'hybrid', threshold: 1, budgetOk: true }).tier === 'cloud', 'threshold is tunable');

  // --- BUDGET (rolling 1h window over in-memory meta) ---
  const store = {}; const getMeta = (k) => store[k]; const setMeta = (k, v) => { store[k] = v; };
  const T0 = 1_000_000_000_000;
  ok(S.budgetOk(getMeta, T0, 100000) === true, 'empty window is within budget');
  S.recordSpend({ getMeta, setMeta, now: T0, tokens: 60000 });
  S.recordSpend({ getMeta, setMeta, now: T0 + 60000, tokens: 50000 });
  ok(S.spentLastHour(getMeta, T0 + 120000) === 110000, 'spend sums within the hour');
  ok(S.budgetOk(getMeta, T0 + 120000, 100000) === false, 'over cap → not ok (fail-safe to local)');
  ok(S.spentLastHour(getMeta, T0 + 2 * 3600 * 1000) === 0, 'window prunes entries older than 1h');
  ok(S.budgetOk(getMeta, T0, 0) === true, 'cap 0/unset = uncapped');
  // BUDGET ISOLATION: a lane with its OWN window key is unaffected by the shared pool being maxed out.
  // (the idle graph-walk uses this so news/curation/forecast spend can't starve knowledge-expansion.)
  const LANE = 'graphwalk.budget.window';
  ok(S.budgetOk(getMeta, T0 + 120000, 100000, LANE) === true, 'isolated lane is within budget though the shared window is over cap');
  S.recordSpend({ getMeta, setMeta, now: T0 + 120000, tokens: 70000, key: LANE });
  ok(S.spentLastHour(getMeta, T0 + 120000, LANE) === 70000, 'isolated lane accrues only its OWN spend');
  ok(S.spentLastHour(getMeta, T0 + 120000) === 110000, 'shared window is untouched by the lane spend');
  ok(S.budgetOk(getMeta, T0 + 120000, 60000, LANE) === false, 'the isolated lane enforces its own cap');
  ok(S.estimateTokens([{ content: 'a'.repeat(400) }], 'b'.repeat(400)) === 200, 'estimateTokens ~chars/4');

  // --- SOURCE SUPPORT ---
  const search = async (q, k) => [
    { content: 'Lucas has two kids, Maya and Theo.', source: 'personal_fact' },
    { content: 'He prefers concise answers.', source: 'preference' }
  ].slice(0, k);
  const srcs = await S.retrieveSources('what do I know about Lucas', { search, k: 2 });
  ok(srcs.length === 2 && srcs[0].ref === 'S1', 'retrieveSources tags refs S1..Sn');
  ok(/personal_fact/.test(srcs[0].source), 'source label preserved');
  ok((await S.retrieveSources('x', {})).length === 0, 'no search fn → [] (fail-safe)');
  const gb = S.buildGroundingBlock(srcs);
  ok(/\[S1\]/.test(gb) && /Maya/.test(gb) && /do NOT invent/i.test(gb), 'grounding block cites refs + anti-confabulation instruction');
  ok(S.buildGroundingBlock([]) === '', 'no sources → empty grounding block');

  // --- SYNTHESIS ---
  const s2 = {}; const gm2 = (k) => s2[k]; const sm2 = (k, v) => { s2[k] = v; };
  ok(S.shouldSynthesize({ getMeta: gm2, now: T0, intervalMin: 20 }) === true, 'first synthesis is due');
  S.markSynthesized({ setMeta: sm2, now: T0 });
  ok(S.shouldSynthesize({ getMeta: gm2, now: T0 + 5 * 60000, intervalMin: 20 }) === false, 'not due 5min later');
  ok(S.shouldSynthesize({ getMeta: gm2, now: T0 + 21 * 60000, intervalMin: 20 }) === true, 'due again after interval');
  const sp = S.buildSynthesisPrompt({ recentThoughts: [{ content: 'thinking about entropy' }, { content: 'and 6G channels' }], threads: [{ content: 'finish the memory work' }], sources: srcs });
  ok(/entropy/.test(sp) && /Open threads/.test(sp) && /\[S1\]/.test(sp) && /<wonder>/.test(sp), 'synthesis prompt packs thoughts + threads + grounding + wonder ask');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
