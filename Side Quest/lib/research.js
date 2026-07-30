/**
 * research — the DEPTH-FIRST loop logic for a directed research run.
 *
 * The first driver was breadth-first + one-and-done: pick an org, ONE pass, next org. Lucas wanted it
 * to FOLLOW a target until a decent share of the material on it is gathered before moving on, and for
 * the data to be ORGANIZED with cloud passes as it goes (not only at the end). This module is the pure
 * brain of that two-level loop: parse a pass's control lines, decide whether to keep deepening the
 * current target or advance, estimate how much NEW material a pass added, and build the three prompts
 * (new-target overview / deepen-a-facet / organize-one-target). All I/O (operator + reasoner cloud
 * calls, file, db) lives in main.js; this stays pure + offline-testable.
 */
'use strict';

const MAX_PASSES_PER_TARGET = 6;   // depth cap per org in a MULTI-org run — "a decent percentage", not infinite
const MAX_PASSES_DEEP_TARGET = 12; // a SINGLE bounded deep target may work each facet (6-facet brief needs >6); throttled 18→12 so one target can't grind endlessly
const MAX_PASSES_REFUSAL = 16;     // REFUSAL mode (dossier beats) deep-dives to exhaustion, but a SOFT per-target cap (throughput tune) so one never-drying office can't monopolize the serial single-focus engine — 16 passes is still a deep dossier (~16k+ chars); the 2-dry-pass "well is dry" signal advances most finite rosters far sooner, and news-maintenance re-visits later
const MAX_PASSES_VALIDATE = 3;     // VALIDATION mode (leash slice B): official roster + one corroborator + change check, then MOVE ON — the sweep validates officials, it never grinds dossiers
const MIN_NEW_CHARS = 220;         // a deepen pass adding less than this = diminishing returns (one "dry" pass)

