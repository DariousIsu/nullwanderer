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

  // --- CLASSIFIER-PRIMARY (relearned live 21:04-21:07: three real steerings evaded the regex) ---
  ok(uw.REDIRECT_TRIGGER_RE.test('Clarifying: Map Arizona elected officials now and then pivot your attention to the AI and materials China research'), 'trigger fires on "pivot your attention to" (regex missed it)');
  ok(uw.REDIRECT_TRIGGER_RE.test('can you gather these now and then move to the china research?'), 'trigger fires on "move to the X research"');
  ok(uw.REDIRECT_TRIGGER_RE.test('Complete any research related to China first'), 'trigger fires on "complete X first"');
  ok(!uw.REDIRECT_TRIGGER_RE.test('good morning, how did the evening go'), 'small talk never reaches the classifier');
  // RE-LOOK verbs (measured live 2026-08-06: the P4b acceptance-test turn evaded the trigger)
  ok(uw.REDIRECT_TRIGGER_RE.test('Hey Zo, can you take another look at the Hartfield and Green South report please'), 'trigger fires on "take another look at the X report" (the live acceptance-test miss)');
  ok(uw.REDIRECT_TRIGGER_RE.test('revisit the Monroe dossier when you can'), 'trigger fires on "revisit"');
  ok(uw.REDIRECT_TRIGGER_RE.test('go over the funding section again'), 'trigger fires on "go over"');
  const spec = uw.buildRedirectAsk('move to the china research');
  ok(spec.task === 'redirect_intent' && /STEERING WHAT SHE WORKS ON/.test(spec.want), 'the prompt states the DISTINCTION, not a phrase list');
  ok(/BACK to finished or in-flight work is steering too/.test(spec.want), 'the prompt counts a re-look at existing work as steering');
  ok(/NOT steering when he asks a question, plans HIS OWN work/.test(spec.want), 'the prompt names the non-steering shapes (direction grid)');
  ok(/immediate=false when he queued it AFTER current work/.test(spec.want), 'immediate-vs-queued is part of the contract');
  const v1 = spec.validate('{"redirect": true, "immediate": false, "topic": "the the China AI and materials research"}');
  ok(v1.valid && v1.value.topic === 'China AI and materials research' && v1.value.immediate === false, 'a queued redirect parses; leading "the the" is cleaned');
  ok(!spec.validate('{"redirect": "yes", "topic": "x"}').valid, 'a non-boolean verdict is refused (schema, not vibes)');
  ok(!spec.validate('{"redirect": true, "topic": ""}').valid, 'a redirect without a topic is refused');
  ok(spec.validate('{"redirect": false, "topic": ""}').valid, 'a clean "not a redirect" verdict parses');

  // --- DEFERRED-AGENDA CAPTURE (audit 10278: "saved for the meeting" with nothing behind it) ---
  ok(uw.AGENDA_TRIGGER_RE.test("Save that elections news for next week's Rainey team meeting. If the story has more development we can bring it up to the elections team"), 'the REAL 10278 message reaches the classifier');
  ok(uw.AGENDA_TRIGGER_RE.test('remind me about the parish list on friday'), '"remind me … friday" reaches the classifier');
  ok(!uw.AGENDA_TRIGGER_RE.test('how are the county boards structured in Georgia'), 'plain research questions never reach it');
  const ag = uw.buildAgendaAsk('Save that for the meeting', 'ai_said: The Fulton County elections board has a vacancy…');
  ok(/HOLD something for a FUTURE moment/.test(ag.want) && /NOT a hold when he asks a question/.test(ag.want), 'the prompt states the hold DISTINCTION, not a phrase list');
  ok(/resolved from the recent turns/.test(ag.want) && /recent_turns/.test(JSON.stringify(ag.input)), '"that" resolves against the recent turns riding the input');
  const av = ag.validate('{"defer": true, "item": "Fulton County elections board vacancy story", "when": "next week\'s Rainey team meeting", "days": 7}');
  ok(av.valid && av.value.days === 7 && /Fulton County/.test(av.value.item), 'a concrete hold parses with its timing');
  ok(!ag.validate('{"defer": true, "item": "that", "when": "later", "days": 3}').valid, 'an unresolved "that" is refused — the item must be concrete');
  ok(ag.validate('{"defer": false, "item": "", "when": "", "days": 0}').valid, 'a clean "not a hold" verdict parses');
}

