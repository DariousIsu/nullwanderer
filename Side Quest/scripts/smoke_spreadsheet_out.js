'use strict';
/* smoke_spreadsheet_out.js — Spine 3 door R6 (lib/spreadsheet_out.js).
 * The contract: a spreadsheet is only DELIVERED if it OPENS. Write a real .xlsx, reopen it, assert shape;
 * prove the openable-check catches a broken file; prove the CSV fallback fires when xlsx can't be written.
 * Real fs + exceljs, temp dir. Run: node scripts/smoke_spreadsheet_out.js */
const so = require('../lib/spreadsheet_out');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-'));
const ROWS = [
  { Parish: 'Acadia', Official: 'Ryan Turner', Email: 'president@acadiaparish.gov' },
  { Parish: 'Ascension', Official: 'Clint Cointment', Email: '' },
  { Parish: 'Caddo', Official: 'Todd Hopkins', Email: 'thopkins@caddo.org' },
];

(async () => {
  // ── happy path: styled xlsx, verified openable ──────────────────────────────────────────────────────────
  const r = await so.deliverSpreadsheet({ dir, basename: 'louisiana parishes!', rows: ROWS, sheetName: 'Parishes' });
  ok(r.ok && r.format === 'xlsx' && r.openable === true, 'deliver: writes a verified-openable xlsx');
  ok(r.rows === 3, 'deliver: reports the row count');
  ok(/\.xlsx$/.test(r.path) && fs.existsSync(r.path), 'deliver: the .xlsx file exists on disk');
  ok(!/[^\w.\-]/.test(path.basename(r.path)), 'deliver: the basename is filesystem-safe (spaces/!, sanitized)');

  // independent reopen with exceljs proves it really opens + carries the data
  {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.path);
    const ws = wb.worksheets[0];
    ok(ws && ws.name === 'Parishes', 'reopen: worksheet name preserved');
    ok(ws.getRow(1).getCell(1).value === 'Parish', 'reopen: header row present');
    ok(ws.getRow(2).getCell(2).value === 'Ryan Turner', 'reopen: a data cell round-trips');
    ok(ws.getRow(1).font && ws.getRow(1).font.bold === true, 'reopen: header is styled (bold)');
  }

  // ── the openable check catches a broken file ────────────────────────────────────────────────────────────
  {
    const bad = path.join(dir, 'broken.xlsx');
    fs.writeFileSync(bad, 'this is not a real xlsx', 'utf-8');
    const chk = await so.openableCheckXlsx(bad, { expectRows: 3, expectCols: 3 });
    ok(chk.openable === false, 'openableCheck: a non-xlsx file → not openable (would NOT be shipped)');
  }
  {
    const good = path.join(dir, 'good.xlsx');
    await so.writeXlsx(good, { cols: so.normalizeColumns(null, ROWS), rows: ROWS });
    const chk = await so.openableCheckXlsx(good, { expectRows: 3, expectCols: 3 });
    ok(chk.openable === true && chk.rows === 3, 'openableCheck: a real xlsx with the right rows → openable');
    const wrong = await so.openableCheckXlsx(good, { expectRows: 99, expectCols: 3 });
    ok(wrong.openable === false, 'openableCheck: a row-count mismatch → not openable (catches truncation)');
  }

  // ── CSV fallback when xlsx can't be written (delivered ≠ openable → default CSV) ──────────────────────────
  {
    const r2 = await so.deliverSpreadsheet({ dir, basename: 'fallback', rows: ROWS, _writeXlsx: async () => { throw new Error('exceljs boom'); } });
    ok(r2.ok && r2.format === 'csv' && r2.openable === true, 'fallback: xlsx write fails → a verified CSV is delivered instead');
    ok(/exceljs boom/.test(r2.reason || ''), 'fallback: the reason names the xlsx failure honestly');
    const csv = fs.readFileSync(r2.path, 'utf-8');
    ok(/^Parish,Official,Email/.test(csv) && /Acadia,Ryan Turner/.test(csv), 'fallback: the CSV has the header + data');
  }

  // ── a MISSING parent dir is created, not silently lost (the swarm-branch bug: Side Quest/notes didn't exist,
  //    writeFile threw ENOENT, and BOTH xlsx + CSV vanished — a delivery door must not lose the deliverable) ──
  {
    const nested = path.join(dir, 'does', 'not', 'exist', 'yet');
    ok(!fs.existsSync(nested), 'precondition: the target dir does not exist');
    const r3 = await so.deliverSpreadsheet({ dir: nested, basename: 'la_roster', rows: ROWS, sheetName: 'LA' });
    ok(r3.ok && r3.openable === true, 'deliver: a missing (nested) dir is created → the sheet still delivers openable');
    ok(fs.existsSync(r3.path), 'deliver: the file exists under the freshly-created dir');
  }

  // ── CSV escaping + column handling ──────────────────────────────────────────────────────────────────────
  ok(so.csvCell('a,b') === '"a,b"' && so.csvCell('say "hi"') === '"say ""hi"""', 'csvCell: commas + quotes escaped');
  {
    const cols = so.normalizeColumns([{ key: 'Parish', header: 'Parish Name' }, 'Email'], ROWS);
    ok(cols[0].header === 'Parish Name' && cols[1].key === 'Email', 'normalizeColumns: explicit + string columns both work');
  }
  ok((await so.deliverSpreadsheet({ dir, basename: 'empty', rows: [] })).ok === false, 'deliver: empty rows + no columns → honest failure (nothing to write)');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
