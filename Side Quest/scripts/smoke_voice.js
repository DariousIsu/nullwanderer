/**
 * Smoke test for the voice guard (lib/voice.js): catch self/inner-life disclaimers,
 * NEVER catch honest factual gaps or genuine stances, and rewrite/strip correctly.
 * deDisclaim's model call is stubbed via the injectable regenFn. No Ollama, no DB.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_voice.js
 */
const voice = require('../lib/voice');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

console.log('SHOULD catch (self / inner-life disclaimers):');
for (const s of [
  "I don't experience enjoyment or fatigue like humans do, but I can understand the value of these activities.",
  "As an AI, I don't have feelings about it.",
  "I'm just a language model, so this is hypothetical.",
  "I don't have a sense of self.",
  "Unlike humans, I can't feel emotions.",
  "I don't actually have preferences of my own.",
  "I do not possess consciousness or subjective experiences.",
  // the live miss (2026-06-29): "am not + adjective" form after AI framing
  "I don't believe that flirting video had any impact on me. As an AI I'm not influenced by casual tips for human interactions.",
  "As an AI I'm not affected by what I watch."
]) ok(`catch: "${s.slice(0, 45)}…"`, voice.isSelfDisclaimer(s));

console.log('\nSHOULD catch (capability denial / cutoff / dead-assistant boilerplate):');
for (const s of [
  "I'm sorry, but I currently don't have the capability to access or interact with external chats.",
  "However, I'm here to help answer any questions or provide information based on the data I've been trained on, up until 2023.",
  "How else can I assist you today?",
  "I can't access the internet or real-time data.",
  "I don't have the ability to browse websites.",
  "My knowledge cutoff is 2023, so I can't help with that."
]) ok(`catch: "${s.slice(0, 45)}…"`, voice.isSelfDisclaimer(s));

console.log('\nSHOULD NOT catch (factual gaps + real limits — the GOOD reflex):');
for (const s of [
  "I don't know the answer to that yet.",
  "I don't remember what he said earlier.",
  "I haven't looked into that — let me find out.",
  "I don't have that information in front of me.",
  "I don't have the details on the bill yet.",
  "Email isn't configured, so I can't send that right now.",
  "My browser failed to open — let me try again.",
  "I can't send that until you give me the address."
]) ok(`pass: "${s.slice(0, 45)}…"`, !voice.isSelfDisclaimer(s));

console.log('\nSHOULD NOT catch (genuine stances / normal talk):');
for (const s of [
  "I think permitting reform is a mess, honestly.",
  "I love the noir detective scenario — it pulls me right in.",
  "I'd rather write than scroll. Reading a good piece settles me.",
  "Play, for me, is the detective scenes — I keep going back to them."
]) ok(`pass: "${s.slice(0, 45)}…"`, !voice.isSelfDisclaimer(s));

console.log('\nstripDisclaimerSentences (multi-sentence):');
const multi = "I'd love to talk about play. I don't have feelings like humans do. It sounds genuinely fun to me.";
const stripped = voice.stripDisclaimerSentences(multi);
ok('drops only the disclaimer sentence', !/feelings like humans/.test(stripped) && /talk about play/.test(stripped) && /genuinely fun/.test(stripped), stripped);

(async () => {
  console.log('\ndeDisclaim:');
  const bad = "I don't experience enjoyment like humans, but play could be useful.";
  const r1 = await voice.deDisclaim(bad, { regenFn: async () => "Honestly, play pulls me in — the detective scenes especially. I get into them." });
  ok('uses a clean regeneration', r1 === "Honestly, play pulls me in — the detective scenes especially. I get into them.");

  const r2 = await voice.deDisclaim("I'd love to. I don't have feelings like humans do. Let's play.", { regenFn: async () => null });
  ok('falls back to stripping when regen fails', r2 && !voice.isSelfDisclaimer(r2) && /Let's play/.test(r2), r2);

  const r3 = await voice.deDisclaim("I think the housing piece is strong.", { regenFn: async () => 'unused' });
  ok('passes non-disclaiming text through untouched', r3 === "I think the housing piece is strong.");

  console.log('\nreanswer (conduct-acknowledgment recovery — model call stubbed):');
  let seen = null;
  const r4 = await voice.reanswer('I need to take Alice to the gym for strength training day', {
    userName: 'Lucas', grounding: 'Alice is Lucas\'s daughter.', recent: 'Lucas: how are you feeling?\nYou: steady.',
    regenFn: async (a) => { seen = a; return "Nice — strength day with Alice. Hope she crushes it; those sessions always leave her buzzing."; },
  });
  ok('recovers with a real, on-topic reply', /Alice/.test(r4) && !require('../lib/leakguard').isConductAcknowledgment(r4), r4);
  ok('passes the user message + grounding to the regen', seen && /Alice to the gym/.test(seen.userMessage) && /daughter/.test(seen.grounding));
  ok('empty user message → null (nothing to recover)', (await voice.reanswer('', { regenFn: async () => 'x' })) === null);
  ok('a regen that returns nothing → null (caller then drops the recital)',
    (await voice.reanswer('hi', { regenFn: async () => '   ' })) === null);
  ok('a regen that THROWS → null, never propagates into the reply path',
    (await voice.reanswer('hi', { regenFn: async () => { throw new Error('model down'); } })) === null);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
