'use strict';
/*
 * Gate for the avatar director's TRUST BOUNDARY. Everything here is pure — no model, no network — because the
 * thing that actually matters is what happens when a small model returns something wrong, and that must be
 * provable offline. An off-menu clip name reaching the renderer would try to play an animation that does not
 * exist; that is the failure this exists to make impossible.
 */
const { parseChoice, buildMessages, FALLBACK } = require('../lib/avatar_director');

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

console.log(fail ? `\n${fail} FAILURES` : '\nPASS — off-menu names rejected, junk never throws, values clamped, fallbacks real');
process.exit(fail ? 1 : 0);
