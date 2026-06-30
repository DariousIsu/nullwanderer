/* studio/sheet_view.js — PURE spreadsheet shaping for the Canvas drop pipeline (no I/O).
 * CSV/TSV text → rows (quote-aware), and rows (from CSV or exceljs) → a saga `table` block payload
 * ({headers, rows}) so a dropped spreadsheet renders as a real table, not raw text. Capped so a huge
 * sheet can't blow up the block. The .xlsx file read itself is main-side (exceljs); this shapes it. */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// RFC-4180-ish parse: handles quoted fields, escaped "" quotes, commas/tabs inside quotes, CRLF.
function parseDelimited(text, delim = ',') {
  const t = String(text == null ? '' : text);
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') { q = true; }
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* swallow */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// rows[][] → { headers, rows, truncated } table payload. First non-empty row is the header. Capped.
function toTable(rows, { maxRows = 500, maxCols = 40 } = {}) {
  const r = (Array.isArray(rows) ? rows : []).filter(x => Array.isArray(x) && x.some(c => str(c).trim() !== ''));
  const headers = (r[0] || []).slice(0, maxCols).map(str);
  const body = r.slice(1, 1 + maxRows).map((row) => {
    const o = row.slice(0, maxCols).map(str);
    while (o.length < headers.length) o.push('');
    return o;
  });
  return { headers, rows: body, truncated: Math.max(0, (r.length - 1) - maxRows) };
}

function csvToTable(text, delim = ',') { return toTable(parseDelimited(text, delim)); }

module.exports = { str, parseDelimited, toTable, csvToTable };
