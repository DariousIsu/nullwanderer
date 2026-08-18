/** classifyQuery: narrow factual asks (named bill/entity, who/what question, quoted phrase)
 *  vs broad/open turns. Drives scoped retrieval + conditional recency-gating. */
const { classifyQuery } = require('../lib/intent');
let pass = 0, fail = 0;
const is = (text, want) => { const got = classifyQuery(text); const ok = got === want; (ok ? pass++ : fail++); console.log(`  ${ok ? '✓' : '✗'} [${want}] ${text}${ok ? '' : `  <-- got ${got}`}`); };

console.log('NARROW (tight, entity-exact, recency-gated):');
is('What is H.R. 1 about?', 'narrow');
is('what did the permitting reform bill say about deadlines', 'narrow');
is('Who is Christiane Amanpour?', 'narrow');
is('remind me what the "One Big Beautiful Bill" includes', 'narrow');
is('When was the FAST-41 Act passed?', 'narrow');

console.log('\nBROAD (wider, keep continuous-mind texture):');
is('what do you think about all this?', 'broad');
is("how's it going?", 'broad');
is('tell me about the Maastricht treaty', 'broad');
is("let's talk through the dedup approach", 'broad');
is('catch me up on what you found', 'broad');

const { isRecallQuery } = require('../lib/intent');
const rc = (text, want) => { const got = isRecallQuery(text); const ok = got === want; (ok ? pass++ : fail++); console.log(`  ${ok ? '✓' : '✗'} [recall=${want}] ${text}`); };
console.log('\nisRecallQuery (routes to user-statement recall):');
rc("what did I say about my father's day plans", true);
rc('remind me what we decided on the schema', true);
rc('what are my plans for saturday', true);
rc('what is H.R. 1 about?', false);
rc("how's the dedup research going?", false);

const { isEpisodicReference } = require('../lib/intent');
const ep = (text, want) => { const got = isEpisodicReference(text); const ok = got === want; (ok ? pass++ : fail++); console.log(`  ${ok ? '✓' : '✗'} [episodic=${want}] ${text}${ok ? '' : `  <-- got ${got}`}`); };
console.log('\nisEpisodicReference (fires the AGE-NEUTRAL deep episode scan — reaches months-ago):');
// positives — recalling an OLDER episode (topic + when), across both speakers
ep('remember when we talked about Louisiana energy policy?', true);
ep('do you remember when we got into the Cassidy bills?', true);            // also matches isRecallQuery — episodic wins (deep scan)
ep('when did Louisiana first come up between us?', true);
ep('when did we first discuss the Hartfield Foundation?', true);
ep('have we ever talked about the 2026 Senate forecast?', true);
ep('the first time we talked about the parish rosters', true);
ep('back when we were working on the donor network', true);
// negatives — reminders, obligations, idioms, factual lookups, and plain recall must NOT fire the deep scan
ep('remember to send the senator that email', false);                       // a reminder, not a recall
ep('remember we were supposed to file the brief by Friday', false);         // obligation, not a recall
ep('remember we had a call scheduled at noon', false);                      // reminder, not a recall
ep('when did we go over budget on this?', false);                           // idiom (over budget), not "review"
ep('when did the error come up in the logs?', false);                       // "come up" = arise, no conversational anchor
ep('when did the permitting bill pass?', false);                            // factual date, not "come up between us"
ep("what did I say about my father's day plans", false);                    // isRecallQuery's job (user-statement, recent)
ep('what is H.R. 1 about?', false);
ep("how's it going?", false);

console.log(`\n${fail === 0 ? 'QUERY CLASSIFIER OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
