/* Smoke: lib/track — the deliverable-query path (count / list / sample / facet / status) over a
 * research Track's index + document, ACTIVE or COMPLETE. The bug it guards: post-completion
 * confabulation ("around 15" while 21 were on file) + the live-research disconnect.
 * Pure functions, no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_track.js
 */
'use strict';
const tk = require('../lib/track');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- a completed Track: 3 sections + matching index ---
const mk = (h, people, contact) => ({ heading: h, body: `## ${h}\n- **Focus:** policy\n- **Key people:** ${people}\n- **Contact:** ${contact}\n` });
const complete = {
  kind: 'complete', goal: 'study every think tank', completed: 'done',
  covered: ['Heritage Foundation', 'Cato Institute', 'Heartland Institute'],
  sections: [
    mk('Heritage Foundation', 'Kevin Roberts — President', 'heritage.org / 800-546-2843'),
    mk('Cato Institute', 'Peter Goettler — President', 'not found'),
    mk('Heartland Institute', 'James Taylor — President', 'not found')
  ],
  target: null
};
// --- an active Track: 2 done sections + an in-flight target not yet a section ---
const active = {
  kind: 'active', goal: 'study every think tank', completed: null,
  covered: ['Heritage Foundation', 'Cato Institute'],
  sections: complete.sections.slice(0, 2),
  target: { name: 'MIRI', rawExcerpt: 'Machine Intelligence Research Institute — AI safety nonprofit, Berkeley.' }
};

// --- classifyQuery ---
ok(tk.classifyQuery('how many have you done?').kind === 'count', '"how many" → count');
ok(tk.classifyQuery("what's the list so far").kind === 'list', '"the list" → list');
ok(tk.classifyQuery('name them all').kind === 'list', '"name them all" → list');
ok(tk.classifyQuery('how is it going?').kind === 'status', '"how is it going" → status');
ok(tk.classifyQuery('what do you have on Cato?').kind === 'sample', '"what do you have on X" → sample');
ok(tk.classifyQuery('who leads Heritage?').kind === 'sample', '"who leads X" → sample');
ok(tk.classifyQuery("who's the head of policy for each?").kind === 'facet', '"head of policy for each" → facet (all-entries sweep)');
ok(tk.classifyQuery("who's the head of policy for each?").scope === 'people', 'facet scope = people');
ok(tk.classifyQuery('contacts for all of them').kind === 'facet' && tk.classifyQuery('contacts for all of them').scope === 'contact', '"contacts for all" → facet/contact');
ok(tk.classifyQuery('I love that, thank you').is === false, 'gratitude is NOT a deliverable query');
ok(tk.classifyQuery('lets get pizza later').is === false, 'unrelated chatter is NOT a deliverable query');

// --- COUNT off the artifact, COMPLETE track (the post-completion confabulation bug) ---
const c1 = tk.buildAnswer(complete, 'how many think tanks have you done?');
ok(c1.handled && /\b3 organizations\b/.test(c1.block), 'count comes from the artifact (3), not a guess');
ok(/Heritage Foundation/.test(c1.block) && /Heartland Institute/.test(c1.block), 'count answer names every org');

// --- COUNT from the INDEX when the document is short/truncated (the live "5 vs 13" miss) ---
const truncated = {
  kind: 'active', goal: 'g', completed: null,
  covered: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],   // index = 13
  sections: [mk('A', 'x', 'y'), mk('B', 'x', 'y'), mk('C', 'x', 'y'), mk('D', 'x', 'y'), mk('E', 'x', 'y')],  // doc parsed only 5 (read cap)
  target: null
};
const tc = tk.buildAnswer(truncated, 'how many have you covered?');
ok(tc.handled && /\b13 organizations\b/.test(tc.block), 'count uses the INDEX (13), not the short/truncated document (5)');
ok(/A, B, C, D, E, F, G, H, I, J, K, L, M/.test(tc.block), 'list names every indexed org, not just the parsed ones');

