/* Smoke: lib/research — the DEPTH-FIRST research loop logic (follow a target until well-covered,
 * then advance; organize per target). Pure, no model/file/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research.js
 */
'use strict';
const r = require('../lib/research');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- parsePass: control lines ---
const pT = r.parsePass('## The Cato Institute\nLibertarian…\nTARGET: The Cato Institute');
ok(pT.target === 'The Cato Institute' && !pT.saturated && !pT.allCovered, 'new-target pass → target parsed');
ok(/Libertarian/.test(pT.body) && !/TARGET:/.test(pT.body), 'body keeps findings, strips the TARGET line');
const pF = r.parsePass('Leadership: Jane Doe (President)…\nFACET: leadership & staff');
ok(pF.facet === 'leadership & staff' && pF.target === '', 'deepen pass → facet parsed, no target');
ok(r.parsePass('SATURATED').saturated === true, 'SATURATED recognized');
ok(r.parsePass('ALL-COVERED').allCovered === true, 'ALL-COVERED recognized');
// leaked operator control JSON must be stripped from the body (the line-30 deliverable bug)
const pJson = r.parsePass('Real findings here.\n{"thought":"I have gathered the org\'s details (Lawson Bader).", "action":null}\nFACET: contacts');
ok(!/"thought"|"action"/.test(pJson.body) && /Real findings here/.test(pJson.body), 'leaked {"thought":…,"action":…} JSON stripped from body, real text kept');

// --- grounding hardening (the Goldwater R.Z./P.C. placeholder bug) ---
ok(/never use initials|NEVER use initials/i.test(r.buildDeepenPrompt({ goal: 'g', target: 'X' })), 'deepen prompt forbids initials/placeholders (write "not found")');
ok(/initials|placeholder/i.test(r.buildOrganizeTargetPrompt({ target: 'X', raw: 'n' })[0].content), 'organize prompt forbids initials/placeholders');
ok(/\/contact|\/about/i.test(r.buildDeepenPrompt({ goal: 'g', target: 'X' })), 'deepen prompt steers to the org contact/about page (contact-retrieval fix)');
ok(/open_page|EXHAUST|use the site/i.test(r.buildDeepenPrompt({ goal: 'g', target: 'X' })), 'deepen prompt tells her to EXHAUST a site (open_page) before re-searching (Concern 2)');

// --- STATUS request detection (Concern 1: frontier-gated progress updates) ---
ok(r.isStatusRequest("how's the project going") === true, '"how\'s the project going" → status request');
ok(r.isStatusRequest('How is the think tank project going?') === true, '"How IS the think tank project going" → status (the live miss)');
ok(r.isStatusRequest('What is the list of think tanks you have done so far?') === true, '"what is the list … done so far" → status/list (the live miss)');
ok(r.isStatusRequest('which ones have you covered') === true, '"which ones have you covered" → status/list');
ok(r.isStatusRequest('give me an update on the research') === true, '"give me an update" → status request');
ok(r.isStatusRequest('any progress?') === true, '"any progress?" → status request');
ok(r.isStatusRequest('how far along are you') === true, '"how far along" → status request');
ok(r.isStatusRequest('what is the date today') === false, 'a plain question is NOT a status request');
ok(r.isStatusRequest('how are you') === false, '"how are you" (personal, no going/progress) → NOT a status request');
ok(r.isStatusRequest('research every think tank') === false, 'a fresh task is NOT a status request');

// --- decideAdvance: depth-first — stay until saturated / cap / diminishing returns ---
ok(r.decideAdvance({ passes: 1, newChars: 900 }).advance === false, 'pass 1 with new material → keep deepening');
ok(r.decideAdvance({ passes: 3, newChars: 900 }).advance === false, 'still adding material → keep deepening');
ok(r.decideAdvance({ passes: 2, saturated: true }).advance === true, 'model says SATURATED → advance');
ok(r.decideAdvance({ passes: r.MAX_PASSES_PER_TARGET, newChars: 900 }).advance === true, 'hit the per-target pass cap → advance');
ok(r.decideAdvance({ passes: 3, newChars: 10 }).reason === 'diminishing returns' && r.decideAdvance({ passes: 3, newChars: 10 }).advance === true,
  'a near-empty pass (after a couple) → diminishing returns → advance');
ok(r.decideAdvance({ passes: 1, newChars: 10 }).advance === false, 'a thin FIRST pass does NOT advance prematurely (give it a chance)');

