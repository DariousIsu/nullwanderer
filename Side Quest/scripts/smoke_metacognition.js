/* Smoke: lib/metacognition — calibrated confidence (self-awareness Layer 3).
 * Pure/deterministic (plain rows, no model/DB). Guards: factual question + no grounding →
 * admit-the-gap directive; partial → separate-known-from-inferred; rich or non-factual → silent
 * (no over-hedging).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_metacognition.js
 */
const m = require('../lib/metacognition');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- classifyClaimType: factual vs other ---
ok(m.classifyClaimType('who is the current president') === 'factual', 'who-is question → factual');
ok(m.classifyClaimType('what did we decide about the Maastricht treaty') === 'factual', 'shared-history fact → factual');
ok(m.classifyClaimType('when is my meeting with Russ') === 'factual', 'when-is question → factual');
ok(m.classifyClaimType("what's your favorite color") === 'other', 'taste question → other (her own to decide)');
ok(m.classifyClaimType('how are you tonight?') === 'other', 'social → other');
ok(m.classifyClaimType('explain how STDP works') === 'other', 'concept explanation → other (core model job)');
ok(m.classifyClaimType('write me a short poem') === 'other', 'creative command → other');
ok(m.classifyClaimType('what do you think about permitting reform') === 'other', 'opinion → other');

// --- the imperative retrieval ask (live fall 2026-07-23: no '?', no interrogative word → 'other'
// → the whole grounding ladder went dark while the store held 1,676 Iran stories) ---
ok(m.classifyClaimType('Just give me the latest new on Iran, I know the other strait in the region got partially closed') === 'factual',
  'the live Iran ask, verbatim (imperative, typo and all) → factual');
ok(m.classifyClaimType('give me the latest on the war') === 'factual', 'imperative "the latest on X" → factual');
ok(m.classifyClaimType('catch me up on the tariff situation') === 'factual', 'catch-me-up → factual');
ok(m.classifyClaimType('summarize the news on Iran') === 'factual', 'currency object OUTRANKS the creative gate — summarizing news is retrieval');
ok(m.classifyClaimType('write me a short poem about the sea') === 'other', 'creative stays creative when nothing current is asked for');
ok(m.classifyClaimType('what do you think about the news coverage of you AIs') === 'other', 'opinion still outranks currency — her take is hers');

// --- assessGrounding: rich / thin / none ---
ok(m.assessGrounding({ knowledgeRows: [{ source: 'verified_fact', content: 'x' }] }).level === 'rich', 'a verified_fact → rich');
ok(m.assessGrounding({ knowledgeRows: [{ source: 'personal_fact', content: 'Alice' }] }).level === 'rich', 'a personal_fact → rich');
ok(m.assessGrounding({ selfRows: [{ epistemic: 'told', content: 'x' }] }).level === 'rich', 'a told self-fact → rich');
ok(m.assessGrounding({ knowledgeRows: [{ source: 'note', content: 'x' }] }).level === 'thin', 'a loose note → thin');
ok(m.assessGrounding({ pastTurns: [{ content: 'we talked about X' }] }).level === 'thin', 'a relevant past turn → thin');
ok(m.assessGrounding({}).level === 'none', 'nothing retrieved → none');

