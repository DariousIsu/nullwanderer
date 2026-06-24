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

// --- empty / garbage inputs ---
ok('empty working copy → no units', extractUnits({ blocks: [] }).units.length === 0);
ok('null working copy → no units, no throw', extractUnits(null).units.length === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
