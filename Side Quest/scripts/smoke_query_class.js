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

console.log(`\n${fail === 0 ? 'QUERY CLASSIFIER OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