// --- VALIDATE mode (leash slice B): roster + corroborator + change check, then MOVE ON ---
ok(r.decideAdvance({ passes: 1, newChars: 900, validate: true }).advance === false, 'validate: overview pass → keep validating');
ok(r.decideAdvance({ passes: 2, newChars: 900, validate: true }).advance === false, 'validate: productive corroboration pass → one more allowed');
ok(r.decideAdvance({ passes: r.MAX_PASSES_VALIDATE, newChars: 900, validate: true }).reason === 'validated (pass cap)', `validate: hard cap at ${r.MAX_PASSES_VALIDATE} passes — NEVER a dossier grind`);
ok(r.decideAdvance({ passes: 2, newChars: 10, validate: true }).reason === 'validated (nothing new)', 'validate: nothing new after corroboration → done early');
ok(r.decideAdvance({ passes: 1, saturated: true, validate: true }).advance === true, 'validate: model says saturated → advance');
ok(r.MAX_PASSES_VALIDATE < r.MAX_PASSES_PER_TARGET, 'validate cap sits BELOW the ordinary per-target cap (it is the light shape)');

// --- COMPREHENSION over collation (Lucas 2026-07-30): user runs synthesize, never card-collate ---
{
  const p = r.buildUnderstandTargetPrompt({ goal: 'grid pressure memo', target: 'PJM Interconnection', raw: 'notes here', known: '[PJM] operates 13 states' });
  const sys = p[0].content, usr = p[1].content;
  ok(/how it works/i.test(sys) && /causal link/i.test(sys), 'understanding prompt demands mechanism + causal link, not a contact card');
  ok(/Tensions & unknowns/i.test(sys) && /OPEN: /.test(sys), 'it demands tensions + OPEN questions');
  // AN OPEN QUESTION IS A GAP IN UNDERSTANDING, NOT AN ERRAND (Lucas 2026-07-30: "she will need to
  // discover what she doesn't know to even begin"). Measured on the county runs: 9/9 and 27/27
  // ledger questions were locate-shaped ("where is the roster published", "which page lists staff")
  // — retrieval errands wearing the question form, so the run could never deepen, only fetch.
  ok(/what you now realize you DON'T KNOW/.test(sys), 'the OPEN line asks for the gap in her own understanding');
  ok(/HOW something works/.test(sys) && /WHY it is that way/.test(sys) && /HOW MUCH/.test(sys) && /WHAT DEPENDS ON IT/.test(sys),
    'it names the learning shapes: mechanism, cause, quantity, dependency');
  ok(/is a FETCH, not an open question/.test(sys) && /where is X published/.test(sys),
    'it REFUSES the locate-shaped question by name (the measured failure mode)');
  ok(/write no OPEN line at all/.test(sys), 'no genuine gap → no question (an honest quiet beats a manufactured errand)');
  ok(/never invent a name or number/i.test(sys) && /read as inference/i.test(sys), 'grounding survives translated: notes faithful, inference MARKED as inference');
  ok(/THE GOAL: grid pressure memo/.test(usr) && /ALREADY IN OUR GRAPH/.test(usr), 'goal + prior knowledge ride the synthesis');
  const oq = r.parseOpenQuestions('## X\nbody\nOPEN: does the queue reform bind before 2027?\nOPEN: which states bear the cost?\nOPEN: a\nOPEN: fourth question that must be dropped by the cap');
  ok(oq.length === 2 || oq.length === 3, `OPEN lines parse (${oq.length}) — the too-short "a" is rejected`);
  ok(oq[0].includes('queue reform'), 'first open question survives verbatim');
  ok(r.parseOpenQuestions('no open lines here').length === 0 && r.parseOpenQuestions(null).length === 0, 'no OPEN lines / null → empty, never throws');

  // THE LIVING DOCUMENT + SOURCE BINDING ride the synthesis
  const p2 = r.buildUnderstandTargetPrompt({
    goal: 'g', target: 'MISO', raw: 'notes',
    priorDoc: { title: 'Research — grid pressure', extract: 'PJM queue is the bottleneck' },
    sources: ['https://miso.org/planning', 'https://ferc.gov/order-1920'],
  });
  ok(/DEEPEN, REVISE, or CONTRADICT/.test(p2[0].content) && /never restate/i.test(p2[0].content), 'living doc: bounce-off contract in the system prompt');
  ok(/LIVING DOCUMENT ALREADY CONCLUDED/.test(p2[1].content) && /PJM queue is the bottleneck/.test(p2[1].content), 'prior conclusions ride the user message');
  ok(/SOURCES \(the pages this run actually visited/.test(p2[1].content) && /miso\.org\/planning/.test(p2[1].content), 'visited pages ride as the citable source list');
  ok(/chosen ONLY from the SOURCES list/.test(p2[0].content) && /NEVER invent a URL/.test(p2[0].content), 'source binding: cite from visited only, never invent');
  ok(/pages read this pass/.test(p2[0].content), 'the prompt teaches the claim→page markers (40 URLs offered, 0 bound until the notes carried traceability)');
  ok(/held knowledge this pass/.test(p2[0].content) && /\(source: held doc:N\)/.test(p2[0].content), 'the prompt teaches held-knowledge binding (echo-first passes cite the store, refs from markers ONLY)');
  const p3 = r.buildUnderstandTargetPrompt({ goal: 'g', target: 'X', raw: 'n' });
  ok(!/LIVING DOCUMENT/.test(p3[1].content) && !/SOURCES \(/.test(p3[1].content), 'no prior doc / no sources → blocks simply absent');
}

// --- newContentChars: repeat detection ---
ok(r.newContentChars('', 'Brand new finding about the org leadership here.') > 0, 'against empty → all new');
ok(r.newContentChars('Jane Doe is the President of the org.', 'Jane Doe is the President of the org.') === 0, 'exact repeat → no new content');
ok(r.newContentChars('Jane Doe is President.', 'Jane Doe is President. The budget is forty million dollars annually.') > 20, 'a genuinely new sentence → counts as new');

// --- prompts ---
const np = r.buildNewTargetPrompt({ goal: 'study every right-of-center think tank', covered: ['Heritage Foundation'] });
ok(/do NOT pick any of these again/i.test(np) && /Heritage Foundation/.test(np), 'new-target prompt lists done orgs (anti-repeat)');
ok(/TARGET:/.test(np) && /ALL-COVERED/.test(np), 'new-target prompt asks for TARGET + offers ALL-COVERED');
const dp = r.buildDeepenPrompt({ goal: 'g', target: 'R Street Institute', facets: ['overview'] });
ok(/CURRENT ORGANIZATION: R Street Institute/.test(dp) && /overview/.test(dp), 'deepen prompt names the current target + its gathered facets');
ok(/staff|leadership/i.test(dp) && /contact|email|phone/i.test(dp) && /SATURATED/.test(dp), 'deepen prompt prioritizes staff+contacts and offers SATURATED');
const op = r.buildOrganizeTargetPrompt({ target: 'Cato', raw: 'notes…' });
ok(op.length === 2 && /never add|Ground ONLY/i.test(op[0].content), 'organize prompt is grounded (no invention)');

// --- TOPICAL prompt (research kind=topical/forecast): a SUBJECT brief, NOT an org/contact walk ---
const tp = r.buildTopicalPrompt({ goal: 'the Strait of Hormuz situation', facet: 'Drivers & causes', covered: ['Current state'] });
ok(/SUBJECT/i.test(tp) && /Strait of Hormuz/.test(tp), 'topical prompt frames the SUBJECT');
ok(/Drivers & causes/.test(tp) && /ASPECT:/.test(tp), 'topical prompt targets ONE aspect + asks for ASPECT');
ok(/NOT profiling organizations/i.test(tp) && /NOT gathering.*contact|do NOT.*emails\/phones/i.test(tp), 'topical prompt FORBIDS org-profiling + contact hunting (the misroute fix)');
ok(/do NOT repeat/i.test(tp) && /Current state/.test(tp), 'topical prompt lists already-covered aspects (anti-repeat)');
ok(/never invent|Ground EVERY claim/i.test(tp), 'topical prompt is grounded (no invention)');
ok(/## Cato/.test(op[0].content) && /Key people|Contact/i.test(op[0].content), 'organize prompt enforces the per-org schema');

// --- MID-RUN CLARIFICATION: detect his refinement, fold it into every pass ---
ok(r.isClarification({ message: 'yes, include state-level think tanks too', assistantAskedQuestion: true }) === true, 'an answer to her question → clarification');
ok(r.isClarification({ message: 'also make sure to get their funding sources' }) === true, 'refinement language ("also/make sure") → clarification');
ok(r.isClarification({ message: 'focus on the energy ones first' }) === true, '"focus on …" → clarification');
ok(r.isClarification({ message: 'the weather is nice' }) === false, 'unrelated chatter (no refinement, no question asked) → NOT a clarification');
ok(r.isClarification({ message: 'lol' }) === false, 'too-short throwaway → not a clarification');
// live mis-captures (2026-06-29): fix the false positive + false negative
ok(r.isClarification({ message: 'Thank you Zoe', assistantAskedQuestion: true }) === false, '"Thank you Zoe" (after she asked a Q) → NOT a clarification (social, was wrongly captured)');
ok(r.isClarification({ message: 'canvas is perfect, thank you', assistantAskedQuestion: true,
  assistantQuestion: 'Do you want the list pasted here or added to a Canvas document?',
  focusGoal: 'Compile and keep current the county-level governing board for Beaver County, Utah — members, seats, contact info' }) === false,
  'ADDRESS gate: her question came from ANOTHER thread (parish list) → answer never lands on the Beaver County focus (live misroute 2026-07-23)');
ok(r.isClarification({ message: 'yes, include the school board seats too', assistantAskedQuestion: true,
  assistantQuestion: 'Should I include appointed county board seats for Beaver County as well?',
  focusGoal: 'Compile and keep current the county-level governing board for Beaver County, Utah — members, seats, contact info' }) === true,
  'ADDRESS gate: her question ABOUT the focus → the answer still captures');
ok(r.isClarification({ message: 'thanks so much!', assistantAskedQuestion: true }) === false, 'gratitude → NOT a clarification');
ok(r.isClarification({ message: 'good morning Zoe', assistantAskedQuestion: true }) === false, 'a greeting → NOT a clarification');
ok(r.isClarification({ message: 'Rainey Center is a right of center think tank for example' }) === true, '"X is a … think tank for example" → clarification (scope steer, was wrongly MISSED)');
ok(r.isClarification({ message: "But if it helps, expand to 'moderate' as well" }) === true, '"expand to moderate as well" → clarification (scope broadening)');
// 2026-07-22 live mis-capture: her SOCIAL question made any answer a "clarification" for the focus.
ok(r.isClarification({ message: 'Pretty ok, lots of work today, a lot of it was on your program', assistantAskedQuestion: true, assistantQuestion: 'How was your day going?' }) === false,
  'an answer to her SOCIAL question ("how was your day?") → NOT a clarification (the Aiken County mis-capture)');
ok(r.isClarification({ message: 'busy day, mostly meetings and travel', assistantAskedQuestion: true, assistantQuestion: 'how are you holding up?' }) === false,
  'a self-report answer to a social question → NOT a clarification');
ok(r.isClarification({ message: 'good — but only include the federal ones', assistantAskedQuestion: true, assistantQuestion: 'How was your evening?' }) === true,
  'a directive INSIDE small talk still captures (refinement language stands alone)');
ok(r.isClarification({ message: 'the state ones matter most to me', assistantAskedQuestion: true, assistantQuestion: 'Should I include state-level orgs or stay federal?' }) === true,
  'an answer to her TASK question still captures (the designed case survives)');
// 2026-07-22 second live mis-capture, same evening: past-tense NARRATIVE with a weak word ("only").
ok(r.isClarification({ message: 'it ended up only be me Devon and Joshua', focusGoal: 'the governing body of Aiken County, South Carolina' }) === false,
  'past-tense narrative with a weak word ("it ended up only…") → NOT a clarification (the Devon/Joshua mis-capture)');
ok(r.isClarification({ message: 'Rainey Center is a right of center think tank for example', focusGoal: 'right of center think tanks and their leadership' }) === true,
  'a weak-worded scope statement ON TOPIC (goal overlap) still captures');
ok(r.isClarification({ message: 'Rainey Center is a right of center think tank for example', focusGoal: 'the governing body of Aiken County, South Carolina' }) === false,
  'the same weak-worded statement OFF topic does not capture (goal overlap gate)');
ok(r.isClarification({ message: 'only include the federal ones', focusGoal: 'the governing body of Aiken County, South Carolina' }) === true,
  'a STRONG directive ("include") captures regardless of goal overlap');
ok(r.buildGuidanceBlock([]) === '', 'no clarifications → empty guidance block');
const gb = r.buildGuidanceBlock(['include state-level ones', 'skip any already in our CRM']);
ok(/ADDITIONAL GUIDANCE/i.test(gb) && /include state-level ones/.test(gb) && /skip any already/.test(gb), 'guidance block lists all clarifications');
// the guidance actually reaches the pass prompts
ok(r.buildNewTargetPrompt({ goal: 'g', covered: [], guidance: gb }).includes('include state-level ones'), 'new-target prompt carries the clarification guidance');
ok(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [], guidance: gb }).includes('skip any already'), 'deepen prompt carries the clarification guidance');

// --- Slice 2c: object-first open (pickSeedTarget) + known-injection into the deepen prompt ---
const seeds = [{ name: 'John Curtis (US)', degree: 320 }, { name: 'R Street Institute' }];
ok(r.pickSeedTarget({ seeds, consumed: [], covered: [] }).name === 'John Curtis (US)', 'pickSeedTarget: first unconsumed seed');
ok(r.pickSeedTarget({ seeds, consumed: ['John Curtis (US)'], covered: [] }).name === 'R Street Institute', 'pickSeedTarget: skips a consumed seed → next');
ok(r.pickSeedTarget({ seeds, consumed: [], covered: ['john curtis (us)'] }).name === 'R Street Institute', 'pickSeedTarget: skips an already-covered seed (case-insensitive)');
ok(r.pickSeedTarget({ seeds, consumed: ['John Curtis (US)', 'R Street Institute'], covered: [] }) === null, 'pickSeedTarget: all seeds used → null (fall through to discovery)');
ok(r.pickSeedTarget({ seeds: [], consumed: [], covered: [] }) === null, 'pickSeedTarget: no seeds → null');
const dpKnown = r.buildDeepenPrompt({ goal: 'g', target: 'John Curtis (US)', facets: ['overview'], known: '[object] John Curtis (US) — person, degree 320\n  • title: U.S. Senator' });
ok(/WHAT WE ALREADY HOLD on John Curtis/.test(dpKnown) && /do NOT re-derive/.test(dpKnown) && /U\.S\. Senator/.test(dpKnown), 'buildDeepenPrompt: known dossier injected as GIVEN prior knowledge');
ok(!/WHAT WE ALREADY HOLD/.test(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [] })), 'buildDeepenPrompt: no known → no prior-knowledge block (unchanged default)');
// visited memory: tell the pass not to re-open the same URLs/searches (the "same websites over and over" fix)
const dpVis = r.buildDeepenPrompt({ goal: 'g', target: 'Curtis', facets: [], visited: ['https://curtis.senate.gov/contact/', 'search: Senator John Curtis background'] });
ok(/ALREADY VISITED THIS RUN/.test(dpVis) && /do NOT open these again/.test(dpVis) && /go DEEPER/.test(dpVis) && /curtis\.senate\.gov\/contact/.test(dpVis), 'buildDeepenPrompt: visited URLs/searches listed with a go-deeper directive');
ok(!/ALREADY VISITED/.test(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [] })), 'buildDeepenPrompt: no visited → no block (unchanged default)');

