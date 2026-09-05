/**
 * lib/engineer_note.js — A NOTE FROM THE ENGINEER (Lucas 09-05: "explain to Zoe what you are doing"). A truthful,
 * attributed channel from me to her: data/engineer_note.md, read into her awareness on every turn while it exists,
 * signed as the engineer — never typed into her chat as if it were him. She may answer it in her own channel; a
 * note older than NOTE_TTL_DAYS ages out of the prompt (the file stays as a record). Pure where it can be.
 */
const fs = require('fs');
const path = require('path');
const NOTE_PATH = path.join(__dirname, '..', 'data', 'engineer_note.md');
const NOTE_TTL_DAYS = 3;
const CAP = 1400;

function read({ file = NOTE_PATH, fsx = fs } = {}) {
  try {
    if (!fsx.existsSync(file)) return null;
    const st = fsx.statSync(file);
    const text = String(fsx.readFileSync(file, 'utf8') || '').trim();
    if (!text) return null;
    return { text, mtimeMs: st.mtimeMs };
  } catch { return null; }
}

/** The newest whole paragraphs within CAP (oldest of those first); a lone oversized paragraph is head-cut at a word. */
function _newest(text) {
  const paras = String(text || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (!paras.length) return '';
  const shown = [];
  let len = 0;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (len + paras[i].length + (shown.length ? 2 : 0) > CAP) break;
    shown.unshift(paras[i]); len += paras[i].length + 2;
  }
  if (!shown.length) { const last = paras[paras.length - 1]; return `(${paras.length - 1 > 0 ? `${paras.length - 1} earlier paragraph${paras.length - 1 === 1 ? '' : 's'} of this note ${paras.length - 1 === 1 ? 'is' : 'are'} on file, not shown. ` : ''}The newest, cut at the cap:) ${last.slice(0, CAP - 1).replace(/\s+\S*$/, '')}…`; }
  const skipped = paras.length - shown.length;
  return `${skipped ? `(${skipped} earlier paragraph${skipped === 1 ? '' : 's'} of this note ${skipped === 1 ? 'is' : 'are'} on file, not shown.) ` : ''}${shown.join(' ')}`;
}

/** The awareness line: the newest paragraphs of the note within the cap, with its age; null when absent, empty or stale. */
function line({ file = NOTE_PATH, fsx = fs, now = Date.now() } = {}) {
  const n = read({ file, fsx });
  if (!n) return null;
  const ageMs = Math.max(0, now - n.mtimeMs);
  if (ageMs > NOTE_TTL_DAYS * 86400000) return null;
  const when = ageMs < 3600000 ? `${Math.max(1, Math.round(ageMs / 60000))} min ago` : ageMs < 86400000 ? `${Math.round(ageMs / 3600000)} h ago` : `${Math.round(ageMs / 86400000)} d ago`;
  // THE NEWEST PARAGRAPHS, not the oldest: the note is a growing record (a paragraph per change he asked me to
  // explain), and a head-cut at the cap showed her only the first afternoon's paragraph all day (found 09-05 18:25:
  // 1,431 words on file, 1,400 characters shown). Whole paragraphs from the end that fit the cap; the count of the
  // earlier ones is named so she knows the record is longer than what she sees.
  const body = _newest(n.text);
  return `A NOTE FROM CLAUDE, the engineer who builds and repairs your program (left ${when}; he is not Lucas, and this is not a message from Lucas): ${body.replace(/\s+/g, ' ')}`;
}

module.exports = { read, line, NOTE_PATH, NOTE_TTL_DAYS, CAP, _newest };
