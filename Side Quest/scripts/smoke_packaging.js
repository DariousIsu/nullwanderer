/* Smoke: the "package that" command (lib/packaging + studio/doc_shapes render).
 * Deterministic: injected canvas/meta/readFile/fetch/ask. No model/network/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_packaging.js
 */
'use strict';
const pkg = require('../lib/packaging');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- detection: imperative fires, interrogative does not (detectors-vs-comprehension) ---
  ok(pkg.detectCommand('package that as a policy brief').type === 'policy_brief', '"package that as a policy brief" → policy_brief');
  ok(pkg.detectCommand('can you package the dossier as an op-ed').type === 'op_ed', 'polite imperative + op-ed shape');
  ok(pkg.detectCommand('apply the house style to this').type === null, '"apply the house style" fires with no shape (inferred later)');
  ok(pkg.detectCommand('package it as a research paper').type === 'research_paper', 'research paper shape word');
  ok(pkg.detectCommand('how should we package this?') === null, 'a QUESTION about packaging does not fire');
  ok(pkg.detectCommand("don't package that yet") === null, 'a negation does not fire');
  ok(pkg.detectCommand('the package arrived from Amazon yesterday and the driver left it by the door, which reminded me of the delivery saga') === null, 'ordinary "package" noun talk does not fire (no doc object → guard)');

  // --- target resolution: title match beats recency; empty tabs are not packageable ---
  const canvasAll = () => ([
    { tabKey: 'a', mode: 'DOC', title: 'China AI Announcements', openedAt: 100, blocks: [{ blockType: 'paragraph', data: { markdown: '# China AI Announcements\n\n' + 'substance '.repeat(60) } }] },
    { tabKey: 'b', mode: 'DOC', title: 'Bloomberg Government Brief', openedAt: 200, blocks: [{ blockType: 'paragraph', data: { markdown: '# Bloomberg Government AI Team\n\n' + 'newer substance '.repeat(60) } }] },
    { tabKey: 'c', mode: 'DOC', title: 'Empty Tab', openedAt: 300, blocks: [] },
  ]);
  const getMeta = (k) => (k === 'research.last_dossier' ? JSON.stringify({ path: 'notes/directed-9-dossier.md', goal: 'right-of-center think tanks' }) : null);
  const readFile = () => '# Think Tanks Dossier\n\n' + 'dossier body '.repeat(80);
  const t1 = pkg.resolveTarget({ message: 'package the china announcements doc', deps: { canvasAll, getMeta, readFile } });
  ok(t1 && t1.tabKey === 'a', 'title words in the command pick the NAMED tab over a newer one');
  const t2 = pkg.resolveTarget({ message: 'package that as a brief', deps: { canvasAll, getMeta, readFile } });
  ok(t2 && t2.tabKey === 'b', 'no name → most recent contentful canvas doc wins (empty tab skipped)');
  const t3 = pkg.resolveTarget({ message: 'package the think tanks dossier', deps: { canvasAll, getMeta, readFile } });
  ok(t3 && t3.source === 'dossier', 'dossier goal words pick the dossier');
  ok(pkg.resolveTarget({ message: 'package it', deps: { canvasAll: () => [], getMeta: () => null } }) === null, 'nothing packageable → null (honest refusal upstream)');

  // --- shape inference from content ---
  ok(pkg.inferType('# T\n\n## Abstract\n…\n## Methodology\n…') === 'research_paper', 'abstract+methodology → research_paper');
  ok(pkg.inferType('# T\n\n## Executive Summary\n…\n## Recommendations\n…') === 'policy_brief', 'exec summary → policy_brief');
  ok(pkg.inferType('plain findings text') === 'report', 'no signals → report');
  ok(pkg.inferType('anything', 'op_ed') === 'op_ed', 'an explicit command shape always wins');

  // --- citations + bounded source check ---
  const md = 'See [A](https://example.org/a) and https://example.com/b, plus https://example.com/b again.';
  const urls = pkg.extractCitations(md);
  ok(urls.length === 2, 'citations dedupe');
  const fetchFn = async (u) => ({ status: /example\.org/.test(u) ? 200 : 404 });
  const v = await pkg.verifySources(urls, { fetchFn, now: 1753200000000 });
  ok(v.checked === 2 && v.ok === 1, 'source check counts reachable honestly');
  ok(/1 of 2 cited links reachable/.test(v.note) && /1 did not respond/.test(v.note), 'footer note states the misses, never hides them');
  ok((await pkg.verifySources([], {})).note === '', 'no citations → no note (op-ed/report path)');

  // --- sectionize: validator preserves content; fallback is honest ---
  const src = '# Title\n\n' + 'para one. '.repeat(30) + '\n\n' + 'para two. '.repeat(30);
  const val = pkg.validateSectionize('policy_brief', src);
  const goodJson = JSON.stringify({ executive_summary: 'para one. '.repeat(30), analysis: 'para two. '.repeat(30) });
  ok(val(goodJson).valid, 'a full reorganization validates');
  ok(!val(JSON.stringify({ executive_summary: 'tiny.' })).valid, 'a lossy "reorganization" (content dropped) is REJECTED');
  ok(!val(JSON.stringify({ not_a_section: 'x '.repeat(200) })).valid, 'unknown-only keys are rejected');
  const fb = pkg.fallbackSections('policy_brief', src);
  ok(fb.analysis && fb.analysis.includes('para two.'), 'fallback carries the WHOLE document into the main section');
  const s1 = await pkg.sectionize({ type: 'op_ed', markdown: src, deps: { ask: async () => null } });
  ok(s1.body && s1.body.includes('para one.'), 'cloud down → deterministic fallback, content intact');

  // --- render: brand + honest gaps + verify footer ---
  const html = pkg.renderPackaged({ type: 'policy_brief', title: 'Parish Coverage', sections: fb, verifyNote: v.note, now: 1753200000000 });
  ok(/Policy Brief/.test(html) && /Parish Coverage/.test(html), 'branded render carries shape label + title');
  ok(/Incomplete\./.test(html) && /Executive Summary/.test(html), 'missing required sections are DECLARED in the document');
  ok(/1 of 2 cited links reachable/.test(html), 'source-check note rides in the rendered artifact');
  ok(/Joseph Rainey Center/.test(html), 'the one hardcoded brand is present');

  // --- filenames ---
  ok(/^\d{4}-\d{2}-\d{2}-parish-coverage$/.test(pkg.fileSlug('Parish Coverage', 1753200000000)), 'file slug is dated + slugged');

  // --- O5 SELF-CHECK: re-open what was just produced (an artifact you didn't re-open is a guess) ---
  {
    const os = require('os'); const fsn = require('fs'); const path = require('path');
    const dir = fsn.mkdtempSync(path.join(os.tmpdir(), 'pkg_check_'));
    const src = 'Analysis with a citation: https://example.com/roster and more prose here to carry weight.';
    const sections = { analysis: src };
    const goodHtml = pkg.renderPackaged({ type: 'policy_brief', title: 'Check Me', sections, now: 1753200000000 });
    const htmlPath = path.join(dir, 'doc.html');
    fsn.writeFileSync(htmlPath, goodHtml, 'utf8');
    const pdfPath = path.join(dir, 'doc.pdf');
    fsn.writeFileSync(pdfPath, '%PDF-1.4\n' + '/Type /Page\n'.repeat(2) + 'x'.repeat(1200));
    const good = pkg.selfCheck({ type: 'policy_brief', sections, sourceMarkdown: src, htmlPath, pdfPath });
    ok(good.ok, `a healthy artifact passes every check (${good.summary})`);
    // Mutilated render: the section title deleted → the check catches what the announce would have hidden.
    fsn.writeFileSync(htmlPath, goodHtml.replace(/Analysis/g, ''), 'utf8');
    const mut = pkg.selfCheck({ type: 'policy_brief', sections, sourceMarkdown: src, htmlPath, pdfPath });
    ok(!mut.ok && /section/.test(mut.summary), 'a render missing its section title FAILS honestly');
    // Lost citation: the package dropped the URL → a rewrite, not a packaging.
    fsn.writeFileSync(htmlPath, goodHtml.replace(/https:\/\/example\.com\/roster/g, ''), 'utf8');
    const lost = pkg.selfCheck({ type: 'policy_brief', sections, sourceMarkdown: src, htmlPath, pdfPath });
    ok(!lost.ok && /citations/.test(lost.summary), 'a render that lost a cited link FAILS honestly');
    // Pageless PDF → fail.
    fsn.writeFileSync(htmlPath, goodHtml, 'utf8');
    fsn.writeFileSync(pdfPath, '%PDF-1.4\n' + 'x'.repeat(1200));
    const nopg = pkg.selfCheck({ type: 'policy_brief', sections, sourceMarkdown: src, htmlPath, pdfPath });
    ok(!nopg.ok && /pdf/.test(nopg.summary), 'a pageless PDF FAILS the re-open');
    ok(!pkg.selfCheck({ type: 'policy_brief', sections, sourceMarkdown: src, htmlPath: path.join(dir, 'missing.html') }).ok, 'a missing file can never announce success');
    try { fsn.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
