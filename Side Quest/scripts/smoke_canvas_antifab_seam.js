'use strict';
/* Smoke: the canvas anti-fab CONTENT seam (measured 2026-08-18). canvas_docs.lastWriteTs() is the probe the
 * anti-fabrication reply gate calls to answer "did a canvas write actually happen this turn?" before trusting
 * an "…on your canvas" claim. It used to read MAX(updated_at) FROM docs — but a bare saga_canvas_open_tab
 * (recordTab) bumps docs.updated_at with NO block, so an opened-but-empty tab (or one whose add_block lands
 * late/fails) read as "content landed" and SILENCED the gate on an ungrounded canvas claim (canvasWrites=0
 * from the blocks table, while the gate stayed quiet on docs). Fix: lastWriteTs reads BLOCKS (real content).
 * recordBlock bumps both tables, so a real delivery still registers — no false correction on a real block.
 * Deterministic, in-memory, no model/network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_canvas_antifab_seam.js
 */
process.env.CANVAS_DOCS_DB_PATH = ':memory:';
const cd = require('../lib/canvas_docs');
const mc = require('../lib/metacognition');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// the gate's real probe shape: canvasWroteThisTurn = lastWriteTs() >= anchor. anchor=1 → any real block's
// ms-timestamp clears it, an empty blocks table (lastWriteTs=0) does not.
const ANCHOR = 1;
const CLAIM = 'The two-item brief is on your canvas.';
const probe = { canvasWroteThisTurn: () => cd.lastWriteTs() >= ANCHOR };

// (1) a bare open_tab is NOT a content write
cd.recordTab({ tabKey: 'brief', mode: 'DOC', title: 'LA energy brief' });
ok(cd.lastWriteTs() === 0, 'a bare open_tab does NOT register as a canvas write (blocks table still empty)');

// (2) the gate FIRES on "…on your canvas" when only a tab opened (this is the false-delivery it must catch)
const vTab = mc.verifyArtifactClaims(CLAIM, probe);
ok(vTab.violations.some((v) => v.kind === 'canvas'), 'gate FIRES on an "on your canvas" claim when only a tab opened');

// (3) a real block IS a content write
cd.recordBlock({ tabKey: 'brief', blockId: 'b1', blockType: 'paragraph', data: { markdown: '# Louisiana energy' } });
ok(cd.lastWriteTs() > 0, 'a block write registers as a canvas write');

// (4) once a real block landed the gate STAYS SILENT — no false correction on a genuine delivery
const vBlk = mc.verifyArtifactClaims(CLAIM, probe);
ok(vBlk.ok, 'gate STAYS SILENT once a real block landed (no false scold on a real delivery)');

// (5) opening ANOTHER empty tab does not advance the content clock (the seam, isolated)
const before = cd.lastWriteTs();
cd.recordTab({ tabKey: 'brief2', mode: 'DOC', title: 'another empty tab' });
ok(cd.lastWriteTs() === before, 'opening a second empty tab does NOT advance the content-write timestamp');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
