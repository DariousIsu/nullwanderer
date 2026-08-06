/* Smoke: lib/compose — the CLOUD DOCUMENT COMPOSER + the completeness GATE (Pillar 3). Proves the
 * compose prompt cages the leaf, chunking never splits an org, the gate catches a dropped org against the
 * lossless oracle, the patch restores it verbatim, and the final assembly is page1 → product → gaps.
 * Pure: no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_compose.js
 */
'use strict';
const cp = require('../lib/compose');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const secs = [
  { heading: 'Heritage Foundation', body: '## Heritage Foundation\n- **Focus:** conservative policy\n- **Key people:** Kevin Roberts — President' },
  { heading: 'Cato Institute', body: '## Cato Institute\n- **Focus:** libertarian policy\n- **Key people:** Peter Goettler — President' },
  { heading: 'Manhattan Institute', body: '## Manhattan Institute\n- **Focus:** urban policy\n- **Key people:** Reihan Salam — President' },
];

// --- buildComposePrompt: single-doc cages the leaf + demands every org ---
const single = cp.buildComposePrompt({ goal: 'right-wing think tanks', sections: secs, chunkIndex: 0, chunkTotal: 1 });
ok(Array.isArray(single) && single.length === 2, 'compose prompt is a system+user message pair');
ok(/never add a person|Ground ONLY/i.test(single[0].content) && /never drop, merge, rename/i.test(single[0].content), 'compose system cages grounding + no-drop');
ok(/executive summary/i.test(single[0].content) && /Do NOT write a "plan" section/i.test(single[0].content), 'single-doc: writes exec summary, skips the plan (prepended separately)');
ok(/include all 3 of these organizations/i.test(single[1].content) && /Heritage Foundation/.test(single[1].content), 'compose user lists all orgs + carries the bodies');

// --- chunked part: no exec summary, only the orgs ---
const part = cp.buildComposePrompt({ goal: 'g', sections: secs.slice(0, 1), chunkIndex: 1, chunkTotal: 3 });
ok(/PART 2 of 3/i.test(part[0].content) && /Do NOT write an executive summary/i.test(part[0].content), 'chunked part: labeled + suppresses the overall summary');

// --- chunkSections: groups under the cap, never splits an org ---
const small = cp.chunkSections(secs, 100000);
ok(small.length === 1 && small[0].length === 3, 'small run → a single group');
const split = cp.chunkSections(secs, 80);   // each body > 80 chars → one org per group
ok(split.length === 3 && split.every(g => g.length === 1), 'tight cap → one org per group (never split an org)');
ok(cp.chunkSections([], 14000).length >= 0, 'empty sections → no throw');

// --- composeBudget: scales to the document, bounded ---
ok(cp.composeBudget(secs) >= 1500, 'budget floors at the minimum');
const big = [{ heading: 'X', body: 'y'.repeat(60000) }];
ok(cp.composeBudget(big) <= 7000, 'budget caps at the maximum');

// --- composedHeadings + verifyComposition: the gate against the oracle ---
const full = '# Dossier\n\n## Heritage Foundation\nx\n\n## Cato Institute\ny\n\n## Manhattan Institute\nz';
ok(cp.composedHeadings(full).length === 3, 'composedHeadings finds all "## " headings');
ok(cp.verifyComposition(full, secs).ok === true, 'gate passes when every org survived');

const dropped = '# Dossier\n\n## Heritage Foundation\nx\n\n## Cato Institute\ny';   // Manhattan dropped
const gate = cp.verifyComposition(dropped, secs);
ok(gate.ok === false && gate.missing.length === 1 && gate.missing[0].heading === 'Manhattan Institute', 'gate catches the dropped org (full section returned for patching)');
ok(gate.present.length === 2, 'gate reports the present orgs');

// tolerant matching: "## The Heritage Foundation" still counts as present
const tol = '## The Heritage Foundation\nx\n\n## Cato Institute\ny\n\n## Manhattan Institute\nz';
ok(cp.verifyComposition(tol, secs).ok === true, 'gate matches "The Heritage Foundation" ↔ "Heritage Foundation"');