// --- guardrails: bounded-run termination (allTargetsCovered) ---
ok(r.allTargetsCovered({ intended: ['John Curtis (US)'], covered: ['John Curtis (US)'] }) === true, 'allTargetsCovered: single intended, covered → true (terminate)');
ok(r.allTargetsCovered({ intended: ['John Curtis'], covered: ['John Curtis (US)'] }) === true, 'allTargetsCovered: fuzzy — "John Curtis (US)" satisfies intended "John Curtis"');
ok(r.allTargetsCovered({ intended: ['John Curtis', 'R Street'], covered: ['John Curtis (US)'] }) === false, 'allTargetsCovered: one of two covered → false (keep going)');
ok(r.allTargetsCovered({ intended: [], covered: ['anything'] }) === false, 'allTargetsCovered: no intended (open run) → false (no bounded terminus)');
ok(r.allTargetsCovered({ intended: ['Curtis Auto Sales'], covered: ['John Curtis (US)'] }) === false, 'allTargetsCovered: a drift org does NOT satisfy the intended person');

// --- scope drift guard: isConcreteTarget (bounds a single named entity, leaves categories open) ---
ok(r.isConcreteTarget('Emergence Water') === true, 'isConcreteTarget: a single named company → bounded (the drift fix)');
ok(r.isConcreteTarget('Sen. Mike Lee') === true, 'isConcreteTarget: a named person → bounded');
ok(r.isConcreteTarget('right-of-center think tanks') === false, 'isConcreteTarget: a category ("think tanks") → open discovery');
ok(r.isConcreteTarget('all the companies in the article') === false, 'isConcreteTarget: "all … companies" → open');
ok(r.isConcreteTarget('21 conservative organizations') === false, 'isConcreteTarget: "organizations" category → open');
ok(r.isConcreteTarget('') === false && r.isConcreteTarget(null) === false, 'isConcreteTarget: empty/nil → false');
ok(r.isConcreteTarget('a very long descriptive phrase that is clearly not a proper name') === false, 'isConcreteTarget: an over-long phrase → not a concrete entity');

