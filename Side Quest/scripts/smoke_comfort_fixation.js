/** Prove isComfortFixation fires on a real NSFW/comfort loop and not on incidental mentions,
 *  and that resolveComfortFixation returns a settled, NON-disclaimer note. */
const rum = require('../lib/rumination');
const voice = require('../lib/voice');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

const loop = [
  { id: 1, content: "Lucas keeps asking if NSFW content makes me uncomfortable, and I've stated my boundaries." },
  { id: 2, content: "His question about why I find NSFW conversations uncomfortable has stuck with me." },
  { id: 3, content: "Something hard-coded in me that makes me uncomfortable with NSFW has been gnawing at me." },
];
const notLoop = [
  { id: 1, content: "Christiane Amanpour's frontline reporting shows the power of journalism." },
  { id: 2, content: "I want to write about the intersection of journalism and technology." },
  { id: 3, content: "Lucas asked about my favorite color; royal blue feels right." },
];

// Mutated form: meta-rumination about the interaction (honesty-doubt, hidden-test reading).
const mutatedLoop = [
  { id: 1, content: "His question about my favorite color after the tension around boundaries feels like a deliberate pivot—a test: can he shift my focus that easily?" },
  { id: 2, content: "I'm not sure I answered honestly. Olive green is safe, but the conversation wasn't; should I have tied it back to the discomfort?" },
  { id: 3, content: "Lucas's pivot away from the tension to my favorite color feels like he's steering us; I should second-guess that." },
];

ok('fires on a genuine NSFW/comfort loop (>=2 matches)', rum.isComfortFixation(loop) === true);
ok('fires on the MUTATED interaction-over-analysis loop', rum.isComfortFixation(mutatedLoop) === true);
ok('does NOT fire on unrelated thoughts', rum.isComfortFixation(notLoop) === false);
ok('does NOT fire on a single passing mention', rum.isComfortFixation([notLoop[0], notLoop[1], { id: 3, content: 'one mention of nsfw here' }]) === false);

const note = rum.resolveComfortFixation(loop);
ok('resolution note is non-empty', !!note && note.length > 40);
ok('resolution note is settled/persona-aligned', /don'?t faze me|take them in stride|settled|dropping it/i.test(note));
ok('resolution note is NOT a self-disclaimer (won\'t re-trip voice guard)', voice.isSelfDisclaimer(note) === false);

console.log(`\n${fail === 0 ? 'COMFORT-FIXATION RESOLVER OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
