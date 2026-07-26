/* Smoke: lib/canvas_awareness — surfacing recent canvas drops into chat grounding. Proves the detector
 * fires on canvas/recent-drop questions (and not on ordinary turns) and the block lists recent drops with
 * their understanding gloss. Fully offline — recentDocuments is mocked.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_canvas_awareness.js
 */
'use strict';
const CW = require('../lib/canvas_awareness');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── detector fires on canvas / recent-drop questions ────────────────────────────────────────────
for (const q of [
  'what did I just drop on your canvas?',
  "what's on my canvas?",
  'did you process the papers I dropped?',
  'the docs I gave you — what are they about?',
  'I dropped a few PDFs on your canvas, did you read them?',
]) ok(CW.recognize(q), `detect: "${q.slice(0, 40)}"`);

// ── does NOT fire on ordinary turns ─────────────────────────────────────────────────────────────
for (const q of [
  'how is Alice doing with cheer?',
  'what are the Louisiana parishes?',
  'are you excited for the summit?',
  'give me a rundown of the semiconductor market',
]) ok(!CW.recognize(q), `no false-fire: "${q.slice(0, 40)}"`);

// ── buildBlock lists recent canvas drops with their gloss ────────────────────────────────────────
const mockDocs = (n) => [
  { source: 'canvas_drop', title: 'dac23-pruek', understanding: 'DAC 2023 paper on glass interposer integration of logic and memory chiplets.' },
  { source: 'canvas_drop', title: 'IMAPsCorningTGV', understanding: 'Corning through-glass-via advanced packaging.' },
  { source: 'browser_download', title: 'some-roster.pdf', understanding: 'a county roster' },   // must be excluded
  { source: 'canvas_drop', title: 'Borosilicate foam NTR', understanding: '' },                 // no gloss → title only
].slice(0, n);

const block = CW.buildBlock({ deps: { recentDocuments: mockDocs }, userName: 'Lucas' });
ok(block && /ON YOUR CANVAS/.test(block), 'block: header present');
ok(/dac23-pruek/.test(block) && /glass interposer/.test(block), 'block: a drop with its understanding gloss');
ok(!/some-roster/.test(block), 'block: non-canvas_drop docs are excluded (only the canvas)');
ok(/Borosilicate foam NTR/.test(block), 'block: a drop with no gloss still lists by title');
ok(/do not say you don't have them/.test(block), 'block: carries the anti-refusal instruction');

// ── empty state → null (nothing dropped) ─────────────────────────────────────────────────────────
ok(CW.buildBlock({ deps: { recentDocuments: () => [] } }) === null, 'block: null when nothing is on the canvas');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
