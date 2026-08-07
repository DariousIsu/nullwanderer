'use strict';
/* smoke_meeting_leave.js — the polarity-safe chat leave detector (lib/meeting_leave.js).
 * Disease G: leaving a live call is irreversible; questions and negations must NEVER fire.
 * Run: node scripts/smoke_meeting_leave.js */
const path = require('path');
const { detectChatLeave } = require(path.join(__dirname, '..', 'lib', 'meeting_leave'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── the measured false positives — MUST NOT fire ────────────────────────────────────────────────
ok('question about state: "is the meeting over?"', !detectChatLeave('is the meeting over?'));
ok('question: "was the call done?"', !detectChatLeave('was the call done?'));
ok('question: "did the meeting wrap up?"', !detectChatLeave('did the meeting wrap up?'));
ok('question: "when does the meeting end"', !detectChatLeave('when does the meeting end'));
ok('negation: "don\'t leave the meeting yet"', !detectChatLeave("don't leave the meeting yet"));
ok('negation: "do not leave the call"', !detectChatLeave('do not leave the call'));
ok('stay-put: "stay in the meeting please"', !detectChatLeave('stay in the meeting please'));
ok('stay-put: "keep taking notes in the meeting"', !detectChatLeave('keep taking notes in the meeting'));
ok('unrelated: "the meeting notes look great"', !detectChatLeave('the meeting notes look great'));
ok('unrelated: "leave that for later"', !detectChatLeave('leave that for later'));

// ── genuine directives — MUST fire ──────────────────────────────────────────────────────────────
ok('order: "leave the meeting"', !!detectChatLeave('leave the meeting'));
ok('order: "you can leave the call now"', !!detectChatLeave('you can leave the call now'));
ok('order: "please hang up the call"', !!detectChatLeave('please hang up the call'));
ok('order: "end the meeting"', !!detectChatLeave('end the meeting'));
ok('polite modal is still an order: "can you leave the meeting"', !!detectChatLeave('can you leave the meeting'));
ok('modal with ?: "could you drop off the call?"', !!detectChatLeave('could you drop off the call?'));
const over = detectChatLeave('the meeting is over');
ok('declarative over: "the meeting is over"', !!over && over.reason === 'declared-over');
ok('declarative: "call\'s done, thanks everyone"', !!detectChatLeave("call's done, thanks everyone"));
ok('declarative: "that\'s a wrap"', !!detectChatLeave("that's a wrap"));
ok('order with trailing ?: "leave the meeting, ok?"', !!detectChatLeave('leave the meeting, ok?'));

console.log(`smoke_meeting_leave: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
