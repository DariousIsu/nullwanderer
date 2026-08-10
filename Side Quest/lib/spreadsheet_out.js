'use strict';
/* spreadsheet_out.js — Spine 3 door R6 (docs/DELIVERY_BINDING_SPINE.md).
 *
 * The census finding: a spreadsheet deliverable is only DELIVERED if it actually OPENS. Zoe had no xlsx
 * writer at all, and "delivered ≠ openable" was a real failure mode. This door writes a styled .xlsx
 * (exceljs), then VERIFIES it by reopening + parsing it back to the same shape; if the write or the reopen
 * fails, it falls back to a plain .csv (which always opens). The caller always gets a file that opens, and
 * is told which format + that it was verified.
 *
 * Pure-ish: fs + exceljs (no native deps). The xlsx writer is injectable so the CSV-fallback path is
 * offline-testable. Run: node scripts/smoke_spreadsheet_out.js */

const fs = require('fs');
const path = require('path');

// ── columns / rows normalization ────────────────────────────────────────────────────────────────────────
// columns: [{key, header?, width?}] or ['Name','Email'] (header=key). If absent, inferred from the first
// row's own keys. rows: array of objects keyed by column key.
function normalizeColumns(columns, rows) {
  if (Array.isArray(columns) && columns.length) {
    return columns.map((c) => (typeof c === 'string' ? { key: c, header: c } : { key: c.key, header: c.header || c.key, width: c.width }));
  }
  const first = (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') ? rows[0] : {};
  return Object.keys(first).map((k) => ({ key: k, header: k }));
}

// ── CSV (the always-opens fallback) ─────────────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(cols, rows) {
  const head = cols.map((c) => csvCell(c.header)).join(',');
  const body = (rows || []).map((r) => cols.map((c) => csvCell(r[c.key])).join(',')).join('\n');
  return body ? head + '\n' + body + '\n' : head + '\n';
}

// ── styled xlsx (the preferred format) ──────────────────────────────────────────────────────────────────
async function writeXlsx(filePath, { cols, rows, sheetName = 'Sheet1' }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(sheetName).slice(0, 31) || 'Sheet1');   // Excel caps sheet names at 31 chars
  ws.columns = cols.map((c) => ({
    header: String(c.header),
    key: c.key,
    width: c.width || Math.min(60, Math.max(12, String(c.header).length + 4)),
  }));
  for (const r of (rows || [])) ws.addRow(cols.reduce((o, c) => { o[c.key] = r[c.key] == null ? '' : r[c.key]; return o; }, {}));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  header.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];                              // header stays visible on scroll
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  await wb.xlsx.writeFile(filePath);
}

// THE OPENABLE CHECK — reopen the written xlsx and confirm it parses to the shape we wrote. This is the
// heart of R6: a file that doesn't reopen was never delivered. Returns {openable, rows, reason?}.
async function openableCheckXlsx(filePath, { expectRows, expectCols }) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 100) return { openable: false, reason: 'file missing or empty' };
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return { openable: false, reason: 'no worksheet' };
    let dataRows = 0;
    ws.eachRow({ includeEmpty: false }, () => { dataRows++; });
    dataRows = Math.max(0, dataRows - 1);                                   // minus the header row
    if (dataRows !== expectRows) return { openable: false, reason: `row count ${dataRows} ≠ expected ${expectRows}` };
    const headerCells = ws.getRow(1).actualCellCount;
    if (expectCols && headerCells < expectCols) return { openable: false, reason: `header has ${headerCells} cells, expected ${expectCols}` };
    return { openable: true, rows: dataRows };
  } catch (e) { return { openable: false, reason: 'reopen failed: ' + e.message }; }
}

// The door. Writes a verified spreadsheet and ALWAYS returns a file that opens.
// { dir, basename, rows, columns?, sheetName?, _writeXlsx? (test injection) }
//   → { ok, path, format:'xlsx'|'csv', openable, rows, reason? }
async function deliverSpreadsheet({ dir, basename, rows = [], columns = null, sheetName = 'Sheet1', _writeXlsx = writeXlsx } = {}) {
  const cols = normalizeColumns(columns, rows);
  if (!cols.length) return { ok: false, reason: 'no columns (empty rows and no columns given)' };
  const safeBase = String(basename || 'deliverable').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'deliverable';
  const xlsxPath = path.join(dir, safeBase + '.xlsx');
  let reason = null;
  try {
    await _writeXlsx(xlsxPath, { cols, rows, sheetName });
    const chk = await openableCheckXlsx(xlsxPath, { expectRows: rows.length, expectCols: cols.length });
    if (chk.openable) return { ok: true, path: xlsxPath, format: 'xlsx', openable: true, rows: rows.length };
    reason = 'xlsx openable-check failed — ' + chk.reason;
    try { fs.unlinkSync(xlsxPath); } catch {}                              // don't leave a broken file behind
  } catch (e) { reason = 'xlsx write failed — ' + e.message; }
  // FALLBACK: CSV always opens. Write it, then confirm it reads back with the right line count.
  try {
    const csvPath = path.join(dir, safeBase + '.csv');
    fs.writeFileSync(csvPath, toCsv(cols, rows), 'utf-8');
    const lines = fs.readFileSync(csvPath, 'utf-8').replace(/\n$/, '').split('\n');
    const openable = fs.existsSync(csvPath) && lines.length === rows.length + 1;   // header + data
    return { ok: true, path: csvPath, format: 'csv', openable, rows: rows.length, reason };
  } catch (e) {
    return { ok: false, reason: `both formats failed — xlsx: ${reason}; csv: ${e.message}` };
  }
}

module.exports = { deliverSpreadsheet, writeXlsx, openableCheckXlsx, toCsv, normalizeColumns, csvCell };
