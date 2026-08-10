'use strict';
/* smoke_delivery.js — Spine 3 delivery binding (lib/delivery.js).
 * The load-bearing case: "I'll pull that roster together" — a delivery PROMISE that, unkept, silently dies.
 * detectPromise must catch the real deliverable promises and leave offers / done-claims / chatter alone.
 * Pure, no db. Run: node scripts/smoke_delivery.js */
const d = require('../lib/delivery');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const has = (say) => d.detectPromise(say).length > 0;

// ── the census disease: committal deliverable promises ──────────────────────────────────────────────────
ok(has("I'll pull that roster together and get it to you."), 'promise: "I\'ll pull that roster together" → detected (the census case)');
ok(has('Let me compile the list of parish officials for you.'), 'promise: "let me compile the list … for you" → detected');
ok(has("I'm going to put together a spreadsheet of the contacts."), 'promise: "going to put together a spreadsheet" → detected');
ok(has("I'll draft the report and send it over."), 'promise: "draft the report and send it" → detected');
ok(has("Let me gather the emails and build a table."), 'promise: "gather the emails and build a table" → detected');
{
  const p = d.detectPromise("I'll pull that roster together for you.");
  ok(p[0] && /roster/i.test(p[0].deliverable), 'promise: the deliverable phrase is captured (roster)');
}

// ── NOT debts: offers, questions, done-claims, conversational "I'll" ─────────────────────────────────────
ok(!has('Want me to pull that roster together?'), 'FP: an OFFER ("want me to …?") is not a debt');
ok(!has('Should I compile the list for you?'), 'FP: a question ("should I …?") is not a debt');
ok(!has('Let me know if you want the spreadsheet.'), 'FP: "let me know if you want" is HER asking THEM, not a promise');
ok(!has("I've already compiled the list and it's on your canvas."), 'FP: a DONE-claim ("I\'ve already compiled it") → anti-fab\'s job, not a promise');
ok(!has('The roster is saved and ready for you.'), 'FP: "is saved and ready" (completion) → not a future promise');
ok(!has("I'll be honest — that's a hard question."), 'FP: conversational "I\'ll be honest" (no deliverable) → not a promise');
ok(!has("I'll keep that in mind going forward."), 'FP: "I\'ll keep that in mind" (no deliverable object) → not a promise');
ok(!has("Let me think about that for a second."), 'FP: "let me think" (no deliver-verb) → not a promise');
ok(!has('I prefer working from primary sources.'), 'FP: a stated preference → not a promise');

// ── bookingSubject: stable + deliverable-keyed + coalescing ─────────────────────────────────────────────
{
  const a = d.bookingSubject({ deliverable: 'roster', sentence: "I'll pull that roster together for you." });
  const b = d.bookingSubject({ deliverable: 'roster', sentence: "I'll pull that roster together for you." });
  const c = d.bookingSubject({ deliverable: 'list', sentence: 'Let me compile the list.' });
  ok(a === b, 'bookingSubject: identical promise → identical subject (coalesces)');
  ok(a !== c, 'bookingSubject: different deliverable → different subject');
  ok(/^roster#/.test(a), 'bookingSubject: keyed by the deliverable noun');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
