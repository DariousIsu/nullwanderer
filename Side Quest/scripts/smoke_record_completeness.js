/* Smoke: lib/record_completeness — measure a record's completeness by READING it (real data points vs
 * "not found"), NOT by length. The fix this proves: a long record full of "not found" must NOT outrank a
 * shorter record that's actually filled. Pure. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_record_completeness.js
 */
'use strict';
const rc = require('../lib/record_completeness');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const full = { heading: 'Full Org', body: '- **Key people:** Jane Doe – President; Robert Lang – Director of Policy\n- **Contact:** jane@full.org / 202-555-1212 / https://full.org/team' };
const sparse = { heading: 'Sparse Org', body: '- **Key people:** not found\n- **Contact:** not found' };
// LONGER than `full` but empty — the length-trap the old patch fell into.
const longEmpty = { heading: 'Long Empty', body: '- **Focus:** ' + 'general policy advocacy and research '.repeat(12) + '\n- **Key people:** not found\n- **Contact:** not found\n- **Funding:** not found' };

const sFull = rc.scoreSection(full), sSparse = rc.scoreSection(sparse), sLong = rc.scoreSection(longEmpty);
ok(sFull.dataPoints >= 3, 'filled record → multiple data points (email + url + phone + person)');
ok(sSparse.dataPoints === 0 && sSparse.notFound >= 2, 'sparse record → 0 data points, counts the "not found"s');
ok(sLong.dataPoints === 0 && sLong.notFound >= 3, 'long-but-empty record → 0 data points despite its length');
ok(sLong.size > sFull.size, 'sanity: the empty record is genuinely LONGER than the filled one');

// THE point: completeness ranks by real data, not length.
const ranked = rc.rankByCompleteness([sparse, longEmpty, full]);
ok(ranked[0].heading === 'Full Org', 'most complete = the FILLED record (beats the longer empty one)');
ok(ranked[ranked.length - 1].dataPoints === 0, 'least complete sorts last');

// ratio: a clean filled record scores higher ratio than one with many gaps
const mixed = { heading: 'Mixed', body: '- **Key people:** Amy Stone – VP\n- **Contact:** not found; not found; not found' };
ok(rc.scoreSection(mixed).ratio < 1 && rc.scoreSection(mixed).ratio > 0, 'a partially-filled record → ratio strictly between 0 and 1');

// coverage summary surfaces the thin records (the gaps)
const cov = rc.coverageSummary([full, sparse, longEmpty]);
ok(cov.count === 3 && cov.totalData >= 3, 'coverageSummary totals the data points across records');
ok(cov.thin.includes('Sparse Org') && cov.thin.includes('Long Empty') && !cov.thin.includes('Full Org'), 'coverageSummary flags the THIN records, not the filled one');

ok(rc.scoreSection(null).dataPoints === 0, 'null section → 0 (fail-safe)');
ok(rc.rankByCompleteness([]).length === 0, 'empty input → [] (fail-safe)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
