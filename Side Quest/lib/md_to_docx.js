/**
 * lib/md_to_docx.js — convert a canvas document's Markdown into a real .docx via the `docx` library
 * (programmatic construction — no HTML parsing, clean dep tree). Handles headings h1-h6, ordered +
 * unordered lists, blockquotes, horizontal rules, fenced code, markdown tables, and inline bold/italic/
 * code. Pure over its input (a title + markdown string) → a Promise<Buffer>. The block PARSING is a plain
 * function so it's offline-testable without emitting a real file.
 */
'use strict';
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} = require('docx');

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

// inline markdown (**bold**, __bold__, *italic*, _italic_, `code`) → TextRun[]. `base` applies to every run.
function inlineRuns(text, base = {}) {
  const runs = [];
  const push = (t, opt) => { if (t) runs.push(new TextRun({ text: t, ...base, ...opt })); };
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    if (m[2] || m[3]) push(m[2] || m[3], { bold: true });
    else if (m[4] || m[5]) push(m[4] || m[5], { italics: true });
    else if (m[6]) push(m[6], { font: 'Consolas' });
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  if (!runs.length) push(text || '');
  return runs;
}

function splitRow(line) { return String(line).trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); }
function buildTable(tblLines) {
  const rows = tblLines.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l));   // drop the |---|---| separator row
  if (!rows.length) return null;
  const grid = rows.map(splitRow);
  const cols = Math.max(...grid.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: grid.map((r, ri) => new TableRow({
      children: Array.from({ length: cols }, (_, ci) => new TableCell({
        children: [new Paragraph({ children: inlineRuns(r[ci] || '', ri === 0 ? { bold: true } : {}) })],
      })),
    })),
  });
}

// Markdown → array of docx Paragraph/Table. Mirrors the renderer's md() block detection.
function buildBlocks(markdown) {
  const lines = String(markdown == null ? '' : markdown).split(/\r?\n/);
  const out = []; let para = [];
  const flushPara = () => { if (para.length) { out.push(new Paragraph({ children: inlineRuns(para.join(' ')) })); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (/^\s*```/.test(line)) {   // fenced code — one monospace, shaded line per row
      flushPara(); i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { out.push(new Paragraph({ shading: { fill: 'F2F2F2' }, children: [new TextRun({ text: lines[i] || ' ', font: 'Consolas', size: 20 })] })); i++; }
      i++; continue;
    }
    if (line === '') { flushPara(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); out.push(new Paragraph({ heading: HEADINGS[h[1].length - 1], children: inlineRuns(h[2]) })); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } })); i++; continue; }   // hr
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) { flushPara(); out.push(new Paragraph({ indent: { left: 360 }, children: inlineRuns(bq[1], { italics: true, color: '555555' }) })); i++; continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); out.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(ul[1]) })); i++; continue; }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { flushPara(); out.push(new Paragraph({ numbering: { reference: 'ol', level: 0 }, children: inlineRuns(ol[1]) })); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {   // markdown table block
      const tbl = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tbl.push(lines[i]); i++; }
      const t = buildTable(tbl); if (t) { flushPara(); out.push(t); }
      continue;
    }
    para.push(line); i++;
  }
  flushPara();
  return out;
}

async function buildDocxBuffer({ title = '', markdown = '' } = {}) {
  const children = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: inlineRuns(title) }));
  children.push(...buildBlocks(markdown));
  if (children.length === 0) children.push(new Paragraph({ children: [new TextRun('')] }));
  const doc = new Document({
    numbering: { config: [{ reference: 'ol', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }] },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocxBuffer, buildBlocks, inlineRuns, buildTable };
