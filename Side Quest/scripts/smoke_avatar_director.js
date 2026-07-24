'use strict';
/*
 * Gate for the avatar director's TRUST BOUNDARY. Everything here is pure — no model, no network — because the
 * thing that actually matters is what happens when a small model returns something wrong, and that must be
 * provable offline. An off-menu clip name reaching the renderer would try to play an animation that does not
 * exist; that is the failure this exists to make impossible.
 */
const { parseChoice, buildMessages, postureFromTurn, FALLBACK, SOURCE_POSTURE } = require('../lib/avatar_director');

const CLIPS = ['idle', 'listen', 'speak', 'think', 'idle_settle', 'listen_lean',
               'speak_soft', 'speak_emphatic', 'think_deep', 'nod', 'shake', 'perk'];
let fail = 0;
const ok = (cond, label, extra) => { if (!cond) { console.log('FAIL:', label, extra == null ? '' : JSON.stringify(extra)); fail++; } };

// --- accepts a clean answer
let c = parseChoice('{"clip":"speak_emphatic","intensity":0.8,"hold":5}', CLIPS);
ok(c && c.clip === 'speak_emphatic' && c.intensity === 0.8 && c.hold === 5, 'clean answer', c);

// --- small models wrap things: prose, fences, trailing chatter
ok(parseChoice('Sure! {"clip":"nod","intensity":0.5,"hold":2} hope that helps', CLIPS) !== null, 'prose-wrapped');
ok(parseChoice('```json\n{"clip":"listen_lean","intensity":0.7,"hold":4}\n```', CLIPS) !== null, 'fenced');

// --- THE ONE THAT MATTERS: an off-menu name must be rejected, not passed through
ok(parseChoice('{"clip":"backflip","intensity":0.9,"hold":3}', CLIPS) === null, 'off-menu clip rejected');
ok(parseChoice('{"clip":"","intensity":0.9}', CLIPS) === null, 'empty clip rejected');
ok(parseChoice('{"clip":"Speak","intensity":0.5}', CLIPS) === null, 'wrong-case rejected (menu is exact)');

// --- garbage never throws and never yields a choice
for (const junk of ['', null, undefined, 'no json here', '{broken', '[]', '{"x":1}']) {
  let r; let threw = false;
  try { r = parseChoice(junk, CLIPS); } catch (e) { threw = true; }
  ok(!threw, 'no throw on junk', junk);
  ok(r === null, 'junk yields null', junk);
}

// --- out-of-range values are clamped, not trusted
c = parseChoice('{"clip":"idle","intensity":99,"hold":9999}', CLIPS);
ok(c && c.intensity === 1 && c.hold === 8, 'clamps high', c);
c = parseChoice('{"clip":"idle","intensity":-5,"hold":-5}', CLIPS);
ok(c && c.intensity === 0 && c.hold === 1, 'clamps low', c);
c = parseChoice('{"clip":"idle"}', CLIPS);
ok(c && Number.isFinite(c.intensity) && Number.isFinite(c.hold), 'defaults when omitted', c);

// --- an empty menu can never be satisfied
ok(parseChoice('{"clip":"idle"}', []) === null, 'empty menu rejects everything');

// --- the deterministic fallbacks must be real clips, or the safety net points at nothing
for (const k of Object.keys(FALLBACK)) ok(CLIPS.includes(FALLBACK[k]), 'fallback is a real clip: ' + k, FALLBACK[k]);

// --- the prompt must actually carry the menu, or the model is guessing blind
const msgs = buildMessages({ kind: 'say', text: 'hello', clips: CLIPS });
ok(msgs.length === 2 && CLIPS.every((n) => msgs[0].content.includes(n)), 'prompt lists every clip');
ok(msgs[1].content.includes('say'), 'prompt carries the event');

/* ---- POSTURE FROM THE TURN. These are the shapes cognition.answerGrounded actually returns; the point is
   that WHERE the answer came from is a fact the program owns, and the body must not contradict it. ---- */

// THE ONE THAT MATTERS MOST: an honest miss must read as a miss, and must not spend a cloud call to be
// talked out of it. She checked, she searched, she found nothing — the body says no.
let p = postureFromTurn({ kind: 'say', missed: true, enriched: true, need: 'the vote count', tried: ['graph', 'web'] });
ok(p && p.clip === 'shake' && p.decisive === true, 'searched-miss → shake, decisively', p);
ok(CLIPS.includes(p.clip), 'miss posture is a real clip', p);

