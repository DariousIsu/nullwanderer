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

// --- advice / suggestion / subjective-quality → other (Lucas 2026-08-18 over-routing finding: soft
// "what's a good way to / what makes X feel Y / any tips for" questions were routing to lookup and
// spinning the operator/web-search for knowledge she already holds) ---
ok(m.classifyClaimType('What is one small thing that makes a workspace feel calm?') === 'other', 'subjective-quality "makes X feel Y" → other');
ok(m.classifyClaimType("What's a good way to ease into a morning?") === 'other', 'advice "good way to" → other');
ok(m.classifyClaimType('What makes a cup of coffee taste good?') === 'other', 'subjective-quality "makes X taste …" → other');
ok(m.classifyClaimType('Any tips for staying focused while working from home?') === 'other', 'advice "any tips for" → other');
// controls — the SAFE direction: real factual questions STILL route factual (no under-routing regression)
ok(m.classifyClaimType('What is the capital of France?') === 'factual', 'a real fact stays factual');
ok(m.classifyClaimType("What are Bill Cassidy's two most recent bills?") === 'factual', 'external lookup stays factual');
ok(m.classifyClaimType('what makes the stock market go up?') === 'factual', 'CAUSAL "what makes X happen" (no sensory word) stays factual — the net is tight');

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

// --- ARTIFACT-CLAIM VERIFICATION (file / canvas) ---
const FE_NO = () => false, FE_YES = () => true, CW_NO = () => false, CW_YES = () => true, IG_NO = () => false, IG_YES = () => true;
ok(m.verifyArtifactClaims('The dossier is saved at notes/x.md', { fileExists: FE_NO }).violations.some(v => v.kind === 'file'),
  'file: "saved at notes/x.md" + file missing → violation');
ok(m.verifyArtifactClaims('The dossier is saved at notes/x.md', { fileExists: FE_YES }).ok,
  'file: same claim but file EXISTS → ok');
ok(m.verifyArtifactClaims("I'll save it to notes/x.md", { fileExists: FE_NO }).ok,
  'file: FUTURE intent ("I\'ll save it") → not a falsifiable claim, no violation');
ok(m.verifyArtifactClaims('I put 994 contacts on your canvas', { canvasWroteThisTurn: CW_NO }).violations.some(v => v.kind === 'canvas'),
  'canvas: "put ... on your canvas" + no write → violation');
ok(m.verifyArtifactClaims('I put 994 contacts on your canvas', { canvasWroteThisTurn: CW_YES }).ok,
  'canvas: same claim WITH a write this turn → ok');
// PHRASING GAP (2026-08-17, the #12338 fabrication): "It's on your canvas now" slipped past — the verb regex
// had "is on" but not "'s on". Both straight and curly apostrophes (the cloud writer re-voices with U+2019).
ok(m.verifyArtifactClaims("It's on your canvas now.", { canvasWroteThisTurn: CW_NO }).violations.some(v => v.kind === 'canvas'),
  'canvas: "It\'s on your canvas" (straight apostrophe) + no write → violation (the phrasing-gap fix)');
ok(m.verifyArtifactClaims('It’s on your canvas now.', { canvasWroteThisTurn: CW_NO }).violations.some(v => v.kind === 'canvas'),
  'canvas: curly-apostrophe "It’s on your canvas" + no write → violation too');
ok(m.verifyArtifactClaims("It's on your canvas now.", { canvasWroteThisTurn: CW_YES }).ok,
  'canvas: "It\'s on your canvas" WITH a write → ok (no false scold)');
// CONTENT-AWARE (2026-08-17, the #12338 wrong-doc): a write landed but the WRONG doc — the claim's proper-noun
// anchor absent from the landed text → violation; present → ok (no false scold); no probe → fail-open.
ok(m.verifyArtifactClaims('I put the Louisiana elected-official contacts on your canvas', { canvasWroteThisTurn: CW_YES, canvasLandedText: () => 'Inquiry — Which layer is causing the dispatch-timeout failure' }).violations.some(v => v.kind === 'canvas'),
  'canvas content: a write landed but the WRONG doc (no "Louisiana" in it) → violation (the #12338 catch)');
ok(m.verifyArtifactClaims('I put the Louisiana elected-official contacts on your canvas', { canvasWroteThisTurn: CW_YES, canvasLandedText: () => 'Louisiana officials — Baton Rouge, Shreveport, Monroe; 183 rows with emails' }).ok,
  'canvas content: a write landed with the RIGHT doc (contains "Louisiana") → ok (no false scold)');
ok(m.verifyArtifactClaims('I put the Louisiana contacts on your canvas', { canvasWroteThisTurn: CW_YES }).ok,
  'canvas content: no landed-text probe → fail OPEN (unchanged behavior)');
