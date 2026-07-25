/* Smoke: lib/conversation_agent — conversation as an agent loop (KEYSTONE Slice 2a). Proves the loop
 * dereferences coordinates then answers from what it gathered, honors an explicit final, handles a plain
 * text answer, records a gap when web is unavailable (so she can be honest), synthesizes when steps run
 * out, and that the flag defaults OFF. Fully offline — the model is a scripted mock.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_conversation_agent.js
 */
'use strict';
const CA = require('../lib/conversation_agent');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// scripted model: returns the next queued response per call
function scriptedModel(queue) { let i = 0; return async () => queue[Math.min(i++, queue.length - 1)]; }

(async () => {
  // ── flag defaults OFF ────────────────────────────────────────────────────────────────────────
  ok(CA.isOn({ db: { getMeta: () => null } }) === false, 'flag: conv.agentloop defaults OFF');
  ok(CA.isOn({ db: { getMeta: () => 'on' } }) === true, 'flag: flips ON when meta says so');

  // ── the loop DEREFS then answers from what it gathered ────────────────────────────────────────
  const derefed = [];
  const r1 = await CA.run({
    userMessage: 'is Alice excited for cheer?',
    manifestText: 'OBJECTS:\n  "Alice" -> person:owner/alice  (held)',
    deps: {
      complete: scriptedModel([
        '{"action":"deref","coord":"person:owner/alice"}',
        '{"final":"Yeah — she just started strength training for her Level 1 Elite year, she is fired up."}',
      ]),
      deref: async (coord) => { derefed.push(coord); return "Lucas's youngest daughter, 12, competitive cheer, started strength training"; },
    },
  });
  ok(r1 && derefed[0] === 'person:owner/alice', 'loop: dereferenced the coordinate before answering');
  ok(r1.derefs === 1 && /strength training/i.test(r1.reply), 'loop: the answer is grounded in the deref, not invented');
  ok(r1.steps === 2, 'loop: two steps (deref → final)');

  // ── a plain-text answer (model just speaks) is returned as the reply ──────────────────────────
  const r2 = await CA.run({ userMessage: 'how are you?', manifestText: '', deps: { complete: scriptedModel(['Steady and a little stretched — good to see you.']) } });
  ok(r2 && /steady/i.test(r2.reply), 'loop: a direct non-JSON answer is taken as the reply');

  // ── a GAP with no web tool → recorded so she can be honest ("I do not hold this yet") ─────────
  let sawGapNote = false;
  const r3 = await CA.run({
    userMessage: 'what are the Disney summit dates?',
    manifestText: 'GAPS: place:short/walt-disney-world',
    deps: {
      complete: (() => { let i = 0; return async (prompt) => {
        if (/don't hold this yet/i.test(prompt)) sawGapNote = true;   // the gap note reached the model
        return i++ === 0 ? '{"action":"web","query":"disney summit dates"}' : '{"final":"I don\'t hold anything on the Disney summit yet — send me the flier and I\'ll map it."}';
      }; })(),
      // no web dep → gap path
    },
  });
  ok(sawGapNote, 'gap: web-unavailable note is fed back so the model can admit the gap honestly');
  ok(r3 && /don't hold/i.test(r3.reply), 'gap: she says she does not hold it rather than inventing');

  // ── synthesis fallback: model never emits final within maxSteps → one closing synthesis pass ──
  const r4 = await CA.run({
    userMessage: 'tell me about Rainey',
    manifestText: 'OBJECTS:\n  "Rainey" -> org:work/rainey-center (held)',
    maxSteps: 2,
    deps: {
      complete: (() => { return async (prompt) => {
        if (/Answer now with/.test(prompt)) return '{"final":"Rainey Center — where we both work."}';
        return '{"action":"deref","coord":"org:work/rainey-center"}';   // always a tool → never finals on its own
      }; })(),
      deref: async () => 'Rainey Center — your employer',
    },
  });
  ok(r4 && /Rainey Center/.test(r4.reply), 'synthesis: runs a closing pass when steps run out without a final');

  // ── total model failure → null so the caller can fall back to the pipeline ────────────────────
  const r5 = await CA.run({ userMessage: 'x', deps: { complete: async () => { throw new Error('model down'); } } });
  ok(r5 === null, 'fail-soft: model failure returns null (caller falls back to the one-shot pipeline)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
