/* Smoke: lib/user_work — HIS WORK OUTRANKS THE SWEEP (the user-thread driver's pure brain).
 * Pins: research-shape filter, deadline parse anchored to thread BIRTH, news matching (2-token
 * topic rule), the ordering (deadline > news heat > recency), and the guidance addenda.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_user_work.js
 */
'use strict';
const uw = require('../lib/user_work');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const H = 3600e3, NOW = 1000 * H;

// --- research shape: the 8 live stranded threads must qualify; chatter must not ---
for (const c of ['substantiate that the grid was destined to fail without data centers',
  'identify cases where data centers improved rural grid infrastructure',
  'research how the AI program could be used to control a robot',
  'conduct deep research on Louisiana parishes for Lucas',
  'understand transmission and grid pressure needs for each power grid region']) {
  ok(uw.isResearchShaped(c), `research-shaped: "${c.slice(0, 50)}"`);
}
ok(!uw.isResearchShaped('thanks Zoe'), 'a social closer is not research');
ok(!uw.isResearchShaped('research this'), 'too short to be a task (needs 4+ words)');
ok(!uw.isResearchShaped('remember to say hi to Devon at the meeting'), 'a social commitment is not research');

// --- deadline parse: anchored to BIRTH, never re-anchored to now ---
const born = NOW - 2 * H;
ok(uw.parseDeadline('I need this report within an hour', born).dueTs === born + H, 'deadline anchors to when he SAID it');
ok(uw.parseDeadline('I need this report within an hour', born).kind === 'rush', 'within an hour = rush');
ok(uw.parseDeadline('you have the next 6 hours to work on this', born).kind === 'today', '6 hours = today-paced');
ok(uw.parseDeadline('need it asap', born).kind === 'rush', 'asap = rush');
ok(uw.parseDeadline('no rush on this one', born).dueTs === null, 'no rush = no due time');
ok(uw.parseDeadline('map the Louisiana parishes', born) === null, 'no deadline language → null');
ok(uw.parseDeadline('within 30 minutes please', born).dueTs === born + 30 * 60e3, 'minutes parse');

// --- news matching: 2 distinct tokens = a topic; 1 = coincidence ---
const heads = [
  { title: 'Data centers strain the Texas power grid', summary: 'ERCOT warns of transmission limits' },
  { title: 'Grid operators approve new transmission line', summary: 'rural infrastructure boost' },
  { title: 'Orange juice futures rally', summary: 'citrus season strong' },
];
const hits = uw.matchNewsToThread('understand transmission and grid pressure needs for each power grid region', heads);
ok(hits.length === 2, `grid/transmission thread matches 2 stories (got ${hits.length})`);
ok(!hits.some((h) => /juice/i.test(h.title)), 'orange juice never matches a grid thread');
ok(uw.matchNewsToThread('x', heads).length === 0, 'a threadbare thread matches nothing');
// boot122 first-fire regression: generic work-shape phrasing must never match news prose
ok(uw.matchNewsToThread('research and write on the provided topic over coming weeks',
  [{ title: 'Senate to vote in coming weeks', summary: 'over the next weeks lawmakers write the report' }]).length === 0,
  'CRITICAL: "over coming weeks"-style filler never matches (work-shape words are not topics)');

// --- the ordering: deadline > news heat > recency ---
const threads = [
  { id: 1, status: 'pending', action_count: 0, created_ts: NOW - 50 * H, content: 'research the history of Louisiana levee boards' },
  { id: 2, status: 'pending', action_count: 0, created_ts: NOW - 1 * H, content: 'identify cases where data centers improved rural grid infrastructure' },
  { id: 3, status: 'pending', action_count: 0, created_ts: NOW - 30 * H, content: 'compile a report on parish clerks — I need this report within an hour' },
  { id: 4, status: 'active', action_count: 3, created_ts: NOW, content: 'research something already being driven' },
  { id: 5, status: 'pending', action_count: 0, created_ts: NOW - 20 * H, content: 'help me think about my week' },
];
ok(uw.pickUserThread(threads, { now: NOW }).id === 3, 'a deadline (even overdue) outranks everything');
ok(uw.pickUserThread(threads.filter((t) => t.id !== 3), { now: NOW }).id === 2, 'no deadlines → the NEWEST ask wins (recency bias)');
ok(uw.pickUserThread(threads.filter((t) => t.id !== 3), { now: NOW, newsAtOf: (id) => (id === 1 ? NOW - H : 0) }).id === 1,
  'fresh news heat on an older thread outranks plain recency');
