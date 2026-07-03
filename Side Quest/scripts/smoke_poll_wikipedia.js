/**
 * Offline smoke for lib/poll_wikipedia.js — the Wikipedia poll-table parser (Suite-A adapter #1).
 * Fixtures mirror the REAL structure of "Opinion polling on the second Trump presidency" tables:
 * linked pollster cells, "Month D–D, YYYY" date ranges, "N (A/LV/RV)" samples, "±x%" MoE, percent
 * cells with [ref] markers, an RCP-average aggregate row, and a colspan section banner (skip+count).
 *
 * Run: node scripts/smoke_poll_wikipedia.js
 */
const W = require('../lib/poll_wikipedia');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

// --- unit: field parsers ---
eq('parsePct percent', W.parsePct('56%<sup>[3]</sup>'), 56);
eq('parsePct decimal', W.parsePct('40.5 %'), 40.5);
eq('parsePct unicode-minus net', W.parsePct('−15'), -15);
eq('parsePct empty', W.parsePct('—'), null);
eq('parseSample A', W.parseSample('1,002 (A)'), { sample_size: 1002, population: 'a' });
eq('parseSample LV', W.parseSample('800 (LV)'), { sample_size: 800, population: 'lv' });
eq('parseSample words', W.parseSample('1,500 registered voters'), { sample_size: 1500, population: 'rv' });
eq('parseMoe', W.parseMoe('± 3.5%'), 3.5);
eq('date same-month range', W.parseDateRange('July 7–21, 2026'), { start_date: '2026-07-07', end_date: '2026-07-21' });
eq('date cross-month range', W.parseDateRange('June 30 – July 2, 2026'), { start_date: '2026-06-30', end_date: '2026-07-02' });
eq('date single day', W.parseDateRange('July 21, 2026'), { start_date: '2026-07-21', end_date: '2026-07-21' });
eq('date ISO passthrough', W.parseDateRange('2026-07-21'), { start_date: '2026-07-21', end_date: '2026-07-21' });
const ps = W.parsePollster('<a href="https://x.com/g">Gallup</a>');
eq('pollster link + url', [ps.pollster, ps.url], ['Gallup', 'https://x.com/g']);
eq('pollster slash sponsor', (() => { const p = W.parsePollster('YouGov/The Economist'); return [p.pollster, p.sponsor]; })(), ['YouGov', 'The Economist']);

// --- integration: an approval table ---
const APPROVAL = `
<table class="wikitable sortable">
<tr><th>Pollster</th><th>Date(s) administered</th><th>Sample size</th><th>Margin of error</th><th>Approve</th><th>Disapprove</th><th>No opinion</th><th>Net approval</th></tr>
<tr><td><a href="https://insideradvantage.com">InsiderAdvantage</a></td><td>July 7–21, 2026</td><td>800 (RV)</td><td>±3.5%</td><td>56%<sup>[1]</sup></td><td>39%</td><td>5%</td><td>+17</td></tr>
<tr><td><a href="/wiki/Gallup">Gallup</a></td><td>June 30 – July 2, 2026</td><td>1,002 (A)</td><td>±4%</td><td>40%</td><td>55%</td><td>5%</td><td>−15</td></tr>
<tr><td>RCP Average</td><td>July 2026</td><td>—</td><td>—</td><td>47%</td><td>49%</td><td>4%</td><td>−2</td></tr>
</table>`;

const a = W.parseTable(APPROVAL, { subject: 'Donald Trump', poll_type: 'approval' });
ok('approval: 3 rows parsed', a.polls.length === 3, `got ${a.polls.length}`);
ok('approval: 0 skipped', a.skipped === 0, `skipped ${a.skipped}`);
const g = a.polls.find((p) => p.pollster === 'Gallup');
ok('approval: Gallup found', !!g);
eq('approval: Gallup dates', [g.start_date, g.end_date], ['2026-06-30', '2026-07-02']);
eq('approval: Gallup sample/pop', [g.sample_size, g.population], [1002, 'a']);
eq('approval: Gallup moe', g.moe_pct, 4);
eq('approval: Gallup url', g.url, '/wiki/Gallup');
eq('approval: Gallup answers', g.answers, [{ choice: 'Approve', pct: 40 }, { choice: 'Disapprove', pct: 55 }, { choice: 'No opinion', pct: 5 }]);
ok('approval: Net column NOT an answer', !g.answers.some((x) => /net/i.test(x.choice)));
ok('approval: source_kind+tier tagged', g.source_kind === 'wikipedia' && g.tier === 'free');
ok('approval: subject+poll_type carried', g.subject === 'Donald Trump' && g.poll_type === 'approval');
ok('approval: stable source_id', g.source_id === 'wikipedia-approval-donald-trump-gallup-2026-06-30-2026-07-02', g.source_id);
const rcp = a.polls.find((p) => /rcp/i.test(p.pollster));
ok('approval: aggregate row flagged is_aggregate', rcp && rcp.is_aggregate === true);
ok('approval: real pollster NOT aggregate', g.is_aggregate === false);

// --- integration: head-to-head (answer columns = candidate names) ---
const HORSERACE = `
<table class="wikitable">
<tr><th>Poll source</th><th>Date(s)</th><th>Sample</th><th>Margin of error</th><th>Smith (D)</th><th>Jones (R)</th><th>Undecided</th></tr>
<tr><td>Emerson College</td><td>July 10–12, 2026</td><td>1,000 (LV)</td><td>±3%</td><td>48%</td><td>45%</td><td>7%</td></tr>
</table>`;
const h = W.parseTable(HORSERACE, { subject: '2026 Florida', poll_type: 'us-senator' });
ok('horse-race: 1 row', h.polls.length === 1);
eq('horse-race: candidate answers', h.polls[0].answers, [{ choice: 'Smith (D)', pct: 48 }, { choice: 'Jones (R)', pct: 45 }, { choice: 'Undecided', pct: 7 }]);
eq('horse-race: population LV', h.polls[0].population, 'lv');

// --- span rows are skipped AND counted (no silent drop) ---
const WITHBANNER = `
<table class="wikitable">
<tr><th>Pollster</th><th>Date(s) administered</th><th>Sample size</th><th>Approve</th><th>Disapprove</th></tr>
<tr><td colspan="5">2026 second-quarter polling</td></tr>
<tr><td>Quinnipiac</td><td>May 1–4, 2026</td><td>1,200 (RV)</td><td>44%</td><td>52%</td></tr>
</table>`;
const b = W.parseTable(WITHBANNER, { subject: 'Donald Trump', poll_type: 'approval' });
ok('banner: 1 data row parsed', b.polls.length === 1, `got ${b.polls.length}`);
ok('banner: 1 colspan row skipped+counted', b.skipped === 1, `skipped ${b.skipped}`);

// --- parsePage: multi-table page with explicit table map ---
const PAGE = APPROVAL + '\n' + HORSERACE;
const pg = W.parsePage(PAGE, { subject: 'Donald Trump', tables: [{ poll_type: 'approval' }, { poll_type: 'us-senator', subject: '2026 Florida' }] });
ok('page: found 2 tables', pg.tableCount === 2, `tableCount ${pg.tableCount}`);
ok('page: 4 polls total', pg.polls.length === 4, `got ${pg.polls.length}`);
ok('page: per-table subject override', pg.polls.some((p) => p.subject === '2026 Florida' && p.poll_type === 'us-senator'));

// --- fail-soft ---
eq('empty html → no polls', W.parsePage('').polls, []);
eq('garbage → no throw', W.parseTable('<table class="wikitable"><tr><td>x</td></tr></table>').polls, []);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