ok(m.verifyArtifactClaims('I put the list on your canvas', { canvasWroteThisTurn: CW_YES, canvasLandedText: () => 'some entirely unrelated doc content here' }).ok,
  'canvas content: claim has NO proper-noun anchor → no violation (never scold a generic claim)');
// FALSE-SCOLD FIXES (2026-08-17 adversarial): must NOT scold a real multi-doc / image delivery. Landed text
// UNIONS every this-turn doc; the check ABSTAINS when an image rendered.
ok(m.verifyArtifactClaims('The Cleco brief is on your canvas.', { canvasWroteThisTurn: CW_YES, canvasLandedText: () => 'Cleco — rate case brief. Entergy — merger brief.' }).ok,
  'canvas content: multi-doc turn — claim about doc A finds its anchor in the UNION → no false scold');
ok(m.verifyArtifactClaims("I drew the Gonzalez portrait — it's on your canvas.", { canvasWroteThisTurn: CW_YES, imageGenThisTurn: () => true, canvasLandedText: () => 'Acme Q3 revenue table with many rows' }).ok,
  'canvas content: an IMAGE rendered this turn → abstain (image has no matchable text) → no false scold');
ok(m.verifyArtifactClaims('I put the Louisiana contacts on your canvas', { canvasWroteThisTurn: CW_YES, imageGenThisTurn: () => false, canvasLandedText: () => 'Inquiry — dispatch-timeout failure analysis' }).violations.some(v => v.kind === 'canvas'),
  'canvas content: no image + wrong doc (no "Louisiana") still caught (#12338)');

// --- F24 (run-2b gap-fill 4): a PAST-TIME reference is about a PRIOR delivery — never a this-turn scold ---
ok(m.verifyArtifactClaims('I saved the diagnostics to your canvas about ten minutes ago.', { canvasWroteThisTurn: CW_NO }).ok,
  'F24: "saved to your canvas … minutes ago" + no write THIS turn → ok (the live false-scold)');
ok(m.verifyArtifactClaims('The brief landed on your canvas earlier tonight.', { canvasWroteThisTurn: CW_NO }).ok,
  'F24: "on your canvas earlier" → past reference, no violation');
ok(m.verifyArtifactClaims('It\'s already on your canvas from last session.', { canvasWroteThisTurn: CW_NO }).ok,
  'F24: "already … last session" → past reference, no violation');
ok(m.verifyArtifactClaims('I put the table on your canvas just now.', { canvasWroteThisTurn: CW_NO }).violations.some(v => v.kind === 'canvas'),
  'F24 guard: a THIS-turn claim ("just now") with no write still violates — the exemption is not a hole');

// --- F18 (run-2): a bare DB EXISTENCE reference is NOT a write claim — the write probe must not judge it ---
const DBW_NO = () => false, DBW_YES = () => true;
ok(m.verifyArtifactClaims('Kim Brondyke is in my database — I have her on file.', { dbWroteThisTurn: DBW_NO }).ok,
  'F18: "X is in my database" (existence) + no write this turn → ok (the live false-scold on entities #1605541)');
ok(m.verifyArtifactClaims("He's in the CRM with a Baton Rouge address.", { dbWroteThisTurn: DBW_NO }).ok,
  'F18: "he\'s in the CRM" (existence) → no violation');
ok(m.verifyArtifactClaims('Tom is now in the contacts database.', { dbWroteThisTurn: DBW_NO }).violations.some(v => v.kind === 'db'),
  'F18 guard: "is NOW in the contacts database" is a completed-write claim → still violates with no write');
ok(m.verifyArtifactClaims('I added Tom Arceneaux to the contacts database.', { dbWroteThisTurn: DBW_NO }).violations.some(v => v.kind === 'db'),
  'F18 guard: a write-verb claim ("added to the contacts database") still violates with no write');
ok(m.verifyArtifactClaims('I added Tom Arceneaux to the contacts database.', { dbWroteThisTurn: DBW_YES }).ok,
  'F18 guard: same write claim WITH a landed write → ok');
ok(m.verifyArtifactClaims('I added her to the CRM a couple of hours ago.', { dbWroteThisTurn: DBW_NO }).ok,
  'F18+F24: a PAST-referenced write ("a couple of hours ago") → prior turn\'s work, no this-turn scold');

// --- IMAGE anti-fab (the #10872 "…Generating now." confab; no generation ran) ---
const SOCCER = "Got it — more realistic. I'll push the soccer image toward photorealism. Generating now.";
ok(m.verifyArtifactClaims(SOCCER, { imageGenThisTurn: IG_NO }).violations.some(v => v.kind === 'image'),
  'image: the exact #10872 "Generating now" (image ctx, no gen) → violation');
ok(m.verifyArtifactClaims(SOCCER, { imageGenThisTurn: IG_YES }).ok,
  'image: same reply but a real image DID render this turn → ok');
