/**
 * Backtest — inbox.isJunkSender, the guard that keeps Zoe from auto/intent-replying to
 * non-people (newsletters, mailer-daemon bounces, no-reply, notifications, lists). The
 * observed bug: last_inbound_from drifted to a newsletter → her reply bounced → the
 * mailer-daemon bounce became the next target → she "replied" to the daemon. This proves
 * the filter that now gates last_inbound_* recording + both reply paths.
 */
const inbox = require('../lib/inbox');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — inbox.isJunkSender\n');

console.log('JUNK (never a reply target):');
['newsletters@mail.investopedia.com', 'mailer-daemon@googlemail.com', 'no-reply@substack.com',
 'donotreply@notion.so', 'notifications@github.com', 'postmaster@example.com',
 'bounce+abc@sendgrid.net', 'weekly-digest@medium.com', 'updates@list.example.com'
].forEach(a => ok(a, inbox.isJunkSender(a) === true));

console.log('\nREAL PEOPLE (eligible to reply to):');
['rainey@raineycenter.org', 'lucas.overby@gmail.com', 'jane.smith@gleipnir.co',
 'editor@thehill.com', 'someone@gmail.com'
].forEach(a => ok(a, inbox.isJunkSender(a) === false));

console.log('\nedge:');
ok('empty → not junk (caller also format-checks)', inbox.isJunkSender('') === false);
ok('null → not junk', inbox.isJunkSender(null) === false);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
