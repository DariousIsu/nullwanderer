/* Smoke: lib/news_brief — the consistent, schema-locked news-brief document. Proves the grounded input
 * shaping, the instruction/contract content, the validator, the deterministic fallback + renderer (fixed
 * formatting, sources from OUR data, developing lines, "Also Tracking"), anti-confabulation (unknown
 * model ids dropped), and generateBrief's cloud/fallback paths. PURE — no DB/network. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_brief.js
 */
'use strict';
const b = require('../lib/news_brief');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const S = (id, title, sc, uc, summary, sources, opts = {}) => {
  const outlets = opts.outlets || sources;
  const reports = opts.reports || outlets;   // default: fixture outlets are independent reports (opts.reports overrides for syndication)
  return { id, title, source_count: sc, update_count: uc, summary, source_set: new Set(sources),
    outlet_set: new Set(outlets), outlet_count: outlets.length,
    report_set: new Set(reports), report_count: reports.length,
    redaction: opts.redaction ? 1 : 0, redaction_note: opts.redaction || null };
};
const stories = [
  S(1, 'Russian attack on Kyiv kills at least 18', 3, 2, 'A large-scale strike hit the capital; the mayor declared mourning.', ['BBC', 'CNN', 'NBC News'], { outlets: ['BBC', 'CNN', 'NBC News', 'NYT', 'WaPo'] }),
  S(2, 'Google loses €4.7B EU antitrust appeal', 2, 1, 'The court upheld the Android penalty.', ['Reuters', 'US News'], { redaction: 'correction' }),
  S(3, 'US-Iran talks resume in Qatar', 2, 1, 'Indirect negotiations focused on the Strait of Hormuz.', ['CBS', 'Bloomberg']),
  S(4, 'Heat wave threatens July 4 weekend', 1, 1, 'Records could fall across the US.', ['The Hill']),
  S(5, 'Lithuania scraps nuclear-weapons ban', 1, 1, 'Lawmakers lifted the constitutional prohibition.', ['NPR']),
  S(6, 'Gas-station heroin crackdown announced', 1, 1, 'New restrictions on 7-OH products.', ['NewsLive']),
  S(7, 'Markets rally on AI optimism', 1, 1, 'Indexes climbed.', ['CNBC']),
  S(8, 'Storm system develops in the Atlantic', 1, 1, 'Forecasters watching.', ['NOAA']),
];
const deltasByStory = { 1: [{ title: 'At least 13 killed in Kyiv', kind: 'born' }, { title: 'Toll rises to 17', kind: 'update' }, { title: 'At least 18 killed', kind: 'update' }] };

