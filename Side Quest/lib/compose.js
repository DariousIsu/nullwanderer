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

module.exports = {
  COMPOSE_SYS,
  buildComposePrompt, chunkSections, composeBudget,
  composedHeadings, verifyComposition, patchMissing, assembleFinal,
};
