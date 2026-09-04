'use strict';
/*
 * lib/partition_fold.js — THE FOLD for an engine-executed partition (stage 4.5 D/E, 2026-09-04; merge
 * map contract part 5): "A run's output lands where a partition's does today: covered targets, the
 * dossier, the agent-consume ledger. One consume path."
 *
 * PURE: foldFound({ output, targets }) reads the delegate's return (the FOUND / NOT FOUND / SOURCES
 * shape lib/executor_pick.brief asks for) and names which of the partition's targets it established,
 * matched the same way this side's own passes mark coverage (lib/research.targetIsCovered — the
 * bounded residue rule, never a loose substring). The caller writes `covered` onto the parent focus and
 * lands the notes; nothing here touches the db.
 */

const { targetIsCovered } = require('./research');

function _section(text, name, nextNames) {
  const s = String(text || '');
  const re = new RegExp(`\\b${name}\\s*:\\s*`, 'i');
  const m = re.exec(s);
  if (!m) return '';
  let rest = s.slice(m.index + m[0].length);
  let cut = rest.length;
  for (const n of nextNames) { const r2 = new RegExp(`(?:^|\\n|·|\\s)${n}\\s*:`, 'i').exec(rest); if (r2 && r2.index < cut) cut = r2.index; }
  return rest.slice(0, cut).trim();
}
function _lines(block) {
  return String(block || '').split(/\n|(?:\s·\s)|(?:^|\s)[-•]\s/).map((l) => l.replace(/^[\s\-•*]+/, '').trim()).filter((l) => l.length > 2);
}

/**
 * foldFound({ output, targets }) → { covered: [target...], found: [line...], notFound: [line...], sources: [url...], unmatched: [line...] }
 *   A FOUND line covers a target when the line names it (the coverage rule), so a line that merely
 *   mentions a neighbor never marks the neighbor covered.
 */
function foldFound({ output = '', targets = [] } = {}) {
  const found = _lines(_section(output, 'FOUND', ['NOT FOUND', 'SOURCES']));
  const notFound = _lines(_section(output, 'NOT FOUND', ['SOURCES', 'FOUND']));
  const srcBlock = _section(output, 'SOURCES', ['FOUND', 'NOT FOUND']);
  const sources = Array.from(new Set((srcBlock.match(/https?:\/\/[^\s)\]>,;"']+/g) || []).map((u) => u.replace(/[.,;:]+$/, ''))));
  const covered = [];
  const unmatched = [];
  for (const line of found) {
    // the line's head (before ':' / ' — ' / ' - ') is where the brief asked for the target name
    const head = line.split(/\s[—–-]\s|:\s/)[0].trim();
    const hit = (targets || []).find((t) => targetIsCovered([head], t) || targetIsCovered([line.slice(0, Math.max(head.length, 40) + 20)], t));
    if (hit && !covered.includes(hit)) covered.push(hit); else if (!hit) unmatched.push(line);
  }
  return { covered, found, notFound, sources, unmatched };
}

module.exports = { foldFound };
