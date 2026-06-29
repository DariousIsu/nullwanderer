/* Smoke: cloud-drafted / locally-voiced answers (lib/answer_draft) — "cloud thinks, local speaks"
 * for grounding-critical turns. Deterministic: injected ask (no cloud), temp DB.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_answer_draft.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_ad_${Date.now()}.db`);
require('../lib/db').init();
const ad = require('../lib/answer_draft');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // ask is injected; it runs the caller's validator on a simulated cloud reply.
  let sawInput = null, sawDeps = null;
  const ask = async ({ input, validate, deps }) => {
    sawInput = input; sawDeps = deps;
    const raw = 'The clip is a montage — right now an analysis of the movie Secretary and the MeToo movement, not a Zoe Barnes scene.';
    const v = validate(raw); return v.valid ? v.value : null;
  };

  const d = await ad.draft({ userMessage: 'what are you watching', grounding: 'Running understanding: Secretary MeToo analysis', kind: 'watching', deps: { ask } });
  ok(/Secretary/.test(d) && /montage/.test(d), 'draft returns the cloud-grounded answer substance');
  ok(sawInput && /Secretary MeToo/.test(sawInput.grounding) && /what are you watching/.test(sawInput.question), 'draft passes question + grounding to the cloud');
  ok(sawDeps && sawDeps.skipBudget === true, 'draft bypasses the daily cloud budget cap (user-facing reliability, never silently skipped)');

  ok((await ad.draft({ userMessage: 'x', grounding: '', deps: { ask } })) === null, 'no grounding → null (fall back to normal local flow)');
  ok((await ad.draft({ userMessage: '', grounding: 'g', deps: { ask } })) === null, 'no question → null');

  // validator rejects a too-short / empty cloud reply → null (never voice junk)
  const askShort = async ({ validate }) => { const v = validate('hi'); return v.valid ? v.value : null; };
  ok((await ad.draft({ userMessage: 'q', grounding: 'g', deps: { ask: askShort } })) === null, 'too-short cloud draft → null');

  // validator strips code fences
  const askFenced = async ({ validate }) => { const v = validate('```\nThe answer is grounded and clear.\n```'); return v.valid ? v.value : null; };
  const df = await ad.draft({ userMessage: 'q', grounding: 'g', deps: { ask: askFenced } });
  ok(df === 'The answer is grounded and clear.', 'validator strips ``` fences');

  // ask throwing → null (fail-safe, never crashes the turn)
  ok((await ad.draft({ userMessage: 'q', grounding: 'g', deps: { ask: async () => { throw new Error('cloud 500'); } } })) === null, 'cloud error → null (fail-safe)');

  // --- factualGrounding: assemble grounding for a factual/shared-history turn (or '' when too thin) ---
  const g1 = ad.factualGrounding({ knowledgeBlock: 'Lucas has two kids, Maya and Theo. He prefers concise answers.', pastTurns: [] });
  ok(/Maya and Theo/.test(g1), 'factualGrounding includes the retrieved knowledge block');
  const g2 = ad.factualGrounding({ knowledgeBlock: null, pastTurns: [{ speaker: 'user', content: 'we agreed to ship Friday' }, { speaker: 'ai_said', content: 'got it, Friday it is' }] });
  ok(/ship Friday/.test(g2) && /Relevant past conversation/.test(g2), 'factualGrounding folds in relevant past turns');
  ok(ad.factualGrounding({ knowledgeBlock: 'tiny', pastTurns: [] }) === '', 'thin/empty grounding → "" (caller uses normal flow, does NOT draft from thin air)');
  ok(ad.factualGrounding({}) === '', 'no grounding at all → ""');

  // voice block: rephrase as her, NO new facts, carries the draft verbatim
  const b = ad.buildVoiceBlock('The clip is a montage about the movie Secretary.', 'Lucas');
  ok(/own voice/i.test(b) && /do NOT add any facts/i.test(b) && /montage about the movie Secretary/.test(b), 'voice block: voice-it + no-new-facts + carries the draft');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
