/** The exact failure: she denied email/browser capability and the voice guard missed it,
 *  and her read-test tripped the send-exclusion. Prove both are fixed (pure logic). */
const voice = require('../lib/voice');
const inbox = require('../lib/inbox');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

console.log('voice.isSelfDisclaimer — must CATCH (true):');
ok('the exact message she sent', voice.isSelfDisclaimer("I'm sorry, but I don't have the capability to perform browser actions or access emails. However, I can certainly help guide you through the process or answer any other questions you might have!"));
ok('"I can\'t access emails"', voice.isSelfDisclaimer("I can't access emails"));
ok('"I am unable to check your inbox"', voice.isSelfDisclaimer("I am unable to check your inbox right now"));
ok('"I don\'t have the ability to send email"', voice.isSelfDisclaimer("I don't have the ability to send email"));

console.log('\nvoice.isSelfDisclaimer — must KEEP (false, real gaps):');
ok('"I don\'t know what\'s in that email yet"', voice.isSelfDisclaimer("I don't know what's in that email yet — let me check.") === false);
ok('"I haven\'t read that email yet"', voice.isSelfDisclaimer("I haven't read that email yet.") === false);
ok('"I don\'t have that information"', voice.isSelfDisclaimer("I don't have that information.") === false);

console.log('\ninbox.detectInboxIntent — must FIRE (true):');
ok("Lucas's actual message (mentions he sent)", inbox.detectInboxIntent("That's my inbox, and yes I did send you an email. We were testing out you using your zoelanai@gmail.com account") === true);
ok('"check your inbox"', inbox.detectInboxIntent("can you check your inbox?") === true);
ok('"did I get any new emails?"', inbox.detectInboxIntent("did I get any new emails?") === true);

console.log('\ninbox.detectInboxIntent — must NOT fire (false, send requests):');
ok('"can you send an email to John"', inbox.detectInboxIntent("can you send an email to John?") === false);
ok('"please draft a reply"', inbox.detectInboxIntent("please draft a reply to that") === false);

console.log('\ninbox.inboxReferent — which mailbox (his=shared browser, hers=her IMAP):');
ok('"check my inbox" → his', inbox.inboxReferent('check my inbox') === 'his');
ok('"that\'s my inbox" → his', inbox.inboxReferent("that's my inbox, I sent you something") === 'his');
ok('"check my email" → his', inbox.inboxReferent('can you check my email') === 'his');
ok('"check your inbox" → hers', inbox.inboxReferent('check your inbox') === 'hers');
ok('"did you get any new email" → hers', inbox.inboxReferent('did you get any new email?') === 'hers');
ok('"the email I sent you" → hers', inbox.inboxReferent('read the email I sent you') === 'hers');
ok('"check email" → null (ambiguous→her account)', inbox.inboxReferent('check email') === null);

console.log(`\n${fail === 0 ? 'INBOX+VOICE OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
