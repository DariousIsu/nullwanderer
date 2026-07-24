/**
 * Offline smoke for the verification harness STAGE 2 (studio/verify_extract.js):
 * working copy → standardized verification units. Pure deterministic — no cloud, no Echo.
 *
 * Drives a realistic mixed document through the REAL importer (editor_import) first, so the
 * smoke proves the two modules compose on the actual block shape, then asserts the unit contract.
 *
 * Run: node scripts/smoke_verify_extract.js
 */
const { importText } = require('../lib/editor_import');
const VE = require('../studio/verify_extract');
const {
  extractUnits, splitSentences, detectQuotes, detectUrls, detectDois, detectMarkers, detectNumbers, kindOf,
} = VE;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- detector unit tests (the deterministic atoms) -------------------------------------------

// Sentence splitter: must NOT split on decimals, initialisms, or abbreviations.
ok('split keeps decimals intact', splitSentences('Inflation hit 3.5 percent last year. It then fell.').length === 2);
ok('split protects U.S. initialism', splitSentences('The U.S. economy grew. Europe lagged.').length === 2,
  JSON.stringify(splitSentences('The U.S. economy grew. Europe lagged.')));
ok('split protects "Dr." abbreviation', splitSentences('Dr. Smith testified today. The hearing ended.').length === 2);
ok('split on plain boundary', splitSentences('First claim here. Second claim there. Third.').length === 3);
ok('empty text → no sentences', splitSentences('   ').length === 0);

// Quote detection (straight + curly + blockquote), min length filter.
ok('straight double quote', detectQuotes('He said "the deal is final" yesterday.', 4)[0] === 'the deal is final');
ok('curly double quote', detectQuotes('She wrote “never again” in the memo.', 4)[0] === 'never again');
ok('blockquote marker', detectQuotes('> the committee rejected the proposal', 4)[0] === 'the committee rejected the proposal');
ok('short scare-quote ignored at minLen 6', detectQuotes('a so-called "fix" appeared', 6).length === 0);

// URL / DOI / marker / number detectors.
ok('url detected + trailing period stripped', detectUrls('See https://gao.gov/report.pdf. Next.')[0] === 'https://gao.gov/report.pdf');
ok('markdown-link url found', detectUrls('Per the [report](https://x.org/a) it rose.')[0] === 'https://x.org/a');
ok('doi detected', detectDois('Published at 10.1126/science.abc1234 last year.')[0] === '10.1126/science.abc1234');

// Bare cited domains — a designed document prints "…June 15, 2026. ago.mo.gov" with no scheme, so
// without this the whole sentence carries no citation signal and is never even a unit.
const dd = VE.detectDomains;
ok('bare domain detected', dd('Missouri AG press release, June 15, 2026. ago.mo.gov')[0] === 'ago.mo.gov');
ok('bare domain at sentence end (trailing period stripped)', dd('Read it at dhs.gov.')[0] === 'dhs.gov');
ok('multiple bare domains', dd('texasattorneygeneral.gov and chinalawtranslate.com both cited').length === 2);
ok('mixed case host normalized', dd('ClassAction.org reported it.')[0] === 'classaction.org');
ok('host inside a full url NOT double-reported', dd('See https://ago.mo.gov/news/x for detail.').length === 0);
ok('email address is NOT a citation', dd('Contact info@raineycenter.org for more.').length === 0);
ok('filename is NOT a domain (tld allowlist)', dd('The file report.pdf was attached.').length === 0);
ok('abbreviation is NOT a domain', dd('Per e.g. the usual sources.').length === 0);
ok('version string is NOT a domain', dd('Version 2.10 shipped.').length === 0);
ok('decimal is NOT a domain', dd('Costs rose 4.2 percent.').length === 0);
ok('domain makes the sentence a citation unit', kindOf({ domain: 'dhs.gov' }) === 'citation');