// a miss is a miss regardless of event kind — it is about the outcome, not the trigger
ok((postureFromTurn({ kind: 'think', missed: true }) || {}).clip === 'shake', 'miss outranks the event kind');

// answered with nothing fetched = it was already in hand: her most settled state
p = postureFromTurn({ kind: 'say', enriched: false, enrichSource: null });
ok(p && p.clip === 'speak' && p.decisive === false, 'grounded → settled speak, model may still refine', p);

// her OWN model is the strongest ground she has; a dug-up web page is the weakest
ok((postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'forecast' }) || {}).clip === 'speak_emphatic',
   'her own forecast → emphatic');
ok((postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'graph' }) || {}).clip === 'speak',
   'our own KG → settled');
ok((postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'excavate' }) || {}).clip === 'speak_soft',
   'had to dig for it → soft');
ok((postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'wiki-verify' }) || {}).clip === 'speak_soft',
   'hyphenated source name resolves (wiki-verify)');

// every posture in the table must be a clip that exists, or the director points at nothing
for (const s of Object.keys(SOURCE_POSTURE)) ok(CLIPS.includes(SOURCE_POSTURE[s]), 'posture is a real clip: ' + s, SOURCE_POSTURE[s]);

// no signal → null, so the caller falls through to the model instead of inventing certainty
for (const t of [null, undefined, {}, 'nope', { kind: 'say' }, { kind: 'say', enriched: true, enrichSource: 'martian' }]) {
  let r; let threw = false;
  try { r = postureFromTurn(t); } catch (e) { threw = true; }
  ok(!threw, 'posture never throws', t);
  ok(r === null, 'no usable signal → null', t);
}

// a listening turn is not an answer — posture is about how she ANSWERS
ok(postureFromTurn({ kind: 'hear', enriched: false, enrichSource: null }) === null, 'hear carries no posture');

// the suggested posture must reach the model, or passing it changed nothing
const pm = buildMessages({ kind: 'say', text: 'hi', clips: CLIPS, posture: { clip: 'speak_soft', why: 'enriched:web' } });
ok(pm[1].content.includes('speak_soft') && pm[1].content.includes('enriched:web'), 'prompt carries the posture', pm[1].content);

/* ---- SIGNAL-ONLY IS THE DEFAULT. Measured: the posture floor alone was right 4/4 while local gemma4:12b
   managed 0/4 and hermes3:8b changed one case for the worse. So with no ZOE_AVATAR_MODEL set, chooseClip
   must answer from the signal WITHOUT a network call — that is what "save the delay" actually buys. ---- */
const { chooseClip, directorModel } = require('../lib/avatar_director');
delete process.env.ZOE_AVATAR_MODEL;
ok(directorModel() === null, 'no model configured by default', directorModel());

(async () => {
  const t0 = Date.now();
  const web = await chooseClip({ kind: 'say', text: 'The amendment failed 211-217.', clips: CLIPS,
                                 turn: { enriched: true, enrichSource: 'web' } });
  const dt = Date.now() - t0;
  ok(web.source === 'signal' && web.clip === 'speak_soft', 'no model → posture answers directly', web);
  ok(dt < 100, 'answered without a network call (<100ms)', dt);

  const miss = await chooseClip({ kind: 'say', text: 'x', clips: CLIPS, turn: { missed: true } });
  ok(miss.source === 'signal' && miss.clip === 'shake', 'miss still decisive with no model', miss);

  const hear = await chooseClip({ kind: 'hear', text: 'can you check that?', clips: CLIPS });
  ok(hear.clip === 'listen', 'no posture and no model → deterministic map still holds', hear);

  // opting a model back in must still route through the model path
  process.env.ZOE_AVATAR_MODEL = 'some-model';
  ok(directorModel() === 'some-model', 'ZOE_AVATAR_MODEL opts the model back in');
  delete process.env.ZOE_AVATAR_MODEL;

  console.log(fail ? `\n${fail} FAILURES` : '\nPASS — off-menu rejected, junk never throws, values clamped, a miss reads as a miss, and with no model configured the signal answers in 0ms');
  process.exit(fail ? 1 : 0);
})();
