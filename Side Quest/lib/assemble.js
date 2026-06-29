/**
 * assemble — DETERMINISTIC, lossless assembly of a directed research run's deliverable.
 *
 * The bug this fixes: a finished run's per-target file (notes/directed-<id>.md) already holds one
 * clean "## <org>" section per covered organization — written by the continuous cloud ORGANIZE pass,
 * in professional register, appended one-per-org. That file IS the complete N-in deliverable. The old
 * condense step then RE-SUMMARIZED the whole document through a model and dropped 15 of 21 orgs.
 *
 * The law (docs/TRACKS_PRIORITY_DESIGN.md §5/§6): the PROGRAM assembles the full document by a
 * deterministic STITCH of the parts (N-parts-in = N-parts-out); a cloud model is used ONLY for the
 * wrapper (a short Summary + a Gaps list) and is FORBIDDEN from touching the section bodies. The count
 * is derived from the ARTIFACT (the sections actually present), never from a parallel counter that can
 * drift from the file.
 *
 * PURE module: parsing, reconciliation, the wrapper prompt, and the stitch. All I/O (read the run
 * file, call the reasoner for the wrapper, write the dossier) lives in main.js. Fail-safe: every
 * function returns a value and never throws on bad input; a failed wrapper still yields a complete,
 * lossless document (just without the prose Summary/Gaps).
 */
'use strict';

// --- parse -------------------------------------------------------------------

// Split a deliverable/notes file into its per-organization sections. A section starts at a top-level
// "## " heading and runs until the next "## " (or EOF). Text before the first "## " (the run header)
// is returned as `preamble`. LOSSLESS: every line of every section body is preserved verbatim.
function parseSections(doc) {
  const text = String(doc || '');
  const lines = text.split('\n');
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);   // "## " heading — not "### " (that's "##" + "#", no space)
    if (m && !/^###/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: m[1].trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map(s => ({ heading: s.heading, body: s.lines.join('\n').trim() }))
  };
}

function countSections(doc) { return parseSections(doc).sections.length; }

// --- reconcile (index <-> document) -----------------------------------------

function _norm(s) { return String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

// Does a covered-index name correspond to a section heading? Tolerant containment both ways so
// "Heritage Foundation" (index) matches "## The Heritage Foundation" (heading) and vice-versa.
function _namesMatch(a, b) {
  const na = _norm(a), nb = _norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Cross-check the covered-set (the running index) against the sections actually in the document.
// The DOCUMENT is authoritative for the deliverable; `indexedMissing` are orgs the counter claims but
// whose section never made it into the file (e.g. an append threw) — surfaced in Gaps, honestly.
function reconcileIndex(covered = [], sections = []) {
  const headings = (sections || []).map(s => s.heading);
  const cov = Array.isArray(covered) ? covered.filter(Boolean) : [];
  const indexedMissing = cov.filter(c => !headings.some(h => _namesMatch(c, h)));
  const unindexed = headings.filter(h => !cov.some(c => _namesMatch(c, h)));
  return { count: headings.length, indexedMissing, unindexed };
}

// --- wrapper prompt (the ONLY model step; caged at the leaf) ----------------

const WRAPPER_SYS = `You write ONLY the two wrapper pieces of a research dossier whose organization sections are already written and will be stitched in by the program — you NEVER reproduce, list, rewrite, or re-summarize the organizations themselves.
Output EXACTLY these two blocks and nothing else:
SUMMARY: <2-3 sentences describing the dossier as a whole — what it covers and the overall shape of what was found. Do NOT enumerate the organizations.>
GAPS:
- <organization name> — <what's still missing (people / contacts / positions), one line>
- <… one bullet per organization that has a real gap; write "none" as a single bullet if nothing is missing>
Ground only in the headings and excerpts provided. Never invent an organization not listed.`;

// Small prompt: the model sees only headings + a short excerpt of each section (never full bodies),
// so it can write the Summary/Gaps without the document ever passing through a lossy whole-doc rewrite.
function buildWrapperPrompt({ goal = '', sections = [] } = {}) {
  const list = (Array.isArray(sections) ? sections : []).map((s, i) => {
    const excerpt = String(s.body || '').replace(/\s+/g, ' ').slice(0, 280);
    return `${i + 1}. ## ${s.heading}\n   ${excerpt}`;
  }).join('\n');
  return [
    { role: 'system', content: WRAPPER_SYS },
    { role: 'user', content: `TASK THIS RESEARCH SERVED:\n${String(goal).slice(0, 600)}\n\nORGANIZATION SECTIONS ALREADY WRITTEN (headings + excerpts — the full sections are stitched in separately, do not reproduce them):\n${list || '(none)'}\n\nWrite the SUMMARY and GAPS blocks now.` }
  ];
}

// Parse the wrapper model's reply into { summary, gaps } — fail-safe (missing block → '').
function parseWrapper(text) {
  const s = String(text || '');
  let summary = '', gaps = '';
  const sm = s.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*GAPS:|$)/i);
  if (sm) summary = sm[1].trim();
  const gm = s.match(/GAPS:\s*([\s\S]*)$/i);
  if (gm) gaps = gm[1].trim();
  return { summary, gaps };
}

// --- stitch (deterministic; N-in = N-out) -----------------------------------

// Assemble the final dossier from the verbatim sections + the (optional) model wrapper. The section
// bodies are copied byte-for-byte — the model never sees the assembled output, so it cannot drop an
// org. The count comes from sections.length (the artifact). Fail-safe: empty summary/gaps fall back to
// neutral text so a failed wrapper still yields a complete, lossless document.
function stitchDocument({ goal = '', completed = 'done', sections = [], summary = '', gaps = '', indexedMissing = [] } = {}) {
  const secs = Array.isArray(sections) ? sections : [];
  const count = secs.length;
  const body = secs.map(s => String(s.body || '').trim()).filter(Boolean).join('\n\n');
  let gapsBlock = String(gaps || '').trim();
  // Honesty: an org the index counted but whose section is missing from the file goes into Gaps.
  if (indexedMissing && indexedMissing.length) {
    const miss = indexedMissing.map(m => `- ${m} — section not captured in the deliverable file (indexed but missing)`).join('\n');
    gapsBlock = gapsBlock ? `${gapsBlock}\n${miss}` : miss;
  }
  if (!gapsBlock) gapsBlock = '- none recorded';
  const summaryLine = String(summary || '').trim() || `This dossier consolidates ${count} organization${count === 1 ? '' : 's'} gathered for the task below. Each section is reproduced exactly as researched.`;
  return [
    `# Research dossier`,
    ``,
    `**Task:** ${String(goal).trim()}`,
    `**Completed:** ${completed}`,
    `**Organizations covered:** ${count}`,
    ``,
    `**Summary** — ${summaryLine}`,
    ``,
    `---`,
    ``,
    body,
    ``,
    `---`,
    ``,
    `**Gaps**`,
    gapsBlock,
    ``
  ].join('\n');
}

module.exports = {
  parseSections, countSections, reconcileIndex,
  buildWrapperPrompt, parseWrapper, WRAPPER_SYS,
  stitchDocument
};
