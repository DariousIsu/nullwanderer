/* Smoke: lib/doc_extract spreadsheet support (parseCsv + rowsToMarkdownTable). Fully offline, pure.
 * Guards the "spreadsheets aren't working" fix — a dropped csv/xlsx must parse into a markdown table
 * the card pipeline can read.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_sheet_extract.js
 */
const DE = require('../lib/doc_extract');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- parseCsv: quoting, escaped quotes, CRLF, delimiter ---
const rows = DE.parseCsv('Name,Email\r\nBrad Overcash,brad@x.gov\r\n"Keeter, Madeline",m@y.org\r\n"He said ""hi""",z@z.com');
ok(rows.length === 4 && rows[0][0] === 'Name', 'parseCsv: header + rows, CRLF handled');
ok(rows[2][0] === 'Keeter, Madeline', 'parseCsv: quoted field with an embedded comma');
ok(rows[3][0] === 'He said "hi"', 'parseCsv: escaped "" → a literal quote');
ok(DE.parseCsv('a\tb\tc', '\t')[0].length === 3, 'parseCsv: tab delimiter (tsv)');

// --- rowsToMarkdownTable: header, separator, padding, pipe-escape ---
const md = DE.rowsToMarkdownTable([['Name', 'Email'], ['Brad', 'brad@x.gov'], ['Solo']]);
const lines = md.split('\n');
ok(lines[0] === '| Name | Email |', 'rowsToMarkdownTable: header row');
ok(lines[1] === '| --- | --- |', 'rowsToMarkdownTable: separator row');
ok(lines[2] === '| Brad | brad@x.gov |', 'rowsToMarkdownTable: data row');
ok(lines[3] === '| Solo |  |', 'rowsToMarkdownTable: ragged row padded to width');
ok(DE.rowsToMarkdownTable([['a|b', 'c']]).includes('a\\|b'), 'rowsToMarkdownTable: escapes a literal pipe');
ok(DE.rowsToMarkdownTable([['', '  '], []]) === '', 'rowsToMarkdownTable: all-empty rows → empty string');

// --- SHEET_EXT registered ---
ok(DE.SHEET_EXT.has('xlsx') && DE.SHEET_EXT.has('csv') && DE.SHEET_EXT.has('tsv'), 'SHEET_EXT: xlsx/csv/tsv recognized');
ok(DE.SHEET_EXT.has('xls'), 'SHEET_EXT: legacy .xls recognized (the LA SoS roster format)');

// --- legacy .xls extracts via SheetJS (fixture written in-memory, real BIFF bytes) ---
(async () => {
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    const XLSX = require('C:/Users/azrae/Desktop/Side Quest/node_modules/xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Parish', 'Sheriff', 'Email'], ['Caddo', 'Henry Whitehorn', 'sheriff@caddo.gov']]), 'Officials');
    const fp = path.join(os.tmpdir(), `sq_smoke_biff_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.xls`);
    fs.writeFileSync(fp, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xls' })));
    const r = await DE.extractSpreadsheet(fp);
    ok(r.format === 'xls' && /## Officials/.test(r.markdown) && /\| Caddo \| Henry Whitehorn \| sheriff@caddo\.gov \|/.test(r.markdown),
      'legacy .xls → markdown table with sheet heading (her own asked-for capability)');
    try { fs.unlinkSync(fp); } catch {}
  } catch (e) { fail++; console.error('  ✗ xls extract threw:', e.message); }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
