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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