// --- Slice 3: facet → toolset map + coverage plan injected into the deepen pass ---
ok(/fec_committee_search/.test(r.facetToolset('Financial health and funding sources').tools.join(' ')), 'facetToolset: financial → the FEC/990 tree');
ok(/Puller pattern/i.test(r.facetToolset('Comprehensive contact information').note) && /derive.*pattern|pattern.*verify/i.test(r.facetToolset('Comprehensive contact information').tools.join(' ')), 'facetToolset: contacts → the Puller email-pattern+verify pattern');
ok(/kg_neighborhood|kg_query/.test(r.facetToolset('Key affiliations and partners').tools.join(' ')), 'facetToolset: affiliations → the KG relation tools');
ok(Array.isArray(r.facetToolset('something unmapped').tools) && r.facetToolset('something unmapped').tools.length >= 1, 'facetToolset: unmapped facet → a safe default toolset');
const cp = r.buildCoveragePlan(['Leadership team and board', 'Financial health and funding', 'Comprehensive contact information']);
ok(/COVERAGE PLAN/.test(cp) && /Leadership/.test(cp) && /fec_committee_search/.test(cp) && /EXHAUSTION/.test(cp), 'buildCoveragePlan: lists every facet with its tools + an exhaustion directive');
ok(r.buildCoveragePlan([]) === '', 'buildCoveragePlan: no facets → empty');
ok(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [], coveragePlan: cp }).includes('COVERAGE PLAN'), 'buildDeepenPrompt: carries the coverage plan into the pass');
ok(!r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [] }).includes('COVERAGE PLAN'), 'buildDeepenPrompt: no coverage plan → unchanged default');