// --- buildDirective: behavior matches level + scope ---
const dCur = m.buildDirective({ level: 'none', claimType: 'factual', scope: 'current', userName: 'Lucas' });
ok(/look it up|search|verify/i.test(dCur), 'none + current → verify/search the live specifics, don\'t state from memory');
const dPers = m.buildDirective({ level: 'none', claimType: 'factual', scope: 'personal', userName: 'Lucas' });
ok(/told you|mentioned/i.test(dPers), 'none + personal → forbids fake "you told/mentioned"');
ok(/general knowledge/i.test(dPers), 'none + personal → still permits a general-knowledge fallback');
ok(m.buildDirective({ level: 'none', claimType: 'factual', scope: 'general' }) === null, 'none + general → NO directive (never suppress general knowledge)');
const dThin = m.buildDirective({ level: 'thin', claimType: 'factual', scope: 'current' });
ok(/what you KNOW from what you'?re INFERRING/i.test(dThin), 'thin → separate known from inferred');
ok(m.buildDirective({ level: 'rich', claimType: 'factual', scope: 'current' }) === null, 'rich → no directive (no over-hedging)');
ok(m.buildDirective({ level: 'none', claimType: 'other' }) === null, 'non-factual → no directive even with no grounding');

// --- groundingDirective end-to-end (the live wiring contract) ---
ok(m.groundingDirective({ userMessage: 'who is the current president', knowledgeRows: [], pastTurns: [] }) !== null,
  'unfamiliar current-event with no memory → directive fires');
ok(m.groundingDirective({ userMessage: 'who is the current president', knowledgeRows: [{ source: 'verified_fact', content: 'x' }] }) === null,
  'same question WITH a verified fact → no directive (she\'s grounded)');
ok(m.groundingDirective({ userMessage: "what's your favorite color", knowledgeRows: [] }) === null,
  'taste question → never a calibration directive');
ok(m.groundingDirective({ userMessage: 'how are you', knowledgeRows: [] }) === null,
  'social turn → never a calibration directive');

// --- grounding SCOPE: general world knowledge must NOT be suppressed (the over-hedging regression) ---
ok(m.groundingScope('what is the price of oil today') === 'current', 'current/live → current scope');
ok(m.groundingScope('what did we decide about the schedule') === 'personal', 'shared-history → personal scope');
ok(m.groundingScope('who was Zoe Barnes as a character, was she daring or meek') === 'general', 'famous fictional character → general scope');
ok(m.groundingScope('who painted the Mona Lisa') === 'general', 'general history/knowledge → general scope');
ok(m.groundingDirective({ userMessage: 'who was Zoe Barnes, was she daring or meek or sexy', knowledgeRows: [], pastTurns: [] }) === null,
  'general-knowledge question with no retrieval → NO directive (she answers from training, not "I only know what we discussed")');
ok(m.groundingDirective({ userMessage: 'what did we decide last time about the schedule', knowledgeRows: [], pastTurns: [] }) !== null,
  'personal/shared-history with no memory → directive STILL fires (don\'t invent shared history)');
ok(/general knowledge/i.test(m.groundingDirective({ userMessage: 'what did we agree on', knowledgeRows: [], pastTurns: [] }) || ''),
  'the personal directive explicitly permits a general-knowledge fallback');

// --- DATE/TIME carve-out (the RAG over-refusal regression: she refused the date she HELD in awareness) ---
ok(m.groundingScope('what is the date today') === 'general', 'date question → general (she has it in the awareness block, no suppression)');
ok(m.groundingScope("what's the date today?") === 'general', "what's the date today → general");
ok(m.groundingScope('what time is it') === 'general', 'time question → general');
ok(m.groundingScope('what day is it today') === 'general', 'day-of-week question → general');
ok(m.groundingScope('what month is it') === 'general', 'month question → general');
ok(m.groundingDirective({ userMessage: 'what is the date today', knowledgeRows: [], pastTurns: [] }) === null,
  'date question with no retrieval → NO hedge directive (she must just state the date she holds)');
ok(m.groundingDirective({ userMessage: 'what time is it right now', knowledgeRows: [], pastTurns: [] }) === null,
  'time question → NO hedge directive even with "right now" present');
// guard against over-broadening: live facts that merely CONTAIN a date word must STILL be guarded
ok(m.groundingScope("what's the weather today") === 'current', 'weather today → STILL current (needs a tool, not the carve-out)');
ok(m.groundingScope("what's today's news") === 'current', "today's news → STILL current");
ok(m.groundingScope('what is the price of oil today') === 'current', 'price today → STILL current (carve-out did not swallow it)');
// ELECTION / OFFICE-TRANSITION RECENCY (the "who did the UK JUST ELECT PM?" → stale "Keir Starmer" fix):
// these are LIVE facts CURRENT_RE missed and answered from the model's training cutoff. Must be 'current'.
ok(m.groundingScope('who did the UK just elect to prime minister?') === 'current', 'election recency: "who did X just elect PM" → current (was general)');
ok(m.groundingScope('Starmer is gone, they just elected a new one like 12 hours ago?') === 'current', 'correction w/ recency: "they just elected a new one" → current');
ok(m.groundingScope("who's the new pope?") === 'current', 'new office-holder: "who\'s the new pope" → current');
ok(m.groundingScope('did the governor just resign?') === 'current', 'transition: "did the governor just resign" → current');
ok(m.groundingScope('who did the UK elect PM?') === 'current', 'election (no "just"): "who did X elect PM" → current');
// FP guards: ordinary "just"/"new" must NOT be dragged into 'current'.
ok(m.groundingScope('who painted the Mona Lisa') === 'general', 'FP guard: timeless art → still general');
// The property that matters: ordinary "just"/"new" must NOT be dragged into CURRENT (a live-fact confabulation).
ok(m.groundingScope('I just wanted to name my new project') !== 'current', 'FP guard: "just...name...new project" → NOT current');
ok(m.groundingScope('what should I name my new puppy') !== 'current', 'FP guard: "name my new puppy" → NOT current');

// --- ACTION HONESTY (the "I watched the clips" confabulation guard) ---
ok(m.detectActionRequest('pull up clips of Zoe Barnes from house of cards on youtube, turn CC on') === 'media',
  'watch-media request detected as media');
ok(m.detectActionRequest('can you look up the price of oil') === 'lookup',
  'lookup request detected as lookup');
ok(m.detectActionRequest('what do you think about House of Cards?') === null,
  'a plain opinion question is NOT an action request (no fabrication guard needed)');
ok(m.detectActionRequest('good morning') === null, 'small talk → not an action request');
const adir = m.actionHonestyDirective({ userMessage: 'pull up some youtube clips and watch them', userName: 'Lucas' });
ok(adir && /fabrication|do NOT describe/i.test(adir), 'media action → directive forbids narrating fake results');
ok(/cannot search YouTube|paste|link/i.test(adir), 'directive offers the honest alternative (paste a link)');
ok(m.actionHonestyDirective({ userMessage: 'how are you today' }) === null, 'non-action turn → no action directive');

// --- MEETING-ACTION HONESTY (the "Joining the Google Meet now" confab, 2026-07-24) ---
ok(m.mentionsMeeting('The BGov meeting you just need to be ready to show off a little'), 'mentionsMeeting: the live confab trigger ("...meeting...")');
ok(m.mentionsMeeting('when is my call with Sam?'), 'mentionsMeeting: "call"');
ok(m.mentionsMeeting('are we still on for the Teams sync?'), 'mentionsMeeting: teams/sync');
ok(!m.mentionsMeeting('what is the price of oil today'), 'mentionsMeeting: unrelated → false');
ok(!m.mentionsMeeting('good morning'), 'mentionsMeeting: greeting → false');
// the exact confab that shipped this morning
ok(m.claimsMeetingAction('Joining the Google Meet now.'), 'claimsMeetingAction: the exact confab "Joining the Google Meet now"');
ok(m.claimsMeetingAction("I'm hopping on the call."), 'claimsMeetingAction: hopping on the call');
ok(m.claimsMeetingAction('Jumping in now.'), 'claimsMeetingAction: jumping in');
ok(m.claimsMeetingAction("I'm in the meeting now."), 'claimsMeetingAction: in the meeting now');
ok(!m.claimsMeetingAction('The meeting is at 10:00 on Teams.'), 'claimsMeetingAction: stating a fact ≠ claiming to join');
ok(!m.claimsMeetingAction('Want me to join when you send the link?'), 'claimsMeetingAction: offering ≠ claiming');
const mdir = m.meetingActionHonestyDirective('Lucas');
ok(/NOT in a meeting|not (in|joining)/i.test(mdir) && /Lucas/.test(mdir), 'directive: states she is not in/joining, addressed to Lucas');
ok(/Teams meeting isn'?t something you can join yet|link/i.test(mdir), 'directive: honest alternative (needs a link; Teams not joinable yet)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