// A NAME in quotes is not a quotation. Writers quote proper nouns constantly, and treating those as
// claims sent the harness looking for a source that "supports" a malware name — three of the seven
// findings on cert CFC-2026-07-20-01 were exactly that.
ok('two-word proper noun is not a verifiable quote', !VE.isVerifiableQuote('Camaro Dragon'));
ok('one-word name is not a verifiable quote', !VE.isVerifiableQuote('Brickstorm'));
ok('4-word quotation qualifies', VE.isVerifiableQuote('the deal is final'));
ok('long 2-word quote qualifies on length', VE.isVerifiableQuote('antidisestablishmentarianism reconsidered'));
ok('empty/garbage is not a quote', !VE.isVerifiableQuote('') && !VE.isVerifiableQuote(null));
{
  const nameDoc = importText('Researchers named the implant "Brickstorm" after a 2026 report.', { format: 'md' });
  const nu = extractUnits(nameDoc).units;
  ok('name-in-quotes does NOT become a quote unit', !nu.some(u => u.kind === 'quote'), JSON.stringify(nu));
  const realDoc = importText('The report said the policy was "a complete and total success" last year.', { format: 'md' });
  ok('a real quotation still becomes a quote unit',
    extractUnits(realDoc).units.some(u => u.kind === 'quote' && /complete and total/.test(u.quote)));
  // detectQuotes itself is unchanged — the operator's citation list still sees every quoted span.
  ok('detectQuotes still reports the short span (detector unchanged)',
    detectQuotes('Researchers named it "Brickstorm" that year.', 4)[0] === 'Brickstorm');
}
{
  // The important guarantee: a bare host must NOT become a fetchable url. Promoting "ago.mo.gov" to
  // "https://ago.mo.gov" would point the resolver at a HOMEPAGE and let the judge rule on whatever is
  // there today — a confident verdict from the wrong page.
  const dwc = importText('Missouri AG sued the manufacturer, June 15, 2026. ago.mo.gov', { format: 'md' });
  const du = extractUnits(dwc).units[0];
  ok('domain unit carries `domain`, never `url`', du && du.domain === 'ago.mo.gov' && du.url === undefined,
    JSON.stringify(du));
  ok('domain unit is kind citation', du && du.kind === 'citation');
}
ok('numeric ref marker [1]', detectMarkers('This is established [1].')[0] === '[1]');
ok('author-year paren marker', detectMarkers('Growth slowed (Smith, 2020).')[0] === '(Smith, 2020)');
ok('percentage stat', detectNumbers('Unemployment fell 4.2% in March.')[0].replace(/\s/g, '') === '4.2%');
ok('currency stat', detectNumbers('The bill costs $3 billion over ten years.')[0].replace(/\s/g, '').toLowerCase() === '$3billion');
ok('bare year is NOT a stat', detectNumbers('It happened in 2021.').length === 0);

// kindOf precedence.
ok('quote outranks citation', kindOf({ quote: 'x', url: 'http://y' }) === 'quote');
ok('citation when url only', kindOf({ url: 'http://y' }) === 'citation');
ok('numeric when only numbers', kindOf({ numbers: ['5%'] }) === 'numeric');
ok('no signal → null (claim suppressed)', kindOf({}) === null);
ok('no signal → claim when includeBareClaims', kindOf({}, true) === 'claim');

// ---- end-to-end through the real importer ----------------------------------------------------

const DOC = [
  '# Wyoming Snowpack Brief',
  '',
  'The program raised snowpack by 15% across treated basins, according to the state water office.',
  'Dr. Lee noted the U.S. EPA has not reviewed the method. No federal framework exists yet.',
  'A 2021 review concluded the effect was "limited to a single demonstration site" (GAO, 2021).',
  'Full data is posted at https://wwdo.wyo.gov/report2023 for public review.',
  'The downwind analysis was published at 10.1126/science.abc1234 last spring.',
  'The appropriation totals $3 billion over the biennium [2].',
  'This paragraph is ordinary narration with nothing to check.',
  '',
  '> the committee rejected the amendment on a 6-3 vote',
  '',
  '- Treated basins saw a 12% gain versus controls.',
  '- Costs remain under review by staff.',
  '',
  '| Basin | Gain |',
  '| --- | --- |',
  '| North Fork | 18% |',
  '| South Fork | 9% |',
  '',
  '```',
  'this is code with a "fake quote" and 50% that must be ignored',
  '```',
].join('\n');

