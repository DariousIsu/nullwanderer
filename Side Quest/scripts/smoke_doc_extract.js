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

// --- legacy "## Page N" markdown still normalizes (older working copies / other producers) ---
// extractPdf NO LONGER emits these: page boundaries are not document structure, the marker became
// the doc's first heading so every designed PDF imported titled "Page 1", and it added one junk
// heading block per page. Kept only so previously-extracted markdown still parses.
{
  const md = `## Page 1\n\nRESEARCH BRIEF energy policy and AI infrastructure.\n\n## Page 2\n\nMore text here.`;
  const wc = EI.normalizeMarkdown(md, { format: 'pdf' });
  ok('legacy pdf markdown → page headings + paragraphs', wc.blocks.filter(b => b.type === 'heading').length === 2 && wc.blocks.some(b => /RESEARCH BRIEF/.test(b.text)));
}

// --- PDF page furniture: running headers/folios are boilerplate, not content ------------------
// Shape taken from the real Rainey op-ed PDF: a cover with no header, then ALTERNATING recto/verso
// headers with the folio glued into the same text run, then a back page. Each header therefore
// covers only ~6 of 14 text pages — a half-threshold misses both, which is why this is a third.
{
  const mk = (n, header) => [`${n} ${header}`, `Body paragraph on page ${n}.`, `A second distinct paragraph, number ${n}.`];
  const pages = [
    ['Your Chinese-made Children’s Monitor Is Spying on Your Family', 'By R. Russell Walker'],  // cover
    mk(3, 'The J oseph Rainey Center f or P ublic P olicy'),
    mk(4, 'Your Chinese-made Children’s M onitor Is Spying on Y our F amily'),
    mk(5, 'The J oseph Rainey Center f or P ublic P olicy'),
    mk(6, 'Your Chinese-made Children’s M onitor Is Spying on Y our F amily'),
    mk(7, 'The J oseph Rainey Center f or P ublic P olicy'),
    mk(8, 'Your Chinese-made Children’s M onitor Is Spying on Y our F amily'),
    ['info@raineycenter.org raineycenter.org'],                                                     // back
  ];
  const f = DX.findPageFurniture(pages);
  ok('alternating recto/verso headers BOTH detected', f.size === 2, JSON.stringify([...f]));
  ok('folio glued to header does not defeat matching (page-number-stripped key)',
    f.has('The J oseph Rainey Center f or P ublic P olicy'), JSON.stringify([...f]));
  ok('body copy is NOT furniture', ![...f].some(k => /Body paragraph|More body copy/.test(k)));
  ok('cover/back-page one-offs are NOT furniture', ![...f].some(k => /raineycenter\.org|Russell Walker/.test(k)));
  ok('furnitureKey strips a leading folio', DX.furnitureKey('3 The Rainey Center') === 'The Rainey Center');
  ok('furnitureKey strips a trailing folio', DX.furnitureKey('The Rainey Center 3') === 'The Rainey Center');
  // Too few pages to conclude anything — repetition across 2 pages is not evidence.
  ok('under minPages → no furniture claimed', DX.findPageFurniture([mk(1, 'Hdr'), mk(2, 'Hdr')]).size === 0);
  ok('empty input tolerated', DX.findPageFurniture([]).size === 0 && DX.findPageFurniture([[], []]).size === 0);
  // KNOWN LIMITATION, asserted so it stays visible: detection is repetition-at-page-edges, with no
  // notion of "content". A line genuinely repeated near the edge of a third of the pages IS dropped.
  // Acceptable — verbatim repetition at a page edge is boilerplate in practice (standing disclaimer,
  // section rubric) — but it is a heuristic, not a guarantee, and it fires on real text too.
  const repeated = [1, 2, 3, 4, 5, 6].map(n => [`${n} Hdr`, `Unique body ${n}.`, 'Paid for by the committee.']);
  ok('a genuinely repeated edge line is treated as furniture (documented tradeoff)',
    DX.findPageFurniture(repeated).has('Paid for by the committee.'));
}

// --- dispatch guard ---
(async () => {
  let threw = false;
  try { await DX.extractToMarkdown('/x/y.rtf'); } catch (e) { threw = /unsupported/.test(e.message); }
  ok('extractToMarkdown rejects unsupported ext', threw);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
