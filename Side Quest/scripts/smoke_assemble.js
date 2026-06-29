/* Smoke: lib/assemble — DETERMINISTIC, lossless assembly of a research deliverable.
 * The core invariant: N sections in = N sections out; the model wrapper never drops an org.
 * Pure functions, no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_assemble.js
 */
'use strict';
const as = require('../lib/assemble');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- a realistic accreted run file: header preamble + N "## <org>" sections ---
const N = 21;
const orgs = Array.from({ length: N }, (_, i) => `Org ${i + 1}`);
const file = `# Directed research deliverable\n\n**Task:** study every think tank\n\n---\n\n` +
  orgs.map(o => `## ${o}\n- **Focus:** policy\n- **Key people:** Jane Doe — President\n- **Contact:** ${o.replace(/\s+/g, '').toLowerCase()}.org\n- **Positions / work:** stuff\n`).join('\n');

// --- parseSections: preamble split off, every section captured, headings clean ---
const ps = as.parseSections(file);
ok(ps.sections.length === N, `parseSections finds all ${N} org sections`);
ok(/Directed research deliverable/.test(ps.preamble) && !/## Org/.test(ps.preamble), 'preamble holds the header, not a section');
ok(ps.sections[0].heading === 'Org 1' && ps.sections[N - 1].heading === `Org ${N}`, 'headings parsed in order, "## " stripped');
ok(ps.sections[0].body.includes('**Key people:**'), 'section body preserved verbatim');

// "###" subheadings must NOT be mistaken for a new section
const withSub = `## A\ntext\n### subhead\nmore\n## B\ntext`;
ok(as.parseSections(withSub).sections.length === 2, '"###" subheading does not split a section');
ok(as.parseSections(withSub).sections[0].body.includes('### subhead'), 'subheading stays inside its section body');

// countSections
ok(as.countSections(file) === N, 'countSections matches the artifact');
ok(as.countSections('') === 0 && as.countSections(null) === 0, 'empty/null → 0 sections (fail-safe)');

// --- reconcileIndex: index vs document, drift surfaced ---
const rec = as.reconcileIndex(orgs, ps.sections);
ok(rec.count === N && rec.indexedMissing.length === 0, 'clean run: index matches document, nothing missing');
const recDrift = as.reconcileIndex(orgs.concat('Ghost Org'), ps.sections);   // counter claims an org with no section
ok(recDrift.indexedMissing.length === 1 && /Ghost/.test(recDrift.indexedMissing[0]), 'indexed-but-missing org detected (append-failed case)');
ok(as.reconcileIndex(['heritage foundation'], [{ heading: 'The Heritage Foundation', body: 'x' }]).indexedMissing.length === 0, 'tolerant name match (index "heritage foundation" ↔ heading "The Heritage Foundation")');

// --- wrapper prompt: small (headings+excerpt only), forbids reproducing sections ---
const wp = as.buildWrapperPrompt({ goal: 'study every think tank', sections: ps.sections });
ok(wp.length === 2 && wp[0].role === 'system', 'wrapper prompt is system+user');
ok(/NEVER reproduce|never reproduce|do not reproduce/i.test(wp[0].content) && /SUMMARY:/i.test(wp[0].content) && /GAPS:/i.test(wp[0].content), 'wrapper system forbids reproducing sections + asks only SUMMARY/GAPS');
// the no-whole-doc-rewrite property: with LARGE section bodies, the wrapper sees only a bounded
// excerpt per section, so its prompt grows far slower than the document itself.
const bigSecs = orgs.map(o => ({ heading: o, body: `## ${o}\n` + ('long detailed research paragraph. '.repeat(120)) }));
const bigFileLen = bigSecs.reduce((n, s) => n + s.body.length, 0);
const wpBig = as.buildWrapperPrompt({ goal: 'g', sections: bigSecs });
ok(wpBig[1].content.length < bigFileLen * 0.4, 'wrapper prompt is a small fraction of the full document (no whole-doc rewrite)');

// --- parseWrapper ---
const pw = as.parseWrapper('SUMMARY: A set of 21 right-of-center policy shops.\nGAPS:\n- Org 5 — contacts missing');
ok(/21 right-of-center/.test(pw.summary) && /Org 5/.test(pw.gaps), 'parseWrapper splits SUMMARY and GAPS');
ok(as.parseWrapper('garbage').summary === '' && as.parseWrapper('garbage').gaps === '', 'parseWrapper on junk → empty (fail-safe)');

// --- stitchDocument: THE lossless invariant — every org survives ---
const doc = as.stitchDocument({ goal: 'study every think tank', completed: 'done', sections: ps.sections, summary: 'A set of policy shops.', gaps: '- none' });
const outCount = as.countSections(doc);
ok(outCount === N, `STITCH IS LOSSLESS: ${N} in → ${outCount} out`);
for (const o of orgs) ok(doc.includes(`## ${o}\n`), `stitched doc still contains "## ${o}"`);
ok(new RegExp(`\\*\\*Organizations covered:\\*\\* ${N}`).test(doc), 'count line derives from the artifact, not a counter');
ok(/\*\*Summary\*\*/.test(doc) && /\*\*Gaps\*\*/.test(doc), 'doc has Summary + Gaps wrapper');
ok(doc.indexOf('## Org 1') < doc.indexOf('## Org 2'), 'sections keep their order');

// failed-wrapper path: empty summary/gaps still yields a COMPLETE, lossless doc
const docNoWrap = as.stitchDocument({ goal: 'g', completed: 'stalled', sections: ps.sections, summary: '', gaps: '' });
ok(as.countSections(docNoWrap) === N, 'failed wrapper (empty summary/gaps) → still all N sections (fail-safe)');
ok(/\*\*Summary\*\* — This dossier consolidates 21/.test(docNoWrap), 'empty summary → neutral deterministic fallback line');

// indexedMissing surfaces in Gaps honestly
const docMiss = as.stitchDocument({ goal: 'g', completed: 'done', sections: ps.sections, summary: 's', gaps: '- none', indexedMissing: ['Ghost Org'] });
ok(/Ghost Org — section not captured/.test(docMiss), 'indexed-but-missing org honestly noted in Gaps');

// a single-section run still assembles
const one = as.stitchDocument({ goal: 'g', completed: 'done', sections: [{ heading: 'Solo', body: '## Solo\n- x' }] });
ok(as.countSections(one) === 1 && /\*\*Organizations covered:\*\* 1/.test(one), 'single-org run assembles with count 1');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