const wc = importText(DOC, { format: 'md' });
const { units, summary } = extractUnits(wc);
const byUid = Object.fromEntries(units.map(u => [u.uid, u]));
const find = (pred) => units.find(pred);

// --- shape / contract ---
ok('returns {units,summary}', Array.isArray(units) && !!summary);
ok('every unit has uid/anchor/blockType/kind/text', units.every(u => u.uid && u.anchor && u.blockType && u.kind && u.text));
ok('uids unique', new Set(units.map(u => u.uid)).size === units.length);
ok('every kind is in the frozen enum', units.every(u => VE.KINDS.includes(u.kind)));
ok('summary tallies match unit count', summary.unitCount === units.length &&
  VE.KINDS.reduce((n, k) => n + summary.byKind[k], 0) === units.length, JSON.stringify(summary.byKind));

// --- code block is fully skipped (no "fake quote" / "50%" leaks) ---
ok('code block produces no units', !units.some(u => /fake quote/i.test(u.text) || (u.numbers || []).some(n => /50%/.test(n))));

// --- the ordinary narration sentence is dropped (no verifiable signal) ---
ok('signal-less narration dropped', !find(u => /ordinary narration/.test(u.text)));

// --- each kind appears with the right attribute ---
const numeric15 = find(u => /raised snowpack by 15%/.test(u.text));
ok('15% sentence → numeric with the stat', numeric15 && numeric15.kind === 'numeric' && (numeric15.numbers || []).some(n => /15\s*%/.test(n)));

const quoteUnit = find(u => u.quote === 'limited to a single demonstration site');
ok('quoted GAO sentence → kind quote + quote field', quoteUnit && quoteUnit.kind === 'quote');
ok('that quote sentence also carried its (GAO, 2021) marker', quoteUnit && quoteUnit.marker === '(GAO, 2021)');

const urlUnit = find(u => u.url === 'https://wwdo.wyo.gov/report2023');
ok('url sentence → kind citation', urlUnit && urlUnit.kind === 'citation');

const doiUnit = find(u => u.doi === '10.1126/science.abc1234');
ok('doi sentence → kind citation + doi field', doiUnit && doiUnit.kind === 'citation');

const apprUnit = find(u => /appropriation totals/.test(u.text));
ok('appropriation → numeric stat + [2] marker captured', apprUnit &&
  (apprUnit.numbers || []).some(n => /\$\s?3\s?billion/i.test(n)) && apprUnit.marker === '[2]');

const bq = find(u => u.quote === 'the committee rejected the amendment on a 6-3 vote');
ok('blockquote → kind quote', bq && bq.kind === 'quote' && bq.blockType === 'paragraph');

// --- list items mined; table rows mined row-wise; separator dropped ---
ok('list item 12% gain → numeric', find(u => u.blockType === 'list_item' && /12%/.test(u.text) && u.kind === 'numeric'));
const tableUnits = units.filter(u => u.blockType === 'table');
ok('table separator row dropped (no --- row)', !tableUnits.some(u => /---/.test(u.text)));
ok('table data rows mined as numeric (North/South Fork %)', tableUnits.filter(u => u.kind === 'numeric').length === 2,
  JSON.stringify(tableUnits.map(u => u.text)));

// --- determinism: same input → identical output ---
const again = extractUnits(wc);
ok('deterministic (re-run identical)', JSON.stringify(again.units) === JSON.stringify(units));

// --- includeBareClaims widens to declarative prose ---
const withClaims = extractUnits(wc, { includeBareClaims: true });
ok('includeBareClaims surfaces the narration sentence as claim',
  withClaims.units.some(u => /ordinary narration/.test(u.text) && u.kind === 'claim'));
ok('includeBareClaims is a superset', withClaims.units.length > units.length);

