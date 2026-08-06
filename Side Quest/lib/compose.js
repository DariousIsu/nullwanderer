/**
 * compose — the CLOUD DOCUMENT COMPOSER (Pillar 3). "Cloud models need to be writing everything."
 *
 * The earlier law (lib/assemble) kept the cloud OUT of the section bodies because a whole-document
 * re-summarize dropped 15/21 orgs. Lucas wants the cloud to author the WHOLE professional document.
 * We reconcile the two with a COMPLETENESS GATE: the cloud composes a flowing professional dossier,
 * then we VERIFY — using the deterministic lossless sections (lib/assemble) as the ORACLE — that every
 * organization heading survived. Any the cloud dropped are PATCHED back verbatim from the oracle. So we
 * get cloud prose with a hard N-in≥N-out guarantee. Large runs are CHUNKED (map) so no single call
 * truncates; the gate runs over the concatenation.
 *
 * PURE module: prompt builders, the section chunker, the gate, the patch, and the final assembly. The
 * cloud call + file/canvas I/O live in main.js (composeDocument). Fail-safe: never throws on bad input.
 */
'use strict';

const assemble = require('./assemble');

const str = (v) => (v == null ? '' : String(v));

// --- compose prompt (the caged cloud leaf that writes the product) ----------------------------------

const COMPOSE_SYS = `You are composing the FINAL, professional research dossier for Lucas from per-organization sections that have already been researched and written. Produce one cleanly-flowing, well-formatted Markdown document that a professional would be glad to read.
RULES — these are absolute:
• Keep a "## <Organization>" heading for EVERY organization you are given — never drop, merge, rename, or combine two organizations into one.
• Ground ONLY in the provided sections — never add a person, title, email, phone number, or fact that is not already there. Keep "not found" wherever the source says so. NEVER turn initials or a placeholder ("R. Z.", "the VP") into a real name.
• You MAY improve wording, structure each section consistently (focus / key people / contacts / positions / funding), and add brief connective prose — but you may NOT invent content or omit any organization.
• Drop any leaked JSON, tool calls, or control text.
Output Markdown only — no preamble, no "here is".`;

// Build the compose messages. For a chunked run (chunkTotal>1) the part composes ONLY its organizations
// and skips the overall executive summary (the program adds the single summary), so parts concatenate
// cleanly without competing intros.
function buildComposePrompt({ goal = '', sections = [], chunkIndex = 0, chunkTotal = 1 } = {}) {
  const secs = (Array.isArray(sections) ? sections : []).filter(s => s && s.body);
  const joined = secs.map(s => str(s.body).trim()).filter(Boolean).join('\n\n');
  const headings = secs.map((s, i) => `${i + 1}. ${s.heading}`).join('\n');
  const single = chunkTotal <= 1;
  const sys = single
    ? COMPOSE_SYS + `\nOpen the document with a 2-3 sentence executive summary of what the dossier covers and the overall shape of what was found (do NOT enumerate every organization in it). Do NOT write a "plan" section — page 1 is prepended separately.`
    : COMPOSE_SYS + `\nThis is PART ${chunkIndex + 1} of ${chunkTotal} of a larger dossier. Compose ONLY the organizations below. Do NOT write an executive summary, introduction, or conclusion — another part covers those. Output just the clean "## <Organization>" sections, in order.`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `TASK THIS RESEARCH SERVED:\n${str(goal).slice(0, 600)}\n\nYou MUST include all ${secs.length} of these organizations, each under its own "## " heading:\n${headings || '(none)'}\n\nThe researched sections (compose these into the professional document — keep every organization):\n"""\n${joined}\n"""\n\nWrite the composed dossier${single ? '' : ' part'} now.` }
  ];
}

// --- chunking (never split an organization across two calls) ----------------------------------------

// Group sections so each group's combined body stays under maxChars. A single oversized section becomes
// its own group (it can't be split without breaking the org). Returns an array of section-arrays.
function chunkSections(sections, maxChars = 14000) {
  const secs = (Array.isArray(sections) ? sections : []).filter(s => s && (s.heading || s.body));
  const groups = [];
  let cur = [];
  let curLen = 0;
  for (const s of secs) {
    const len = str(s.body).length + 1;
    if (cur.length && curLen + len > maxChars) { groups.push(cur); cur = []; curLen = 0; }
    cur.push(s);
    curLen += len;
  }
  if (cur.length) groups.push(cur);
  return groups.length ? groups : [secs];
}