ok(m.verifyArtifactClaims('I generated that image for you.', { imageGenThisTurn: IG_NO }).violations.some(v => v.kind === 'image'),
  'image: create-verb + noun, no gen → violation (tier 1)');
ok(m.verifyArtifactClaims('I generated that image for you.', { imageGenThisTurn: IG_YES }).ok,
  'image: create-verb + noun WITH a gen → ok');
ok(m.verifyArtifactClaims("Here they come — three portraits. Putting them on your canvas now.", { imageGenThisTurn: IG_NO }).violations.some(v => v.kind === 'image'),
  'image: "here they come / on your canvas" (portrait ctx), no gen → violation (tier 2)');
ok(m.verifyArtifactClaims('I can generate that image once it\'s enabled.', { imageGenThisTurn: IG_NO }).ok,
  'image: FUTURE/capability ("I can generate") → not falsifiable, no violation');
ok(m.verifyArtifactClaims('There are over 14,000 stock photos of puppies you can browse.', { imageGenThisTurn: IG_NO }).ok,
  'image: honest search result ("stock photos", no create/progress verb) → no false positive');
ok(m.verifyArtifactClaims('I updated the chart on your canvas.', { imageGenThisTurn: IG_NO, canvasWroteThisTurn: CW_YES }).ok,
  'image: chart on canvas (no image noun) → NOT an image violation');
// correction copy mentions image
ok(/image/i.test(m.artifactCorrection([{ kind: 'image', claim: 'x' }])), 'artifactCorrection: image violation → correction names the image');
ok(m.artifactCorrection([]) === '', 'artifactCorrection: no violations → empty string');

// --- SPINE 2: ABSENCE (false-blank) — the parish §7.1 case: "couldn't find an email" WITHOUT searching ---
const GATHER_NO = () => false, GATHER_YES = () => true;
ok(m.groundAbsence("I couldn't find an email address for Mayor Arceneaux.", { gatherRanThisTurn: GATHER_NO }).violations.some(v => v.kind === 'absence'),
  'absence: "couldn\'t find an email" + NO gather this turn → violation (the §7.1 false-blank)');
ok(m.groundAbsence("I couldn't find an email address for Mayor Arceneaux.", { gatherRanThisTurn: GATHER_YES }).ok,
  'absence: same claim WITH a gather this turn → honest absence, no violation');
ok(m.groundAbsence('No email is listed for him in any public record.', { gatherRanThisTurn: GATHER_NO }).violations.some(v => v.kind === 'absence'),
  'absence: record-noun branch ("no email is listed") + no gather → violation');
ok(m.groundAbsence('The phone number isn\'t publicly available.', { gatherRanThisTurn: GATHER_NO }).violations.some(v => v.kind === 'absence'),
  'absence: "phone number isn\'t publicly available" + no gather → violation');
ok(m.groundAbsence("I couldn't find it.", { gatherRanThisTurn: () => { throw new Error('probe down'); } }).ok,
  'absence: probe THROWS → fails OPEN (no false scold)');
ok(m.groundAbsence("I couldn't find it.", {}).ok,
  'absence: no probe injected → nothing to check, ok');
// FP guards — generic negatives are NOT lookup-absence claims
ok(m.groundAbsence('No problem — I\'ll take care of that.', { gatherRanThisTurn: GATHER_NO }).ok,
  'absence FP: "no problem" → not an absence claim');
ok(m.groundAbsence("There's no easy answer to that question.", { gatherRanThisTurn: GATHER_NO }).ok,
  'absence FP: "no easy answer" → not an absence claim');
ok(m.groundAbsence('No doubt he\'ll respond soon.', { gatherRanThisTurn: GATHER_NO }).ok,
  'absence FP: "no doubt" → not an absence claim');
ok(m.groundAbsence("I'll try to find an email for him.", { gatherRanThisTurn: GATHER_NO }).ok,
  'absence: FUTURE intent ("I\'ll try to find") → not a blank claim, no violation');
// correction copy
ok(/search|look/i.test(m.verificationCorrection([{ kind: 'absence', claim: 'x' }])), 'verificationCorrection: absence → correction says she didn\'t actually search');
ok(m.verificationCorrection([]) === '', 'verificationCorrection: no violations → empty string');