// ---- reference/endnote section: a source table, NOT claim material --------------------------
// Shapes taken from real studio documents: bullet endnotes with positional ordinals (markdown
// path), and "**1 **"-prefixed paragraphs trailed by an author bio (the docx-conversion path).

const bulletDoc = importText([
  '# Nevada Should Vote Yes on Question 7',
  '',
  'Question 7 first passed with about 73% support in 2024.[1]',
  '',
  'Florida strengthened its photo ID law in 2005.[2] Turnout did not decline.',
  '',
  '- The Nevada Independent, "Tracking 2026 ballot measures" (https://thenevadaindependent.com/article/tracking)',
  '- Florida Division of Elections, "Voter ID at the Polls" (https://soe.dos.state.fl.us/pdf/voter-id.pdf)',
  '- Ballotpedia, "Voter turnout in Florida" (https://ballotpedia.org/Voter_turnout_in_Florida)',
].join('\n'), { format: 'md' });

const bulletRes = extractUnits(bulletDoc);
const bulletRefs = VE.findReferenceSection(bulletDoc.blocks);
ok('bullet endnote list detected as reference section', !!bulletRefs && bulletRefs.entries[1] && bulletRefs.entries[3]);
ok('reference entries are NOT mined as units',
  !bulletRes.units.some(u => /thenevadaindependent|ballotpedia\.org/i.test(u.text)),
  JSON.stringify(bulletRes.units.map(u => u.text.slice(0, 40))));
ok('body claims survive the reference cut', bulletRes.units.length === 2, JSON.stringify(bulletRes.units.map(u => u.uid)));
// The whole point: "[2]" must dereference to endnote 2, not endnote 1 or 3.
const u2 = bulletRes.units.find(u => u.marker === '[2]');
ok('marker [2] dereferenced to the SECOND endnote url',
  u2 && u2.url === 'https://soe.dos.state.fl.us/pdf/voter-id.pdf' && u2.refOrdinal === 2, u2 && u2.url);
const u1 = bulletRes.units.find(u => u.marker === '[1]');
ok('marker [1] dereferenced to the FIRST endnote url',
  u1 && /thenevadaindependent/.test(u1.url) && u1.refOrdinal === 1, u1 && u1.url);
ok('summary reports dereference count', bulletRes.summary.markersDereferenced === 2 && bulletRes.summary.referenceEntries === 3,
  JSON.stringify(bulletRes.summary));

// docx shape: numbered "**1 **" paragraphs, with a trailing author bio that is NOT a reference.
const docxDoc = importText([
  'Beijing built a blueprint over two decades.',
  '',
  'China emitted approximately 3.7 billion tons in the 1990s.',
  '',
  '**1 **State Armor, \'ELI and Communist China\' https://statearmor.org/eli-report',
  '',
  '**2 **ELI website on CIBDEG. https://www.eli.org/cibdeg',
  '',
  '**3 **China emissions per EDGAR 2025. https://www.worldometers.info/co2-emissions/',
  '',
  '_Russ Walker is Executive Director of the Rainey Freedom Project._',
].join('\n'), { format: 'md' });

const docxRefs = VE.findReferenceSection(docxDoc.blocks);
ok('"**1 **"-numbered paragraph endnotes detected', !!docxRefs && Object.keys(docxRefs.entries).length === 3,
  JSON.stringify(docxRefs && docxRefs.entries));
ok('explicit printed ordinals win over position', docxRefs && /statearmor/.test(docxRefs.entries[1].url) && /worldometers/.test(docxRefs.entries[3].url));
const docxUnits = extractUnits(docxDoc).units;
ok('trailing author bio is NOT swallowed by the reference run',
  docxRefs.endIndex === docxDoc.blocks.length - 2, `endIndex=${docxRefs && docxRefs.endIndex} of ${docxDoc.blocks.length}`);
ok('endnote paragraphs not mined as claims', !docxUnits.some(u => /statearmor|worldometers/i.test(u.text)));

