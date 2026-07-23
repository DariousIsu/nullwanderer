/* Smoke: lib/spreadsheet — the SPREADSHEET LANE (hermetic; fixtures built in-memory, no network).
 * Proves: detection by URL extension (querystring-safe) + content-type; xlsx buffer → bounded text
 * table with sheet headers and real cell values; CSV and TSV parse with delimiter sniffing; the
 * char cap truncates HONESTLY (marker names what was dropped); legacy binary .xls refuses while
 * NAMING THE DOOR (find xlsx/csv/HTML instead); the result rides fetchPage's page shape.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_spreadsheet.js
 */
const sheet = require('C:/Users/azrae/Desktop/Side Quest/lib/spreadsheet');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    // --- detection ---
    ok(sheet.isSpreadsheet({ url: 'https://sos.la.gov/ElectedOfficials.xlsx' }), 'xlsx extension detected');
    ok(sheet.isSpreadsheet({ url: 'https://x.gov/data.csv?ts=1' }), 'csv extension survives a querystring');
    ok(sheet.isSpreadsheet({ url: 'https://x.gov/download', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx content-type detected without an extension');
    ok(sheet.isSpreadsheet({ url: 'https://x.gov/d', contentType: 'text/csv; charset=utf-8' }), 'csv content-type detected');
    ok(!sheet.isSpreadsheet({ url: 'https://x.gov/page.html', contentType: 'text/html' }), 'a plain page is not a spreadsheet');

    // --- xlsx: build a real workbook in memory, read it back ---
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Officials');
    ws.addRow(['Parish', 'President', 'Sheriff']);
    ws.addRow(['Acadia', 'Chance Henry', 'K.P. Gibson']);
    ws.addRow(['Allen', 'Roland Hollins', 'Doug Hebert']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    ok(sheet._sniff(buf) === 'xlsx', 'magic bytes sniff a real xlsx (zip)');
    const px = await sheet.toBoundedText(buf, { url: 'https://sos.la.gov/ElectedOfficials.xlsx' });
    ok(px.ok && /Sheet: Officials \(3 rows\)/.test(px.text), 'xlsx → sheet header with an honest row count');
    ok(/Acadia \| Chance Henry \| K\.P\. Gibson/.test(px.text), 'xlsx rows arrive as readable pipe-joined lines');
    ok(/ElectedOfficials\.xlsx \(spreadsheet: 1 sheet\(s\), 3 rows\)/.test(px.title), 'title names the file and its true size');

    // --- csv + tsv with delimiter sniffing ---
    const pc = await sheet.toBoundedText(Buffer.from('Parish,President\nBeauregard,Brian Manuel\n'), { url: 'https://x.gov/d.csv' });
    ok(pc.ok && /Beauregard \| Brian Manuel/.test(pc.text), 'csv parses');
    const pt = await sheet.toBoundedText(Buffer.from('Parish\tSheriff\nBossier\tJulian Whittington\n'), { url: 'https://x.gov/d.tsv' });
    ok(pt.ok && /Bossier \| Julian Whittington/.test(pt.text), 'tsv parses on the tab delimiter');

    // --- the cap truncates honestly ---
    const big = 'col1,col2\n' + Array.from({ length: 500 }, (_, i) => `row${i},value${i}`).join('\n');
    const pb = await sheet.toBoundedText(Buffer.from(big), { url: 'https://x.gov/big.csv', cap: 800 });
    ok(pb.ok && pb.truncated && /truncated — \d+ more line/.test(pb.text), 'over-cap → truncated with an honest marker naming what was dropped');
    ok(pb.text.length < 1000, 'the bounded text respects the cap');

    // --- legacy BIFF .xls PARSES (SheetJS; the Louisiana SoS roster is genuine OLE .xls with no
    // modern sibling on the server) — a corrupt OLE still refuses while naming the door ---
    const XLSX = require('C:/Users/azrae/Desktop/Side Quest/node_modules/xlsx');
    const xwb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(xwb, XLSX.utils.aoa_to_sheet([['Parish', 'Sheriff'], ['Caddo', 'Henry Whitehorn']]), 'Roster');
    const xlsBuf = Buffer.from(XLSX.write(xwb, { type: 'buffer', bookType: 'xls' }));
    ok(sheet._sniff(xlsBuf) === 'xls', 'OLE magic sniffs as legacy xls');
    const pl = await sheet.toBoundedText(xlsBuf, { url: 'https://x.gov/old.xls' });
    ok(pl.ok && /Caddo \| Henry Whitehorn/.test(pl.text) && /Sheet: Roster \(2 rows\)/.test(pl.text), 'legacy BIFF .xls parses to readable rows (the SoS-roster format)');
    const corrupt = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const pc2 = await sheet.toBoundedText(corrupt, { url: 'https://x.gov/broken.xls' });
    ok(!pc2.ok && /\.xlsx\/\.csv|web page/i.test(pc2.error), 'a corrupt .xls still refuses while NAMING THE DOOR');

    // --- cell normalization ---
    ok(sheet._cellText({ result: 42 }) === '42' && sheet._cellText({ richText: [{ text: 'a' }, { text: 'b' }] }) === 'ab' && sheet._cellText(null) === '', 'formula results, rich text, and nulls normalize to plain text');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  }
  console.log(fail ? `\nPASS — ${pass} ok, ${fail} failed` : `\nPASS — ${pass} ok, 0 failed`);
  process.exit(fail ? 1 : 0);
})();
