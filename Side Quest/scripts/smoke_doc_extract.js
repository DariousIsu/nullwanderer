/**
 * Offline smoke for the document extractor (lib/doc_extract.js): the pure HTML→markdown converter
 * over mammoth's real tag vocabulary (h1-6 / p / li / strong / em / tables). Binary extraction
 * (mammoth/pdfjs) is exercised separately by the live check in scripts/livefire_doc_extract.js.
 *
 * Run: node scripts/smoke_doc_extract.js
 */
const DX = require('../lib/doc_extract');
const EI = require('../lib/editor_import');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// --- entities + inline ---
ok('entities: amp/lt/gt/quote/apos', DX.decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;') === 'a & b <c> "d" \'e\'');
ok('inline: strong → **', DX.inlineMd('<strong>Bold</strong> text') === '**Bold** text');
ok('inline: em → _', DX.inlineMd('<em>it</em>') === '_it_');
// hyperlink TARGETS are preserved — a citation verifier needs the source URLs, not just link text
ok('inline: http link → "text (url)"', DX.inlineMd('see <a href="https://x.org/a">here</a>') === 'see here (https://x.org/a)');
ok('inline: link whose text IS the url → bare url', DX.inlineMd('<a href="https://x.org/a">https://x.org/a</a>') === 'https://x.org/a');
ok('inline: fragment/anchor link → text only', DX.inlineMd('note<a href="#fn1">[1]</a>') === 'note[1]');
ok('inline: trailing footnote backlink glyph dropped', DX.inlineMd('source text <a href="#ref1">↑</a>') === 'source text');
ok('inline: stray tags stripped + ws collapsed', DX.inlineMd('<span class="x">a</span>   b') === 'a b');

// SUPERSCRIPT ENDNOTE REFS. Without the <sup>→[n] rule the generic tag-strip welds the digit onto
// the sentence ("…commitments.3"), no marker detector sees it, and the claim loses the source the
// document itself named. Both real docx shapes are covered: hand-typed superscripts (no anchor) and
// mammoth's Word-footnote refs (anchored, with a ↩ backlink in the list).
ok('inline: superscript endnote ref → [n]',
  DX.inlineMd('zero binding commitments.<sup>3</sup>') === 'zero binding commitments.[3]',
  DX.inlineMd('zero binding commitments.<sup>3</sup>'));
ok('inline: adjacent refs stay separable (not "45")',
  DX.inlineMd('the bill<sup>4</sup><sup>5</sup>') === 'the bill[4][5]',
  DX.inlineMd('the bill<sup>4</sup><sup>5</sup>'));
ok('inline: anchored footnote ref → [n]',
  DX.inlineMd('a claim<a href="#user-content-fn-2"><sup>2</sup></a>') === 'a claim[2]',
  DX.inlineMd('a claim<a href="#user-content-fn-2"><sup>2</sup></a>'));
ok('inline: ordinal suffix is NOT a marker (digits-only rule)',
  DX.inlineMd('the 21<sup>st</sup> century') === 'the 21st century', DX.inlineMd('the 21<sup>st</sup> century'));
// KNOWN LIMITATION, asserted so it is visible rather than surprising: a numeric superscript UNIT
// (km², m³) is indistinguishable from an endnote ref at this layer and does become "[2]". Harmless
// in practice — it only matters if that ordinal also exists in a reference section, and these are
// policy documents, not physics papers. Revisit if a doc with real units ever mis-cites.
ok('inline: numeric unit superscript is a known false positive', DX.inlineMd('12 km<sup>2</sup>') === '12 km[2]');
ok('inline: ↩ footnote-return glyph dropped', DX.inlineMd('Stateline, "Red states" <a href="#fnref-8">↩</a>') === 'Stateline, "Red states"',
  DX.inlineMd('Stateline, "Red states" <a href="#fnref-8">↩</a>'));

// footnote citations with hyperlinks: the URLs must survive extraction (the ELI-op-ed failure mode)
{
  const fn = '<ol><li id="fn3"><p>See the <a href="https://worldometers.info/china">EDGAR table</a>; report at <a href="https://statearmor.org/r.pdf">State Armor</a>. <a href="#ref3">↑</a></p></li></ol>';
  const md = DX.htmlToMarkdown(fn);
  const urls = md.match(/https?:\/\/[^\s)]+/g) || [];
  ok('footnote hyperlink URLs survive extraction', urls.includes('https://worldometers.info/china') && urls.includes('https://statearmor.org/r.pdf'), md);
  ok('footnote backlink glyph not leaked', !/↑/.test(md));
}

// --- htmlToMarkdown over mammoth-shaped HTML ---
{
  const html = '<h1>Title</h1><p>First <strong>para</strong>.</p><h2>Sub</h2><ul><li>one</li><li>two</li></ul>';
  const md = DX.htmlToMarkdown(html);
  ok('h1/h2 → # / ##', /^# Title/m.test(md) && /^## Sub/m.test(md));
  ok('paragraph + inline bold', /First \*\*para\*\*\./.test(md));
  ok('list items → "- "', /- one/.test(md) && /- two/.test(md));
  ok('blocks blank-line separated', md.split('\n\n').length === 5);
}

// --- real mammoth shape: layout tables flatten to their inner paragraphs (captured 2026-06-25) ---
{
  const real = '<p><strong>What We Do</strong></p><p><em>Full-spectrum consulting.</em></p><table><tr><td></td><td><p><strong>01</strong></p><p><strong>Fundraising</strong></p><p>No campaign runs on conviction alone.</p></td></tr></table>';
  const md = DX.htmlToMarkdown(real);
  ok('table tags dropped, inner paragraphs kept', !/<t(able|r|d)/.test(md) && /\*\*Fundraising\*\*/.test(md) && /No campaign runs/.test(md));
  ok('empty cell produced no block', !/\n\n\n/.test(md));
  // composes with the existing block model → working copy
  const wc = EI.normalizeMarkdown(md, { format: 'docx' });
  ok('extractor markdown → normalizeMarkdown blocks', wc.blocks.length >= 4 && wc.blocks.every(b => b.anchor && b.type));
  ok('title guessed from leading content', /What We Do/.test(wc.title));
}

// --- pdf-style markdown (## Page N + run-on text) normalizes too ---
{
  const md = `## Page 1\n\nRESEARCH BRIEF energy policy and AI infrastructure.\n\n## Page 2\n\nMore text here.`;
  const wc = EI.normalizeMarkdown(md, { format: 'pdf' });
  ok('pdf markdown → page headings + paragraphs', wc.blocks.filter(b => b.type === 'heading').length === 2 && wc.blocks.some(b => /RESEARCH BRIEF/.test(b.text)));
}

// --- dispatch guard ---
(async () => {
  let threw = false;
  try { await DX.extractToMarkdown('/x/y.rtf'); } catch (e) { threw = /unsupported/.test(e.message); }
  ok('extractToMarkdown rejects unsupported ext', threw);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