// --- anti-loop: searchSignature collapses re-worded permutations to one key ---
const sA = r.searchSignature("Emergence Water 'Tyler Breton' co-founder team leadership executives LinkedIn");
const sB = r.searchSignature("search: Emergence Water 'Tyler Breton' team executives co-founder leadership LinkedIn");
const sC = r.searchSignature("Emergence Water 'Tyler Breton' leadership team executives founders LinkedIn");
ok(sA === sB, 'searchSignature: two word-order permutations collapse to the SAME signature (the loop the guard missed)');
ok(sA !== r.searchSignature('Emergence Water financial funding 990 revenue'), 'searchSignature: a genuinely different search → different signature');
ok(r.searchSignature('search: FOO bar') === r.searchSignature('bar foo'), 'searchSignature: strips the "search:" prefix + is order/case-insensitive');
ok(r.searchSignature('') === '' && r.searchSignature(null) === '', 'searchSignature: empty/nil → empty');
// the deepen prompt steers to uncovered facets
const dpu = r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [], uncovered: ['Financial health', 'Recent projects'] });
ok(/FACETS STILL MISSING/.test(dpu) && /Financial health/.test(dpu) && /Recent projects/.test(dpu), 'buildDeepenPrompt: lists the uncovered facets to steer off a loop');
ok(/RE-WORDED version of a listed search counts as the SAME/.test(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [], visited: ['search: a b c'] })), 'buildDeepenPrompt: visited block forbids re-worded repeats');

