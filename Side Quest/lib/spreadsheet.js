/**
 * lib/spreadsheet.js — the SPREADSHEET LANE for the fetch path (2026-07-23).
 *
 * A data source published as a spreadsheet used to die at fetchPage's content-type wall
 * ("unsupported content-type: application/vnd…") — inquiry #1 ground through 8 touches on exactly
 * this: the Louisiana SoS "Elected Officials" Excel file was its best source and every attempt
 * honestly reported "could not be retrieved". This module turns a fetched spreadsheet into a
 * BOUNDED TEXT TABLE — same shape as any page read, so operator runs and the learning capture
 * consume it with zero changes downstream.
 *
 * Formats: .xlsx (exceljs), .csv/.tsv (fast-csv). Legacy binary .xls (OLE) is refused HONESTLY —
 * the refusal names what to do instead (find the xlsx/csv/HTML variant), never a bare error.
 * Pure-ish: parsing takes a Buffer, no network; fetch stays the caller's job.
 */
'use strict';

const SHEET_EXT_RE = /\.(xlsx|xls|csv|tsv)(?:[?#]|$)/i;
const SHEET_CT_RE = /spreadsheetml|ms-excel|text\/csv|tab-separated-values/i;

// Detect from the URL path or the response content-type — either signal is enough.
function isSpreadsheet({ url = '', contentType = '' } = {}) {
  return SHEET_EXT_RE.test(String(url)) || SHEET_CT_RE.test(String(contentType));
}

// Cell → short string. exceljs values can be rich objects (formula {result}, richText, Date).
function _cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result != null) return _cellText(v.result);
    if (v.text != null) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.hyperlink) return String(v.text || v.hyperlink);
    return '';
  }
  return String(v);
}

function _rowLine(cells) {
  return cells.map((c) => String(c).replace(/\s+/g, ' ').trim()).join(' | ');
}

// Magic-byte sniff: xlsx is a zip (PK\x03\x04); legacy .xls is OLE (D0 CF 11 E0).
function _sniff(buf) {
  if (!buf || buf.length < 4) return 'text';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'xls';
  return 'text';
}

async function _xlsxToLines(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const lines = [];
  let rowsTotal = 0;
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : []; // exceljs row.values is 1-indexed
      rows.push(_rowLine(vals.map(_cellText)));
    });
    rowsTotal += rows.length;
    lines.push(`## Sheet: ${ws.name} (${rows.length} rows)`);
    lines.push(...rows);
  }
  return { lines, rowsTotal, sheets: wb.worksheets.length };
}

function _csvToLines(buf, { delimiter }) {
  const { parseString } = require('fast-csv');
  const text = buf.toString('utf8');
  return new Promise((resolve, reject) => {
    const rows = [];
    parseString(text, { delimiter, headers: false })
      .on('error', reject)
      .on('data', (r) => rows.push(_rowLine(Array.isArray(r) ? r : Object.values(r))))
      .on('end', () => resolve({ lines: rows, rowsTotal: rows.length, sheets: 1 }));
  });
}

/**
 * Buffer → { ok, text, title, sheets, rowsTotal, truncated } or { ok:false, error } where the
 * error TEACHES the alternative (never a bare failure — a refusal that doesn't name the door
 * gets retried forever).
 */
async function toBoundedText(buf, { url = '', cap = 14000 } = {}) {
  try {
    const kind = _sniff(buf);
    if (kind === 'xls') {
      return { ok: false, error: 'legacy binary .xls is not readable — look for an .xlsx/.csv download or a web page listing the same data' };
    }
    let parsed;
    if (kind === 'xlsx') {
      parsed = await _xlsxToLines(buf);
    } else {
      const isTsv = /\.tsv(?:[?#]|$)/i.test(url) || (String(buf.slice(0, 2000)).split('\n')[0] || '').split('\t').length > (String(buf.slice(0, 2000)).split('\n')[0] || '').split(',').length;
      parsed = await _csvToLines(buf, { delimiter: isTsv ? '\t' : ',' });
    }
    if (!parsed.rowsTotal) return { ok: false, error: 'spreadsheet parsed but held no rows' };
    let text = '';
    let shown = 0;
    let truncated = false;
    for (const line of parsed.lines) {
      if (text.length + line.length + 1 > cap) { truncated = true; break; }
      text += (text ? '\n' : '') + line;
      shown++;
    }
    if (truncated) text += `\n[…truncated — ${parsed.lines.length - shown} more line(s) beyond the ${cap}-char window]`;
    const fname = (String(url).split(/[?#]/)[0].split('/').pop() || 'spreadsheet');
    return { ok: true, text, title: `${fname} (spreadsheet: ${parsed.sheets} sheet(s), ${parsed.rowsTotal} rows)`, sheets: parsed.sheets, rowsTotal: parsed.rowsTotal, truncated };
  } catch (e) {
    return { ok: false, error: `spreadsheet parse failed (${e.message}) — try a web page listing the same data` };
  }
}

module.exports = { isSpreadsheet, toBoundedText, _sniff, _cellText };
