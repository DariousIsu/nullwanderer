/* smoke_doc_shapes.js — four shapes, ONE brand.
 *
 * Lucas, 2026-07-21: "A research paper, a briefing, an op-ed, a report all have different meanings
 * and shapes that will be different format. The instruction is to make the branding hardcoded
 * universal. it doesnt need to be perfect today as long the information is there but I dont want the
 * hard code base to be wrong."
 *
 * So these tests guard the STRUCTURE, not the prettiness:
 *
 *   · the brand is IMPORTED from studio/cert_template, never re-declared. Two copies of a palette
 *     drift, and then nothing tells you which one is the house style — that is the "hard code base
 *     being wrong" he is warning about, and it is the assertion that matters most here.
 *   · a shape is DATA. Adding a fifth document type must be one new entry in SHAPES and nothing else.
 *   · a required section with no content renders as a visible placeholder and is counted in an
 *     "Incomplete" banner. A packaged document that quietly omits its methodology looks finished and
 *     is not — and this system has spent the day producing things that looked finished.
 *   · rendering is pure code: same input, same output, no model.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DS = require('../studio/doc_shapes');
const cert = require('../studio/cert_template');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── ⭐ ONE BRAND, SHARED ────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'studio', 'doc_shapes.js'), 'utf8');
  ok(/require\('\.\/cert_template'\)/.test(src), 'the brand is IMPORTED from the certification template');
  ok(/cert && cert\.STYLE/.test(src), 'and its STYLE is what gets rendered');
  ok(!/--purple:#662d91/.test(src),
    'SAFETY: the palette is NOT re-declared here — one house style, one place to change it');
  ok(typeof cert.STYLE === 'string' && /--purple:#662d91/.test(cert.STYLE), 'cert_template exports the real style');
  ok(cert.ORG_NAME === 'Joseph Rainey Center for Public Policy', 'and the org name, so the masthead cannot drift either');

  // every type must carry the same brand
  for (const type of DS.TYPES) {
    const html = DS.renderDocument({ type, title: 'T', sections: {} });
    ok(/--purple:#662d91/.test(html), `${type} renders with the house palette`);
    ok(/Joseph Rainey Center for Public Policy/.test(html), `${type} carries the masthead`);
  }
}

// ── the four shapes are Lucas's spec ────────────────────────────────────────────────────────────
{
  ok(DS.TYPES.length === 4, 'four types');
  ok(DS.TYPES.join(',') === 'research_paper,policy_brief,op_ed,report', 'research paper, policy brief, op-ed, report');

  const keys = (t) => DS.shapeFor(t).sections.map((s) => s.key).join(',');
  ok(keys('research_paper') === 'abstract,introduction,methodology,results,discussion,references',
    'a research paper is abstract → introduction → methodology → results → discussion → references');
  ok(keys('policy_brief').startsWith('executive_summary,problem,analysis,options,recommendations'),
    'a policy brief leads with the executive summary and ends on recommendations');
  ok(keys('op_ed') === 'hook,thesis,body,counterargument,conclusion',
    'an op-ed is hook → thesis → argument → counterargument → conclusion');
  ok(keys('report') === 'introduction,body,methodology,conclusions,recommendations', 'a report is the internal shape');

  // ORDER is the shape — a brief that opens with methodology is not a brief
  const brief = DS.renderDocument({ type: 'policy_brief', title: 'T', sections: { executive_summary: 'A', recommendations: 'B' } });
  ok(brief.indexOf('Executive Summary') < brief.indexOf('Recommendations'), 'sections render in the shape\'s order');

  ok(DS.shapeFor('report').hasToc === true, 'only the report gets a table of contents');
  ok(!DS.shapeFor('op_ed').hasToc, 'an op-ed does not');
  ok(/700–800 words/.test(DS.shapeFor('op_ed').lengthRule), 'the op-ed carries its length discipline');
  ok(/25 words or less/.test(DS.shapeFor('policy_brief').titleRule), 'the brief carries its title rule');

  // adding a type must be data-only
  ok(Object.keys(DS.SHAPES).every((k) => Array.isArray(DS.SHAPES[k].sections) && DS.SHAPES[k].purpose),
    'every shape is plain data — sections + purpose');
}

// ── ⭐ AN UNFINISHED DOCUMENT SAYS SO ───────────────────────────────────────────────────────────
{
  const html = DS.renderDocument({ type: 'research_paper', title: 'T', sections: { abstract: 'A', introduction: 'B' } });
  ok(/Incomplete\./.test(html), 'SAFETY: missing required sections produce a banner');
  ok(/4 required sections are not written yet/.test(html), 'counted honestly');
  ok(/Methodology, Results/.test(html), 'and named');
  ok(/Not written yet — How the data was collected/.test(html),
    'each gap renders in place with what belongs there — never silently omitted');
  ok(DS.missingSections('research_paper', { abstract: 'A' }).length === 5, 'missingSections is callable on its own');

  const done = DS.renderDocument({ type: 'op_ed', title: 'T', sections: { hook: 'h', thesis: 't', body: 'b', counterargument: 'c', conclusion: 'x' } });
  ok(!/Incomplete\./.test(done), 'a complete document carries no banner');
  ok(!/Not written yet/.test(done), 'and no placeholders');

  // whitespace is not content
  ok(DS.missingSections('op_ed', { hook: '   \n  ' }).length === 5, 'SAFETY: whitespace does not count as a written section');
}

// ── markdown → HTML, and it must be safe ────────────────────────────────────────────────────────
{
  ok(/<h2>Head<\/h2>/.test(DS.mdToHtml('# Head')), 'headings convert (offset one level under the doc title)');
  ok(/<ul>\n<li>a<\/li>/.test(DS.mdToHtml('- a')), 'bullets convert');
  ok(/<ol>\n<li>a<\/li>/.test(DS.mdToHtml('1. a')), 'numbered lists convert');
  ok(/<strong>b<\/strong>/.test(DS.mdToHtml('**b**')) && /<em>i<\/em>/.test(DS.mdToHtml('an *i* word')), 'bold and italic');
  ok(/<a href="https:\/\/x\.test">t<\/a>/.test(DS.mdToHtml('[t](https://x.test)')), 'links convert');
  ok(/<p>plain<\/p>/.test(DS.mdToHtml('plain')), 'prose becomes paragraphs');
  ok(DS.mdToHtml('') === '' && DS.mdToHtml(null) === '', 'empty in, empty out');

  // SAFETY: a renderer must never emit its input as markup
  const evil = DS.mdToHtml('<script>alert(1)</script> & <b>x</b>');
  ok(!/<script>/.test(evil) && /&lt;script&gt;/.test(evil), 'SAFETY: HTML in the markdown is ESCAPED, not executed');
  ok(/&amp;/.test(evil), 'and ampersands are escaped');
  const titled = DS.renderDocument({ type: 'report', title: '<img src=x onerror=1>', sections: {} });
  ok(!/<img src=x/.test(titled), 'SAFETY: the title is escaped too');
}

// ── pure: same input, same output ───────────────────────────────────────────────────────────────
{
  const a = { type: 'report', title: 'T', date: 1784650000000, sections: { introduction: 'i' } };
  ok(DS.renderDocument(a) === DS.renderDocument(a), 'rendering is deterministic — no model, no clock drift');
  let threw = false;
  try { DS.renderDocument({ type: 'nonsense', title: 'T' }); } catch { threw = true; }
  ok(threw, 'an unknown type throws rather than guessing a shape');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
