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
ok(/## Cato/.test(op[0].content) && /Key people|Contact/i.test(op[0].content), 'organize prompt enforces the per-org schema');

// --- MID-RUN CLARIFICATION: detect his refinement, fold it into every pass ---
ok(r.isClarification({ message: 'yes, include state-level think tanks too', assistantAskedQuestion: true }) === true, 'an answer to her question → clarification');
ok(r.isClarification({ message: 'also make sure to get their funding sources' }) === true, 'refinement language ("also/make sure") → clarification');
ok(r.isClarification({ message: 'focus on the energy ones first' }) === true, '"focus on …" → clarification');
ok(r.isClarification({ message: 'the weather is nice' }) === false, 'unrelated chatter (no refinement, no question asked) → NOT a clarification');
ok(r.isClarification({ message: 'lol' }) === false, 'too-short throwaway → not a clarification');
ok(r.buildGuidanceBlock([]) === '', 'no clarifications → empty guidance block');
const gb = r.buildGuidanceBlock(['include state-level ones', 'skip any already in our CRM']);
ok(/ADDITIONAL GUIDANCE/i.test(gb) && /include state-level ones/.test(gb) && /skip any already/.test(gb), 'guidance block lists all clarifications');
// the guidance actually reaches the pass prompts
ok(r.buildNewTargetPrompt({ goal: 'g', covered: [], guidance: gb }).includes('include state-level ones'), 'new-target prompt carries the clarification guidance');
ok(r.buildDeepenPrompt({ goal: 'g', target: 'X', facets: [], guidance: gb }).includes('skip any already'), 'deepen prompt carries the clarification guidance');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
