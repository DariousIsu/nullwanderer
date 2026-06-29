/* Smoke: lib/track_index — resolve which Track a topic-addressed query is about, across ALL tracks.
 * Pure. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_track_index.js
 */
'use strict';
const ti = require('../lib/track_index');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// The real live track shapes (2026-06-29): a think-tank dossier + two AI-safety runs.
const tracks = [
  { id: 2027, status: 'stalled', hasDossier: true, goal: 'study every right of center think tank that deals with politics, policy, energy, the environment, global warming, AI, or infrastructure', covered: ['The Heritage Foundation', 'Competitive Enterprise Institute', 'Cato Institute', 'Manhattan Institute', 'Hudson Institute'] },
  { id: 2050, status: 'stalled', hasDossier: true, goal: 'dig into the people that run these groups', covered: ['Center for AI Safety', 'Future of Life Institute', 'MIRI', 'Anthropic'] },
  { id: 2064, status: 'resolved', hasDossier: true, goal: 'Busy day today, how does it feel to be working on real projects?', covered: ['International Association for Safe and Ethical AI', 'Center for AI Safety', 'Machine Intelligence Research Institute (MIRI)', 'Ada Lovelace Institute', 'CSET'] },
];

const R = (q) => { const t = ti.resolveByTopic(tracks, q); return t ? t.id : null; };

// --- topic-addressed resolution (the live failure) ---
ok(R('do we have a wrap up for the right wing think tanks list?') === 2027, '"right wing think tanks" → #2027 (NOT the AI-safety tracks)');
ok(R('how many think tanks did you cover?') === 2027, '"think tanks" → #2027');
ok(R('show me the conservative think tank research') === 2027, '"think tank" → #2027 even with the chit-chat-titled #2064 present');
ok(R('what do you have on the AI safety organizations?') === 2064, '"AI safety" → an AI-safety track (the bigram disambiguates from think tanks)');
ok([2050, 2064].includes(R('the AI safety orgs')), '"AI safety orgs" → an AI-safety track, not the think-tank one');

// --- AI-safety tie-break: both 2050 & 2064 match "ai safety"; the higher-id/more-covered wins ---
ok(R('the AI safety research') === 2064, 'between two AI-safety tracks, the larger / more-recent (#2064) wins the tie');

// --- no topic / generic → null (caller falls back to current-or-last) ---
ok(ti.resolveByTopic(tracks, 'how many have you covered so far?') === null, 'generic "how many" (no topic) → null → fallback to current-or-last');
ok(ti.resolveByTopic(tracks, "what's the full list?") === null, 'generic "the full list" (no topic) → null → fallback');
ok(ti.resolveByTopic([], 'think tanks') === null, 'empty registry → null');

// --- a single weak unigram does not hijack (minScore guard) ---
ok(ti.resolveByTopic([{ id: 1, goal: 'energy policy survey', covered: ['X'] }], 'tell me about policy') === null, 'a lone weak unigram ("policy") → below minScore → null');

// --- term extraction sanity ---
const terms = ti.topicTerms('right wing think tanks list');
ok(terms.bigrams.includes('think tanks') || terms.bigrams.includes('wing think'), 'bigrams extracted from the query');
ok(!terms.unigrams.includes('list') && !terms.unigrams.includes('the'), 'stopwords ("list","the") dropped from unigrams');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