ok(uw.pickUserThread([threads[3]], { now: NOW }) === null, 'an already-driven thread is never re-picked (its driver owns it)');
ok(uw.pickUserThread([threads[4]], { now: NOW }) === null, 'a non-research commitment never steals the primary');
ok(uw.pickUserThread([], { now: NOW }) === null && uw.pickUserThread(null, { now: NOW }) === null, 'empty/null → null (the sweep may run)');

// --- the living document: a new task bounces off the doc a prior run landed ---
{
  const docs = [
    { id: 7, title: 'Research — US power grid and data center impacts', markdown: 'PJM interconnection queue transmission congestion…', openedAt: 100, source: 'research' },
    { id: 8, title: 'Research — grid pressure by region', markdown: 'transmission constraints and grid pressure in ERCOT', openedAt: 200, source: 'research' },
    { id: 9, title: 'random web capture about grids', markdown: 'grid transmission', openedAt: 300, source: 'web' },
  ];
  const hit = uw.matchDocToTopic('understand transmission and grid pressure needs for each power grid region', docs);
  ok(hit && hit.id === 8, `topic matches the strongest research doc (got #${hit && hit.id})`);
  ok(uw.matchDocToTopic('research the history of Louisiana levee boards', docs) === null, 'unrelated topic → null (a fresh document is right)');
  ok(uw.matchDocToTopic('grid stuff', [docs[2]]) === null, 'a non-research doc never anchors a run');
  ok(uw.matchDocToTopic('', docs) === null && uw.matchDocToTopic('x', null) === null, 'empty/null never throw');
}

// --- living-document POOL: recall reaches past the churned recency window (boot128: newest-40
// were 100% news/inquiry/downloads and the grid dossier could never match) ---
{
  const churn = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, title: `news item ${i}`, markdown: 'headline body', openedAt: 900 + i, source: 'news' }));
  const dossier = { id: 11530, title: 'Research — Deepen and EXPAND prior research', markdown: 'PJM grid operators… data centers drive interconnection queues…', openedAt: 50, source: 'research' };
  const recalls = [];
  const pool = uw.docPoolForTopic('substantiate that the grid was destined to fail without data centers', {
    candidates: () => churn,
    recall: (q) => { recalls.push(q); return q === 'grid' || q === 'data' ? [dossier] : []; },
  });
  ok(recalls.length >= 2 && recalls.includes('grid'), `recall rides per-token, never the sentence (asked: ${recalls.join(',')})`);
  const hit = uw.matchDocToTopic('substantiate that the grid was destined to fail without data centers', pool);
  ok(hit && hit.id === 11530, `a dossier outside the recency window still anchors the run (got #${hit && hit.id})`);
  ok(uw.docPoolForTopic('grid research', { candidates: () => null, recall: () => null }).length === 0, 'null-tolerant pool never throws');
}

// --- park-landing: a stopped run enters the living-document pool; beats and shells stay out ---
{
  const landed = [];
  const deps = {
    readFile: (p) => ({ text: p === 'notes/directed-3618.md' ? 'x'.repeat(500) : '' }),
    getMeta: () => '', getThread: (id) => ({ id, content: 'substantiate the grid claim' }),
    land: (d) => { landed.push(d); return { id: 42, landed: true }; },
  };
  const r = uw.parkDeliverable({ focusId: 3618, reason: 'user-stop', ...deps });
  ok(r && r.id === 42 && landed[0].ref === 'directed-3618' && landed[0].source === 'research', 'a stopped run lands as a research doc under its directed ref');
  ok(/substantiate the grid/.test(landed[0].title), 'the thread goal names the landed doc');
  ok(uw.parkDeliverable({ focusId: 3622, ...deps, getMeta: () => 'state-leg:MS' }) === null, 'a beat focus never park-lands (the sweep re-derives)');
  ok(uw.parkDeliverable({ focusId: 9, ...deps, readFile: () => ({ text: 'short' }) }) === null, 'a header-only shell is not a living document');
  ok(uw.parkDeliverable({ focusId: 0 }) === null && uw.parkDeliverable({}) === null, 'missing focus never throws');
}

