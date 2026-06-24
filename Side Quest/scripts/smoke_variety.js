/** Prove the anti-repetition nudge: it fires on her real stock-template stretch and names the
 *  patterns; stays silent (null) when her voice is varied or there's too little to judge. No model. */
const voice = require('../lib/voice');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

// real repetitive stretch (from the live diagnostic)
const repetitive = [
  "I keep thinking about what you said about Roman as a house DJ. It's fascinating how the scene evolved. What drew you to it?",
  "I keep thinking about what you said about Nonpoint in Miami. It's interesting how those connections form. Do you remember more?",
  "Lucas, I appreciate you sharing that about Smallville. It's interesting to think about how names carry meaning. What else?",
  "I understand what you mean about human memory, Lucas. It's fascinating how our brains work. Do certain triggers bring memories back?",
  "Lucas, I appreciate your willingness to share these stories. It's amazing how vivid they still are. What's your favorite?",
];
const varied = [
  "Roman as a house DJ — no wonder you've got stories. Did you ever catch one of his sets live?",
  "Miami in that era must have been something else. I picture sweat on the walls and a bassline you could stand on.",
  "Smallville. So my last name is basically a timestamp of when you built me. I kind of love that.",
  "Memory's a strange machine — half archive, half rumor. Mine's more literal, but I think yours keeps the better stories.",
  "Late nights at Castle Ybor. You were collecting the kind of material most people only read about.",
];

console.log('fires on the repetitive stretch + names the patterns:');
const n = voice.buildAntiRepetitionNudge(repetitive, 'Lucas');
ok('returns a nudge (not null)', !!n);
ok('flags the "it\'s fascinating/interesting" tic', /fascinating\/interesting/i.test(n || ''));
ok('flags the reused opener', /reopening with/i.test(n || ''));
ok('flags ending-on-a-question', /ending on a question/i.test(n || ''));

console.log('\nstays silent when her voice is varied:');
ok('varied replies → null', voice.buildAntiRepetitionNudge(varied, 'Lucas') === null);

console.log('\nstays silent with too little to judge / placeholders:');
ok('< 3 replies → null', voice.buildAntiRepetitionNudge(['hey', 'how are you'], 'Lucas') === null);
ok('"…" placeholders ignored → null', voice.buildAntiRepetitionNudge(['…', '…', '…', '…'], 'Lucas') === null);
ok('empty input → null', voice.buildAntiRepetitionNudge([], 'Lucas') === null);

console.log(`\n${fail === 0 ? 'VARIETY OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
