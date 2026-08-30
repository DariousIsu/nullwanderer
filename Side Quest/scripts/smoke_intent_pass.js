/* smoke_intent_pass.js — W1 THE ONE INTENT PASS (docs/CHAT_PATH_SIMPLIFICATION_2026-08-29.md).
 * Pins: the fast-path catches every cured leak-ledger phrasing instantly (no model consulted);
 * the classifier's contract (closed vocabulary, clamping, low-confidence deliver → clarify,
 * unknown intent → chatter, the authority + chatter-bias rules in the prompt); one-verdict-per-
 * turn caching; and the four wiring sites (verdict before the doors; canvas create+edit gated;
 * the backstop deliver fallback; the assignment suppression).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_intent_pass.js
 */
'use strict';
const ip = require('../lib/intent_pass');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // ── the fast path: every cured leak-ledger phrasing is caught with NO model ──────────────────
  const LEDGER = [
    'Alright please present your final, full and complete report',
    'Can you make the final deliverable on the anti china legislation with the sponsors and co sponsors please',
    'pull it all together into a document on the canvas',
    'I still need a list of everyone that sponsored or co sponsored those bills in each state',
    'go ahead and finish the summary and Analysis of the Frontier Act',
  ];
  for (const s of LEDGER) {
    const v = ip.fastPath(s);
    ok(v && v.intent === 'deliver' && v.via.startsWith('net:'), `fast path: "${s.slice(0, 52)}…" → deliver (${v ? v.via : 'MISS'})`);
  }
  ok(ip.fastPath('How are you today Zoe?') === null, 'the fast path stays silent on chat — comprehension owns it');

  // ── the classifier contract (fake ask — the parsing/clamping is what's under test) ────────────
  const mk = (resp) => ({ ask: async (args) => { mk.lastArgs = args; return resp; } });
  let d = mk({ intent: 'deliver', deliverable: 'report', topic: 'x', referent: null, size: 'report', confidence: 0.9 });
  let v = await ip.classify('anything', { deps: d });
  ok(v.intent === 'deliver' && v.size === 'report' && v.via === 'model', 'a confident deliver verdict passes through');
  ok(/deliver\|edit\|redirect\|status\|question\|chatter\|control/.test(mk.lastArgs.want) && /unsure between deliver and chatter, answer chatter/.test(mk.lastArgs.want),
    'the prompt carries the closed vocabulary and the chatter bias');
  ok(/OUTRANKS ANY OTHER MEMORY/.test(mk.lastArgs.input.rule), 'the live-window authority law rides the classifier (catch #7)');
  v = await ip.classify('x', { deps: mk({ intent: 'deliver', deliverable: 'report', confidence: 0.4 }) });
  ok(v.intent === 'clarify', 'a low-confidence deliver (real artifact noun) becomes clarify — never silent spawned work');
  v = await ip.classify('x', { deps: mk({ intent: 'banana', confidence: 0.9 }) });
  ok(v.intent === 'chatter', 'an out-of-vocabulary intent clamps to chatter');
  // THE ARTIFACT-NOUN LAW (08-29 live: "just go get the information" → deliver:information at
  // 0.99 → an unrequested wrong-topic document, composed twice by two organs).
  v = await ip.classify('x', { deps: mk({ intent: 'deliver', deliverable: 'information', confidence: 0.99 }) });
  ok(v.intent === 'question', '⭐ deliver with a non-artifact deliverable ("information") DEMOTES to question — a want-to-be-told never composes');
  v = await ip.classify('x', { deps: mk({ intent: 'deliver', deliverable: null, confidence: 0.99 }) });
  ok(v.intent === 'question', 'deliver with NO deliverable noun demotes too (the nets have always required an artifact noun)');
  v = await ip.classify('x', { deps: mk({ intent: 'deliver', deliverable: 'dossier', topic: 'the Frontier Act', confidence: 0.9 }) });
  ok(v.intent === 'deliver', 'a real artifact noun (dossier) still passes as deliver');
  ok(/question = they want to be TOLD/.test(mk.lastArgs.want) && /NEVER deliver/.test(mk.lastArgs.want), 'the prompt DEFINES question (it was in the vocabulary but never defined — the 08-29 hole)');
  ok(/unsure between deliver and question, answer question/.test(mk.lastArgs.want), 'the prompt carries the deliver-vs-question bias');
  ok(/bare reference you cannot resolve from the window/.test(mk.lastArgs.want), 'the prompt demands referent resolution FROM THE WINDOW, with low confidence on a miss');
  ok(mk.lastArgs.lane === 'interactive', '⭐ the classifier rides the INTERACTIVE lane — a live turn\'s comprehension is never quota-starved (the two 08-29 nulls)');
  ok(mk.lastArgs.numPredict === 320, 'the verdict JSON always fits — 220 truncated a long-referent classification (trace#104823)');

  // ── D1 COMPLETION: the extractor executes the verdict (lib/open_threads.groundGoal) ──────────
  const ot = require('../lib/open_threads');
  ok(ot.groundGoal('gather enough data to run forecasting scenarios for Lucas', 'polling data for the St. Petersburg FL mayoral race') ===
    'gather enough data to run forecasting scenarios for Lucas — re: polling data for the St. Petersburg FL mayoral race',
    '⭐ a bare goal gains the verdict\'s referent — the object survives the boundary (the #4109 wound)');
  ok(ot.groundGoal('track the St. Petersburg mayoral polling', 'St. Petersburg mayoral race polling') === 'track the St. Petersburg mayoral polling',
    'a goal already naming the referent is never double-appended');
  ok(ot.groundGoal('do the thing', '') === 'do the thing' && ot.groundGoal('do the thing', 'that information') === 'do the thing',
    'no grounding, or an all-generic referent, leaves the goal untouched (fail-open)');
  ok((await ip.classify('x', { deps: { ask: async () => null } })) === null, 'a dead cloud → null (the nets alone; the pass only adds recall)');
  // the cloud_logic validator CONTRACT (leg 7's second catch): validate receives the RAW STRING
  // and must return {valid, value} — exercise it exactly the way ask() does.
  const vd = mk({ intent: 'chatter', confidence: 0.8 });
  await ip.classify('x', { deps: vd });
  const realValidate = mk.lastArgs.validate;
  let vr = realValidate('Sure! Here is the JSON: {"intent":"deliver","deliverable":"report","confidence":0.9}');
  ok(vr && vr.valid === true && vr.value.intent === 'deliver', 'the validator parses JSON out of a chatty raw string and returns {valid, value}');
  vr = realValidate('I could not classify that.');
  ok(vr && vr.valid === false && typeof vr.error === 'string', 'a JSON-less raw string returns {valid:false, error} — never a bare boolean');
  vr = realValidate('{"intent":"banana","confidence":0.9}');
  ok(vr && vr.valid === false, 'an out-of-vocabulary intent fails validation (the repair retry gets a real error)');

  // ── one verdict per turn ──────────────────────────────────────────────────────────────────────
  ip._resetForTest();
  let calls = 0;
  const dd = { ask: async () => { calls++; return { intent: 'chatter', confidence: 0.8 }; } };
  const t0 = Date.now();
  await ip.intentPass('Taking the quiet morning to do some work on your systems', { deps: dd, nowMs: t0 });
  await ip.intentPass('Taking the quiet morning to do some work on your systems', { deps: dd, nowMs: t0 + 5000 });
  ok(calls === 1, 'the same turn text classifies ONCE — every door reads the one verdict');
  ok(ip.current({ nowMs: t0 + 10000 }).intent === 'chatter', 'current() serves the fresh verdict (the leg-6 sentence = chatter)');
  ok(ip.current({ nowMs: t0 + 120000 }) === null, 'a stale verdict is never served to a later turn');

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/intent_pass'\)\.intentPass\(userMessage, \{ windowText: _iwin \}\)/.test(main), 'wiring: the verdict computes BEFORE the doors, over the rolling assembly');
  ok(/intent=\$\{_iv\.intent\} → standing down/.test(main) && /→ edit suppressed/.test(main), 'wiring: both canvas doors execute the verdict (create + edit)');
  ok(/intent-pass order accepted/.test(main), 'wiring: the backstop claims from a confident deliver verdict (the leak-ledger net)');
  ok(/intent order REFUSED — "\$\{_ivNoun\}" is not an artifact noun/.test(main), 'wiring: the door refuses a non-artifact deliverable (belt behind the classify demotion)');
  ok(/intent order REFUSED — bare\/generic topic/.test(main) && /hasSpecificTopic\(_ivTopic\)/.test(main), '⭐ wiring: a bare/generic topic never claims the road — it CLARIFIES (one question costs a turn; a guessed document cost the evening)');
  ok(/Do NOT start any work, do NOT claim anything is being produced/.test(main), 'wiring: the clarify followup forbids spawning work while asking');
  // D1 completion wiring: the three remaining re-deciders now execute the verdict.
  ok(/grounding: \(\(\) => \{ try \{ const _gv = require\('\.\/lib\/intent_pass'\)\.current\(\)/.test(main), 'wiring D1: the open-threads extractor receives the verdict referent as grounding');
  ok(/the turn's resolved referent \("\$\{_verdictForeign\}"\) shares nothing with run #/.test(main), 'wiring D1: the correction net stands down on zero referent overlap (the #3996 misfacet)');
  ok(/askContext: _askCtx/.test(main) && /planValidatorFor\(ctx\)/.test(main), 'wiring D1: the seeder feeds the ask conversation to the plan composer, behind the no-invented-specifics gate');
  ok(/assignment SUPPRESSED — intent=/.test(main), 'wiring: a chatter verdict de-assigns (the leg-6 false positive)');

  console.log(`\nsmoke_intent_pass: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