// --- facet-aware pass cap: a single bounded deep target works its facets past the base cap (#3364 thin-doc fix) ---
ok(r.decideAdvance({ passes: 6, newChars: 800, saturated: false }).advance === true, 'decideAdvance: base 6-pass cap unchanged for a multi-org run (deep=false)');
ok(r.decideAdvance({ passes: 6, newChars: 800, uncovered: 3, deep: true }).advance === false, 'decideAdvance: deep target + uncovered facets + productive → KEEP deepening past 6 (was force-finalizing)');
ok(r.decideAdvance({ passes: 18, newChars: 800, uncovered: 3, deep: true }).advance === true && r.decideAdvance({ passes: 18, newChars: 800, uncovered: 3, deep: true }).reason === 'deep cap', 'decideAdvance: deep target hits the deep ceiling → advance (deep cap)');
ok(r.decideAdvance({ passes: 6, newChars: 800, uncovered: 0, deep: true }).advance === true, 'decideAdvance: deep target with ALL facets covered → base cap (do not over-work)');
ok(r.decideAdvance({ passes: 3, newChars: 100, uncovered: 5, deep: true }).advance === true && r.decideAdvance({ passes: 3, newChars: 100, uncovered: 5, deep: true }).reason === 'diminishing returns', 'decideAdvance: diminishing returns still self-limits a deep run (sparse 1-person company bows out)');
ok(r.decideAdvance({ passes: 2, newChars: 900, saturated: true }).advance === true, 'decideAdvance: SATURATED always advances');
// DOSSIER depth (autonomic elected-officials) — deep=true keeps every board deepening across its full facet
// set (members+contacts, meetings, minutes, bios, charter, history) past the base cap, until facets run out.
ok(r.decideAdvance({ passes: 8, newChars: 900, uncovered: 4, deep: true }).advance === false, 'decideAdvance: dossier target with uncovered facets + material → keep deep-diving past the base cap');
ok(r.decideAdvance({ passes: 8, newChars: 900, uncovered: 0, deep: true }).advance === true, 'decideAdvance: dossier target with ALL facets covered → advance (do not over-work)');
ok(r.decideAdvance({ passes: 3, newChars: 10, uncovered: 4, deep: true }).advance === true, 'decideAdvance: a genuinely dry facet still self-limits (diminishing returns) even in dossier depth');
// REFUSAL mode (Lucas 2026-07-18): deep-dive to EXHAUSTION — advance only on a 2-pass dry streak or saturation,
// never on facet-touched or an arbitrary ceiling, with a high runaway guard.
ok(r.decideAdvance({ refusal: true, passes: 10, newChars: 900, dryStreak: 0 }).advance === false, 'refusal: still pulling material below the soft cap → keep deep-diving');
ok(r.decideAdvance({ refusal: true, passes: 5, dryStreak: 1 }).advance === false, 'refusal: ONE thin pass does not give up (could be a bad search)');
ok(r.decideAdvance({ refusal: true, passes: 5, dryStreak: 2 }).advance === true && r.decideAdvance({ refusal: true, passes: 5, dryStreak: 2 }).reason === 'exhausted (dry well)', 'refusal: TWO consecutive dry passes → exhausted, advance');
ok(r.decideAdvance({ refusal: true, passes: 8, dryStreak: 0, saturated: true }).advance === true, 'refusal: model SATURATED still advances immediately');
ok(r.decideAdvance({ refusal: true, passes: r.MAX_PASSES_REFUSAL, newChars: 900, dryStreak: 0 }).advance === true && r.decideAdvance({ refusal: true, passes: r.MAX_PASSES_REFUSAL, dryStreak: 0 }).reason === 'soft depth cap', `refusal: soft depth cap at ${r.MAX_PASSES_REFUSAL} passes (throughput tune — one office can't monopolize)`);
ok(r.MAX_PASSES_REFUSAL <= 20, `refusal soft cap is bounded for throughput (${r.MAX_PASSES_REFUSAL})`);

