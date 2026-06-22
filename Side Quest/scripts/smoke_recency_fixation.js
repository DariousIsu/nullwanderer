/**
 * Backtest — recency-fixation seed guard (monologue.diversifySeeds), OFFLINE.
 * Part of the fix for the "roving obsession engine": a single fixation must not fill the
 * free-association seed and get re-connected to everything. (NOTE: this is a PARTIAL
 * measure — the deeper core-idea-mashing problem is still being designed with Lucas.)
 */
const { diversifySeeds } = require('../lib/monologue');
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
