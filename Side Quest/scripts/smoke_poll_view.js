/**
 * Offline smoke for the Polling view model (studio/poll_view.js): pure mappers over the REAL
 * polling tool shapes captured live (2026-06-25 — F13 "March Political Survey" + the issue feed).
 *
 * Run: node scripts/smoke_poll_view.js
 */
const PV = require('../studio/poll_view');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// --- real fixtures ---
const LIST = { result: [
  { fielding_id: 'F15', title: 'May Political Survey', fielded_start: '2026-05-15', sample_size: 1010, frame: 'LV', source_kind: 'rainey', meta: { question_count: 0, topline_count: 0, crosstab_count: 0, file_count: 0 } },
  { fielding_id: 'X538-trump-1', title: 'Trump approval', fielded_start: '2025-01-30', sample_size: 1500, frame: 'A', source_kind: '538', meta: { question_count: 1, topline_count: 2, crosstab_count: 0, file_count: 0 } },
] };
const F13 = {
  fielding_id: 'F13', title: 'March Political Survey', fielded_start: '2026-03-23', fielded_end: '2026-03-26',
  sample_size: 1021, frame: 'RV', moe_pct: 3.2, mode: 'online_panel', vendor: 'Bedrock Polling',
  sponsor: 'Joseph Rainey Center for Public Policy', weighting: '2024 vote, gender, age, race, education',
  themes: 'Democracy / Elections, Multi-topic Omnibus', notes: 'news-consumption, 2024 vote recall…', source_kind: 'rainey', pollster: null,
  meta: { question_count: 115, topline_count: 400, crosstab_count: 0, file_count: 2 },
  files: [
    { file_id: 18, role: 'crosstabs', source_pdf_path: 'C:\\x\\2026-03_Rainey_March_Political_Survey_Crosstabs.pdf', page_count: 90 },
    { file_id: 19, role: 'toplines', source_pdf_path: 'C:\\x\\2026-03_Rainey_March_Political_Survey_Toplines.pdf', page_count: 11 },
  ],
  open_issues: [],
  questions: [
    { question_id: 1009, question_number: '3', wording: 'Is the border more secure now than when Biden was President?', concept_id: null, options: [
      { option_id: 4801, ordinal: 0, label: 'More secure now', is_net: 0, pct: 54 },
      { option_id: 4802, ordinal: 1, label: 'More secure when Biden', is_net: 0, pct: 21 },
      { option_id: 4803, ordinal: 2, label: 'Not sure', is_net: 0, pct: 26 },
    ] },
    { question_id: 1024, question_number: '18', wording: 'Do you feel taxes take too much of your paycheck?', concept_id: null, options: [
      { option_id: 4865, ordinal: 0, label: 'Yes', is_net: 0, pct: 82 },
      { option_id: 4866, ordinal: 1, label: 'No', is_net: 0, pct: 18 },
    ] },
  ],
};
const ISSUES = { result: [
  { issue_id: 8, fielding_id: 'F03', source_path: 'C:\\x\\Rainey_Climate_Toplines.pdf', severity: 'warn', kind: 'codemap_mismatch', detail: 'sample_size: PDF=488 vs CODEMAP=1061', created_at: 1, resolved_at: null },
  { issue_id: 6, fielding_id: 'F11', source_path: 'C:\\x\\Crosstabs.pdf', severity: 'error', kind: 'pdf_corrupt', detail: 'markdown_chars=0', created_at: 1, resolved_at: null },
] };

// --- fielding list ---
{
  const items = PV.fieldingList(LIST);
  ok('list: one item per fielding', items.length === 2);
  ok('list: maps id/title/date/sample', items[0].id === 'F15' && items[0].title === 'May Political Survey' && items[0].sampleSize === 1010);
  ok('list: source label resolved', items[0].sourceLabel === 'Rainey' && items[1].sourceLabel === '538');
  ok('list: question count from meta', items[1].questionCount === 1);
  const only538 = PV.fieldingList(LIST, { source: '538' });
  ok('list: source filter', only538.length === 1 && only538[0].source === '538');
}

// --- fielding card ---
{
  const c = PV.fieldingCard(F13);
  ok('card: id/title', c.id === 'F13' && c.title === 'March Political Survey');
  ok('card: date range collapses start–end', c.dateRange === '2026-03-23 – 2026-03-26');
  ok('card: methodology fields', c.sampleSize === 1021 && c.moe === 3.2 && c.frame === 'RV' && c.frameLabel === 'Registered voters' && c.mode === 'online_panel');
  ok('card: pollster falls back to vendor', c.pollster === 'Bedrock Polling');
  ok('card: files basename + pages', c.files.length === 2 && c.files[0].name === '2026-03_Rainey_March_Political_Survey_Crosstabs.pdf' && c.files[0].pages === 90);
  ok('card: counts from meta', c.counts.questions === 115 && c.counts.toplines === 400 && c.counts.files === 2);
  ok('card: source label', c.sourceLabel === 'Rainey');
}

// --- topline bars ---
{
  const v = PV.pollView(F13);
  ok('pollView: card + questions', !!v.card && v.questions.length === 2);
  const q = v.questions[0];
  ok('bars: wording + number', q.number === '3' && /border more secure/.test(q.wording));
  ok('bars: option per row, pct text', q.options.length === 3 && q.options[0].pctText === '54%');
  ok('bars: sorted by ordinal', q.options[0].label === 'More secure now' && q.options[2].label === 'Not sure');
  ok('bars: max option flagged + full width', q.options[0].isMax === true && q.options[0].width === 100);
  ok('bars: smaller option scaled to leader', q.options[1].width === Math.round((21 / 54) * 100));
  const q2 = v.questions[1];
  ok('bars: two-way 82/18 leader=Yes', q2.options[0].isMax === true && q2.options[0].pct === 82);
}

// --- net-option handling ---
{
  const netQ = PV.toplineBars({ question_id: 99, question_number: 'x', wording: 'w', options: [
    { ordinal: 0, label: 'Approve', is_net: 0, pct: 30 }, { ordinal: 1, label: 'Disapprove', is_net: 0, pct: 50 },
    { ordinal: 2, label: 'Net approve', is_net: 1, pct: -20 },
  ] });
  ok('bars: net row flagged', netQ.options.find(o => o.label === 'Net approve').isNet === true);
  ok('bars: leader ignores net rows', netQ.options[1].isMax === true && !netQ.options[2].isMax);
}

// --- issues ---
{
  const rows = ISSUES.result.map(PV.issueRow);
  ok('issues: severity → verdict class', rows[0].verdict === 'warn' && rows[1].verdict === 'bad');
  ok('issues: file basename', rows[0].file === 'Rainey_Climate_Toplines.pdf');
  ok('issues: open flag from resolved_at', rows[0].open === true);
  ok('issues: kind + detail carried', rows[1].kind === 'pdf_corrupt' && /markdown_chars=0/.test(rows[1].detail));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