// --- briefInput ---
const input = b.briefInput(stories, { deltasByStory, top: 12 });
ok(input.length === 8 && input[0].id === 1, 'briefInput keeps stories (capped) with ids');
ok(Array.isArray(input[0].sources) && input[0].sources.includes('BBC'), 'briefInput lifts sources from the source_set');
ok(input[0].developing === true && input[3].developing === false, 'briefInput marks developing from update_count');
ok(input[0].priorHeadlines.length === 3 && /18/.test(input[0].priorHeadlines[2]), 'briefInput carries the delta trail (prior headlines)');
ok(b.briefInput(stories, { top: 3 }).length === 3, 'briefInput honors the top cap');
ok(input[0].outletCount === 5 && input[0].reportCount === 5 && input[0].corroboration === 'widely reported' && input[1].redaction === true, 'briefInput carries confirmation (reportCount, outletCount, corroboration tier, redaction)');
// syndication: a widely-REPUBLISHED single report has high reach but is NOT "widely reported"
const synIn = b.briefInput([S(99, 'Wire story republished everywhere', 6, 1, 'One AP report.', ['AP'], { outlets: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'], reports: ['one'] })]);
ok(synIn[0].outletCount === 6 && synIn[0].reportCount === 1 && synIn[0].corroborationCount === 1 && synIn[0].syndicated === true && synIn[0].corroboration === '', 'briefInput: 6-outlet reach but 1 report → syndicated, corroboration blank (NOT widely reported)');
// single-outlet inflation guard: 1 outlet with 10 distinct-headline articles → corroboration min(1,10)=1
const soIn = b.briefInput([S(98, 'One paper, many archive articles', 1, 1, 'Archive cluster.', ['The Paper'], { outlets: ['The Paper'], reports: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9', 'h10'] })]);
ok(soIn[0].reportCount === 10 && soIn[0].outletCount === 1 && soIn[0].corroborationCount === 1 && soIn[0].corroboration === '', 'briefInput: 1 outlet / 10 headlines → corroboration min(1,10)=1, NOT widely reported');

// --- instructions + contract ---
ok(/Ground every sentence/i.test(b.SYSTEM) && /NEVER invent or name sources/i.test(b.SYSTEM) && /Reference each story by its given "id"/i.test(b.SYSTEM), 'SYSTEM carries the grounding + no-source-invention + id-reference rules');
ok(/single JSON object/i.test(b.briefWant()) && /"edition"/.test(b.briefWant()) && /"developing"/.test(b.briefWant()), 'briefWant states the JSON contract');

// --- validator ---
ok(b.briefValidator('{"edition":"x","stories":[]}').valid === true, 'validator accepts a well-formed object');
ok(b.briefValidator('prose {"edition":"x","stories":[{"id":1,"summary":"y"}]} trailing').valid === true, 'validator extracts JSON embedded in prose');
ok(b.briefValidator('{"edition":"x"}').valid === false, 'validator rejects a missing stories[]');
ok(b.briefValidator('not json').valid === false, 'validator rejects non-JSON');

// --- fallback ---
const fb = b.fallbackBrief(input);
ok(fb.stories.length === 8 && fb.stories[0].summary === input[0].snippet, 'fallbackBrief uses the grounded snippet as summary');
ok(fb.stories[0].developing && /updates/.test(fb.stories[0].developing), 'fallbackBrief notes developing from the delta count');

// --- renderer: fixed formatting ---
const model = { edition: 'A tense global hour: war in Ukraine, an EU antitrust ruling, and renewed US-Iran talks.', stories: input.map((s) => ({ id: s.id, summary: `Grounded summary of "${s.headline}".`, developing: s.developing ? 'The reported toll rose across updates.' : null })) };
const md = b.renderBrief(model, input, { windowLabel: 'the last hour', nowIso: '2026-07-02T12:00:00Z' });
ok(/^# 📰 News Brief — the last hour/.test(md), 'renders the fixed header + window label');
ok(/8 stories tracked/.test(md), 'header shows the tracked-story count');
ok(/\*\*A tense global hour/.test(md), 'renders the edition line');
ok(/### 1\. Russian attack on Kyiv/.test(md) && /\*\*Reporting:\*\* BBC, CNN, NBC News/.test(md), 'top story: numbered headline + attribution from OUR data (outlets)');
ok(/widely reported — 5 reports/.test(md), 'CONFIRMATION: corroboration tier + independent-report count rendered from our data');
ok(/> ⚠ \*\*Integrity:\*\* a source has issued a correction/.test(md), 'CONFIRMATION: a redaction/correction is flagged on the story');
ok(/> \*\*Developing:\*\* The reported toll rose/.test(md), 'developing story gets a Developing line');
ok(/## Also Tracking/.test(md) && /- Markets rally on AI optimism — 1 report/.test(md), 'stories beyond topN go to Also Tracking');
ok(b.renderBrief(model, input, { nowIso: 'x' }) === b.renderBrief(model, input, { nowIso: 'x' }), 'renderer is deterministic (same input → same output)');

// --- anti-confabulation: a model story id absent from input is DROPPED ---
const ghosted = { edition: '', stories: [{ id: 1, summary: 'real' }, { id: 9999, summary: 'INVENTED story not in input' }] };
const md2 = b.renderBrief(ghosted, input, { nowIso: 'x' });
ok(!/INVENTED/.test(md2) && /Russian attack on Kyiv/.test(md2), 'renderer drops a story id the model invented (not in input)');

// --- generateBrief: cloud path (mocked ask) + fallback path ---
(async () => {
  const ask = async ({ input: inp }) => ({ edition: 'Cloud edition line.', stories: inp.map((s) => ({ id: s.id, summary: `Cloud summary ${s.id}.`, developing: null })) });
  const g1 = await b.generateBrief({ stories, deltasByStory, ask, nowIso: 'x' });
  ok(g1.viaCloud === true && /Cloud summary 1\./.test(g1.markdown), 'generateBrief uses the cloud fill when ask succeeds');

  const g2 = await b.generateBrief({ stories, deltasByStory, ask: null, nowIso: 'x' });
  ok(g2.viaCloud === false && /News Brief/.test(g2.markdown), 'generateBrief falls back deterministically when no cloud');

  const g3 = await b.generateBrief({ stories, ask: async () => { throw new Error('cloud down'); }, nowIso: 'x' });
  ok(g3.viaCloud === false && /News Brief/.test(g3.markdown), 'generateBrief falls back when the cloud throws (a brief ALWAYS renders)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