// Size the generation budget to the document so nothing truncates. Output is ~the same length as the
// input sections (compose polishes, it doesn't expand much). num_ctx is 32768 on the compose door, so
// even the cap leaves ample room alongside the input.
function composeBudget(sections, { min = 1500, max = 7000 } = {}) {
  const chars = (Array.isArray(sections) ? sections : []).reduce((n, s) => n + str(s.body).length, 0);
  const tokens = Math.round(chars / 3) + 400;   // ~chars/4 to read + headroom for polish/structure
  return Math.max(min, Math.min(max, tokens));
}

// --- completeness gate (the lossless sections are the ORACLE) ----------------------------------------

// Pull the "## <heading>" lines the composer actually produced.
function composedHeadings(composed) {
  return (str(composed).match(/^##\s+(.+?)\s*$/gim) || [])
    .filter(h => !/^###/.test(h))
    .map(h => h.replace(/^##\s+/, '').trim())
    .filter(Boolean);
}

// Verify every oracle section survived composition. Returns { ok, present, missing } where `missing` is
// the FULL oracle section objects the composer dropped — so they can be patched back verbatim.
function verifyComposition(composed, sections) {
  const heads = composedHeadings(composed);
  const secs = (Array.isArray(sections) ? sections : []).filter(s => s && s.heading);
  const present = [];
  const missing = [];
  for (const s of secs) {
    if (heads.some(h => assemble.namesMatch(s.heading, h))) present.push(s.heading);
    else missing.push(s);
  }
  return { ok: missing.length === 0, present, missing };
}

// Patch dropped organizations back into the document VERBATIM from the oracle. The reader still gets
// every org; the recovered sections are appended in their already-clean "## <Org>" form.
function patchMissing(composed, missingSections) {
  const miss = (Array.isArray(missingSections) ? missingSections : []).filter(s => s && s.body);
  if (!miss.length) return str(composed);
  const bodies = miss.map(s => str(s.body).trim()).filter(Boolean).join('\n\n');
  return `${str(composed).trim()}\n\n${bodies}`;
}

// --- final assembly (page 1 plan → product → gaps) --------------------------------------------------

// Stitch the deliverable: the cloud-authored page 1 plan, the cloud-composed product, and a deterministic
// honest Gaps footer. Pure string assembly — no model, no clock.
function assembleFinal({ goal = '', planPage = '', composedBody = '', gaps = '', completed = 'done', count = 0 } = {}) {
  const title = str(goal).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Research deliverable';
  let gapsBlock = str(gaps).trim() || '- none recorded';
  const parts = [
    `# Research deliverable — ${title}`,
    ``,
    str(planPage).trim(),
    ``,
    `---`,
    ``,
    str(composedBody).trim(),
    ``,
    `---`,
    ``,
    `**Gaps**`,
    gapsBlock,
    ``,
    `_Completed: ${str(completed)} · ${Math.max(0, Number(count) || 0)} organization${(Number(count) || 0) === 1 ? '' : 's'}._`,
    ``,
  ];
  return parts.join('\n');
}

// --- P4 PAPER MODE (ADAPTIVE_RESEARCH_DESIGN §P4) ---------------------------------------------------
// A run that ran the adaptive contract (a preflight verdict or a re-entry audit on file) deserves a
// RESEARCH PAPER, not a dossier stitch: cloud-authored FRONT MATTER (abstract / key findings with
// inline citations / methodology from plan+preflight / quantitative results / open questions) wrapped
// around the SAME completeness-gated evidence body — the gate and the oracle stay untouched. The
// coverage check below is DETERMINISTIC (counted, never asserted), so a thin paper says so itself.

const PAPER_SYS = `You are writing the FRONT MATTER of a submission-grade research paper. The evidence body (the researched sections) is FINISHED and provided — you are framing it, not re-researching it.
RULES — these are absolute:
• Ground EVERY sentence in the provided evidence body, method notes, and open questions — never add a fact, name, number, or source that is not already there.
• Citations: where the evidence body carries a URL or named source for a fact you use, carry it inline next to the claim (e.g. "(source: <url>)"). NEVER mint a URL, a document title, or an author that is not in the evidence.
• Quantitative results: report ONLY numbers actually computed in the evidence body. If a listed quantitative question was never computed, say exactly that — "not computed this run" — never estimate one into existence.
• Output Markdown only, using EXACTLY these five second-level headings in this order:
## Abstract
## Key findings
## Methodology
## Quantitative results
## Open questions
- Abstract: one paragraph — what was researched, how, and the headline of what was found.
- Key findings: 4-8 bullet points, each a specific finding WITH its inline citation where the evidence carries one.
- Methodology: how this run actually worked — fold in the method notes (preflight/plan) honestly, including any stated capability gaps.
- Quantitative results: the computed numbers/probabilities, each tied to its question; honest "not computed this run" entries for the rest.
- Open questions: the genuinely unresolved questions (seed list provided; keep only real ones, add any the evidence clearly raises).
No preamble, no "here is", nothing after Open questions.`;

// Build the front-matter messages. `method` = preflight/audit method notes; `quantQuestions` = the
// questions the run promised to compute; `openQuestions` = the run's live open-question ledger.
function buildPaperPrompt({ goal = '', method = '', body = '', quantQuestions = [], openQuestions = [], gaps = '' } = {}) {
  const qq = (Array.isArray(quantQuestions) ? quantQuestions : []).map((q) => str(q).trim()).filter(Boolean).slice(0, 4);
  const oq = (Array.isArray(openQuestions) ? openQuestions : []).map((q) => str(q).trim()).filter(Boolean).slice(0, 5);
  const parts = [
    `RESEARCH GOAL:\n${str(goal).slice(0, 600)}`,
    str(method).trim() ? `METHOD NOTES (from preflight/plan — fold into Methodology honestly):\n${str(method).slice(0, 2000)}` : '',
    qq.length ? `QUANTITATIVE QUESTIONS THIS RUN PROMISED TO COMPUTE:\n${qq.map((q) => `- ${q}`).join('\n')}` : '',
    oq.length ? `OPEN QUESTIONS STILL LIVE AT RUN END (seed for the Open questions section):\n${oq.map((q) => `- ${q}`).join('\n')}` : '',
    str(gaps).trim() ? `KNOWN GAPS (state honestly in Methodology, never paper over):\n${str(gaps).slice(0, 1200)}` : '',
    `THE FINISHED EVIDENCE BODY (frame this — every claim you write must trace to it):\n"""\n${str(body).slice(0, 16000)}\n"""`,
    `Write the front matter now.`,
  ].filter(Boolean);
  return [
    { role: 'system', content: PAPER_SYS },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// DETERMINISTIC citation coverage: of the content-bearing "## " sections, how many carry a real
// source (a URL or a [n] citation marker)? Structural front matter (abstract, methodology, quant
// results — whose numbers trace to the evidence sections that carry the citations — open questions,
// gaps, sources, appendix) is exempt: it frames, it doesn't evidence. Key findings STAYS countable —
// its contract demands inline citations. Counted from the document itself, so never flattery.
const _STRUCTURAL_HEAD = /^(abstract|methodology|quantitative results|open questions|gaps|sources|appendix\b.*|research plan\b.*)$/i;
function citationCoverage(md) {
  const sections = [];
  let cur = null;
  for (const ln of str(md).split(/\r?\n/)) {
    const m = ln.match(/^##\s+([^#].*?)\s*$/);
    if (m) { cur = { heading: m[1].trim(), body: '' }; sections.push(cur); continue; }
    if (cur) cur.body += ln + '\n';
  }
  const countable = sections.filter((s) => !_STRUCTURAL_HEAD.test(s.heading));
  const uncited = [];
  let cited = 0;
  for (const s of countable) {
    if (/https?:\/\//i.test(s.body) || /\[\d+\]/.test(s.body)) cited++;
    else uncited.push(s.heading);
  }
  return { total: countable.length, cited, uncited };
}

function renderCoverageFooter(cov) {
  if (!cov || !cov.total) return '';
  const head = `**Citation coverage:** ${cov.cited}/${cov.total} content sections carry a source.`;
  return cov.uncited.length ? `${head} Uncited: ${cov.uncited.slice(0, 12).join('; ')}.` : head;
}

// Stitch the PAPER: title → front matter → evidence body → plan appendix → honest Gaps → completed
// line. Pure string assembly, mirror of assembleFinal (which stays the non-paper shape).
function assemblePaper({ goal = '', front = '', planPage = '', composedBody = '', gaps = '', completed = 'done', count = 0 } = {}) {
  const title = str(goal).replace(/\s+/g, ' ').trim().slice(0, 100) || 'Research paper';
  const gapsBlock = str(gaps).trim() || '- none recorded';
  const parts = [
    `# ${title}`,
    ``,
    str(front).trim(),
    ``,
    `---`,
    ``,
    str(composedBody).trim(),
    ``,
    `---`,
    ``,
  ];
  if (str(planPage).trim()) parts.push(`## Appendix — research plan`, ``, str(planPage).trim(), ``);
  parts.push(
    `**Gaps**`,
    gapsBlock,
    ``,
    `_Completed: ${str(completed)} · ${Math.max(0, Number(count) || 0)} section${(Number(count) || 0) === 1 ? '' : 's'}._`,
    ``,
  );
  return parts.join('\n');
}

module.exports = {
  COMPOSE_SYS, PAPER_SYS,
  buildComposePrompt, chunkSections, composeBudget,
  composedHeadings, verifyComposition, patchMissing, assembleFinal,
  buildPaperPrompt, citationCoverage, renderCoverageFooter, assemblePaper,
};