// Parse one research pass. The prompts make the operator end with a control line:
//   TARGET: <org>   (new-target pass)   |   FACET: <what was added>   (deepen pass)
//   SATURATED       (target well-covered)   |   ALL-COVERED   (whole universe done)
function parsePass(answer) {
  const ans = String(answer || '').trim();
  const allCovered = /\bALL[-\s]?COVERED\b/i.test(ans);
  const saturated = /\bSATURATED\b/i.test(ans);
  const tm = ans.match(/^\s*TARGET:\s*(.+?)\s*$/im);
  const fm = ans.match(/^\s*FACET:\s*(.+?)\s*$/im);
  const clean = (s) => String(s || '').trim().replace(/[*_#`]/g, '').slice(0, 80);
  const target = tm ? clean(tm[1]) : '';
  const facet = fm ? clean(fm[1]) : '';
  const body = ans
    .replace(/^\s*(?:TARGET|FACET):.*$/gim, '')
    .replace(/\bALL[-\s]?COVERED\b/i, '')
    .replace(/\bSATURATED\b/i, '')
    // strip any leaked operator control JSON ({"thought":…,"action":…}) so it never reaches the
    // deliverable file (the line-30 `{"thought":…}` blob misattributing a CEI fact to Heritage).
    .replace(/\{[^{}]*"(?:thought|action)"[^{}]*\}/gi, '')
    .trim();
  return { target, facet, saturated, allCovered, body };
}

// How much of `body` is genuinely NEW vs what we already gathered for this target — a cheap repeat
// detector so a pass that just restates known material counts as diminishing returns.
function newContentChars(existing, body) {
  const ex = String(existing || '');
  const segs = String(body || '').split(/[\n.]+/).map(s => s.trim()).filter(s => s.length > 20);
  if (!ex) return segs.reduce((n, s) => n + s.length, 0);
  let novel = 0;
  for (const s of segs) if (!ex.includes(s)) novel += s.length;
  return novel;
}

// Stay on the target or advance to the next one. Advance when the model says it's SATURATED, when a pass
// (after the first couple) stops adding meaningful new material, or when the depth cap is hit. FACET-AWARE:
// a SINGLE bounded deep target (deep=true) with facets STILL uncovered keeps deepening past the base cap
// (up to MAX_PASSES_DEEP_TARGET) as long as passes stay productive — a 6-facet brief needs more than 6
// passes, and the flat cap was force-finalizing a half-covered doc (#3364). Diminishing-returns still
// self-limits, so a genuinely sparse 1-person company bows out early instead of grinding "not found".
function decideAdvance({ passes = 1, newChars = 0, saturated = false, uncovered = 0, deep = false, refusal = false, validate = false, dryStreak = 0, maxPasses = MAX_PASSES_PER_TARGET, minNew = MIN_NEW_CHARS } = {}) {
  if (saturated) return { advance: true, reason: 'saturated' };
  // VALIDATION mode (leash slice B, Lucas 2026-07-29): the autonomic elected sweep confirms WHO holds
  // every office and flags changes — it does not build per-person dossiers. One overview pass + up to
  // two confirm/corroborate passes; a pass that adds nothing after the corroboration means we're done.
  if (validate) {
    if (passes >= MAX_PASSES_VALIDATE) return { advance: true, reason: 'validated (pass cap)' };
    if (passes >= 2 && newChars < minNew) return { advance: true, reason: 'validated (nothing new)' };
    return { advance: false, reason: 'keep validating' };
  }
  // REFUSAL mode (dossier beats, Lucas 2026-07-18): deep-dive a board to genuine EXHAUSTION — never advance on
  // a facet-touched-once or an arbitrary pass ceiling, only when the well is truly dry. "Dry" = TWO consecutive
  // passes that each add < minNew new chars (one thin pass might just be a bad search; two in a row = refusal),
  // or the model declares it saturated. A high runaway guard is the only ceiling.
  if (refusal) {
    if (dryStreak >= 2) return { advance: true, reason: 'exhausted (dry well)' };
    if (passes >= MAX_PASSES_REFUSAL) return { advance: true, reason: 'soft depth cap' };
    return { advance: false, reason: 'keep deepening' };
  }
  if (passes >= 2 && newChars < minNew) return { advance: true, reason: 'diminishing returns' };
  const cap = (deep && uncovered > 0) ? Math.max(maxPasses, MAX_PASSES_DEEP_TARGET) : maxPasses;
  if (passes >= cap) return { advance: true, reason: cap > maxPasses ? 'deep cap' : 'pass cap' };
  return { advance: false, reason: 'keep deepening' };
}

function facetsSummary(facets = []) {
  const f = (Array.isArray(facets) ? facets : []).filter(Boolean);
  return f.length ? f.join('; ') : '(nothing yet)';
}

// --- mid-run CLARIFICATION (Lucas refining the standing task while it runs) -----------------------

// While a directed run is active, decide whether a message is a CLARIFICATION/refinement to fold into
// the task (vs unrelated chatter). Tuned 2026-06-29 after live mis-captures: "Thank you Zoe" was
// captured (assistantAskedQuestion fired on a social reply) and "Rainey Center is a right-of-center
// think tank for example" was MISSED (no imperative keyword). Fix: hard-exclude social/gratitude/ack,
// and broaden the refinement language to catch informative scope statements ("X is a …", "for example",
// "as well", "counts", "consider").
// Refinement vocabulary, SPLIT by strength (2026-07-22, after the second live mis-capture in one
// evening: "it ended up ONLY be me Devon and Joshua" — his meeting-attendance story — was captured as
// Aiken County research guidance because "only" sat in one flat refinement list):
//   STRONG = unambiguous task directives; they stand alone.
//   WEAK   = words that also live in ordinary conversation ("only", "too", "is a"); they capture only
//            when NOT past-tense narrative AND (when the focus goal is known) sharing ≥1 content token
//            with it — "Rainey Center is a right-of-center THINK TANK" overlaps a think-tank goal;
//            a story about who showed up to a meeting overlaps a county-government goal in nothing.
const STRONG_REFINE_RE = /\b(make sure|focus on|prioriti[sz]e|priority|include|exclude|instead|skip|ignore|narrow|broaden|expand|stick to|limit (?:it )?to|make it|don'?t|do not|i want|i'?d like|i need|note that|keep in mind|besides|on top of|but also|prefer)\b/i;
const WEAK_REFINE_RE = /\b(also|as well|in addition|additionally|only|actually|should|add|plus|consider|for example|e\.?g\.?|counts?|is (?:a|an|one)\b|are (?:also|one)\b|too)\b/i;
// Past-tense narrative about people/events — reporting, not directing.
const NARRATIVE_RE = /\b(it (?:ended up|turned out|was|went)|ended up|turned out|we (?:had|were|ended)|there (?:was|were)|showed up|couldn'?t make it|got pulled)\b/i;
const _GOAL_STOP = new Set('the a an of for from and or with this that these those about into onto over under our your their his her its on in to at by as is are was be been do does did not no'.split(/\s+/));
function _goalOverlap(message, goal) {
  const tok = (x) => new Set(String(x || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !_GOAL_STOP.has(w)));
  const m = tok(message), g = tok(goal);
  let n = 0; for (const w of m) if (g.has(w)) n++;
  return n;
}
// Social / gratitude / greeting / pure-ack — NEVER a research clarification (optional trailing name).
const SOCIAL_CLOSER_RE = /^(?:thanks?|thank you|ty|cheers|much appreciated|appreciate it|great|nice|cool|awesome|perfect|ok(?:ay)?|sounds good|got it|gotcha|sure|will do|hi|hey|hello|good (?:morning|night|evening|afternoon)|love you|you'?re the best)\b(?:\s+(?:zoe|so much|a lot|man|dude|babe|then))?[\s!.,]*$/i;
// HER question was SOCIAL (how was your day / how are you / what have you been up to) — an answer to
// it is conversation, not task guidance. The 2026-07-22 live mis-capture: Zoe asked how his day was,
// Lucas answered "Pretty ok, lots of work today…", and the answer-branch below filed it as a research
// clarification for the Aiken County focus (the recurring detector class: the OR-branch fired on ANY
// "?" in her turn, blind to what kind of question it was).
const SOCIAL_QUESTION_RE = /\b(?:how (?:was|is|'s|are) (?:your|the|you)\b|how (?:have|'ve) you been|how(?:'s| is) it going|what (?:did|have) you (?:been )?(?:do(?:ne|ing)?|get up to|been up to)|did you (?:sleep|eat|rest)|how (?:do you|are you) feel)/i;
// An experiential SELF-REPORT reply ("Pretty ok…", "busy day", "tired") — his state, never task scope.
// Checked AFTER REFINE_RE, so "good — but only include the federal ones" still captures.
const SELF_REPORT_RE = /^(?:pretty\b|not (?:bad|great|too bad)|good\b|fine\b|ok(?:ay)?\b|great\b|busy\b|tired\b|exhausted\b|long day|lots of work|rough\b|hectic\b|slow day|same old)/i;
function isClarification({ message = '', assistantAskedQuestion = false, assistantQuestion = '', focusGoal } = {}) {
  const s = String(message).trim();
  if (s.length < 6) return false;
  if (SOCIAL_CLOSER_RE.test(s)) return false;                 // gratitude/greeting/ack ≠ task guidance
  if (STRONG_REFINE_RE.test(s)) return true;                   // an unambiguous directive stands alone
  // Weak refinement words capture only outside narrative, and (when the goal is known) on-topic.
  if (WEAK_REFINE_RE.test(s) && !NARRATIVE_RE.test(s) && (focusGoal === undefined || _goalOverlap(s, focusGoal) >= 1)) return true;
  if (!assistantAskedQuestion) return false;
  // The answer-branch: an answer inherits its KIND from her question.
  if (SOCIAL_QUESTION_RE.test(String(assistantQuestion || ''))) return false;
  if (SELF_REPORT_RE.test(s)) return false;
  // …and its ADDRESS: the answer belongs to the focus only if HER QUESTION was about the focus.
  // Live misroute (2026-07-23): she asked "pasted here or added to a Canvas document?" about the
  // PARISH contact list (a conversation thread), Lucas answered "canvas is perfect, thank you" —
  // and the capture bound it to the ACTIVE focus (#3549, Beaver County UT). Zero distinctive-token
  // overlap between her question and the focus goal means the question came from ANOTHER thread;
  // the answer routes to conversation, never onto the focus's clarification list.
  if (focusGoal !== undefined && _goalOverlap(String(assistantQuestion || ''), focusGoal) < 1) return false;
  return true;
}

// Is the user asking for a STATUS/progress update on the running task? (Concern 1: these were falling
// to the local voice model, which truncates + lacks the real state — they should be answered by a
// frontier model reading the actual progress. Caller gates on "a directed run is active".)
// Broadened (2026-06-29) — the old version missed the most natural phrasings: "How IS the think tank
// project going?" (needs "how's") and "what is the LIST you've done so far". Three shapes: a how-…-going
// progress check (handles "how is/are/'s … going/coming/progressing", words between), explicit status
// words, and a what/which/how-many … done/covered/list enumeration request.
const STATUS_RE = /(\bhow(?:'?s| is| are| has| have)?\b[^?.!]{0,45}\b(?:go(?:ing|ne)|coming|progress(?:ing)?|along|far)\b)|(\b(?:status|update|progress|so far|fill me in|catch me up|where (?:are|r) (?:you|we|u))\b)|(\b(?:what|which|how many)\b[^?.!]{0,45}\b(?:done|covered|researched|finished|found|the list|a list|list of|organi[sz]ations|think tanks|ones)\b)/i;
function isStatusRequest(text) { return STATUS_RE.test(String(text || '')); }

// Render the accumulated clarifications as a guidance block injected into every subsequent pass.
function buildGuidanceBlock(clarifications = []) {
  const c = (Array.isArray(clarifications) ? clarifications : []).filter(Boolean);
  if (!c.length) return '';
  return `ADDITIONAL GUIDANCE FROM LUCAS — incorporate ALL of these into your research from here on (they refine the task):\n${c.map(x => `- ${x}`).join('\n')}`;
}

// --- the three prompts -------------------------------------------------------

// TOPICAL pass (research kind='topical'/'forecast'): research ONE aspect of a SUBJECT for a briefing —
// NOT an org roster, NOT contact hunting. `facet` is the aspect this pass covers; `covered` are the
// aspects already done. The driver advances through the plan's aspects one pass at a time.
function buildTopicalPrompt({ goal = '', facet = '', covered = [], guidance = '' } = {}) {
  const g = guidance ? `\n\n${guidance}` : '';
  const done = (covered && covered.length)
    ? `\n\nASPECTS ALREADY COVERED (do NOT repeat these): ${covered.map(c => String(c)).join('; ')}.`
    : '';
  return `You are researching a SUBJECT for Lucas to produce a BRIEFING. You are NOT profiling organizations and NOT gathering anyone's personal contact details (emails/phones) — this is a subject brief.\n\nSUBJECT / TASK: ${goal}${g}${done}\n\nTHIS PASS: research this ONE aspect of the subject and nothing else — "${facet}". Use web_search / browser_read / echo / recall. Ground EVERY claim in what the tools actually return, name the source inline, and never invent. Write 1-3 tight, substantive paragraphs on this aspect (do NOT compile a leadership roster or chase emails/phones unless the aspect itself is explicitly about contacts).\nIf this aspect is already well covered by what we hold, reply with exactly COVERED.\nEnd with a final line: ASPECT: ${facet}`;
}

// New-target pass: pick ONE not-yet-done org and establish an overview (deepened over later passes).
// COVERAGE LINE — the run's denominator, when it is known. Without it the pass has no idea whether
// it is 9-of-64 or done, which is how a partial run came to be reported as "the complete dossier".
// Omitted entirely when `expected` is falsy: an absent denominator is honest, a guessed one is not.
function coverageLine(covered, expected) {
  const have = Array.isArray(covered) ? covered.length : (Number(covered) || 0);
  const n = Number(expected) || 0;
  if (!n) return '';
  // Clamp when complete: fuzzy coverage matching can push `have` past `n`, and "70 of 64" reads as
  // a bug rather than as done.
  if (have >= n) return `\nCOVERAGE: all ${n} documented — the full set is covered.\n`;
  return `\nCOVERAGE: ${have} of ${n} documented; ${n - have} STILL MISSING. This run is NOT complete until all ${n} are covered — keep going, and never describe what you have as the complete set.\n`;
}

function buildNewTargetPrompt({ goal = '', covered = [], guidance = '', expected = 0 } = {}) {
  const done = (covered && covered.length)
    ? `ORGANIZATIONS ALREADY FULLY DOCUMENTED (do NOT pick any of these again):\n${covered.map(c => `- ${c}`).join('\n')}`
    : 'None documented yet.';
  const g = guidance ? `\n\n${guidance}` : '';
  const cov = coverageLine(covered, expected);
  return `You are researching a standing task for Lucas, ONE organization at a time, in DEPTH.\n\nTASK: ${goal}${g}\n${cov}\n${done}\n\nTHIS PASS: pick ONE specific organization that fits the task and is NOT already documented, and write an OVERVIEW — full name, what it is, its main focus areas — grounded ONLY in what web_search / browser_read / echo / recall actually return (never invent). You will deepen it (staff, contacts, positions) over the next passes, so just establish it now.\nIf EVERY relevant organization is already documented, reply with exactly ALL-COVERED.\nEnd with a final line: TARGET: <the organization name>`;
}

// Object-first open (Slice 2c): the next SEED object to OPEN as a target — one we were handed (resolved
// from the request) that isn't already consumed or covered. Lets a named-entity run start ON the entity
// instead of blind discovery. Pure. Returns the seed object or null.
function pickSeedTarget({ seeds = [], consumed = [], covered = [] } = {}) {
  const lc = s => String(s || '').toLowerCase();
  const used = new Set([...(consumed || []), ...(covered || [])].map(lc));
  return (Array.isArray(seeds) ? seeds : []).find(o => o && o.name && !used.has(lc(o.name))) || null;
}

// Bounded-run TERMINATION (guardrails): are ALL intended targets covered? Fuzzy (case-insensitive + either-
// contains) so "John Curtis (US)" covered satisfies intended "John Curtis". Empty intended → false (an open
// run has no bounded terminus). This is what stops a named-entity assignment from crawling forever.
function allTargetsCovered({ intended = [], covered = [] } = {}) {
  const lc = s => String(s || '').toLowerCase().trim();
  const cov = (covered || []).map(lc).filter(Boolean);
  const want = (intended || []).map(lc).filter(Boolean);
  if (!want.length) return false;
  return want.every(t => cov.some(c => c === t || c.includes(t) || t.includes(c)));
}

// SCOPE DRIFT GUARD — is `target` a single CONCRETE named entity (bounds a run) vs a CATEGORY/discovery
// request (stays open)? "Emergence Water" / "Sen. Mike Lee" → bounded; "right-of-center think tanks" / "all
// the companies" → open. Used when the object-graph seed's salient path misses a novel single company (which
// left scope=open and let a run drift to an adjacent entity once its good first draft was covered). Pure.
const _CATEGORY_RE = /\b(orgs?|organi[sz]ations?|companies|corporations?|institutes?|foundations?|groups?|firms?|think[\s-]?tanks?|nonprofits?|agencies|committees|associations?|councils?|people|everyone|all|each|every|various|several|multiple)\b/i;
function isConcreteTarget(target) {
  const t = String(target == null ? '' : target).trim();
  if (t.length < 2) return false;
  if (_CATEGORY_RE.test(t)) return false;
  return t.split(/\s+/).length <= 6;   // a short proper-noun phrase, not a descriptive category
}

// FACET → TOOLSET map (Slice 3): each research facet drives its FULL array of tools/sources, so "financial"
// pulls the entire FEC/990/USAspending tree and "contacts" runs the Puller pattern (every exec's email
// derived from the domain pattern + verified) — not two web searches. Keyword-matched over the plan's facet
// text; the executor already has these Echo tools. Pure.
const FACET_TOOLSETS = [
  { re: /contact|email|phone|reach|directory|outreach/i, tools: ['the org site /contact & /team pages', 'per-exec email — DERIVE from the domain pattern (first.last@, flast@, first@) and VERIFY', 'kg_neighborhood for known contacts', 'the puller_add tool — BANK each person into Puller as you find them'], note: 'Get EVERY executive: full name, title, work email (pattern-derive + verify), phone. The Puller pattern — never leave a person without at least a pattern-derived email + a confidence note. Call puller_add for each person you find (name+title, email/phone when known, verified:true if from an official source) so Puller learns the email pattern + grades confidence.' },
  { re: /financ|fund|revenue|donor|grant|money|budget|\btax\b/i, tools: ['propublica_nonprofit_search/get (IRS 990)', 'usaspending_search (federal grants & contracts)', 'fec_committee_search + fec_candidate_search (the FULL PAC/donation tree)', 'edgar_full_text_search (SEC)'], note: 'Pull the ENTIRE financial tree — 990s, federal grants/contracts, every affiliated FEC committee and its donations, SEC filings.' },
  { re: /leader|board|executive|founder|staff|\bteam\b|management|director/i, tools: ['search_entities/get_entity (Echo KG)', 'the org /leadership & /about pages', 'per-exec background'], note: 'Name EVERY leader & board member with title + a source.' },
  { re: /affiliat|partner|network|relationship|associat|subsidiar/i, tools: ['kg_neighborhood/kg_query_local (Echo KG relations)', 'opensanctions_search', 'propublica_nonprofit (related orgs)'], note: 'Map all affiliations/partners/subsidiaries from the graph + related-org sources.' },
  { re: /policy|position|project|program|initiative|advocacy|legislat|regulat/i, tools: ['gdelt_article_search & news', 'legiscan_search / fr_search (bills & regs)', 'the org site'], note: 'Recent projects, policy positions, and public advocacy — with dates + sources.' },
  { re: /mission|strateg|overview|background|about|profile|history/i, tools: ['search_documents_semantic (Echo vault — what we already hold)', 'search_entities (KG)', 'the org /about & reputable profiles'], note: 'Mission, strategy, background — ground in what we already hold FIRST.' },
];
function facetToolset(facet) {
  for (const m of FACET_TOOLSETS) if (m.re.test(String(facet == null ? '' : facet))) return { tools: m.tools.slice(), note: m.note };
  return { tools: ['the open web', 'Echo KG (search_entities)'], note: '' };
}
// A coverage directive: every plan facet + the tools to EXHAUST for it. Injected into the deepen pass so the
// executor drives breadth (all facets) AND depth (the full tool array per facet), not a single search. Pure.
function buildCoveragePlan(facets = []) {
  const fs = (Array.isArray(facets) ? facets : []).map((f) => String(f || '').trim()).filter(Boolean);
  if (!fs.length) return '';
  const lines = ['COVERAGE PLAN — the deliverable must cover EVERY facet below; for each, drive the listed tools/sources to EXHAUSTION (do not stop at one web search):'];
  for (const f of fs) { const t = facetToolset(f); lines.push(`• ${f} → ${t.tools.join('; ')}${t.note ? ` — ${t.note}` : ''}`); }
  return lines.join('\n');
}

// Normalize a search query to a token-set SIGNATURE so re-worded permutations of the same search collapse to
// ONE key. "Emergence Water Tyler Breton leadership LinkedIn" and its 8 word-order variants → one signature,
// so the visited-guard + strike detector see them as the SAME search (fixes the permutation-loop evasion:
// she was re-wording the same search each pass to slip past the exact-string dedup). Pure.
const _SIG_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'site', 'www', 'com', 'http', 'https', 'with', 'their', 'his', 'her', 'about', 'search']);
function searchSignature(query) {
  const q = String(query == null ? '' : query).toLowerCase().replace(/^search:\s*/, '').replace(/[^a-z0-9 ]/g, ' ');
  const toks = [...new Set(q.split(/\s+/).filter((w) => w.length >= 3 && !_SIG_STOP.has(w)))].sort();
  return toks.join(' ');
}

// Deepen pass: stay on the current target, pursue the next missing facet, or declare it SATURATED.
// `known` (Slice 2c) = what we ALREADY hold on the target (from our graph) — injected as GIVEN so the pass
// builds PAST it instead of re-deriving the biography we already have (the #2915 fix, deep half).
// `coveragePlan` (Slice 3) = the facet→toolset directive so each facet drives its full tool array.
// `uncovered` = the plan facets NOT yet in the deliverable — pushes her to a NEW facet instead of re-searching
// one she has (the anti-loop steer).
function buildDeepenPrompt({ goal = '', target = '', facets = [], guidance = '', known = '', visited = [], coveragePlan = '', uncovered = [], covered = [], expected = 0 } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  const runCov = coverageLine(covered, expected);
  const cp = coveragePlan ? `\n${coveragePlan}\n` : '';
  const uc = (Array.isArray(uncovered) && uncovered.length)
    ? `\nFACETS STILL MISSING from the deliverable — pursue ONE of THESE this pass, do NOT keep re-searching a facet you already have:\n${uncovered.map((f) => `- ${f}`).join('\n')}\n` : '';
  const k = known ? `\nWHAT WE ALREADY HOLD on ${target} (from our own knowledge graph — treat as GIVEN, do NOT re-derive or re-report it; build PAST it toward what's missing):\n${known}\n` : '';
  // ALREADY-VISITED memory — stop the "same websites over and over" loop: name the URLs/searches already
  // used this run and push toward DEPTH (a new page on a site, a followed link) or a NEW source.
  const v = (Array.isArray(visited) && visited.length)
    ? `\nALREADY VISITED THIS RUN — do NOT open these again or re-run these searches; a RE-WORDED version of a listed search counts as the SAME search — do not run it again in any phrasing. Instead go DEEPER (open a NEW page/section on a site you've seen, or follow a link from it), OPEN the org's own /contact or /team page directly, or switch to a facet you have NOT covered:\n${visited.slice(-18).map(u => `- ${u}`).join('\n')}\n` : '';
  return `You are DEEP-researching ONE organization for Lucas's task, staying on it until it is well covered.\n\nTASK: ${goal}${runCov}\nCURRENT ORGANIZATION: ${target}\nFacets already gathered on it: ${facetsSummary(facets)}\n${k}${v}${uc}${cp}${g}\nTHIS PASS: pursue the NEXT most valuable facet you do NOT yet have on ${target}, in priority order: (1) named leadership & key staff with their roles, (2) direct contact details (work emails, phone numbers, mailing address, key social/LinkedIn) — check the org's own /contact or /about page, (3) detailed policy positions / notable work, (4) funding & affiliations, (5) recent activity / publications. EXHAUST a good source before moving on: when you land on the organization's OWN site, use open_page to go straight into its /team, /leadership, /about and /contact pages (and follow promising links) — do NOT bounce to a fresh web_search until you've actually used the site you're on. Ground EVERY detail in what the tools return — never invent a name, email, or number. If you cannot verify a real, FULL name, write "not found" — NEVER use initials, abbreviations, or any placeholder (e.g. "R. Z." or "VP") in place of a real name.\nIf you have already gathered a solid, well-rounded picture of ${target} (what it is, its people, how to reach it, its positions), reply with exactly SATURATED and nothing else.\nEnd with a final line: FACET: <the facet you added this pass>`;
}

// --- ENRICH / FACET-FILL mode -----------------------------------------------
// The discovery loop above WALKS NEW orgs and AVOIDS the covered set (buildNewTargetPrompt tells the
// model "do NOT pick any already-documented org"). Enrich is its mirror image: re-ENTER a KNOWN set of
// orgs (pulled from a prior dossier) and fill ONE named facet across all of them — "expand the 21 think
// tanks FOR THEIR policy/government-relations VPs + contacts". Without this, an "expand … for their VPs"
// order drifts into discovering brand-new orgs (the live #2027 failure), because the only deepening the
// discovery loop knows is its own next-facet pass on the org it JUST opened — never the existing set.

// Pick the next source org not yet enriched (case-insensitive), or null when the facet is filled across
// all of them. Deterministic order = the source dossier's order, so the run is resumable + predictable.
function pickEnrichTarget({ sourceOrgs = [], enriched = [] } = {}) {
  const done = new Set((Array.isArray(enriched) ? enriched : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
  for (const o of (Array.isArray(sourceOrgs) ? sourceOrgs : [])) {
    const name = String(o || '').trim();
    if (name && !done.has(name.toLowerCase())) return name;
  }
  return null;
}

// A short, clean label for the facet (used as the section field name). The full facet text stays in the
// prompt; this is only for the "## Org\n- **<label>:** …" header so sections read uniformly.
function facetLabel(facet = '') {
  const s = String(facet || '').replace(/[*_#`"]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Findings';
  return (s.length > 56 ? s.slice(0, 56).replace(/\s+\S*$/, '') + '…' : s);
}

// Enrich pass: fill ONLY the named facet for ONE KNOWN org. No TARGET/discovery control line — the org
// is given, the pass is single-purpose. parsePass still strips any leaked control JSON from the body.
function buildEnrichPrompt({ goal = '', org = '', facet = '', guidance = '', known = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  const body = `You are FILLING IN one specific piece of information about a KNOWN organization for Lucas. You are NOT looking for new organizations — the organization is fixed below.\n\nTASK: ${goal}\nORGANIZATION: ${org}\nWHAT TO FIND THIS PASS: ${facet}\n${g}\nGo to ${org}'s OWN website — its /team, /leadership, /staff, /about, /contact, /press pages — and any reliable source, and gather ONLY: ${facet}. For EACH person, give their FULL name and exact title, plus a direct work email / phone / LinkedIn where available. When you land on the org's own site, use open_page to go straight into its /team, /leadership, /about and /contact pages and follow promising links — do NOT bounce to a fresh web_search until you've actually used the site you're on. Ground EVERY detail in what web_search / browser_read / echo actually return — never invent a name, title, email, or number. If a real, FULL name cannot be verified, write "not found" — NEVER use initials, abbreviations, or "VP"/"the VP" as a stand-in for a real name.\nReport what you found for ${org} now.`;
  return require('./known').withKnown(body, { knownBlock: known, entity: org, facet });
}

// --- TWO-LANE DEEP RESEARCH (web lane ∥ deep/structured lane → merge) ------------------------------
// One target, worked CONCURRENTLY by two operators on two cloud models: the WEB lane hunts primary
// sources on the open internet (her browser + reliable fetch), the DEEP lane pulls authoritative
// STRUCTURED records the web won't surface (990 financials, federal funding, FEC, our knowledge graph).
// A merge pass then reconciles both raw streams into one section. This is the multi-cloud win: each
// lane runs the model that fits its work, in parallel, then we fold the results together.

// WEB lane: find the people/contacts/recent-activity on the open web. Browser + web fetch only.
function buildWebLanePrompt({ goal = '', org = '', facet = '', guidance = '', known = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  const body = `You are the WEB-RESEARCH lane for a known organization. Use the OPEN INTERNET only (her browser + web fetch) — another lane is separately pulling structured database records, so you do NOT need those.\n\nORGANIZATION: ${org}\nWHAT TO FIND: ${facet}\n${g}\nGo to ${org}'s OWN website (/team, /leadership, /staff, /about, /contact, /press) and reputable open-web sources, and gather: ${facet}. Give each person's FULL name, exact title, and any direct work email / phone / LinkedIn. Ground EVERY detail in what the tools actually return — never invent; write "not found" rather than a placeholder or initials. Report what you found for ${org}.`;
  return require('./known').withKnown(body, { knownBlock: known, entity: org, facet });
}

// DEEP lane: pull STRUCTURED, authoritative records — the things you can't get by browsing.
function buildDeepLanePrompt({ goal = '', org = '', facet = '', guidance = '', known = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  const body = `You are the DEEP / STRUCTURED-DATA lane for a known organization. Do NOT browse the open web (another lane does that). Use the STRUCTURED tools — IRS 990 financials, federal funding, FEC, and OUR knowledge graph — to surface authoritative records.\n\nORGANIZATION: ${org}\nFACET OF INTEREST: ${facet}\n${g}\nGATHER, where available: (1) nonprofit_lookup → the org's 990 leadership/board + exec-comp + revenue (often names the very officers the facet asks about); (2) gov_funding → federal grants/contracts it receives; (3) fec_lookup → any affiliated committees/PACs; (4) kg_search (+ kg_neighborhood on the id) → what OUR graph already knows about it and its people; (5) knowledge_search → our vault. Ground EVERY detail in what the tools return — never invent; write "not found" for anything missing. Report the structured findings for ${org}.`;
  return require('./known').withKnown(body, { knownBlock: known, entity: org, facet });
}

// MERGE: a reasoner folds the two raw lanes into ONE clean, deduped section. Reconcile overlaps (a
// person found by BOTH lanes = one entry, richest version), keep the union, mark provenance lightly.
function buildMergeLanesPrompt({ org = '', facet = '', webRaw = '', deepRaw = '', known = '' } = {}) {
  const label = facetLabel(facet);
  const knownPart = (known && known.trim())
    ? `\n\nOUR EXISTING RECORD on ${org} (the foundation — PRESERVE everything here that's still accurate; the section must GROW from it, never drop it):\n"""\n${String(known).slice(0, 4000)}\n"""`
    : '';
  return [
    { role: 'system', content: `You merge what we ALREADY KNOW about ONE organization with two fresh research streams — a WEB-lane stream (open-internet) and a DEEP-lane stream (structured databases: 990s, funding, FEC, our graph) — into a SINGLE clean, GROWN section. Rules:\n• Start from OUR EXISTING RECORD (below) and KEEP all of it that's still accurate; ADD the new findings — the section grows, it does not restart.\n• Ground ONLY in the existing record + the two streams — never add a name, title, email, or number not present; write "not found" for anything still missing. NEVER use initials/abbreviations/placeholders as a name.\n• DEDUPE: a person/fact in more than one source is ONE entry — keep the richest combined version.\n• Drop any leaked JSON / tool/control text.\nOutput EXACTLY this Markdown and nothing else:\n## ${org || '<organization>'}\n- **${label}:** <named individuals with roles + direct contacts, one per line; or "not found">\n- **Financials & funding (structured):** <990 revenue / exec-comp / federal funding / FEC ties; or "not found">` },
    { role: 'user', content: `${knownPart}\n\nWEB-LANE FINDINGS on ${org}:\n"""\n${String(webRaw || '(none)').slice(0, 6000)}\n"""\n\nDEEP-LANE FINDINGS on ${org}:\n"""\n${String(deepRaw || '(none)').slice(0, 6000)}\n"""\n\nProduce the single merged, grown section now.` }
  ];
}

// Organize the enrich findings on ONE org into a clean, facet-scoped section appended to the deliverable.
function buildOrganizeEnrichPrompt({ org = '', facet = '', raw = '' } = {}) {
  const label = facetLabel(facet);
  return [
    { role: 'system', content: `You organize raw research findings about ONE named facet for ONE organization into a single clean section. Ground ONLY in the notes — never add a name, title, email, or number not present; write "not found" for anything missing. NEVER use initials, abbreviations, or a placeholder in place of a real name (e.g. "R. Z." or "VP" is NOT a name — write "not found"). Drop any leaked JSON or tool/control text. Dedupe repeats. Output EXACTLY this Markdown and nothing else:\n## ${org || '<organization>'}\n- **${label}:** <named individuals with their roles and direct contact details, one per line; or "not found">` },
    { role: 'user', content: `RAW FINDINGS ON ${org} (facet: ${facet}):\n"""\n${String(raw).slice(0, 12000)}\n"""\n\nProduce the clean section now.` }
  ];
}

// Organize pass (reasoner): fold ONE target's accumulated raw passes into a single clean section.
function buildOrganizeTargetPrompt({ target = '', raw = '' } = {}) {
  return [
    { role: 'system', content: `You organize raw research notes on ONE organization into a single clean dossier section. Ground ONLY in the notes — never add a name, email, or number not present; write "not found" for anything missing. NEVER use initials, abbreviations, or a placeholder in place of a real name (e.g. "R. Z." or "P. C." is NOT a name — write "not found" instead). Drop any leaked JSON or tool/control text. Dedupe repeats. Output EXACTLY this Markdown and nothing else:\n## ${target || '<organization>'}\n- **Focus:** …\n- **Key people:** <named individuals with roles, or "not found">\n- **Contact:** <website / email / phone / address / social, or "not found">\n- **Positions / work:** …\n- **Funding & affiliations:** <or "not found">` },
    { role: 'user', content: `RAW NOTES ON ${target}:\n"""\n${String(raw).slice(0, 16000)}\n"""\n\nProduce the clean section now.` }
  ];
}

// COMPREHENSION over collation (Lucas 2026-07-30: "the papers do not match the depth and
// understanding I would expect"). The card template above is right for the roster sweep and
// DEADLY for his research: it instructs the big model to reorganize-not-think, so a working
// paper's targets come out as contact sheets. A USER research run synthesizes UNDERSTANDING —
// mechanism, the causal link to the goal, tensions in the evidence, and the open questions the
// next passes should chase. Grounding discipline survives translated: notes stay faithful to
// notes; the model's own reasoning is welcome but must READ as reasoning, never as sourced fact.
function buildUnderstandTargetPrompt({ goal = '', target = '', raw = '', known = '', priorDoc = null, sources = [] } = {}) {
  const srcList = (Array.isArray(sources) ? sources : []).filter(Boolean).slice(-20);
  return [
    { role: 'system', content: `You are the research brain synthesizing ONE target into UNDERSTANDING for a working paper. The gathered notes are evidence, not the deliverable — your job is what they MEAN for the goal.\nOutput EXACTLY this Markdown and nothing else:\n## ${target || '<target>'}\n**What it is & how it works:** <the mechanism in your own words, grounded in the notes>\n**Why it matters to the goal:** <the causal link — what depends on what, and which way it cuts>\n**Key facts & numbers:** <the load-bearing specifics from the notes; never invent a name or number — "not found" for anything missing>\n**Tensions & unknowns:** <where sources disagree; what the notes cannot yet answer>\nThen up to 3 lines, each starting exactly "OPEN: " — the questions research should chase next to close the unknowns.\nDiscipline: claims from the notes stay faithful to the notes; your own inference must read as inference ("this implies…", "likely because…"), never as sourced fact. Every load-bearing fact/number carries its source: append "(source: <url>)" chosen ONLY from the SOURCES list, or "(source: gathered notes)" when no listed page carries it — NEVER invent a URL. The notes contain "[pages read this pass: …]" markers — material BELOW a marker came from those pages; use them to bind claims to their URLs. Drop any leaked JSON or tool/control text.${priorDoc ? `\nA LIVING DOCUMENT on this topic already exists — DEEPEN, REVISE, or CONTRADICT what it concluded; never restate it. Where the new evidence changes a prior conclusion, say so explicitly ("revises the earlier finding that …").` : ''}` },
    { role: 'user', content: `THE GOAL: ${goal}\n\n${priorDoc ? `WHAT THE LIVING DOCUMENT ALREADY CONCLUDED ("${String(priorDoc.title || '').slice(0, 120)}" — bounce off it, don't restate it):\n"""\n${String(priorDoc.extract || '').slice(0, 3000)}\n"""\n\n` : ''}${known ? `ALREADY IN OUR GRAPH:\n${String(known).slice(0, 2000)}\n\n` : ''}${srcList.length ? `SOURCES (the pages this run actually visited — cite from these):\n${srcList.map((u) => `- ${String(u).slice(0, 160)}`).join('\n')}\n\n` : ''}GATHERED NOTES ON ${target}:\n"""\n${String(raw).slice(0, 16000)}\n"""\n\nSynthesize the understanding section now.` }
  ];
}

// The "OPEN: " lines out of a synthesized section — they feed the run's facet plan so the next
// passes chase what the synthesis could not answer (research that closes its own gaps).
function parseOpenQuestions(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/^OPEN:\s*(.{8,220})$/gim)) out.push(m[1].trim());
  return out.slice(0, 3);
}

module.exports = {
  parsePass, newContentChars, decideAdvance, facetsSummary,
  buildUnderstandTargetPrompt, parseOpenQuestions,
  isClarification, buildGuidanceBlock, isStatusRequest,
  buildNewTargetPrompt, buildTopicalPrompt, buildDeepenPrompt, buildOrganizeTargetPrompt, pickSeedTarget, allTargetsCovered, isConcreteTarget, coverageLine,
  facetToolset, buildCoveragePlan, searchSignature,
  pickEnrichTarget, facetLabel, buildEnrichPrompt, buildOrganizeEnrichPrompt,
  buildWebLanePrompt, buildDeepLanePrompt, buildMergeLanesPrompt,
  MAX_PASSES_PER_TARGET, MAX_PASSES_DEEP_TARGET, MAX_PASSES_REFUSAL, MAX_PASSES_VALIDATE, MIN_NEW_CHARS
};