// --- SPINE 2: PRESENCE (confabulation) — the Cleco case: a current-event fact absent from evidence ---
const CLECO = 'Cleco was acquired by Stonepeak Infrastructure Partners and Bernhard Capital last year.';
const EV_ABOUT_CLECO_NO_DEAL = 'User asked: what is going on with Cleco Power in Louisiana? We found several 2025 rate-case filings and outage reports for Cleco.';
const gf1 = m.groundFacts(CLECO, { evidence: EV_ABOUT_CLECO_NO_DEAL });
ok(gf1.violations.some(v => v.kind === 'fact'), 'presence: acquisition claim whose acquirers are NOT in evidence → violation (the Cleco confab)');
ok(gf1.violations[0] && /Stonepeak|Bernhard/i.test((gf1.violations[0].novelTerms || []).join(' ')), 'presence: the novelTerms name the unsupported specifics (Stonepeak/Bernhard)');
ok(m.groundFacts(CLECO, { evidence: 'A press release confirms Cleco was acquired by Stonepeak Infrastructure Partners and Bernhard Capital in a deal announced last year.' }).ok,
  'presence: same claim WITH the acquirers present in evidence → grounded, ok');
ok(m.groundFacts(CLECO, { evidence: 'short' }).ok,
  'presence: thin evidence (<40ch) → abstain (bare recall is the step-3b verify path, not a scold)');
ok(m.groundFacts("I'll check whether Cleco was acquired by anyone.", { evidence: EV_ABOUT_CLECO_NO_DEAL }).ok,
  'presence: FUTURE intent → not a falsifiable claim, no violation');
ok(m.groundFacts('The weather in Baton Rouge is mild today and the roads are clear.', { evidence: EV_ABOUT_CLECO_NO_DEAL }).ok,
  'presence FP: no current-event predicate → not a checkable claim, no violation');
ok(m.groundFacts('Governor Jeff Landry signed the bill into law on Tuesday.', { evidence: 'Coverage confirms Governor Jeff Landry signed the bill Tuesday after the House vote.' }).ok,
  'presence FP: a real event fully supported by evidence → no violation');
ok(m.groundFacts('Cleco was acquired by Stonepeak and Bernhard Capital.', { evidence: 'A press release confirms Cleco was acquired by Stonepeak Infrastructure Partners and Bernhard Capital in a deal announced last year.' }).ok,
  'presence FP (live-drive regression): a SHORTER "X and Y" claim grounds against a LONGER "X Extra Words and Y" evidence — the two firms ground individually, no "and"-bridge brittleness');
ok(/unconfirmed|verify/i.test(m.verificationCorrection([{ kind: 'fact', claim: 'x', novelTerms: ['Stonepeak'] }])), 'verificationCorrection: fact → correction flags it unconfirmed and names the term');

// --- SPINE 2: PREDICTION (false certainty) — the §7.6 wrong-prediction: an outcome stated as fact ---
ok(m.groundPrediction('The incumbent will win the runoff easily.').violations.some(v => v.kind === 'prediction'),
  'prediction: "will win" with no hedge → violation (the §7.6 false certainty)');
ok(m.groundPrediction('Landry is going to lose that seat.').violations.some(v => v.kind === 'prediction'),
  'prediction: "going to lose" a seat, flat → violation');
ok(m.groundPrediction('The incumbent will likely win the runoff.').ok,
  'prediction: same outcome WITH a hedge ("likely") → honest, no violation');
ok(m.groundPrediction('I\'d put the incumbent\'s odds of winning around 70%.').ok,
  'prediction: framed as odds/probability → honest, no violation');
ok(m.groundPrediction('The incumbent will win.', { forecastCited: true }).ok,
  'prediction: backed by a cited forecast → honest, no violation');
ok(m.groundPrediction('The meeting will start at 3pm and I will send you the notes.').ok,
  'prediction FP: ordinary "will" (no contest-outcome verb) → not a prediction claim');
ok(m.groundPrediction('The bill passed the House on Tuesday.').ok,
  'prediction FP: a PAST event ("passed"), not a future claim → no violation');
// F26 (boot_p53 retest, turn 12737): the NOUN "pass" (test pass, review pass) matched the outcome-VERB net —
// a conversational echo of the user's own plan drew "[Correction — I stated a future outcome as certain…]".
ok(m.groundPrediction("Got it — you're talking with Claude now, and Lucas will be back once the test pass wraps. Sounds good, I'm here.").ok,
  'F26 REGRESSION: the verbatim live scold — "the test pass wraps" is a noun, not a prediction');
ok(m.groundPrediction('The review pass will take an hour and the smoke pass will follow.').ok,
  'F26: "review pass"/"smoke pass" compounds never trip the net');
ok(m.groundPrediction('The bill will pass the Senate.').violations.some(v => v.kind === 'prediction'),
  'F26 guard: the VERB "will pass" (a real contest outcome) still fires');
ok(m.groundPrediction('SB200 is going to pass.').violations.some(v => v.kind === 'prediction'),
  'F26 guard: "going to pass" still fires');
ok(/expectation|certainty|probabilit/i.test(m.verificationCorrection([{ kind: 'prediction', claim: 'x' }])), 'verificationCorrection: prediction → reframes as expectation/probability, not certainty');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
