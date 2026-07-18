/**
 * Backtest — recency-fixation seed guard (monologue.diversifySeeds), OFFLINE.
 * Part of the fix for the "roving obsession engine": a single fixation must not fill the
 * free-association seed and get re-connected to everything. (NOTE: this is a PARTIAL
 * measure — the deeper core-idea-mashing problem is still being designed with Lucas.)
 */
const { diversifySeeds, pickDistinctByTopic } = require('../lib/monologue');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — diversifySeeds (recency-fixation guard)\n');

const mono = [
  { content: 'The Ramp Card initiative could anchor abstract policy discussions.' },
  { content: 'Ramp Card initiative at the Joseph Rainey Center keeps coming to mind.' },
  { content: 'I keep thinking about the Ramp Card and how it ties into governance.' },
  { content: 'The Ramp Card concept could leverage productive dialogue in meetings.' }
];
const md = diversifySeeds(mono);
ok('mono-thematic stream → collapses to ONE seed', md.seeds.length === 1);
ok('mono-thematic stream → flagged monoFixated', md.monoFixated === true);
ok('detects the anchor even though it is a short word ("ramp"/"card")', /ramp|card/i.test(md.anchor || ''));

const varied = [
  { content: 'Authoritarian governments suppress dissent and stifle innovation.' },
  { content: 'Immersive storytelling could make policy research more engaging.' },
  { content: 'A SQL dedup script could clean the Salesforce duplicate records.' },
  { content: 'The Ramp Card initiative keeps coming to mind too.' }
];
const vd = diversifySeeds(varied);
ok('varied stream → multiple distinct seeds', vd.seeds.length >= 3);
ok('varied stream → NOT flagged monoFixated', vd.monoFixated === false);

ok('empty stream → no seeds, not fixated', (() => { const r = diversifySeeds([]); return r.seeds.length === 0 && r.monoFixated === false; })());
ok('two identical thoughts (<3) → not yet flagged', diversifySeeds([{ content: 'Ramp Card again.' }, { content: 'The Ramp Card once more.' }]).monoFixated === false);

// --- pickDistinctByTopic (synthesis input topic-diversity) ---
console.log('\npickDistinctByTopic (synthesis input diversity)\n');
// A sprawled open-thread list dominated by ONE cluster collapses to distinct clusters.
const sprawledThreads = [
  { content: 'research parish leadership contacts in Louisiana for Lucas' },
  { content: 'continue researching and documenting the Louisiana Parishes' },
  { content: 'compile leadership and historical data for all Louisiana parishes' },
  { content: 'organize and clean the Louisiana Parish leadership database' },
  { content: 'conduct a research project on the race to build AI models' },
  { content: 'monitor the Norway vs England world cup match for Lucas' },
];
const distinctThreads = pickDistinctByTopic(sprawledThreads, { max: 4, simThr: 0.4, window: sprawledThreads.length });
ok('7×-parish sprawl collapses (< the raw count)', distinctThreads.length < sprawledThreads.length);
ok('distinct clusters survive (parish + AI + world cup ≥ 3)', distinctThreads.length >= 3);
ok('only ONE parish thread survives the dedup', distinctThreads.filter(t => /parish/i.test(t.content)).length === 1);
ok('the AI-models thread is kept as a distinct cluster', distinctThreads.some(t => /AI models/i.test(t.content)));
ok('output is chronological (newest last)', /world cup|AI models/i.test((distinctThreads[distinctThreads.length - 1] || {}).content || ''));
// A genuinely varied stream is left intact (nothing collapses).
const variedThoughts = [
  { content: 'Authoritarian governments suppress dissent and stifle innovation broadly.' },
  { content: 'Immersive storytelling could make policy research more engaging overall.' },
  { content: 'A SQL dedup script could clean the Salesforce duplicate records today.' },
];
ok('varied stream is left intact (no false collapse)', pickDistinctByTopic(variedThoughts, { max: 8 }).length === 3);
ok('empty input → empty output (fail-soft)', pickDistinctByTopic([]).length === 0);
ok('accepts plain strings too', pickDistinctByTopic(['alpha beta gamma delta', 'alpha beta gamma delta epsilon', 'wholly unrelated seventeen orange']).length === 2);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