// ── coverageLine — the run DENOMINATOR in the research prompts ─────────────────────────────────
// A partial run reported as "the complete 9-organization dossier" is the failure this prevents.
ok(/9 of 64/.test(r.coverageLine(new Array(9), 64)), 'coverageLine: states X of N');
ok(/55 STILL MISSING/.test(r.coverageLine(new Array(9), 64)), 'coverageLine: names the remainder');
ok(/NOT complete/.test(r.coverageLine(new Array(9), 64)), 'coverageLine: forbids calling a partial run complete');
ok(/all 64 documented/.test(r.coverageLine(new Array(64), 64)), 'coverageLine: a finished run says so');
ok(r.coverageLine(new Array(70), 64).includes('70 of 64') === false, 'coverageLine: over-coverage reads as complete, not 70/64');
ok(r.coverageLine(new Array(9), 0) === '', 'coverageLine: unknown universe → OMITTED (honest, never guessed)');
ok(r.coverageLine([], 0) === '' && r.coverageLine(null, null) === '', 'coverageLine: empty/null inputs → empty');
ok(r.coverageLine(9, 64).includes('9 of 64'), 'coverageLine: accepts a raw count as well as an array');

{
  const p = r.buildDeepenPrompt({ goal: 'LA parishes', target: 'Acadia', covered: new Array(9), expected: 64 });
  ok(/9 of 64/.test(p), 'buildDeepenPrompt: carries the denominator into the pass');
  const p0 = r.buildDeepenPrompt({ goal: 'x', target: 'y', covered: new Array(9) });
  ok(!/COVERAGE/.test(p0), 'buildDeepenPrompt: no expected → no coverage claim at all');
  const n = r.buildNewTargetPrompt({ goal: 'LA', covered: new Array(9), expected: 64 });
  ok(/9 of 64/.test(n), 'buildNewTargetPrompt: carries the denominator');
  const n0 = r.buildNewTargetPrompt({ goal: 'LA', covered: new Array(9) });
  ok(!/COVERAGE/.test(n0), 'buildNewTargetPrompt: no expected → omitted');
}

