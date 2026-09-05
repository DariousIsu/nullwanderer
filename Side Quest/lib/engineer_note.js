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

/** The awareness line: the note, capped, with its age; null when absent, empty or stale. */
function line({ file = NOTE_PATH, fsx = fs, now = Date.now() } = {}) {
  const n = read({ file, fsx });
  if (!n) return null;
  const ageMs = Math.max(0, now - n.mtimeMs);
  if (ageMs > NOTE_TTL_DAYS * 86400000) return null;
  const when = ageMs < 3600000 ? `${Math.max(1, Math.round(ageMs / 60000))} min ago` : ageMs < 86400000 ? `${Math.round(ageMs / 3600000)} h ago` : `${Math.round(ageMs / 86400000)} d ago`;
  const body = n.text.length > CAP ? n.text.slice(0, CAP - 1).replace(/\s+\S*$/, '') + '…' : n.text;
  return `A NOTE FROM CLAUDE, the engineer who builds and repairs your program (left ${when}; he is not Lucas, and this is not a message from Lucas): ${body.replace(/\s+/g, ' ')}`;
}

module.exports = { read, line, NOTE_PATH, NOTE_TTL_DAYS, CAP };