// --- an UNLINKED leading endnote must still be counted (off-by-one guard) ------------------
// Observed live in the SNAP op-ed: note 1 was an unlinked poll ("as provided"), so a url-per-block
// run started at note 2 and every positional ordinal shifted by one — a polling claim resolved to a
// USDA fraud page. A wrong source is worse than none: the judge reads a real passage and returns a
// confident verdict about an unrelated one.
const unlinkedFirst = importText([
  'The survey of 1,002 registered voters finds the policy is popular.[1]',
  '',
  'The program costs taxpayers roughly $100 billion a year.[2]',
  '',
  '- Rainey Center national poll of 1,002 registered voters (as provided; no public release).',
  '- Food and Nutrition Administration (USDA), "SNAP Fraud Prevention" (https://www.fna.usda.gov/snap/fraud)',
  '- Fox News, "Food-stamp fraud numbers" (https://www.foxnews.com/politics/food-stamp-fraud)',
].join('\n'), { format: 'md' });
const ufRefs = VE.findReferenceSection(unlinkedFirst.blocks);
ok('unlinked FIRST endnote is part of the reference section', ufRefs && Object.keys(ufRefs.entries).length === 3,
  JSON.stringify(ufRefs && ufRefs.entries));
ok('ordinal 1 is the UNLINKED entry, not the first linked one',
  ufRefs && /Rainey Center/.test(ufRefs.entries[1].text) && ufRefs.entries[1].url === null,
  JSON.stringify(ufRefs && ufRefs.entries[1]));
const ufUnits = extractUnits(unlinkedFirst).units;
const uf2 = ufUnits.find(u => u.marker === '[2]');
ok('[2] resolves to USDA (no off-by-one shift)', uf2 && /fna\.usda\.gov/.test(uf2.url || ''), uf2 && uf2.url);
const uf1 = ufUnits.find(u => u.marker === '[1]');
ok('[1] stays UNRESOLVED rather than citing the wrong source', uf1 && !uf1.url, uf1 && uf1.url);

// --- no false positives: a document with no reference list keeps every unit ---
const proseDoc = importText([
  'The agency reported a 12% increase this year.',
  '',
  'Officials cited https://gao.gov/report.pdf as the basis for the finding.',
  '',
  'The committee will meet again in March.',
].join('\n'), { format: 'md' });
ok('single trailing linked paragraph is NOT a reference section', VE.findReferenceSection(proseDoc.blocks) === null);
ok('prose doc keeps its linked unit', extractUnits(proseDoc).units.some(u => /gao\.gov/.test(u.url || '')));

// --- opt-out restores the old behaviour ---
ok('mineReferences:true re-mines the endnote list',
  extractUnits(bulletDoc, { mineReferences: true }).units.length > bulletRes.units.length);

// --- author-year markers have no ordinal and must not mis-dereference ---
ok('author-year marker yields no ordinal', VE.markerOrdinal('[Smith, 2019]') === null && VE.markerOrdinal('(GAO, 2021)') === null);
ok('numeric marker ordinal parsed', VE.markerOrdinal('[7]') === 7 && VE.markerOrdinal('[3-5]') === 3);

// --- empty / garbage inputs ---
ok('empty working copy → no units', extractUnits({ blocks: [] }).units.length === 0);
ok('null working copy → no units, no throw', extractUnits(null).units.length === 0);
ok('findReferenceSection tolerates junk', VE.findReferenceSection(null) === null && VE.findReferenceSection([]) === null);

// --- CLAIM SELECTION (live defects, 2026-07-23) -------------------------------------------------
// All three were found by extracting the real Arizona ESA op-ed, not by reading the code.