// ── LINEAGE INHERITANCE: a spawned thread continues its parent run's document ────────────────
// Measured live 2026-07-31: #3640 concluded with a 43,324-char deliverable and spawned three
// follow-ups; #3643 went active and began researching AISI from scratch six minutes after the
// document covering AISI was written. 8 of 8 spawned threads had base_doc=NONE, because base_doc
// was only ever set on the user-work driver's path — the one that handles Lucas's own threads.
{
  const meta = {
    'thread.3643.spawned_from': '3640',      // spawned by a concluded run
    'thread.3638.spawned_from': 'subc',      // spawned by the subconscious — no parent RUN
    'thread.3699.spawned_from': '3698',      // parent exists but never landed a deliverable
    'thread.4000.spawned_from': '4000',      // pathological self-reference
  };
  const docs = { 'directed-3640': { id: 11754, title: 'Research — China AI and materials research' } };
  const deps = { db: { getMeta: (k) => meta[k], getDocumentByRef: (r) => docs[r] || null } };

  const hit = uw.inheritedBaseDocId(3643, { deps });
  ok(hit && hit.docId === 11754 && hit.parentId === 3640, '⭐ a spawned thread inherits its parent run\'s deliverable, by LINEAGE not by matching');
  ok(hit && /China AI and materials/.test(hit.title), 'and carries the title, so the inheritance can be logged honestly');

  ok(uw.inheritedBaseDocId(3638, { deps }) === null, 'a subconscious-born thread inherits nothing — there is no parent RUN (the common, correct null)');
  ok(uw.inheritedBaseDocId(3699, { deps }) === null, 'a parent that never landed a deliverable gives nothing');
  ok(uw.inheritedBaseDocId(4000, { deps }) === null, 'a thread cannot inherit from itself');
  ok(uw.inheritedBaseDocId(1234, { deps }) === null, 'a thread with no spawned_from at all inherits nothing');

  // Never throw into the research loop — a bookkeeping lookup must not be able to stop a run.
  const boom = { db: { getMeta: () => { throw new Error('db down'); }, getDocumentByRef: () => null } };
  ok(uw.inheritedBaseDocId(3643, { deps: boom }) === null, 'a failing db yields null, never an exception into the run');
  const boom2 = { db: { getMeta: () => '3640', getDocumentByRef: () => { throw new Error('gone'); } } };
  ok(uw.inheritedBaseDocId(3643, { deps: boom2 }) === null, 'a failing doc lookup yields null too');

  // …AND THE INHERITED DOCUMENT MUST REACH THE RESEARCH PASSES, not just the write-up. Inheriting
  // it only fed synthesis at first, so a spawned thread still re-researched its target from
  // scratch and merely avoided restating it at the end — the wrong half of the saving.
  const deliverable = [
    '# Research — China AI and materials research', '',
    '## Shanghai Academy of AI for Science (SAIS)', 'SAIS runs the Materials Galaxy platform.', '',
    '## AI for Science Institute (AISI)', 'AISI operates AI4S infrastructure across three campuses.', 'Founded 2021 under the Ministry of Science and Technology.', '',
    '## China National Research Institute of Nonferrous Metals (CNRI)', 'CNRI focuses on alloy design.', '',
  ].join('\n');

  const sec = uw.priorSectionFor(deliverable, 'AI for Science Institute');
  ok(sec && /AI4S infrastructure across three campuses/.test(sec), '⭐ the section ABOUT this target is sliced out of the inherited deliverable');
  ok(sec && !/Materials Galaxy|alloy design/.test(sec), 'and ONLY that section — a neighbouring org never leaks in as established fact');
  ok(/^## AI for Science Institute/.test(uw.priorSectionFor(deliverable, 'AI for Science Institute (AISI)') || ''), 'a heading with a trailing acronym still matches the bare target name');
  ok(uw.priorSectionFor(deliverable, 'CNRI') === null || /alloy design/.test(uw.priorSectionFor(deliverable, 'CNRI')), 'an acronym-only target either matches its own section or honestly returns nothing');

  ok(uw.priorSectionFor(deliverable, 'Tsinghua AI Chemistry Institute') === null, 'a target the document does NOT cover returns null — never a wrong section handed over as fact');

  // ⭐⭐ THE NAMESAKE. Live 2026-07-31 and it FIRED before I caught it: #3640 researched the Chinese
  // "AI for Science Institute (AISI)"; its follow-up #3644 opened "UCI Artificial Intelligence in
  // Science Institute (AISI)" — University of California, Irvine — and this function handed the
  // CHINESE section over as established fact about the AMERICAN institute. Three shared tokens
  // (science · institute · aisi) cleared a two-token bar. Shared generic words cannot carry
  // organizational identity: "science", "institute", "research", "national" are what org names are
  // MADE of, and an acronym is exactly where collisions live.
  ok(uw.priorSectionFor(deliverable, 'UCI Artificial Intelligence in Science Institute (AISI)') === null,
    '⭐ a NAMESAKE sharing an acronym gets NOTHING — no cross-contamination between two real orgs');
  ok(uw.priorSectionFor(deliverable, 'Shanghai Institute of Science') === null,
    'and a different org sharing two generic words gets nothing either');

  // priorOrgsIn: the disambiguator handed to discovery so the namesake is never opened at all.
  const orgs = uw.priorOrgsIn(deliverable);
  ok(orgs.length === 3 && orgs[0] === 'Shanghai Academy of AI for Science (SAIS)', 'priorOrgsIn lists the document\'s own organizations, in order');
  ok(orgs.includes('AI for Science Institute (AISI)'), 'including the one an acronym would collide with');
  ok(uw.priorOrgsIn('').length === 0 && uw.priorOrgsIn(null).length === 0, 'priorOrgsIn is null-safe');
  ok(uw.priorOrgsIn(Array.from({ length: 50 }, (_, i) => `## Institute Number ${i}\ntext\n`).join(''), { max: 5 }).length === 5, 'and bounded');
  ok(uw.priorOrgsIn('## AB\n## Real Institute Name\n').length === 1, 'a too-short heading is not an organization name');

  // ⭐ A REGRESSION I CAUSED, caught live on #3639. Making the run's own questions outrank the
  // generic ladder is right for a single-target spawned thread and WRONG on a multi-target
  // discovery run: entity-specific facets accumulate in the run-level plan, so after the run moved
  // from AI2S to ICDI the deepen pass researched ICDI in order to answer "does AI2S have a formal
  // governance structure". 3 of #3639's 9 plan facets named a specific org.
  {
    const covered = ['Arizona Institute for AI and Society (AI2S)'];
    const tgt = 'Institute for Computation and Data-Enabled Insight (ICDI)';
    ok(uw.facetAppliesTo('Leadership & key staff', tgt, covered), 'a generic facet applies to any target');
    ok(uw.facetAppliesTo('Geographic focus within Arizona', tgt, covered), 'a place name is not an org marker');
    ok(!uw.facetAppliesTo('Does AI2S have a formal governance structure?', tgt, covered),
      '⭐ a facet naming a PREVIOUSLY COVERED org is not pursued against the current one');
    ok(!uw.facetAppliesTo('What are the primary funding streams for AI2S?', tgt, covered), 'and again for its funding question');
    ok(uw.facetAppliesTo('What compute does ICDI operate?', tgt, covered), 'a facet naming THIS target still applies');

    // ⚠ ACRONYMS ALONE WERE NOT ENOUGH — missed live within the hour of shipping the filter.
    // "Eller Artificial Intelligence Laboratory" has no all-caps acronym and "AI" is below the
    // length floor, so a facet asking what compute the ELLER lab has was pursued against the
    // Arizona AI Alliance. A name does not need an acronym to be a name.
    const az = 'Arizona Artificial Intelligence Alliance';
    const azCov = ['Eller Artificial Intelligence Laboratory', 'Institute for Computation and Data-Enabled Insight (ICDI)'];
    ok(!uw.facetAppliesTo('What high-performance computing resources does the Eller AI Lab operate?', az, azCov),
      '⭐ a distinctive PROPER NOUN identifies an org even with no acronym');
    ok(uw.facetAppliesTo('Geographic focus within Arizona', az, azCov),
      'a place the CURRENT target also carries is not exclusionary');
    ok(uw.facetAppliesTo('What role does the University of Arizona play?', az, azCov),
      'generic org vocabulary (University, Institute, Laboratory…) identifies nobody');
    ok(uw.facetAppliesTo('Leadership & key staff', az, azCov), 'and generic facets still apply');
    // Conservative direction: only EXCLUDE on strong evidence (the opposite of the namesake fix,
    // which refused to CLAIM identity on weak evidence). A wrongly-kept facet costs one pass; a
    // wrongly-dropped one loses a real question permanently.
    ok(uw.facetAppliesTo('What does NASA fund here?', tgt, covered), 'an UNRECOGNISED marker is not evidence — the facet stays');
    ok(uw.facetAppliesTo('anything', tgt, []), 'with nothing covered yet, every facet applies');
    ok(!uw.facetAppliesTo('', tgt, covered), 'an empty facet is not a facet');

    // ⭐ ONE SHARED ORDINARY WORD IS NOT IDENTIFICATION (measured 2026-07-31 on focus.3631: 13 of
    // 168 cross-target facets survived). _marks counts every capitalised non-stoplist word, so an
    // org whose NAME is built from common vocabulary claimed everyone else's questions. The cure is
    // comparative — name me better than you name anyone else — because extending the stoplist with
    // "policy"/"energy"/"conservative" can never keep up in a domain built from those words.
    const cov3631 = ['Conservative Energy Network', 'Bipartisan Policy Center',
      'Conservative Climate Foundation', 'State Policy Network', 'Manhattan Institute for Policy Research'];
    ok(!uw.facetAppliesTo("How does the Bipartisan Policy Center's Energy Advisory Council operate day-to-day?", 'Conservative Energy Network', cov3631),
      '⭐ sharing only "Energy" does not make BPC\'s council question belong to Conservative Energy Network');
    ok(!uw.facetAppliesTo('Manhattan Institute for Policy Research – what is its annual budget?', 'State Policy Network', cov3631),
      '⭐ sharing only "Policy" does not hand Manhattan\'s budget question to State Policy Network');
    ok(!uw.facetAppliesTo('Conservative Climate Foundation – what are its primary funding sources?', 'Conservative Energy Network', cov3631),
      '⭐ sharing only "Conservative" does not hand CCF\'s funding question to Conservative Energy Network');
    ok(uw.facetAppliesTo('What is the annual budget of the Bipartisan Policy Center?', 'Bipartisan Policy Center', cov3631),
      'the org that the facet actually names still keeps it');

    // THE PREFIX IS OWNERSHIP. Scoring the whole string lost these: the question names another body
    // more often than its own subject, yet the generator stamped the owner on the front.
    const covEnergy = ['The Green Grid', 'U.S. Department of Energy', 'Environmental Protection Agency',
      'California Energy Commission', 'ASHRAE'];
    ok(uw.facetAppliesTo("U.S. Department of Energy – What internal DOE policy drafts have cited The Green Grid's standards?", 'U.S. Department of Energy', covEnergy),
      '⭐ a facet PREFIXED with the target keeps it even when it names another body more often');
    ok(!uw.facetAppliesTo("U.S. Department of Energy – What internal DOE policy drafts have cited The Green Grid's standards?", 'The Green Grid', covEnergy),
      '…and the body it merely mentions does not also claim it');
    ok(uw.facetAppliesTo('California Energy Commission – Which specific CEC regulatory actions cite these standards?', 'California Energy Commission', covEnergy),
      'a prefix naming the target survives a body full of other orgs');
    // An acronym is high-precision: it settles a genuinely two-org question.
    ok(uw.facetAppliesTo('How does AI2S collaborate with the Mayo Clinic on shared compute?', 'Arizona Institute for AI and Society (AI2S)', ['Mayo Clinic']),
      "an ACRONYM naming the target holds a two-org facet, even though Mayo Clinic scores more marks");
  }
  ok(uw.priorSectionFor(deliverable, 'Institute') === null, 'a single generic shared word is coincidence, not a topic match');
  ok(uw.priorSectionFor('', 'AISI') === null && uw.priorSectionFor(deliverable, '') === null, 'empty inputs are null, never a throw');
  const long = '## AISI\n' + 'x'.repeat(9000);
  const cut = uw.priorSectionFor(long, 'AISI', { maxChars: 500 });
  ok(cut.length <= 520 && /truncated/.test(cut), 'a huge section is capped and SAYS it was cut');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
