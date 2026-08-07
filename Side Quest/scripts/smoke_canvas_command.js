'use strict';
/* smoke_canvas_command.js — the explicit canvas-order detector (lib/canvas_command.js).
 * The live misses (#11104/#11108, 2026-08-07) are the load-bearing cases.
 * Run: node scripts/smoke_canvas_command.js */
const path = require('path');
const { detect } = require(path.join(__dirname, '..', 'lib', 'canvas_command'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── the live misses — MUST fire ─────────────────────────────────────────────────────────────────
ok('live #11104 fires', !!detect('I want to clean up a project we have been working on off and on for the last couple of weeks. I want to slowly build the deliverable, so do each step one at a time. Step 1. Please Identify on a fresh canvas doc the name of every parish in Louisiana'));
ok('live #11108 fires', !!detect('Please print to the canvas so I can verify as we go'));
ok('"put the list on the canvas" fires', !!detect('put the list on the canvas'));
ok('"write it into a new canvas tab" fires', !!detect('write it into a new canvas tab'));
ok('"add those to my canvas doc" fires', !!detect('add those to my canvas doc'));

// ── non-orders and non-canvas — MUST NOT fire ───────────────────────────────────────────────────
ok('question about canvas does not fire', !detect("what's on the canvas right now?"));
ok('"can you see my canvas" does not fire', !detect('can you see my canvas?'));
ok('canvas mention without an order does not fire', !detect('the canvas is looking cluttered'));
ok('a report order without canvas stays with report-cmd', !detect('build the final report on the Hartfield Foundation'));
ok('plain chat does not fire', !detect('every parish in Louisiana has a police jury'));

console.log(`smoke_canvas_command: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