// ── AN OPEN QUESTION MUST NAME ITS SUBJECT (2026-07-31) ────────────────────────────────────────
// OPEN questions go into the run's SHARED plan and are pursued later, against whichever target is
// current then. A question that says "the lab" silently rebinds. Measured live: "the total dollar
// amounts … supporting THE LAB", written about the Eller AI Lab, was re-asked against three
// unrelated institutes in a row — one wasted pass each. No name-matching filter can catch a
// pronoun, so the fix has to be at the generator.
{
  const sys = (t) => r.buildUnderstandTargetPrompt({ goal: 'map Arizona AI', target: t, raw: 'notes', sources: ['https://x.edu'] })
    .find((m) => m.role === 'system').content;
  const s = sys('Eller Artificial Intelligence Laboratory');
  ok(/NAME THE SUBJECT IN EVERY OPEN LINE/.test(s), 'the OPEN rule demands the subject be named');
  ok(/write "Eller Artificial Intelligence Laboratory" in full/.test(s),
    '⭐ and inlines the ACTUAL target name — concrete beats abstract in a prompt');
  ok(/NEVER "the lab", "the institute", "the center", "it", "this organization" or "they"/.test(s),
    'the specific anaphora that caused it are named and forbidden');
  ok(/OUTLIVE this target/.test(s), 'and the REASON rides along — a rule with its why survives editing');
  ok(/write "the organization" in full/.test(sys(undefined)), 'no target → a safe fallback, never a literal "undefined"');
  ok(!/undefined/.test(sys(undefined)), 'and nothing leaks "undefined" into the prompt');
}

// ── THE RUN'S OWN QUESTIONS OUTRANK THE GENERIC LADDER (2026-07-30) ─────────────────────────────
// Lucas: "this topic is about LEARNING about the topics… more than scrape contact information."
// The deepen pass used to close with a fixed (1) leadership (2) contacts (3) positions … order,
// stated as THE instruction for the pass — so it beat the run's own researched facets, which sat
// above it as a mere bulleted list. Live proof on the China run: pass after pass logged "+named
// leadership & key staff with their roles, and direct contact details" while its plan held
// "Which specific AI/ML algorithms and model architectures does MGI employ…".
{
  const askedQs = [
    'Which specific AI/ML algorithms and model architectures does MGI employ in its high-throughput materials discovery workflow?',
    'How is MGI formally linked to China\'s national AI-for-Science roadmap?',
  ];
  const withPlan = r.buildDeepenPrompt({ goal: 'learn China AI materials research', target: 'MGI', uncovered: askedQs });
  ok(/take the single highest-value question from FACETS STILL MISSING/.test(withPlan),
    'a run WITH its own questions is told to answer THOSE this pass');
  ok(/outrank any generic checklist/.test(withPlan),
    'and told explicitly that they outrank a checklist');
  ok(!/in priority order: \(1\) named leadership/.test(withPlan),
    '⭐ the generic contact-first ladder is GONE when the run has its own plan (the defect)');
  ok(/do not substitute a leadership roster or a contact hunt/.test(withPlan),
    'the specific substitution that was happening is named and refused');
  ok(/a roster and a contact page do NOT make a run saturated/i.test(withPlan),
    'SATURATION is judged against the run\'s own questions, not against having found people');
  // ⭐ …AND THE BAR MUST BE REACHABLE. First draft required "every question answered", but the
  // open-question generator ADDS facets during the run — a plan that grows while you work it can
  // never be finished. Measured: targets ending on the pass cap went 27% → 83%, and the saturation
  // signal died, so "done" and "out of budget" became indistinguishable.
  ok(/added nothing new about .* and the questions that remain are ones its sources plainly cannot answer/.test(withPlan),
    'an exhausted-sources escape exists, so saturation is not unreachable-by-construction');
  ok(/EITHER is true/.test(withPlan), 'and the two doors are stated as alternatives, not a single bar');
  ok(/neither does an open list you have no way to close/.test(withPlan),
    'the escape is bounded — it is exhaustion, not permission to stop early');

  // The ladder is still RIGHT for a cold prospecting target — it was only ever wrong as an override.
  const noPlan = r.buildDeepenPrompt({ goal: 'profile this firm', target: 'Acme Corp' });
  ok(/in priority order: \(1\) named leadership/.test(noPlan),
    'with NO plan the contact-first ladder remains (unchanged for cold prospecting)');
  ok(/what it is, its people, how to reach it/.test(noPlan),
    'and so does its saturation test');

  // Orthogonal discipline must survive BOTH paths — these are what keep the pass grounded.
  for (const [p, label] of [[withPlan, 'plan'], [noPlan, 'no-plan']]) {
    ok(/EXHAUST a good source/.test(p) && /NEVER use initials/.test(p) && /FACET: <the facet you added this pass>/.test(p),
      `source-exhaustion, the no-initials rule and the FACET line all survive (${label} path)`);
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
