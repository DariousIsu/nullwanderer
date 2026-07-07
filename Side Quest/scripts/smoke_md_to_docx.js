/* Smoke: lib/md_to_docx — Markdown → .docx via the `docx` library (canvas document Word export).
 * Verifies block PARSING (headings/lists/quote/hr/code/table) + inline runs + a valid .docx buffer.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_md_to_docx.js
 */
'use strict';
const { buildBlocks, inlineRuns, buildDocxBuffer } = require('../lib/md_to_docx');
const { Table } = require('docx');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- block parsing ---
const md = ['# Title', '', 'Intro **bold** and `code`.', '', '## Section', '', '1. one', '2. two', '', '- a', '- b', '',
  '> quoted line', '', '---', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '```', 'x = 1', 'y = 2', '```'].join('\n');
const blocks = buildBlocks(md);
ok(Array.isArray(blocks) && blocks.length > 0, `buildBlocks returns paragraphs — got ${blocks.length}`);
ok(blocks.some((b) => b instanceof Table), 'markdown table → a docx Table');
const nonTable = blocks.filter((b) => !(b instanceof Table));
ok(nonTable.every((b) => b && b.constructor && /Paragraph/.test(b.constructor.name)), 'all non-table blocks are Paragraphs');

// --- inline runs ---
const runs = inlineRuns('plain **b** and *i* and `c`');
ok(runs.length >= 4, `inline splits bold/italic/code into runs — got ${runs.length}`);
ok(inlineRuns('').length === 0, 'empty text → no runs (valid empty paragraph), no crash');

// --- resilience ---
ok(buildBlocks('').length === 0, 'empty markdown → no blocks');
ok((() => { try { buildBlocks(null); buildBlocks(undefined); return true; } catch { return false; } })(), 'null/undefined markdown → no throw');

// --- a real .docx buffer (async) ---
(async () => {
  const buf = await buildDocxBuffer({ title: 'My Report', markdown: md });
  ok(Buffer.isBuffer(buf) && buf.length > 500, `buildDocxBuffer returns a buffer — ${buf.length} bytes`);
  ok(buf[0] === 0x50 && buf[1] === 0x4B, 'buffer is a valid .docx (PK zip magic)');
  const empty = await buildDocxBuffer({ title: '', markdown: '' });
  ok(Buffer.isBuffer(empty) && empty[0] === 0x50, 'empty doc still produces a valid .docx (no crash)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
