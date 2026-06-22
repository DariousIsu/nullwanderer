const { isActionable, classifyQuery } = require('../lib/intent');
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n));};
// the actual failure case
ok('drive link + "try it" → actionable', isActionable('https://docs.google.com/spreadsheets/d/15OvE3Ksaf/edit?usp=sharing try it from your own drive'));
ok('"open this sheet" → actionable', isActionable('open this sheet'));
ok('"read the spreadsheet from the meeting" → actionable', isActionable('read the spreadsheet from the meeting'));
ok('bare file ref .xlsm → actionable', isActionable('LA_Policy_Lab_Speaker_Tracking.xlsm has the data'));
ok('windows path → actionable', isActionable('look at C:\Users\azrae\file.txt'));
ok('"check the email" → actionable', isActionable('check the email'));
// negatives: social/open turns keep their texture (NOT gated)
ok('"how are you?" → NOT actionable', !isActionable('how are you?'));
ok('"what do you think about policy" → NOT actionable', !isActionable('what do you think about policy'));
ok('"tell me about your day" → NOT actionable', !isActionable('tell me about your day'));
ok('empty → NOT actionable', !isActionable(''));
// gate condition parity (narrow OR actionable)
const gated = (m) => (classifyQuery(m)==='narrow' || isActionable(m));
ok('gate fires on the drive-link turn', gated('https://docs.google.com/x try it from your own drive'));
ok('gate does NOT fire on pure social', !gated('how are you feeling today'));
console.log('\n'+(fail===0?'ALL PASS':'FAILURES')+` — ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