// --- patchMissing: restores the dropped org verbatim ---
const patched = cp.patchMissing(dropped, gate.missing);
ok(/## Manhattan Institute/.test(patched) && /Reihan Salam/.test(patched), 'patch appends the dropped org verbatim from the oracle');
ok(cp.verifyComposition(patched, secs).ok === true, 'after patch, the gate passes (N-in = N-out restored)');
ok(cp.patchMissing(dropped, []) === dropped, 'patch with nothing missing is a no-op');

// --- assembleFinal: page1 → product → gaps ---
const doc = cp.assembleFinal({ goal: 'right-wing think tanks', planPage: '# Research plan\n\n**Objective** — profile them', composedBody: full, gaps: '- none', completed: 'done', count: 3 });
ok(/^# Research deliverable — right-wing think tanks/m.test(doc), 'final doc has the deliverable title');
ok(doc.indexOf('# Research plan') < doc.indexOf('## Heritage Foundation'), 'page 1 PLAN comes before the product');
ok(/\*\*Gaps\*\*/.test(doc) && /Completed: done · 3 organizations/.test(doc), 'final doc has Gaps + the completed/count footer');
ok(/Gaps\*\*\n- none recorded/.test(cp.assembleFinal({ goal: 'g', planPage: 'p', composedBody: 'b', gaps: '', count: 1 })), 'empty gaps → "none recorded"');

// --- P4 PAPER MODE: front-matter prompt, deterministic citation coverage, paper assembly ---
const pm = cp.buildPaperPrompt({
  goal: 'anti-data-center foundations in NC', method: 'Preflight method: follow the money through 990s',
  body: full, quantQuestions: ['total grant flow by recipient'], openQuestions: ['who funds the funders'], gaps: '- state filings unavailable',
});
ok(Array.isArray(pm) && pm.length === 2 && /FRONT MATTER/i.test(pm[0].content), 'paper prompt is a system+user pair for FRONT MATTER only');
ok(/## Abstract/.test(pm[0].content) && /## Key findings/.test(pm[0].content) && /## Quantitative results/.test(pm[0].content) && /## Open questions/.test(pm[0].content), 'paper system fixes the five headings');
ok(/never add a fact/i.test(pm[0].content) && /NEVER mint a URL/i.test(pm[0].content) && /not computed this run/i.test(pm[0].content), 'paper system cages grounding, citations, and quant honesty');
ok(/follow the money through 990s/.test(pm[1].content) && /total grant flow by recipient/.test(pm[1].content) && /who funds the funders/.test(pm[1].content) && /state filings unavailable/.test(pm[1].content), 'paper user carries method + quant questions + open questions + gaps');
ok(pm[1].content.indexOf('## Heritage Foundation') > -1, 'paper user carries the finished evidence body');

const covMd = [
  '## Abstract', 'no citation needed here',
  '## Key findings', '- finding one (source: https://example.org/990)',
  '## Methodology', 'structural, exempt',
  '## Alpha Org', 'evidence with a source https://example.org/a',
  '## Beta Org', 'evidence with a footnote marker [2]',
  '## Gamma Org', 'evidence with no source at all',
  '## Open questions', 'exempt', '## Gaps', 'exempt', '## Sources', 'https://example.org (the trail itself is exempt)',
].join('\n');
const cov = cp.citationCoverage(covMd);
ok(cov.total === 4 && cov.cited === 3, 'coverage counts content sections only (key findings + 3 orgs), URL or [n] = cited');
ok(cov.uncited.length === 1 && cov.uncited[0] === 'Gamma Org', 'the uncited section is named');
ok(cp.citationCoverage('no headings at all').total === 0, 'no sections → zero coverage, no throw');
ok(/3\/4 content sections carry a source/.test(cp.renderCoverageFooter(cov)) && /Uncited: Gamma Org/.test(cp.renderCoverageFooter(cov)), 'coverage footer states the count + names the uncited');
ok(cp.renderCoverageFooter({ total: 2, cited: 2, uncited: [] }).indexOf('Uncited') === -1, 'full coverage footer omits the uncited clause');
ok(cp.renderCoverageFooter(null) === '' && cp.renderCoverageFooter({ total: 0, cited: 0, uncited: [] }) === '', 'no countable sections → no footer');

const frontMd = '## Abstract\nA study.\n\n## Key findings\n- x (source: https://e.org)\n\n## Methodology\nm\n\n## Quantitative results\nnot computed this run\n\n## Open questions\n- q';
const paper = cp.assemblePaper({ goal: 'anti-data-center foundations', front: frontMd, planPage: '# Research plan\n\np', composedBody: full, gaps: '- one gap', completed: 'done', count: 3 });
ok(/^# anti-data-center foundations/m.test(paper), 'paper title is the goal');
ok(paper.indexOf('## Abstract') < paper.indexOf('## Heritage Foundation'), 'front matter precedes the evidence body');
ok(paper.indexOf('## Heritage Foundation') < paper.indexOf('## Appendix — research plan'), 'plan is demoted to an appendix AFTER the body');
ok(/\*\*Gaps\*\*\n- one gap/.test(paper) && /Completed: done · 3 sections/.test(paper), 'paper keeps the honest Gaps + completed footer');
ok(cp.assemblePaper({ goal: 'g', front: 'f', planPage: '', composedBody: 'b', count: 1 }).indexOf('Appendix') === -1, 'no plan page → no empty appendix');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
