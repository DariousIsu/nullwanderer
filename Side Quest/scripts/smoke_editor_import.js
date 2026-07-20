/**
 * Offline smoke for lib/editor_import.js (B3) + working-copy persistence in editor_registry.
 * Run under Electron-ABI node (better-sqlite3):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke_editor_import.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `editor_import_${Date.now()}.db`);
process.env.EDITOR_DB_PATH = TMP_DB;
const I = require('../lib/editor_import');
const R = require('../lib/editor_registry');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const MD = [
  '# U.S.–Israel Innovation Brief',
  '',
  'This is the opening paragraph. It spans',
  'two source lines but is one block.',
  '',
  '## Background',
  '',
  '- first point',
  '- second point',
  '1. ordered one',
  '',
  '| Col A | Col B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```js',
  'const x = 1;',
  'const y = 2;',
  '```',
  '',
  'Closing paragraph.'
].join('\n');

try {
  R.init({ path: TMP_DB });

  // --- parse / normalize ---
  const wc = I.normalizeMarkdown(MD, {});
  const types = wc.blocks.map(b => b.type);
  ok('title from first heading', wc.title === 'U.S.–Israel Innovation Brief', wc.title);
  ok('heading parsed w/ level', wc.blocks[0].type === 'heading' && wc.blocks[0].level === 1);
  ok('multiline paragraph joined to one block', wc.blocks[1].type === 'paragraph' && /one block\.$/.test(wc.blocks[1].text));
  ok('subheading level 2', types.includes('heading') && wc.blocks.find(b => b.text === 'Background').level === 2);
  ok('list items parsed (3)', wc.blocks.filter(b => b.type === 'list_item').length === 3);
  ok('table grouped into ONE block', wc.blocks.filter(b => b.type === 'table').length === 1);
  ok('table block preserves rows', /Col A/.test(wc.blocks.find(b => b.type === 'table').text) && /\| 1 \| 2 \|/.test(wc.blocks.find(b => b.type === 'table').text));
  ok('code fence captured verbatim, lang js', (() => { const c = wc.blocks.find(b => b.type === 'code'); return c && c.lang === 'js' && c.text === 'const x = 1;\nconst y = 2;'; })());
  ok('closing paragraph present', wc.blocks.some(b => b.type === 'paragraph' && b.text === 'Closing paragraph.'));

  // --- anchors: unique + stable + deterministic hashes ---
  const anchors = wc.blocks.map(b => b.anchor);
  ok('anchors unique', new Set(anchors).size === anchors.length);
  ok('anchors ordinal a0..aN', anchors[0] === 'a0' && anchors[anchors.length - 1] === `a${anchors.length - 1}`);
  const wc2 = I.normalizeMarkdown(MD, {});
  ok('re-normalize identical content → identical anchors+hashes',
     JSON.stringify(wc2.blocks.map(b => [b.anchor, b.hash])) === JSON.stringify(wc.blocks.map(b => [b.anchor, b.hash])));
  ok('blockHash is 8 hex', /^[0-9a-f]{8}$/.test(wc.blocks[0].hash));

  // --- plaintext / importText ---
  const txt = I.importText('Just a line.\n\nAnother para.', { format: 'txt' });
  ok('txt → 2 paragraphs', txt.blocks.length === 2 && txt.format === 'txt');
  let threw = false; try { I.importText('x', { format: 'xlsx' }); } catch { threw = true; }
  ok('importText rejects unsupported format', threw);

  // --- importFile dispatch: md reads directly; docx requires Echo markdown ---
  const mdPath = path.join(os.tmpdir(), `imp_${Date.now()}.md`);
  fs.writeFileSync(mdPath, '# Hi\n\nbody', 'utf8');
  const fromFile = I.importFile(mdPath);
  ok('importFile reads .md directly', fromFile.title === 'Hi' && fromFile.blocks.length === 2);
  fs.unlinkSync(mdPath);

  let docxThrew = false;
  try { I.importFile('C:/x/report.docx'); } catch (e) { docxThrew = /Echo/.test(e.message); }
  ok('importFile .docx without markdown → points at Echo', docxThrew);
  const docxWc = I.importFile('C:/x/report.docx', { markdown: '# Report\n\nExtracted by Echo.' });
  ok('importFile .docx WITH Echo markdown normalizes', docxWc.format === 'docx' && docxWc.title === 'Report');
  // generalized: ANY real-document format works once the caller supplies extracted markdown (pdf/xlsx/img/…)
  const xlsxWc = I.importFile('C:/x/roster.xlsx', { markdown: '# Roster\n\n| Name | Org |\n| --- | --- |\n| A | B |' });
  ok('importFile any format w/ extracted markdown (xlsx → table)', xlsxWc.format === 'xlsx' && xlsxWc.title === 'Roster' && xlsxWc.blocks.some(b => b.type === 'table'));
  const pdfWc = I.importFile('C:/x/brief.pdf', { markdown: 'Body text only, no heading here.' });
  ok('importFile .pdf w/ markdown normalizes (title from first line)', pdfWc.format === 'pdf' && pdfWc.title === 'Body text only, no heading here.');
  const blankWc = I.importFile('C:/x/scan-2024.pdf', { markdown: '   \n\n  ' });
  ok('importFile filename fallback when content has no title', blankWc.format === 'pdf' && blankWc.title === 'scan-2024');
  let unsupThrew = false; try { I.importFile('C:/x/thing.zip'); } catch { unsupThrew = true; }
  ok('importFile unsupported ext (no markdown) still throws', unsupThrew);

  // --- workingCopyText round-trips structure ---
  ok('workingCopyText re-emits headings', /^# U\.S\.–Israel/.test(I.workingCopyText(wc)));

  // --- persistence via registry (save/load by doc+version) ---
  const doc = R.registerDocument({ title: wc.title, author: 'Lucas Overby', source: 'upload' });
  R.saveWorkingCopy(doc.id, 1, wc);
  const loaded = R.getWorkingCopy(doc.id, 1);
  ok('working copy persists + loads identical', JSON.stringify(loaded.blocks) === JSON.stringify(wc.blocks));
  R.saveWorkingCopy(doc.id, 1, wc2);  // upsert same version
  ok('working copy upsert (no dup)', R.getWorkingCopy(doc.id, 1) !== null);
  ok('getWorkingCopy missing → null', R.getWorkingCopy(doc.id, 99) === null);

} catch (e) {
  fail++; console.log('  FAIL (threw) —', e.message); console.error(e);
} finally {
  R.close();
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
}

// ---- title emphasis (docx→markdown emits the title as "**Title**") --------------------------
{
  const EI = require('../lib/editor_import');
  ok('bold-wrapped title loses its asterisks',
    EI.importText('**The Climate Lawyers Who Handed Beijing a Blueprint**\n\nBody.', { format: 'md' }).title
      === 'The Climate Lawyers Who Handed Beijing a Blueprint');
  ok('italic byline unwrapped', EI.stripEmphasis('_By Russ Walker_') === 'By Russ Walker');
  ok('bold-italic unwrapped', EI.stripEmphasis('***Deep***') === 'Deep');
  ok('mid-sentence emphasis is NOT stripped', EI.stripEmphasis('A **bold** word inside') === 'A **bold** word inside');
  ok('a real heading still wins over a bold paragraph',
    EI.importText('# Real Heading\n\n**Not the title**', { format: 'md' }).title === 'Real Heading');

  // ---- block model → export HTML ------------------------------------------------------------
  const wc = EI.importText([
    '# Report Title',
    '',
    'A paragraph with **bold**, _italic_, and a [link](https://example.org/x).',
    '',
    '- first bullet',
    '- second bullet',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
    '| Basin | Gain |',
    '| --- | --- |',
    '| North | 18% |',
    '',
    '```',
    'const x = 1 < 2 && 3 > 2;',
    '```',
  ].join('\n'), { format: 'md' });
  const html = EI.blocksToHtml(wc.blocks);
  ok('h1 rendered with title class', /<h1 class="ex-title">Report Title<\/h1>/.test(html));
  ok('markdown link not double-wrapped', (html.match(/<a href/g) || []).length === 1, html);
  // Endnote lists cite bare urls; an export must turn them into real links, exactly once.
  const bareHtml = EI.blocksToHtml([{ type: 'list_item', marker: '-', text: 'Ballotpedia, "Voter turnout" (https://ballotpedia.org/Voter_turnout)' }]);
  ok('bare url autolinked', /<a href="https:\/\/ballotpedia\.org\/Voter_turnout">https:\/\/ballotpedia\.org\/Voter_turnout<\/a>/.test(bareHtml), bareHtml);
  ok('bare url linked exactly once', (bareHtml.match(/<a href/g) || []).length === 1, bareHtml);
  ok('inline bold/italic/link rendered',
    /<strong>bold<\/strong>/.test(html) && /<em>italic<\/em>/.test(html) && /<a href="https:\/\/example\.org\/x">link<\/a>/.test(html), html);
  ok('contiguous bullets share ONE <ul>', (html.match(/<ul>/g) || []).length === 1 && (html.match(/<li>/g) || []).length === 4);
  ok('numbered list becomes <ol>', /<ol>/.test(html));
  ok('table renders thead + tbody, separator row dropped',
    /<th>Basin<\/th>/.test(html) && /<td>North<\/td>/.test(html) && !/---/.test(html), html);
  ok('code block is escaped, not interpreted', /<pre><code>const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;<\/code><\/pre>/.test(html), html);
  ok('every list is closed', (html.match(/<ul>/g) || []).length === (html.match(/<\/ul>/g) || []).length &&
    (html.match(/<ol>/g) || []).length === (html.match(/<\/ol>/g) || []).length);
  ok('blocksToHtml tolerates junk', EI.blocksToHtml(null) === '' && EI.blocksToHtml([null]) === '');
  // Injection safety: the export is fed to an offscreen renderer, so raw markup must never survive.
  ok('html in source text is escaped',
    !/<script>/.test(EI.blocksToHtml([{ type: 'paragraph', text: '<script>alert(1)</script>' }])));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