// --- LIST ---
const l1 = tk.buildAnswer(complete, "what's the full list?");
ok(l1.handled && /3 organizations/.test(l1.block) && /Cato Institute/.test(l1.block), 'list answer = full grounded list');

// --- SAMPLE: a named org returns its exact section ---
const s1 = tk.buildAnswer(complete, 'what do you have on Heritage Foundation?');
ok(s1.handled && /Kevin Roberts/.test(s1.block) && /heritage\.org/.test(s1.block), 'sample returns the org\'s exact section');
// SAMPLE for something NOT on file → honest, no invention
const s2 = tk.buildAnswer(complete, 'what do you have on the Brookings Institution?');
ok(s2.handled && /don't have/.test(s2.block) && /Heritage Foundation/.test(s2.block), 'sample for an absent org → honest "don\'t have", lists what we do');

// --- SAMPLE by ACRONYM / short name (the live #2050 "what do you have on MIRI" bug) ---
const acro = {
  kind: 'complete', goal: 'AI safety orgs', completed: 'done',
  covered: ['Machine Intelligence Research Institute (MIRI)', 'Center for AI Safety (CAIS)'],
  sections: [
    mk('Machine Intelligence Research Institute (MIRI)', 'Eliezer Yudkowsky — Research Lead', 'intelligence.org'),
    mk('Center for AI Safety (CAIS)', 'Dan Hendrycks — Director', 'safe.ai')
  ],
  target: null
};
const m1 = tk.buildAnswer(acro, 'what do you have on MIRI?');
ok(m1.handled && /Eliezer Yudkowsky/.test(m1.block) && !/don't have/.test(m1.block), 'sample by ACRONYM "MIRI" hits its full-name section (live bug fixed)');
const m2 = tk.buildAnswer(acro, 'who leads CAIS?');
ok(m2.handled && /Dan Hendrycks/.test(m2.block), 'sample by acronym "CAIS" hits its section');
ok(tk.mentions('what about MIRI', 'Machine Intelligence Research Institute (MIRI)'), 'mentions(): acronym in question matches full name');
ok(tk.mentions('tell me about Cato', 'Cato Institute'), 'mentions(): distinctive token "Cato" matches');
ok(!tk.mentions('what do you have on the institute', 'Cato Institute'), 'mentions(): generic word "institute" alone does NOT match');

// --- FACET sweep: leadership across all entries (the "head of policy for each" failure) ---
const f1 = tk.buildAnswer(complete, "who's the head of policy for each of them?");
ok(f1.handled && /Kevin Roberts/.test(f1.block) && /Peter Goettler/.test(f1.block) && /James Taylor/.test(f1.block), 'facet sweep returns leadership for EVERY org');
const f2 = tk.buildAnswer(complete, 'give me the contacts for all of them');
ok(f2.handled && /heritage\.org/.test(f2.block) && /not found/.test(f2.block), 'contact facet sweep returns contacts (incl. honest "not found")');

// --- ACTIVE track: live count + in-flight target surfaced (the live-research disconnect) ---
const a1 = tk.buildAnswer(active, 'how many so far?');
ok(a1.handled && /2 organizations/.test(a1.block) && /still going/.test(a1.block) && /MIRI/.test(a1.block), 'active count = done so far + names the in-flight target');
// a question about the org being researched RIGHT NOW reaches the answer (not yet a section)
const a2 = tk.buildAnswer(active, 'what do you have on MIRI?');
ok(a2.handled && /Machine Intelligence Research Institute/.test(a2.block) && /still in progress/.test(a2.block), 'live query hits the IN-FLIGHT target\'s fresh research');

// --- 'none' track / non-query → not handled (fail-safe) ---
ok(tk.buildAnswer({ kind: 'none' }, 'how many?').handled === false, 'no track → not handled');
ok(tk.buildAnswer(complete, 'lets get pizza').handled === false, 'non-query turn → not handled');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