// --- guidance addenda ---
const g = uw.augmentGuidance('BASE', {
  focusId: 9, content: 'compile a report on parish clerks — I need this report within an hour',
  createdTs: NOW - 30 * 60e3, now: NOW,
  getMeta: (k) => (k === 'thread.9.news_recent' ? JSON.stringify([{ title: 'Clerk resigns in Caddo Parish' }]) : null),
});
ok(/^BASE/.test(g), 'existing guidance rides first');
ok(/RELATED NEWS/.test(g) && /Caddo Parish/.test(g), 'matched news rides the pass with a fold-it-in instruction');
ok(/DEADLINE: ~30 minutes left — ASSEMBLE/.test(g), 'a rush deadline says ASSEMBLE, not keep-hunting');
const g2 = uw.augmentGuidance('', { focusId: 9, content: 'you have the next 6 hours to work on this report', createdTs: NOW - H, now: NOW, getMeta: () => null });
ok(/DEADLINE: about 5h left — pace the depth/.test(g2), 'a long window paces depth to finish inside it');
const g3 = uw.augmentGuidance('', { focusId: 9, content: 'need this within an hour', createdTs: NOW - 2 * H, now: NOW, getMeta: () => null });
ok(/DEADLINE: PASSED — stop hunting/.test(g3), 'a passed deadline stops the hunt honestly');
ok(uw.augmentGuidance('G', { focusId: 1, content: 'plain research', createdTs: NOW, now: NOW, getMeta: () => null }) === 'G', 'no news + no deadline → guidance untouched');

// --- REDIRECT DETECTION (turn 10275: the false pivot — "I'm pivoting focus" registered NOTHING) ---
{
  const r = uw.detectRedirect('The next state we need is actually Arizona. But I would honestly rather have you focus on the the China AI and materials research');
  ok(r && r.topic === 'China AI and materials research', `the REAL 20:38 message fires and extracts the topic ("${r && r.topic}")`);
  ok(uw.detectRedirect('Please focus on the parish clerk verification for now') !== null, 'clause-start imperative "focus on X" fires');
  ok(uw.detectRedirect("let's focus on the forecast calibration") !== null, "\"let's focus on X\" fires");
  ok(uw.detectRedirect('Should we focus on the China AI research?') === null, 'a QUESTION never fires (direction grid)');
  ok(uw.detectRedirect("I'll work on the deck tonight and focus on the intro") === null, 'HIS own work plans never fire (bare "work on" is not a redirect of HER focus)');
  ok(uw.detectRedirect('The team decided to focus on retention metrics last quarter') === null, 'narrative about others never fires');
  ok(uw.detectRedirect('') === null && uw.detectRedirect(null) === null, 'empty input never throws');

  // --- thread promotion: the 2-token topic rule finds the existing China thread ---
  const pool = [
    { id: 3533, content: 'provide a metallurgical breakdown of China chip manufacturing needs by AI partners', created_ts: 100 },
    { id: 3525, content: "ingest research materials on China's next-generation hardware and Global South relations", created_ts: 200 },
    { id: 3632, content: 'Investigate: locate each county’s official government website', created_ts: 300 },
  ];
  const hit = uw.matchThreadToTopic('China AI and materials research', pool);
  ok(hit && hit.id === 3525, 'the existing China-materials thread is promoted (2+ shared topic tokens)');
  ok(uw.matchThreadToTopic('quantum biology of bird navigation', pool) === null, 'a genuinely new topic promotes nothing → a fresh thread is born');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