// 1) A citation marker must not weld two sentences into one unit. The terminator class allowed ONE
// optional closing char, so "[1]" (three chars) blocked every split after a cited sentence — and the
// judge was handed a claim fused to whatever followed it. Live cost: "Nobody serious defends ESA
// dollars going to diamond rings.[4]", which its source supports outright, was fused with the
// argument sentence after it and the whole unit came back NOT SUPPORTED.
{
  const s = VE.splitSentences('Proficiency is below average.[1] Only 26 percent read at grade level. Only 25 percent of eighth graders do.');
  ok('a marker does not fuse the next sentence into the claim', s.length === 3, JSON.stringify(s));
  ok('the marker stays with the sentence it cites', /\[1\]$/.test(s[0]) && !/\[1\]/.test(s[1]), JSON.stringify(s));
  const multi = VE.splitSentences('Costs rose sharply.[2,3] The board disagreed.');
  ok('multi-ordinal markers split too', multi.length === 2 && /\[2,3\]$/.test(multi[0]), JSON.stringify(multi));
  // …without breaking an ordinary bracketed sentence or a decimal.
  ok('a bare bracket is still not a split point', VE.splitSentences('See figure [a] for detail. Then continue.').length === 2);
}

// 2) A note covers the sentences that DEPEND on it. Authors mark the first of a run; the rest
// inherit. Footnote 1 on the op-ed is explicitly a source for fourth AND eighth grade, yet "Only 25
// percent of eighth graders do." was reported to the author as carrying no citation at all.
{
  const doc = { blocks: [
    { anchor: 'a1', type: 'paragraph', text: 'Reading proficiency is below average.[1] Only 26 percent read at grade level. Only 25 percent of eighth graders do.' },
    { anchor: 'a2', type: 'paragraph', text: 'Spending rose 12 percent last year.' },
    { anchor: 'r1', type: 'list_item', text: '1. NAEP results, https://nationsreportcard.gov/x' },
    { anchor: 'r2', type: 'list_item', text: '2. Budget office, https://budget.example/y' },
  ] };
  const u = extractUnits(doc).units;
  const byUid = Object.fromEntries(u.map(x => [x.uid, x]));
  ok('the marked sentence keeps its own marker', byUid['a1.s0'] && byUid['a1.s0'].marker === '[1]');
  ok('a later sentence in the SAME paragraph inherits the citation',
    byUid['a1.s2'] && byUid['a1.s2'].url === 'https://nationsreportcard.gov/x', JSON.stringify(u.map(x => [x.uid, x.url, x.inheritedMarker])));
  ok('an inherited citation is RECORDED as inherited, never passed off as the claim\'s own',
    byUid['a1.s2'].inheritedMarker === '[1]' && !byUid['a1.s2'].marker);
  ok('inheritance STOPS at the paragraph edge (a citation does not cross a block)',
    byUid['a2.s0'] && !byUid['a2.s0'].url && !byUid['a2.s0'].inheritedMarker, JSON.stringify(byUid['a2.s0']));
}

// 3) Inheritance supplies a SOURCE; it must never manufacture a unit. A signal-less sentence after a
// cited one stays out of the audit — otherwise every line of argument following a citation would be
// dragged in and judged against a source that was never meant to cover it.
{
  const doc = { blocks: [
    { anchor: 'a1', type: 'paragraph', text: 'Fraud cost the program 4 percent.[1] But eligibility and fraud are different problems entirely.' },
    { anchor: 'r1', type: 'list_item', text: '1. Auditor report, https://audit.example/a' },
    { anchor: 'r2', type: 'list_item', text: '2. Other, https://other.example/b' },
  ] };
  const u = extractUnits(doc).units;
  ok('an argument sentence after a citation is not mined as a claim',
    u.length === 1 && u[0].uid === 'a1.s0', JSON.stringify(u.map(x => [x.uid, x.text])));
}

// 4) A statistic written in words is still a statistic. Every numeric pattern keyed on a DIGIT, so
// the op-ed's own restatement of its headline figure was not a unit at all.
{
  ok('spelled-out ratios are detected', VE.detectNumbers('is failing three out of every four students in reading').length === 1);
  ok('digit ratios too', VE.detectNumbers('roughly 1 in 5 households qualify').length >= 1);
  ok('ordinary prose does not trip the ratio pattern',
    VE.detectNumbers('one of the reasons cited in the report was staffing').length === 0);
  ok('a ratio makes the sentence a verification unit', extractUnits({ blocks: [
    { anchor: 'a1', type: 'paragraph', text: 'The system is failing three out of every four students in reading.' },
  ] }).units.length === 1);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
