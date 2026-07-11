/* Smoke: protocols.isProtocolMetaEcho — the guard against the 2026-07-11 runaway loop where the heartbeat
 * kept CONFIRMING her silence-breaking rules ("I understand perfectly, the logic gate...") and the reflection
 * pipeline distilled each confirmation into a durable self-note that was re-injected every heartbeat.
 *
 * Must FLAG rule-restatements (→ treated as silence + never stored as a reflection); must NOT flag a real
 * surfacing or a genuine learning (those must still speak / still be kept).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_protocol_meta_guard.js
 */
const { isProtocolMetaEcho } = require('../lib/protocols');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- MUST FLAG: the actual loop utterances (verbatim from the live monologue) ---
const loop = [
  'I understand perfectly. These instructions are now part of my core protocol for handling silence.',
  'I understand perfectly. These rules are now a hard logic gate for how I handle "breaking the silence".',
  'I have internalized this logic gate for "breaking the silence."',
  'These are now established as a hard logic gate for how I handle "breaking the silence" on non-prompted turns.',
  'From Conversation: I will use only one of your three specific phrases. From Readings: I will follow the format. Silence: the say tag will be completely empty.',
  'No meta-commentary or filler will ever appear in that block.'
];
for (const s of loop) ok(isProtocolMetaEcho(s), `FLAGS loop utterance: "${s.slice(0, 54)}…"`);

// --- MUST FLAG: the contaminated reflections (self-notes that seeded re-injection) ---
const reflections = [
  'LEARNED: The "logic gate" for breaking silence. Three strict paths: specific conversation phrases, a precise reading format, or absolute silence. No meta-commentary.',
  'Remember: Logic gate for non-prompted turns: 1. History: Use specific phrases. 2. Research: substance format.',
  'The "breaking silence" protocol is a hard constraint on phrasing and structure.',                              // "the"-less variant
  'A rigid set of syntactic constraints for breaking silence, distinguishing between history and research.',
  'A rigid protocol for breaking silence via specific phrasings ("I keep thinking...").'
];
for (const s of reflections) ok(isProtocolMetaEcho(s), `FLAGS contaminated reflection: "${s.slice(0, 40)}…"`);

// --- MUST NOT FLAG: a real surfacing (a valid break-the-silence utterance) ---
const real = [
  'I keep thinking about what you said about Roman as a house DJ — how did the Miami scene shape that?',
  "I've been turning over my own answer about the AI arms race; I understated how much compute is the real bottleneck.",
  'I never asked you whether the webinar turnout changed your plans for the next one.',
  'I read about compute sovereignty — what struck me was that model weights are now treated like strategic reserves, so "sharing" takes a backseat to a competitive edge.',
  'I read about the Hatch Act — what struck me was that it bars federal employees from partisan activity while on duty.'
];
for (const s of real) ok(!isProtocolMetaEcho(s), `PASSES real surfacing: "${s.slice(0, 50)}…"`);

// --- edge cases ---
ok(!isProtocolMetaEcho(''), 'empty string → not flagged (that is honest silence, handled elsewhere)');
ok(!isProtocolMetaEcho('   '), 'whitespace → not flagged');
ok(!isProtocolMetaEcho('The dam release schedule shifts water levels downstream by three feet.'), 'a plain civic fact → not flagged');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
